---
title: 'DW-568/DW-569: make listRawSourceSnapshots describe what is actually stored'
type: 'bugfix'
created: '2026-08-31'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
baseline_revision: 'e5dc6724d36cd57af3f28ebc816b065fe980c30c'
---

<intent-contract>

## Intent

**Problem:** `listRawSourceSnapshots` (`src/lib/raw.ts:390-418`) describes a tree that is not the one on disk. Its second walk root is `rawRelPath("")` — plain `raw/` — whose child directory `sources` passes `validateSlug`, so every flat `raw/sources/<hex>.md` file is read as a snapshot of a page called `sources` (`RAW_ID_RE` is `/^[a-f0-9]+$/`, unbounded, so `cafe.md` qualifies): a bogus `{slug: "sources", rawId: "cafe"}` row that `wiki-retrieve.ts` already turns into a duplicate retrieval document and that `cli list --raw` now prints (DW-568). In the other direction `if (child.isDirectory || !child.name.endsWith(".md")) continue` drops every non-Markdown child, so the bytes `saveRawSourceBytes` publishes at `raw/sources/<slug>/<rawId>.<ext>` appear in no listing at all and a PDF-only workspace reports `Raw sources:\t0` (DW-569).

**Approach:** Skip the structural directories under the legacy `raw/` root — they are roots, never page slugs — and widen the per-slug walk to every stored artefact regardless of extension, with each row carrying its `ext` and `mediaType` so the callers DW-437 moved onto this listing filter explicitly instead of relying on an implicit Markdown-only walk.

## Boundaries & Constraints

**Always:**
- A row is still one hashed artefact at depth 1 under a slug directory: `<slug>/<hex>.<ext>`, stem matching `RAW_ID_RE`. `path` stays the Workbench path of the file the row describes.
- The legacy `raw/<slug>/<rawId>.md` root keeps answering — `readRawSourceById` falls back to it and `src/lib/silo.ts:108-113` records it as a real source location.
- Dedup key becomes `<slug>/<rawId>.<ext>`: a PDF and the Markdown extracted from it deliberately share one `rawId`, so keying on `<slug>/<rawId>` would silently drop one of two stored artefacts.
- `listRawSources` stays non-recursive and flat; the Workbench Sources surface built on it does not move.
- `mediaType` is resolved from tables that already exist in `src/lib/workbench-intake.ts`; do not add a third MIME inventory to the repo.
- Every caller must state, in a comment at the call site, whether it filters and why.

**Block If:**
- Closing DW-568 would require dropping the legacy `raw/` root entirely (it would strand pre-move snapshots).

**Never:**
- Do not recurse below depth 1 inside a slug directory. Folder-import Sources (`saveRawSourceTree`, `raw/sources/papers/energy/note.md`) are identified by relative path (FR-40), have no hex `rawId`, and `readRawSourceById` cannot open them — emitting them would mint exactly the unreadable rows DW-568 is about.
- Do not change what `listRawSources`, `readRawSource`, or `readRawSourceById` return.
- Do not change `intakeMediaContentType`'s answers, or widen `MEDIA_CONTENT_TYPES`; the media door's contract is that an unlisted extension falls back to octet-stream.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Flat Source with a hex stem | `raw/sources/cafe.md` written by `saveRawSource("cafe", …)` | `listRawSourceSnapshots()` returns `[]` — no `{slug: "sources"}` row. `listRawSources()` still reports it. | No error expected |
| PDF-only Source | `saveRawSourceBytes("paper", "<hex>", "pdf", bytes)` and nothing else | One row `{slug: "paper", rawId: "<hex>", ext: "pdf", mediaType: "application/pdf", path: "raw/sources/paper/<hex>.pdf"}` | No error expected |
| PDF plus its extracted Markdown | `<hex>.pdf` and `<hex>.md` under `raw/sources/paper/` | Two rows, one per artefact, distinguished by `ext` | No error expected |
| Markdown-only workspace | `saveRawSourceFor("flat-one", "cafe01", …)` | Exactly the pre-change row, now with `ext: "md"`, `mediaType: "text/markdown"` | No error expected |
| Legacy hashed snapshot | `raw/<slug>/<hex>.md` (pre-move layout) | Still listed, `path` `raw/<slug>/<hex>.md` | No error expected |
| Structural roots under `raw/` | `raw/assets/<slug>/x.png`, `raw/parsed/<slug>/<hex>.md`, `raw/uploads/<job>/f`, `raw/originals/<t>/<slug>/f` | No rows from any of them | No error expected |
| Unknown extension | `raw/sources/s/<hex>.bin` | Row with `ext: "bin"`, `mediaType: "application/octet-stream"` | No error expected |
| Root missing | Neither `raw/sources/` nor `raw/` exists | `[]` | `listPrefix` swallows ENOENT; other errors still throw (pinned by `lint.test.ts:1452`) |

</intent-contract>

## Code Map

- `src/lib/raw.ts:342-418` — `RAW_ID_RE`, `RawSourceSnapshot`, `listRawSourceSnapshots`. The two walk roots are at `:391-394`; the extension filter at `:408`. Structural-root constants already live at `:29` (`RAW_SOURCES_DIR`), `:40` (`RAW_PARSED_DIR`), `:69` (`RAW_ASSETS_DIR`).
- `src/lib/raw.ts:301-321` — `saveRawSourceBytes`, the writer whose artefacts are missing. `ext` is validated as `/^[a-z0-9]{1,8}$/`; `rest` is `<slug>/<rawId>.<ext>`, always depth 1.
- `src/lib/raw.ts:460-489` — `saveRawSourceTree`, the folder-import writer that CAN nest. Its files have non-hex stems.
- `src/lib/raw.ts:589-596` — `listPrefix`, the ENOENT-tolerant listing helper both walks use.
- `src/lib/workbench-intake.ts:199-236` — `MEDIA_CONTENT_TYPES` + `intakeMediaContentType`. Its docblock already explains why `INTAKE_MIME_TYPES` cannot be inverted (`jpg`/`jpeg` both mean `image`); reuse it rather than re-deriving.
- `src/lib/workbench-intake.ts:67-131` — `INTAKE_TEXT_EXTENSIONS`, `INTAKE_EXTRACT_EXTENSIONS`, `INTAKE_MEDIA_EXTENSIONS`, `INTAKE_EXTENSIONS`. The parity target for a new resolver.
- `src/lib/document-sources.ts:153-155` — the only writer of `raw/originals/…`; imports `RAW_ASSETS_DIR` from `./raw` already, so a new `RAW_ORIGINALS_DIR` import is in keeping.
- `src/lib/ingest-staging.ts:29-36` — the only writer of `raw/uploads/…` (`stagedKey`, plus `STAGED_KEY_RE`).
- `src/cli.ts:540-590` — `listRawSourceRows`, the DW-437 union. Builds `filename` as `` `${snapshot.rawId}.md` `` (`:582`) — hardcoded `.md`. Feeds both `runList(true)` and `runStatus`'s `Raw sources:` count.
- `src/lib/wiki-retrieve.ts:271-293` — reads each snapshot with `readRawSourceById`, which only opens `.md`. Needs the Markdown filter.
- `src/lib/lint-checks.ts:1013-1030` — `checkIncompleteCoverage` uses snapshots for both candidacy (`rawSlugsOnDisk`) and the read fallback (`snapshotIdsBySlug`), both through `readRawSourceById`. Needs the Markdown filter.
- `src/lib/silo.ts:108-113,144-152` — records the legacy hashed root as real and mirrors `<slug>/<name>` at depth 1 skipping subdirectories: the existing precedent for "depth 1, any extension".
- `src/lib/__tests__/raw.test.ts:302-318` — the current `listRawSourceSnapshots` equality pin.
- `src/lib/__tests__/cli.test.ts:331-333,493-600,655-700` — mocked `listRawSourceSnapshots` return values; each literal needs the new fields.
- `src/lib/__tests__/lint.test.ts:1420-1462` — pins that a throwing snapshot walk still leaves the flat listing driving the check.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-intake.ts` -- add a `SOURCE_CONTENT_TYPES` table for the text and extract extensions and an exported `intakeContentType(ext)` that answers the media table first, then it, then `application/octet-stream` -- gives `raw.ts` a real media type without minting a third MIME inventory or changing `intakeMediaContentType`.
- `src/lib/raw.ts` -- add `RAW_UPLOADS_DIR` and `RAW_ORIGINALS_DIR` beside the existing `RAW_*_DIR` constants and a `RAW_NON_SLUG_DIRS` set built from all five -- the legacy `raw/` walk needs one named list of "this is a root, not a slug".
- `src/lib/document-sources.ts` -- use `RAW_ORIGINALS_DIR` at the `originals/…` key -- one spelling for the directory the walk now excludes.
- `src/lib/raw.ts` -- extend `RawSourceSnapshot` with `ext` and `mediaType`; rewrite `listRawSourceSnapshots` to skip `RAW_NON_SLUG_DIRS` children under the legacy root, accept any extension whose stem matches `RAW_ID_RE`, key `seen` on `<slug>/<rawId>.<ext>`, and fill the new fields -- closes DW-568 and DW-569 in one walk.
- `src/lib/wiki-retrieve.ts` -- skip rows whose `ext` is not `md`, with a comment saying `readRawSourceById` opens only Markdown -- a binary row would log a read failure per retrieval.
- `src/lib/lint-checks.ts` -- same filter in `checkIncompleteCoverage`, for both `rawSlugsOnDisk` and `snapshotIdsBySlug`, with a comment -- a PDF-only page has no prose to compare and would be a candidate that is silently skipped.
- `src/cli.ts` -- build `filename` from `ext`, and dedupe by `<slug>/<rawId>` preferring the non-Markdown artefact, with a comment saying the CLI is the caller that does NOT filter -- an extracted PDF is one Source, not two rows.
- `src/lib/__tests__/raw.test.ts` -- update the equality pin and add cases for the matrix rows: flat hex-stem Source, PDF-only, PDF+extracted Markdown, legacy hashed root, structural roots, unknown extension.
- `src/lib/__tests__/workbench-intake.test.ts` -- pin `intakeContentType` and add a parity test that every `INTAKE_EXTENSIONS` key resolves to something other than `application/octet-stream`.
- `src/lib/__tests__/cli.test.ts` -- add the new fields to every mocked snapshot literal; add a case pinning a PDF-only workspace's non-zero row and a case pinning the PDF+Markdown dedupe.
- `src/lib/__tests__/wiki-retrieve.test.ts`, `src/lib/__tests__/lint.test.ts` -- pin that a binary row produces no retrieval document and no coverage candidate.

**Acceptance Criteria:**
- Given a workspace whose only Source is `raw/sources/paper/<hex>.pdf`, when `runStatus()` runs, then `Raw sources:` reports 1 rather than 0.
- Given a workspace with `raw/sources/cafe.md` and no hashed tree, when `listRawSourceSnapshots()` runs, then it returns `[]` and `listRawSources()` still reports `cafe`.
- Given a workspace whose Sources are all Markdown, when retrieval, `checkIncompleteCoverage`, and `runList(true)` run, then their output is byte-identical to the pre-change output.
- Given `raw/assets/<slug>/x.png` and `raw/parsed/<slug>/<hex>.md` on disk, when `listRawSourceSnapshots()` runs, then neither contributes a row.
- Given a slug with both `<hex>.pdf` and `<hex>.md`, when `runList(true)` runs, then exactly one row is printed for that arrival and its filename is `<hex>.pdf`.

## Spec Change Log

## Review Triage Log

## Design Notes

Why depth 1 and a hex stem, not a full recursive walk: `rawId` is the row's identity and `readRawSourceById(slug, rawId)` is how every caller reads a row back. That reader builds `<slug>/<rawId>.md` — it cannot address a nested folder-import path, and folder imports carry no hex id anyway. A deeper walk would therefore emit rows no caller can open, which is the same defect as DW-568 in a new place. `silo.ts`'s hashed-mirror loop already walks this tree exactly this way.

Why `seen` gains the extension: `saveRawSourceBytes`'s docblock states that the extracted Markdown sits at `<slug>/<rawId>.md` beside the bytes "without a separate identity to keep in sync". Both are stored artefacts; the old key would report only whichever the walk reached first.

Shape of the widened row:

```ts
export interface RawSourceSnapshot {
  slug: string;
  rawId: string;
  /** Lowercase, no dot: `md` for a Markdown snapshot, `pdf`/`png`/… for bytes. */
  ext: string;
  /** What the repo's own doors serve these bytes as; octet-stream when unknown. */
  mediaType: string;
  path: string;
}
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/raw.test.ts src/lib/__tests__/cli.test.ts src/lib/__tests__/lint.test.ts src/lib/__tests__/wiki-retrieve.test.ts src/lib/__tests__/workbench-intake.test.ts` -- expected: all pass, including the new matrix cases.
- `pnpm exec tsc --noEmit` -- expected: no errors (every mocked `RawSourceSnapshot` literal carries the new fields).
- `pnpm test` -- expected: the full suite passes, no regression in the brand, prose-inventory, or source-scan parity suites.
