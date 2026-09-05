---
title: 'Archive and raw-name predicates: slide parts and snapshot id length'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
baseline_revision: '93574e4a7a640352ed13f5acba098b79c53e9c3f'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      extractXlsx has the same "existence is not identity" defect DW-724 fixed in
      extractPptx: a workbook sheet rel resolving to any real archive key is
      accepted as a worksheet and shadows the numbered fallback.
    evidence: |-
      src/lib/document-extract.ts:766 pushes a sheet on `if (path && files[path])`
      with no `^xl/worksheets/sheetN\.xml$` test, and the numbered
      `xl/worksheets/sheetN.xml` fallback is used only when that list is empty —
      the identical shadowing shape. Verified during review: a workbook whose
      `rId1` targets `sharedStrings.xml` alongside a real
      `xl/worksheets/sheet1.xml` extracts as "## Metrics\n\n[Empty worksheet]",
      dropping the real sheet's data. Reachable through the same inline ZIP door
      as DW-724 (`extractDocumentTextAsync`'s zip branch). This bundle's intent
      named only extractPptx, so the sibling was left untouched.
    location: >-
      src/lib/document-extract.ts:766
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two predicates accept entries they were never meant to. `extractPptx` filters the presentation-order list on mere existence in the archive (`Boolean(files[slide.path])`), so a crafted deck whose `p:sldId` rel resolves to a real non-slide part — `ppt/media/photo.jpg` — survives, makes `ordered` non-empty, shadows `fallbackSlides`, and gets image bytes decoded as slide XML (DW-724). `isRawSnapshotName` tests an unbounded `/^[a-f0-9]+$/` stem, so a depth-1 folder-import file such as `raw/sources/papers/2024.pdf` is listed as `{slug: "papers", rawId: "2024"}` — an unreadable row that also suppresses a real flat `raw/sources/papers.md` row (DW-744).

**Approach:** Add a `/^ppt\/slides\/slide\d+\.xml$/i` test on `slide.path` beside the existence check, with a crafted-archive fixture. Bound the raw id to the lengths the writers actually mint — 16 hex (`contentHash`, FNV two-pass) and 64 hex (`sourceSha256`/`bytesSha256`) — in the SHARED `RAW_ID_RE`, so writers, readers and `isRawSnapshotName` cannot disagree; update the fixtures and the two collision pins that inverted.

## Boundaries & Constraints

**Always:**
- The id bound lands in the shared `RAW_ID_RE` (`src/lib/raw.ts:443`), not privately inside `isRawSnapshotName`. A bound only in the predicate would let a writer mint a snapshot the listing and the silo mirror then deny — the exact failure the existing doc comment warns against.
- The bound must accept BOTH real writer lengths: 16 (`contentHash`, used by `ingest.ts` and `workbench/intake` for `saveRawSourceFor`) and 64 (`sourceSha256`/`bytesSha256`). A 64-only bound would reject every text-ingest snapshot.
- `src/lib/raw.ts` and its consumer `src/lib/silo.ts` share the one predicate and must land together.
- Rewrite the doc comment on `isRawSnapshotName` and `RAW_ID_RE`: the "accepted, and bounded" collision paragraphs now describe a CLOSED collision, and must say what the bound is and why it is safe (it equals what the writers mint).

**Block If:**
- A writer is found that mints a raw id at a length other than 16 or 64 hex.

**Never:**
- Do not renumber or otherwise change how surviving slides are numbered in `extractPptx`; only the filter changes.
- Do not loosen `RAW_EXT_RE`, change `validateSlug`, or touch the flat/legacy root walk in `listRawSourceSnapshots`.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Crafted rel at a real image | PPTX whose only `p:sldId` rel targets `../media/photo.jpg`, plus a real `ppt/slides/slide1.xml` | `ordered` is empty, the numbered fallback survives: exactly one `## Slide 1` carrying the real slide's text | No error expected |
| Mixed crafted + real rels | Rels target `slides/slide1.xml` AND `../media/photo.jpg` | Only the real slide part survives the filter; one `## Slide` section, no image bytes decoded | No error expected |
| Crafted rel, no readable slide | Only `../media/photo.jpg` rel, no `ppt/slides/slideN.xml` part | `ClientInputError` ("no slides"), never a `TypeError` | 400 door, not 500 |
| Folder-import file at depth 1 | `raw/sources/papers/2024.pdf` | `isRawSnapshotName("2024.pdf")` is false; no snapshot row, no silo mirror, `papers` not added to `slugsWithSnapshots` | No error expected |
| Short all-hex import file | `beef.md` at an import root | `isRawSnapshotName` is false — the DW-744 collision is closed | No error expected |
| Real 16-hex snapshot | `raw/sources/p/<16 hex>.md` written by `saveRawSourceFor` | Accepted by the writer AND listed/mirrored | No error expected |
| Real 64-hex snapshot | `raw/sources/p/<64 hex>.pdf` written by `saveRawSourceBytes` | Accepted by the writer AND listed/mirrored | No error expected |
| Off-length hex id at a writer | `saveRawSourceFor("p", "beef", …)` | Throws `Invalid raw id: must be a hex hash` | Existing writer error path |

</intent-contract>

## Code Map

- `src/lib/document-extract.ts:597-620` -- `extractPptx`. `fallbackSlides` is `numberedFiles(files, /^ppt\/slides\/slide(\d+)\.xml$/i)`; `ordered` is built from `p:sldId` + `relationshipMap` and filtered by `Boolean(files[slide.path])` only. Add the slide-path test there. `if (ordered.length) slides = ordered;` is the shadowing line.
- `src/lib/document-extract.ts:405-457` -- the OOXML archive is already null-prototype (DW-695); path confusion is a separate defect and is NOT addressed by that.
- `src/lib/document-extract.ts:574-586` -- `resolveArchiveTarget`; `../media/photo.jpg` from `ppt/presentation.xml` resolves to `ppt/media/photo.jpg`, a key `archiveEntryKind` really keeps (image kind).
- `src/lib/__tests__/document-extract.test.ts:11-71` -- `officeBytes` / `office` / `craftedDeck` / `slideHeadings` helpers and `PROTOTYPE_MEMBERS`; :288-345 are the DW-695 crafted-deck tests to model the new fixture on.
- `src/lib/raw.ts:443` -- `RAW_ID_RE = /^[a-f0-9]+$/`; used by `saveRawSourceBytes` (:382), `saveParsedMarkdown` (:416), `saveRawSourceFor` (:624), `readRawSourceById` (:698) and `isRawSnapshotName` (:487-493).
- `src/lib/raw.ts:446-451` -- `RAW_EXT_RE`, hoisted so writer and predicate "cannot disagree"; the same rationale governs the id bound.
- `src/lib/raw.ts:452-486` -- the `isRawSnapshotName` doc comment; its last two paragraphs record the collision as accepted and name `raw.test.ts` as the pin. Both must be rewritten.
- `src/lib/raw.ts:505-535, :584` -- `listRawSourceSnapshots` doc comment explicitly cites `raw/sources/papers/2024.pdf` as an emitted row; that paragraph must be corrected. `:584` is the classify call.
- `src/lib/silo.ts:130` (`mirrorHashedTree`), `:171` (`removeHashedTree`), `:96` (comment) -- the shared consumers.
- Writers that mint ids (read-only evidence, do not change): `src/lib/embeddings.ts:1188-1203` `contentHash` returns exactly 16 hex; `src/lib/source-sha256.ts` `sourceSha256`/`bytesSha256` return 64 hex; call sites `src/lib/ingest.ts:2340-2344`, `src/app/api/workbench/intake/route.ts:290,:572`, `src/lib/extract-dispatch.ts:116,:347,:355`, `src/app/api/chat/conversations/[id]/save/route.ts:107`, `src/lib/research-completion.ts:345,:820`.
- Fixture fallout measured by running the change: 44 failures in 6 node suites -- `src/lib/__tests__/raw.test.ts` (25), `lint.test.ts` (12), `raw-source-search.test.ts` (3), `wiki-retrieve.test.ts` (2), `epic8-remediation.test.ts` (1), `workbench-tree.test.ts` (1). All are short-hex fixture ids (`abc123`, `aa11`, `beef01`, `cafe01`, `a1b2c3`, `ab12`, `ff00`, `aa11bb22`, `deadbeef`, …) plus the two intentional collision pins at `raw.test.ts:966-974` and the `2024.pdf` case near `raw.test.ts:581`.

## Tasks & Acceptance

**Execution:**
- `src/lib/document-extract.ts` -- in `extractPptx`, filter `ordered` on `/^ppt\/slides\/slide\d+\.xml$/i.test(slide.path)` as well as `Boolean(files[slide.path])`; add a short comment naming DW-724 and why existence alone is not identity.
- `src/lib/__tests__/document-extract.test.ts` -- extend `craftedDeck` (or add a sibling helper) so a rel can target a REAL non-slide part, and add tests for the three PPTX rows of the I/O matrix, including the nested-ZIP door if it is cheap to reuse.
- `src/lib/raw.ts` -- bound `RAW_ID_RE` to the two writer lengths (16 or 64 hex); rewrite the `RAW_ID_RE`, `isRawSnapshotName` and `listRawSourceSnapshots` doc comments so they state the bound, cite the writers it mirrors, and no longer describe the collision as accepted.
- `src/lib/silo.ts` -- update the `:96` comment if it still describes the old, unbounded shape; no logic change expected.
- `src/lib/__tests__/raw.test.ts` -- lengthen fixture ids to real writer lengths; invert the two collision pins (`beef.md`, and the `2024.pdf` folder-import row) into assertions that the file is NOT a snapshot and mints NO row; keep a pin that a 16-hex and a 64-hex id both round-trip through writer + predicate.
- `src/lib/__tests__/lint.test.ts`, `raw-source-search.test.ts`, `wiki-retrieve.test.ts`, `workbench-tree.test.ts`, `epic8-remediation.test.ts` -- lengthen short-hex fixture ids (and every path string that embeds them) to 16 hex; behavior assertions stay as they are.

**Acceptance Criteria:**
- Given a PPTX whose presentation rel resolves to a real non-slide archive key, when it is extracted, then the deck's own `ppt/slides/slideN.xml` parts are what get read and no image bytes are decoded as slide XML.
- Given the shared `RAW_ID_RE`, when any writer accepts an id, then `isRawSnapshotName` accepts the filename that writer produces — verified by a test that drives writer and predicate from the same id.
- Given `pnpm test`, when the suite runs, then it passes with no remaining short-hex fixture failures and no skipped assertions.

## Design Notes

The bound is an alternation of the two lengths the writers actually mint, not a floor:

```ts
/** A per-source raw id is a hex digest at one of the two lengths the writers mint. */
const RAW_ID_RE = /^(?:[a-f0-9]{16}|[a-f0-9]{64})$/;
```

16 is `contentHash` (FNV-1a forward+reverse, `embeddings.ts:1203`), 64 is SHA-256 (`source-sha256.ts`). A floor such as `{16,}` would accept stems no writer produces; the alternation is the exact statement of "what a snapshot filename IS", which is what makes narrowing safe here where the old comment said it would not be.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/document-extract.test.ts` -- expected: pass, including the new crafted non-slide-part cases.
- `pnpm exec vitest run --project node src/lib/__tests__/raw.test.ts src/lib/__tests__/silo.test.ts src/lib/__tests__/lint.test.ts src/lib/__tests__/raw-source-search.test.ts src/lib/__tests__/wiki-retrieve.test.ts src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/epic8-remediation.test.ts` -- expected: pass.
- `pnpm test` -- expected: full suite green (baseline before this change is green).
- `pnpm lint` -- expected: no new findings.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Two predicates tightened. `extractPptx` now requires a presentation-order rel to resolve to a slide PART (`/^ppt\/slides\/slide\d+\.xml$/i`), not merely to a key the archive holds, so a crafted deck aimed at a real image or theme part no longer makes `ordered` non-empty, shadows `fallbackSlides` and gets image bytes decoded as slide XML (DW-724). The shared `RAW_ID_RE` is bounded to the two digest lengths the writers actually mint — 16 hex (`contentHash`) and 64 hex (`sourceSha256`/`bytesSha256`) — so a depth-1 folder-import file such as `raw/sources/papers/2024.pdf` is an import file again rather than a snapshot the listing reports, the silo mirror carries, and `readRawSourceById` cannot open (DW-744). The bound lives in the shared constant, not privately in `isRawSnapshotName`, so no writer can mint an id the listing then denies.

### Files changed

- `src/lib/document-extract.ts` — slide-path test added to the `ordered` filter, with the DW-724 rationale at the call site.
- `src/lib/raw.ts` — `RAW_ID_RE` bounded to 16|64 hex; the `RAW_ID_RE`, `isRawSnapshotName` and `listRawSourceSnapshots` doc comments rewritten to state the bound and record the collision as closed.
- `src/lib/silo.ts` — comment only; behavior follows from the shared predicate.
- `src/lib/types.ts` — `raw_id` doc now names the enforced length rule.
- `src/lib/__tests__/document-extract.test.ts` — `nonSlidePartDeck` helper plus four tests (fallback survives, mixed real+non-slide rels, 400 when only non-slide rels exist, the nested-ZIP door).
- `src/lib/__tests__/raw.test.ts` — fixture ids lengthened; both collision pins inverted; new pins for off-length rejection at the writer, writer↔predicate agreement at both lengths, a 16/64 round trip through writer→reader→listing, and a 64-hex bytes snapshot listed and mirrored.
- `src/lib/__tests__/silo.test.ts` — new pin that a short-hex import file is neither mirrored nor deleted with the colliding page.
- `src/lib/__tests__/lint.test.ts`, `raw-source-search.test.ts`, `wiki-retrieve.test.ts`, `workbench-tree.test.ts`, `epic8-remediation.test.ts`, `cli.test.ts`, `lifecycle.test.ts`, `strict-merge-base-reads.test.ts` — short-hex fixture and mock ids lengthened to real writer lengths.

### Review findings

- Patches applied: 3 (all low) — see the triage log entry above.
- Deferred: 1 (low) — the `extractXlsx` sibling of DW-724, recorded in frontmatter `deferred`.
- Rejected: 11 — chiefly the retroactive-narrowing family (an already-stored id at some third length would become unreadable, unlisted and unmirrored), which four independent traces of every writer since the original per-source commit show cannot exist; pre-existing PPTX edge shapes not touched by this change (duplicate `p:sldId` rels emitting a slide twice, a case-variant `ppt/Slides/Slide1.xml` losing its notes and images); `saveParsedMarkdown`'s by-contract silent no-op; and the ledger entries still reading `status: open`, which the orchestrator records.
- Follow-up review recommended: false. Patched findings by severity — high 0, medium 0, low 3; the score counts only high-severity patches, so it is 0.

### Verification performed

- `pnpm exec vitest run --project node src/lib/__tests__/document-extract.test.ts` — 20/20 pass. The four new cases were confirmed to fail (and only those) with the slide-path test removed, so they pin the fix rather than passing vacuously.
- `pnpm exec vitest run --project node` over `raw`, `silo`, `lint`, `raw-source-search`, `wiki-retrieve`, `workbench-tree`, `epic8-remediation`, `cli`, `lifecycle`, `strict-merge-base-reads` — all pass.
- `pnpm test` — 388 files, 9760 passed, 1 skipped, 0 failures (the pre-existing skip). Baseline before the change was green at 9757.
- `pnpm lint` — clean. `pnpm exec tsc --noEmit` — clean.
- Matrix test audit: every I/O row has a covering test that ran and passed. Three tests were added during the audit to close gaps — the silo-mirror half of the `2024.pdf` row, the 64-hex bytes-snapshot row, and the writer's rejection of an off-length hex id.

### Residual risks

- Slide numbers are still assigned from the pre-filter `p:sldIdLst` position, so a deck whose non-slide rel precedes a real slide emits `## Slide 2` (or higher) for its only slide and leaves the literal slide-number paragraph in the speaker notes, which `value !== String(number)` no longer matches. This predates the change — DW-695's filter already dropped entries after numbering — and is reachable only on crafted or malformed decks, where the prior behavior was worse (the bogus entries were extracted as slides). Not filed as a ledger entry.
- The new filter accepts only the conventional `ppt/slides/slideN.xml` part name. OPC permits others, and a deck that named its slide parts otherwise and addressed them by rel would now be refused with `ClientInputError` where it previously extracted. This restores parity with the repo's own primary extractor — `sidecar/extract/src/pptx.rs` and the numbered fallback both match only `slideN.xml` — so such a deck was already unsupported through the `.pptx` door; only the inline ZIP path changes.
- The id bound governs reads as well as writes, so a stored snapshot whose stem is hex at some other length would silently vanish from the listing, the silo mirror and `readRawSourceById`. Every writer since the original per-source commit mints 16 or 64, so no such file should exist, but this was not verified against a live data directory and no migration or diagnostic was added.
