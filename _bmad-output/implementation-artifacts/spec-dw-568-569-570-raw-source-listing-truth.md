---
title: 'DW-568/569/570: make raw.ts describe and mirror what is actually stored'
type: 'bugfix'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The shared `isRawSnapshotName` predicate accepts a depth-1 folder-import file
      whose stem is all hex at ANY extension, so `raw/sources/papers/2024.pdf` is
      listed as `{slug: "papers", rawId: "2024", ext: "pdf"}` and can displace the
      real flat Source row for a page slugged like the import root.
    evidence: |-
      DW-568's fix moved the listing onto `isRawSnapshotName`, whose bound was
      `.md`-only when the listing had its own inline test. Any all-digit stem is
      valid hex, so a folder import containing `docs/2024.pdf` now yields a row.
      `readRawSourceById("docs", "2024")` builds `docs/2024.md` and throws, and
      `listRawSourceRows` adds the slug to `slugsWithSnapshots` — so if a page
      `docs` also has a flat `raw/sources/docs.md`, its real row is suppressed by
      an import file. Retrieval and `incomplete-coverage` are unaffected (both
      filter `ext !== "md"`); only `list --raw` / `Raw sources:` can show it.
      The `.md` half of this collision is pre-existing and deliberately documented
      ("accepted, and bounded — a single colliding FILE"); this change widened it
      to every extension the writers accept. Bounding the stem to the writers'
      digest length would close both halves.
    location: >-
      src/lib/raw.ts:446
    severity: low
baseline_revision: '84565a53fdf62dd4dc72837e6c5a572f512c48e5'
---

<intent-contract>

## Intent

**Problem:** `listRawSourceSnapshots` (`src/lib/raw.ts:472-504`) describes a tree that is not on disk. Its second walk root is plain `raw/`, whose child directory `sources` passes `validateSlug`, so every flat `raw/sources/<hex>.md` is read as a snapshot of a page called `sources` — `RAW_ID_RE` is unbounded, so `cafe.md` qualifies and yields a bogus `{slug: "sources", rawId: "cafe"}` row that `wiki-retrieve.ts` turns into a duplicate retrieval document and `cli list --raw` prints (DW-568). In the other direction `!child.name.endsWith(".md")` drops every binary child, so the bytes `saveRawSourceBytes` publishes at `raw/sources/<slug>/<rawId>.<ext>` appear in no listing and a PDF-only workspace reports `Raw sources:\t0` (DW-569). Separately, `storeRawSource`'s occupied branch mirrors the REQUEST body into the silo when re-reading the stored bytes fails, which its own comment forbids (DW-570).

**Approach:** Skip the structural roots under the legacy `raw/` root — they are roots, never page slugs — and widen both walks to every stored artefact at depth 1 whose name is `<hex>.<ext>`, each row carrying its `ext` and `mediaType` so the three callers DW-437 moved onto this listing filter explicitly. In `storeRawSource`, a failed re-read abandons the silo repair instead of falling back to the request body.

## Boundaries & Constraints

**Always:**
- A row is one hashed artefact at depth 1 under a slug directory (`<slug>/<hex>.<ext>`), and `path` stays the Workbench path of that exact file.
- The listing's name test becomes the exported `isRawSnapshotName` — the writers, the silo mirror and the listing then share one rule instead of two hand-synced ones. Update that function's docblock, which currently states the listing does NOT call it and enumerates `.md` only.
- Dedup key becomes `<slug>/<rawId>.<ext>`: a PDF and the Markdown extracted from it deliberately share one `rawId`, so keying on `<slug>/<rawId>` would silently drop one of two stored artefacts.
- The legacy `raw/<slug>/<rawId>.<ext>` root keeps answering — `readRawSourceById` falls back to it and `src/lib/silo.ts:228-248` mirrors it.
- `mediaType` comes from a resolver added beside the tables in `src/lib/workbench-intake.ts`; do not add a third MIME inventory to the repo.
- Every caller of `listRawSourceSnapshots` states in a comment at the call site whether it filters and why.
- `storeRawSource`'s silo repair mirrors STORED bytes or nothing.

**Block If:**
- Closing DW-568 would require dropping the legacy `raw/` walk root entirely (it would strand pre-move snapshots).

**Never:**
- Do not recurse below depth 1 inside a slug directory. Folder-import Sources (`saveRawSourceTree`, `raw/sources/papers/energy/note.md`) are identified by relative path (FR-40), have no hex `rawId`, and `readRawSourceById` cannot open them — emitting them mints exactly the unreadable rows DW-568 is about.
- Do not change what `listRawSources`, `readRawSource`, `readRawSourceById` or `readRawSourceTree` return, and do not make `listRawSources` recursive.
- Do not change `intakeMediaContentType`'s answers or widen `MEDIA_CONTENT_TYPES` / `INTAKE_MIME_TYPES` / `INTAKE_EXTENSIONS`.
- Do not change `storeRawSourceBytes`' mirror: its keys are content-addressed by construction (`mirrorSourceBytesToSilo`'s docblock), so the buffer in hand IS the stored object there.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Flat Source with a hex stem | `raw/sources/cafe.md` only | `listRawSourceSnapshots()` returns `[]`; `listRawSources()` still reports `cafe` | No error expected |
| PDF-only Source | `saveRawSourceBytes("paper", "<hex>", "pdf", bytes)` | One row `{slug: "paper", rawId: "<hex>", ext: "pdf", mediaType: "application/pdf", path: "raw/sources/paper/<hex>.pdf"}` | No error expected |
| PDF plus extracted Markdown | `<hex>.pdf` and `<hex>.md` under `raw/sources/paper/` | Two rows, one per artefact, distinguished by `ext` | No error expected |
| Markdown-only workspace | `saveRawSourceFor("flat-one", "cafe01", …)` | The pre-change row, now with `ext: "md"`, `mediaType: "text/markdown"` | No error expected |
| Legacy hashed snapshot | `raw/<slug>/<hex>.md` (pre-move layout) | Still listed, `path` `raw/<slug>/<hex>.md` | No error expected |
| Structural roots under `raw/` | `raw/assets/<slug>/x.png`, `raw/parsed/<slug>/<hex>.md`, `raw/uploads/<job>/f`, `raw/originals/<t>/<slug>/f` | No rows from any of them | No error expected |
| Folder-import file | `raw/sources/papers/energy/note.md` | No row (nested, and `note` is not hex) | No error expected |
| Unknown extension | `raw/sources/s/<hex>.bin` | Row with `ext: "bin"`, `mediaType: "application/octet-stream"` | No error expected |
| Roots missing | Neither `raw/sources/` nor `raw/` exists | `[]` | `listPrefix` swallows ENOENT; other errors still throw (pinned by `lint.test.ts:1489`) |
| Silo repair, stored bytes unreadable | Flat key occupied, `readFile(rel)` throws | Warn; NO silo write; no `dataVersion` bump; `storeRawSource` returns `false` | Warning logged, arrival still succeeds |

</intent-contract>

## Code Map

- `src/lib/raw.ts:95-100` — `RAW_STRUCTURAL_DIRS` (`sources`, `assets`, `parsed`, `uploads`). Already the named "this is a root, not a slug" set the legacy walk needs; `originals` is missing from it (`document-sources.ts:162-164` writes `raw/originals/<tenant>/<slug>/<file>` through `rawRelPath`).
- `src/lib/raw.ts:236-265` — `storeRawSource`'s occupied branch. `let stored = content;` at :252 is DW-570; the comment above it at :249-251 is the contract being violated.
- `src/lib/raw.ts:318-331` — `mirrorSourceBytesToSilo`. Its docblock explains why the BINARY twin legitimately mirrors the caller's buffer (content-addressed key); this is why DW-570 is a string-writer-only fix.
- `src/lib/raw.ts:412-419` — `RAW_ID_RE` (`/^[a-f0-9]+$/`), `RAW_EXT_RE` (`/^[a-z0-9]{1,8}$/`).
- `src/lib/raw.ts:421-452` — `isRawSnapshotName`. Exactly the widened test the listing needs. Its docblock's "`listRawSourceSnapshots` still classifies with its own inline `<hex>.md` test and does NOT call this" and the "they already differ deliberately in one respect" paragraph both become false and must be rewritten.
- `src/lib/raw.ts:454-459` — `RawSourceSnapshot`; `:472-504` — `listRawSourceSnapshots`. Walk roots at :473-476, extension filter at :489, dedup key at :492.
- `src/lib/raw.ts:671-678` — `listPrefix`, the ENOENT-tolerant helper both walks use.
- `src/lib/workbench-intake.ts:69-131` — `INTAKE_TEXT_EXTENSIONS`, `INTAKE_EXTRACT_EXTENSIONS`, `INTAKE_MEDIA_EXTENSIONS`, `INTAKE_EXTENSIONS`.
- `src/lib/workbench-intake.ts:133-163` — `INTAKE_MIME_TYPES` (mime → format class). The source of truth for the text/extract content-type spellings, but NOT invertible (many-to-one).
- `src/lib/workbench-intake.ts:199-238` — `MEDIA_CONTENT_TYPES` + `intakeMediaContentType`. Reuse; its docblock already explains the non-invertibility. Imports here are cycle-free: `workbench-intake` pulls only `document-formats`, `slugify`, `workbench-tree`, none of which reach `raw.ts`.
- `src/cli.ts:606-631` — `listRawSourceRows`, the DW-437 union. Hardcodes `` `${snapshot.rawId}.md` `` at :622. Feeds `runList(true)` and `runStatus`'s `Raw sources:` count (`src/cli.ts:650-660`).
- `src/lib/wiki-retrieve.ts:273-296` — reads each snapshot with `readRawSourceById`, which builds `<slug>/<rawId>.md` and so only opens Markdown.
- `src/lib/lint-checks.ts:1027-1042` — `checkIncompleteCoverage` uses snapshots for candidacy (`rawSlugsOnDisk`) and for the read fallback (`snapshotIdsBySlug`), both through `readRawSourceById`.
- `src/lib/silo.ts:124-141` — `mirrorHashedTree`: the existing "depth 1, any extension, `isRawSnapshotName`" precedent.
- `src/lib/__tests__/raw.test.ts:304-318` — the `listRawSourceSnapshots` equality pin; `:680-714` — the `isRawSnapshotName` describe whose comments name the `.md`-only listing.
- `src/lib/__tests__/cli.test.ts:333` (mock), `:501,516,538,556,578,668,691` — snapshot literals needing the new fields.
- `src/lib/__tests__/lint.test.ts:1489` — pins that a throwing snapshot walk still leaves the flat listing driving the check.
- `src/lib/__tests__/cli-status-config-load.test.ts:43` — `listRawSourceSnapshots: vi.fn(async () => [])`; needs no change.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-intake.ts` -- add a `SOURCE_CONTENT_TYPES` table covering `INTAKE_TEXT_EXTENSIONS` + `INTAKE_EXTRACT_EXTENSIONS` and an exported `intakeContentType(name)` that answers `MEDIA_CONTENT_TYPES` first, then it, then `application/octet-stream` -- gives `raw.ts` a real media type without minting a third inventory or changing `intakeMediaContentType`.
- `src/lib/raw.ts` -- add `"originals"` to `RAW_STRUCTURAL_DIRS` with a comment in the style of the existing `uploads` note (literal owned by `document-sources.ts`) -- the legacy walk's skip list must be every structural root, or DW-568 stays open for one of them.
- `src/lib/raw.ts` -- extend `RawSourceSnapshot` with `ext` and `mediaType`; rewrite `listRawSourceSnapshots` to skip `RAW_STRUCTURAL_DIRS` children under the legacy `raw/` root only, classify children with `isRawSnapshotName`, key `seen` on `<slug>/<rawId>.<ext>`, and fill the new fields from the filename and `intakeContentType` -- closes DW-568 and DW-569 in one walk.
- `src/lib/raw.ts` -- rewrite the two now-false paragraphs of `isRawSnapshotName`'s docblock -- the listing calls it, and the deliberate `.md`-only divergence is gone.
- `src/lib/raw.ts` -- in `storeRawSource`'s occupied branch, return `false` without mirroring when the re-read throws, with a comment saying why mirroring the request body is worse than a lagging Files tree -- DW-570.
- `src/lib/wiki-retrieve.ts` -- skip rows whose `ext !== "md"`, with a comment saying `readRawSourceById` opens only Markdown -- a binary row logs a read failure on every retrieval.
- `src/lib/lint-checks.ts` -- same filter in `checkIncompleteCoverage` for both `rawSlugsOnDisk` and `snapshotIdsBySlug`, with a comment -- a PDF-only page has no prose to compare.
- `src/cli.ts` -- build `filename` from `ext`, dedupe by `<slug>/<rawId>` preferring the non-Markdown artefact, and comment that the CLI is the caller that does NOT filter -- an extracted PDF is one Source, not two rows, and the count must not double.
- `src/lib/__tests__/workbench-intake.test.ts` -- pin `intakeContentType` and add a parity test that every `INTAKE_EXTENSIONS` key resolves to something other than `application/octet-stream`.
- `src/lib/__tests__/raw.test.ts` -- update the equality pin, correct the stale `.md`-only comment at `:689`, and add a case per I/O matrix row including the DW-570 unreadable-re-read case (spy `getStorage().readFile` to throw and assert no silo key was written).
- `src/lib/__tests__/cli.test.ts` -- add the new fields to every mocked snapshot literal; add a PDF-only non-zero-count case and a PDF+Markdown dedupe case.
- `src/lib/__tests__/wiki-retrieve.test.ts`, `src/lib/__tests__/lint.test.ts` -- pin that a binary row produces no retrieval document and no coverage candidate.

**Acceptance Criteria:**
- Given a workspace whose only Source is `raw/sources/paper/<hex>.pdf`, when `runStatus()` runs, then `Raw sources:` reports 1 rather than 0.
- Given a workspace with `raw/sources/cafe.md` and no hashed tree, when `runList(true)` runs, then the only row printed is `cafe\tcafe.md`.
- Given a workspace whose Sources are all Markdown, when retrieval, `checkIncompleteCoverage` and `runList(true)` run, then their output is identical to the pre-change output.
- Given a slug with both `<hex>.pdf` and `<hex>.md`, when `runList(true)` runs, then exactly one row is printed for that arrival and its filename is `<hex>.pdf`.
- Given an occupied flat key whose stored bytes cannot be re-read, when `saveRawSourceFor` runs with an `owner`, then no tenant silo key is written and no `dataVersion` bump occurs.

## Spec Change Log

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[medium]` `[patch]` `src/cli.ts` — a BINARY snapshot was adding its slug to `slugsWithSnapshots`, so a page with a flat prose blob plus a hashed `.png` lost the prose row from `list --raw` and the `Raw sources:` count. Gated the suppression on `ext === "md"` (the flat blob's twin is the `.md` snapshot `ingest()` writes from the same text) and pinned both rows plus the count of 2.
  - `[medium]` `[patch]` `src/lib/__tests__/raw.test.ts` — the legacy-root-only scope of the structural skip was unpinned: making the skip unconditional left all 396 tests green while a page slugged `assets`/`sources`/`parsed`/`uploads`/`originals` would lose every Intake Source from retrieval, coverage and the CLI. Added the positive counterpart asserting the modern-root row survives while the legacy-root one does not.
  - `[low]` `[patch]` `src/lib/__tests__/lint.test.ts` — the new binary-candidacy test passed with the `ext !== "md"` filter deleted (both reads throw and `rawParts.length === 0` short-circuits before `callLLM`). Reworked to pin the filter's observable effect — the listed-but-unreadable warning candidacy produces — captured before `mockRestore()`.
  - `[low]` `[patch]` `src/lib/raw.ts` — the listing docblock justified excluding folder imports with "are nested, and carry no hex id", false for the depth-1 hex-stem case the widened predicate now accepts, and `isRawSnapshotName`'s collision bound was still written as `.md`-only. Both passages corrected and the collision pinned by test. Comments only; the predicate is a spec Always clause.
  - `[low]` `[patch]` `src/lib/workbench-intake.ts` — `intakeContentType` indexed both tables bare, so an inherited `Object.prototype` member could be returned as a content type (the DW-365 hazard `classifyIntakeFile` routes around). Both lookups now go through `ownLookup`, pinned with `constructor`/`toString`/`valueOf`/`hasOwnProperty`.
  - `[low]` `[patch]` `src/lib/__tests__/raw.test.ts` — the DW-570 test's silo assertion was a negative against an unscoped `getDataDir()`, so a setup that took the created path would still pass. It now asserts first that the flat key was re-read, i.e. that the occupied branch really ran.

## Design Notes

Why depth 1 and a hex stem, not a full recursive walk: `rawId` is the row's identity and `readRawSourceById(slug, rawId)` is how callers read a row back. That reader builds `<slug>/<rawId>.md` — it cannot address a nested folder-import path, and folder imports carry no hex id anyway. A deeper walk emits rows no caller can open, which is DW-568 in a new place. `silo.ts`'s `mirrorHashedTree` already walks this tree exactly this way.

Why `seen` gains the extension: `saveRawSourceBytes`' docblock states the extracted Markdown sits at `<slug>/<rawId>.md` beside the bytes "without a separate identity to keep in sync". Both are stored artefacts; the old key reported only whichever the walk reached first.

Why the structural skip is legacy-root-only: under `raw/sources/` a directory named `assets` IS a page slug (`raw/sources/assets/<hex>.md` is that page's snapshot tree). The ambiguity only exists one level up.

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
- `pnpm exec vitest run --project node src/lib/__tests__/raw.test.ts src/lib/__tests__/cli.test.ts src/lib/__tests__/lint.test.ts src/lib/__tests__/wiki-retrieve.test.ts src/lib/__tests__/workbench-intake.test.ts src/lib/__tests__/silo.test.ts` -- expected: all pass, including the new matrix cases.
- `pnpm exec tsc --noEmit` -- expected: no errors (every mocked `RawSourceSnapshot` literal carries the new fields).
- `pnpm test` -- expected: the full suite passes, no regression in the brand, prose-inventory or source-scan parity suites.

## Auto Run Result

Status: done

### Implemented change

`listRawSourceSnapshots` now describes what is actually on disk in both directions, and `storeRawSource`'s silo repair no longer invents bytes.

- **DW-568** — under the LEGACY `raw/` walk root the `RAW_STRUCTURAL_DIRS` names are skipped, so the flat Source `raw/sources/cafe.md` is no longer read as a snapshot of a page called `sources`. The skip is legacy-root-only: one level down, a directory named `assets` really is a page slug. `originals` joined that set — it is `document-sources.ts`'s root under `raw/` and its second segment is a tenant, not a slug.
- **DW-569** — both walks now accept every stored artefact at depth 1 whose name is `<hex>.<ext>` (the shared `isRawSnapshotName`, previously duplicated as an inline `.md`-only test), each row carrying `ext` and `mediaType`, keyed for dedup on `<slug>/<rawId>.<ext>` so a PDF and the Markdown extracted from it are two artefacts rather than one that wins by walk order. The three callers DW-437 moved onto this listing each state at the call site whether they filter: retrieval and `incomplete-coverage` drop non-Markdown (`readRawSourceById` opens `.md` only); the CLI deliberately does not filter — it reports what is stored — but collapses one arrival's rows to one, preferring the original over its extract.
- **DW-570** — a failed re-read of the stored bytes now abandons the silo repair instead of mirroring the request body. The silo door is create-only, so the wrong text would have been the permanent answer Files gives for that Source; a silo still missing it is visibly empty, the flat bytes are intact, and the next arrival repairs it for real.

### Files changed

- `src/lib/raw.ts` — `originals` added to `RAW_STRUCTURAL_DIRS`; `RawSourceSnapshot` gains `ext`/`mediaType`; the walk skips structural roots under the legacy root, classifies with `isRawSnapshotName`, and keys dedup on the extension; `storeRawSource` abandons the repair on a failed re-read.
- `src/lib/workbench-intake.ts` — `SOURCE_CONTENT_TYPES` plus the exported `intakeContentType`, both lookups through `ownLookup`.
- `src/cli.ts` — `listRawSourceRows` builds `filename` from `ext`, collapses one arrival's rows, and only lets a Markdown snapshot suppress the slug's flat row.
- `src/lib/wiki-retrieve.ts`, `src/lib/lint-checks.ts` — the Markdown filter each caller needs, with the reason at the call site.
- `src/lib/silo.ts` — comments only: the structural-root enumeration and the legacy-root spelling.
- `src/lib/__tests__/{raw,cli,lint,wiki-retrieve,workbench-intake}.test.ts` — one case per I/O-matrix row plus the review-driven pins.

### Review findings

- Patches applied: 6 (medium 2, low 4) — see the Review Triage Log entry above.
- Items deferred: 1 (low) — the widened predicate accepts a depth-1 folder-import file with an all-hex stem at any extension; recorded in frontmatter `deferred`.
- Items rejected: 4 (all low) — `mediaType` having no production consumer (the recorded 2026-08-29 decision mandates the listing carry it; callers discriminating on `ext` is the same filter); the `originals` silo blast radius (`raw/originals/`'s children are tenant directories, so `mirrorHashedTree` never had a candidate there and nothing could have been mirrored to orphan); two non-Markdown artefacts sharing one `rawId` (the id is a SHA-256 of the bytes, so this means byte-identical files and the collapse is correct); and the absence of an end-to-end CLI pin (`cli.test.ts` mocks `../raw` wholesale by established design, and the two halves are pinned either side of that boundary).
- Follow-up review recommendation: **false**. Patched findings by severity — high 0, medium 2, low 4; the score counts high-severity patches only.

### Verification

- `pnpm exec tsc --noEmit` — clean.
- `pnpm exec vitest run --project node` over `raw`, `cli`, `lint`, `wiki-retrieve`, `workbench-intake`, `silo` — 401 passed.
- `pnpm test` — 372 files, 9284 passed, 1 skipped (pre-existing), 0 failures.
- Matrix audit: every I/O row has a covering test that ran and passed in the runs above.
- One reviewer reported a single failure of the DW-570 test in a combined run; that reviewer was concurrently mutating `raw.ts` for its own experiments. Re-ran the exact file combination five times on the clean tree — 180 passed each time. The test's premise is now asserted explicitly regardless.

### Residual risks

- `list --raw` output changes for any workspace with extracted binaries: a PDF and its extract print as one row named after the PDF, where previously the PDF was invisible and the extract printed alone.
- A page genuinely slugged `originals` no longer has its legacy `raw/originals/` hashed tree mirrored or unmirrored by `silo.ts`. That is the withholding direction the set documents and already applies to `assets`/`parsed`, and nothing writes hashed snapshots at that path.
- `raw.ts` now imports `workbench-intake.ts`. Cycle-free today (`workbench-intake` reaches only `document-formats`, `slugify`, `workbench-tree`), and the import comment says so, but it is a new edge between a storage module and a door module.
- A stale `spec-dw-568-569-raw-source-listing-fidelity.md` sits at `status: in-review` from an earlier interrupted run. Its planned code never landed and the codebase has since moved (`RAW_STRUCTURAL_DIRS` now exists); this spec supersedes it. Left untouched — spec lifecycle is the orchestrator's.
