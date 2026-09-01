---
title: 'DW-608/610/611: Silo mirror covers every address a page stores, and only its own'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
baseline_revision: '7412875c8d0ba574cfd2610715656c1bf8d17dc8'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      The Sources-pane rescan lists `raw/sources/**` only, so a legacy-address
      silo mirror is visible in the Files tab but never in Sources.
    evidence: |-
      `listRawSourceFilePaths` (src/lib/workbench-files.ts:726) walks the silo
      `raw/` root but descends only toward `raw/sources`
      (`underSources`/`towardSources`, :770-776), while
      `listWorkbenchFilePaths` walks the whole root. Both legacy addresses this
      mirror writes — `tenants/<t>/raw/<slug>.md` (pre-existing) and
      `tenants/<t>/raw/<slug>/<rawId>.<ext>` (DW-610, added here) — therefore
      list in Files and never in the Sources pane. DW-610's harm is stated as
      "invisible in Files" and that surface IS closed; the Sources pane is a
      second surface the bundle never named. Pre-existing for the flat legacy
      address, and unchanged by the address-preserving choice recorded in this
      spec's Design Notes.
    location: >-
      src/lib/workbench-files.ts:726
    severity: low
---

<intent-contract>

## Intent

**Problem:** The silo mirror is narrower than what a page actually stores and wider than what a page actually owns. `reconcileSilos` (`src/lib/silo.ts:279-296`) calls `syncSiloForPage` only when the silo wiki md is missing or its bytes differ from flat, and `lifecycle.ts` writes both from the identical content, so a live page always lands on `alreadyCurrent` and a Source (or discussion thread, or asset) added after the md was mirrored is never repaired (DW-608). The legacy hashed root `raw/<slug>/<rawId>.md` — a real source location that `readRawSourceById` falls back to and `listRawSourceSnapshots` enumerates — is still never mirrored, so pre-move hashed arrivals stay invisible in Files, which resolves `raw/` silo-only (DW-610). And `raw/sources/<name>/` is shared by page slugs and folder-import roots (`saveRawSourceTree`, `src/lib/raw.ts:470`), so a page slugged like an import root mirrors that import's top-level files — possibly another owner's — into its silo and takes the whole silo tree with it on delete, because `deleteDirSafe` is recursive on both providers (DW-611).

**Approach:** Widen the reconcile gate to sync every page unconditionally, keeping the md comparison purely as the classifier for the `synced`/`stale`/`alreadyCurrent` counters. Mirror the legacy hashed root alongside the modern one through one shared helper. Define the page-owned subset of a shared `<name>/` directory as its top-level `<hex>.<ext>` snapshot files — the same identity `listRawSourceSnapshots` uses — so folder-import content is neither mirrored nor deleted, and removal deletes those files individually instead of recursively deleting the directory.

## Boundaries & Constraints

**Always:**
- One predicate decides what a hashed snapshot filename is, exported from `src/lib/raw.ts` and reused by `silo.ts`, so the mirror and the snapshot listing cannot drift apart on that identity.
- Keep the flat-first listing order and the copy-only-new bound for BOTH hashed roots: list the flat side first, and skip the silo-side listing entirely when the flat side yields no page-owned candidate.
- Mirror hashed entries byte-exactly (`copyAsset`) at both roots — the tree holds PDFs/DOCX/JPEGs beside extracted `.md`.
- Mirror the legacy hashed root address-preservingly into `tenants/<t>/raw/<slug>/`, the same convention the legacy flat `raw/<slug>.md` mirror two lines above already uses.
- Skip the legacy hashed root entirely when the slug names a structural root under `raw/` (`sources`, `assets`, `parsed`, `uploads`) — those directories hold other pages' and other owners' content, and the path alone cannot tell a real page slugged `assets` from the root itself. Fail closed, as `rawPathSlug` does for `parsed`.
- `removeSiloForPage` deletes only page-owned snapshot files from a shared silo directory, and removes the directory itself only when nothing foreign was left in it.
- Every copied entry still counts toward the `number` `syncSiloForPage` returns.
- Reconcile keeps its existing `ReconcileResult` shape and field names; only the doc comments change to say what the counters now mean.

**Block If:** Nothing here needs a human.

**Never:**
- Never touch the FLAT trees — this is a silo mirror/cleanup change. Flat bytes belong to cascade delete (`deleteRawSourceBytes`).
- Never change `listRawSources`, `listRawSourceSnapshots`, `readRawSourceById`, `rawPathSlug`/`rawPathAllowed`, or any ingest caller's `{ owner }` handling.
- Never add a field to `ReconcileResult` or change `maintenance.ts`'s reconcile log line.
- Never make `syncSiloForPage` take options or a per-artifact opt-out to cheapen reconcile; the copy-only-new bound inside it is the budget answer.
- Never rewrite an already-mirrored hashed key.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Source added after md mirrored | Page synced, then `raw/sources/<slug>/<hex>.md` lands; silo md still byte-identical to flat | `reconcileSilos` counts the page `alreadyCurrent` AND the hashed arrival is now in the silo | Per-page `try/catch` already records the error and continues |
| Legacy hashed arrival | Only `raw/<slug>/<hex>.md` exists | `syncSiloForPage` returns 2; `tenants/<t>/raw/<slug>/<hex>.md` holds identical bytes | No error expected |
| Legacy binary arrival | `raw/<slug>/<hex>.pdf` with non-UTF-8 bytes | Mirrored byte-for-byte via `copyAsset` | No error expected |
| Structural-root slug | Page slugged `sources`; `raw/sources/` holds other pages' files and slug dirs | Legacy root is not listed and nothing under it is mirrored or deleted; the modern `raw/sources/sources/` tree still is | No error expected |
| Import-root collision | Page slugged `papers`; `raw/sources/papers/note.md` (folder import) and `raw/sources/papers/<hex>.md` | Only the `<hex>.md` is mirrored; `note.md` never enters the silo | No error expected |
| Delete over a shared dir | Silo holds `tenants/<t>/raw/sources/papers/{<hex>.md, note.md, sub/deep.md}` | `removeSiloForPage("papers", t)` removes `<hex>.md` only; `note.md`, `sub/deep.md` and the directory survive | `listSafe`/`deleteSafe` swallow ENOENT |
| Delete over a page-only dir | Silo holds only `<hex>.<ext>` entries | Files gone and the directory itself removed | `deleteDirSafe` swallows ENOENT |
| No hashed tree at either root | Flat-only slug | Count unchanged from today; one listing per absent flat prefix, no silo-side listing at either root | `listSafe` answers `[]` on ENOENT |

</intent-contract>

## Code Map

- `src/lib/silo.ts:114-162` -- `syncSiloForPage`'s flat raw copies and the DW-435 hashed block. Replace the inline hashed loop with two calls to one new helper (modern root, then legacy root); extend the comment block at `:100-113` — it currently states the legacy hashed root is *deliberately* unmirrored, which this change reverses.
- `src/lib/silo.ts:214-231` -- `removeSiloForPage`. `deleteDirSafe(tenantRawSourceRelPath(tenant, slug))` at `:229` is the recursive delete DW-611 names; replace it with the selective removal, and add the legacy silo root beside it.
- `src/lib/silo.ts:35-84` -- `copyText`, `copyAsset`, `listSafe`, `deleteSafe`, `deleteDirSafe`. Reuse; add no new storage helper.
- `src/lib/silo.ts:237-248,279-296` -- `ReconcileResult` and the forward-pass gate. `alreadyCurrent`'s doc comment must stop implying nothing was done.
- `src/lib/raw.ts:381` -- `RAW_ID_RE` (private) and `src/lib/raw.ts:333` -- the inline `/^[a-z0-9]{1,8}$/` extension check in `saveRawSourceBytes`. Both feed the new exported `isRawSnapshotName`; hoist the extension literal into a named const so the writer and the predicate agree.
- `src/lib/raw.ts:30,41,69,72-84` -- `RAW_SOURCES_DIR`/`RAW_PARSED_DIR`/`RAW_ASSETS_DIR` and the path spellings. Add the structural-root set here (including the `uploads` literal that `src/lib/ingest-staging.ts:32` owns) so `silo.ts` does not restate it.
- `src/lib/raw.ts:401-433` -- `listRawSourceSnapshots`: READ-ONLY evidence that `<hex>.md` under a per-slug directory at BOTH roots is the snapshot identity, and that the legacy root is real.
- `src/lib/raw.ts:447-500` -- `saveRawSourceFor` / `saveRawSourceTree`: the two writers that share `raw/sources/<name>/`. READ-ONLY.
- `src/lib/workbench-files.ts:196-294,660-690` -- `rawPathSlug`/`rawPathAllowed` and the silo-rooted `raw/` walk: READ-ONLY evidence that mirroring into `tenants/<t>/raw/<slug>/` is what makes a legacy arrival visible in Files, and the precedent for failing closed on structural roots.
- `src/lib/maintenance.ts:260-278` -- the only production `reconcileSilos` caller (end of `rebuildDerivedIndexes`, fail-soft, admin/rebuild path — not a request hot path). READ-ONLY; its log line reads the four existing counters.
- `src/lib/migrate-to-tenants.ts:81` -- the other `syncSiloForPage` caller; sums the returned count. READ-ONLY.
- `src/lib/__tests__/silo.test.ts:105-260` -- the DW-435 hashed tests, including the `vi.spyOn(getStorage(), "listFiles")` cost test at `:174-196` that pins listing order. Extend it to cover the legacy root's prefixes.

## Tasks & Acceptance

**Execution:**
- `src/lib/raw.ts` -- export `isRawSnapshotName(name)` (a `<hex>.<ext>` test built from `RAW_ID_RE` and a hoisted extension regex reused by `saveRawSourceBytes`) and a `RAW_STRUCTURAL_DIRS` set naming `sources`/`assets`/`parsed`/`uploads` -- one owner for "what is a page-owned snapshot" and "what is a structural root", so the silo mirror cannot drift from the snapshot listing.
- `src/lib/silo.ts` -- add a `mirrorHashedTree(flatPrefix, siloPrefix)` helper that lists the flat side, keeps only non-directory, non-dotfile, `isRawSnapshotName` entries, returns 0 without listing the silo when none survive, and `copyAsset`s each not-yet-mirrored one; call it for the modern root and, unless the slug is a structural root, for the legacy `raw/<slug>/` root -- covers pre-move hashed arrivals (DW-610) while keeping a folder import's files out of a colliding page's silo (DW-611).
- `src/lib/silo.ts` -- replace the recursive `deleteDirSafe` on the hashed silo directory with a `removeHashedTree(siloPrefix)` that deletes only `isRawSnapshotName` top-level files and removes the directory only when nothing else was there; apply it to the modern root and, for non-structural slugs, the legacy silo root -- a page delete must not take a same-named import tree with it.
- `src/lib/silo.ts` -- in `reconcileSilos`, call `syncSiloForPage` on every page and use the md comparison only to classify `synced`/`stale`/`alreadyCurrent`; record why the per-page cost is accepted and update `alreadyCurrent`'s doc comment -- a Source, thread, or asset added after the md was mirrored must be repairable by a routine reconcile (DW-608).
- `src/lib/__tests__/silo.test.ts` -- add tests for every I/O matrix row: reconcile repairs a hashed Source under an `alreadyCurrent` page, the legacy hashed root mirrors (text and binary), a structural-root slug is skipped at the legacy root only, an import file beside a snapshot is not mirrored, selective delete spares foreign entries and their directory, a page-only directory is removed outright, and a flat-only slug pays one listing per absent flat prefix and none on the silo side -- pins both the widening and the narrowing.

**Acceptance Criteria:**
- Given a page whose silo md already matches flat and whose `raw/sources/<slug>/<hex>.md` is unmirrored, when `reconcileSilos()` runs, then the silo holds those bytes and the page is still counted exactly once, in `alreadyCurrent`.
- Given `ReconcileResult`, when the change lands, then it still has exactly `total`, `synced`, `stale`, `alreadyCurrent`, `removed`, `errors`, and `maintenance.ts` is unmodified.
- Given `pnpm test`, when the suite runs, then every previously passing silo, raw, lifecycle, and workbench-file test still passes.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[medium]` `[patch]` The delete-side structural-root guard was unobserved: removing the `RAW_STRUCTURAL_DIRS` ternary from `removeSiloForPage` left both assertions of the structural-root test green, because the fixture `otherpage.md` is not a snapshot name and `sources/` is a directory — both land in the `foreign` branch. Seeded a snapshot-named file directly under the shared root (`tenants/alice/raw/sources/beef.md`, an all-hex slug's flat Source mirror) and asserted it survives, plus a second case for a page slugged `assets`. Mutation-checked: dropping the ternary fails both.
  - `[medium]` `[patch]` DW-610's stated harm is visibility in Files, and every DW-610 assertion sat at the storage-key layer, so the comment's load-bearing claim that `listWorkbenchFilePaths` walks the whole silo `raw/` root was unverified — the fix could have shipped fixing nothing. Added a test that asserts the legacy path is absent from `listWorkbenchFilePaths` before the sync and present after; mutation-checked by dropping the legacy `mirrorHashedTree` call.
  - `[low]` `[patch]` `removeHashedTree` fell through to `deleteDirSafe` when the silo directory did not exist at all, so every page delete issued two recursive deletes against absent prefixes — a prefix sweep on R2. Added an empty-listing early return.
  - `[low]` `[patch]` `isRawSnapshotName`'s docblock claimed the export made the mirror and `listRawSourceSnapshots` unable to disagree, but nothing makes the listing call it. Reworded to the one-way adoption that is actually true, naming where the two already differ deliberately.
  - `[low]` `[patch]` Both structural-root comments justified the skip as failing closed "as `rawPathSlug` does for `parsed`" — the opposite mapping (`rawPathSlug` reads the name AS a slug; this skip reads it as a ROOT). Reworded both to the shared principle without claiming one rule.
  - `[low]` `[patch]` `isRawSnapshotName` shipped as new exported API with only indirect coverage. Added direct unit tests in `raw.test.ts`, including `beef.md` as the deliberately-accepted short-hex collision, so a future `RAW_ID_RE` tightening is a visible diff.

## Design Notes

Address-preserving for the legacy root: the mirror copies `raw/<slug>/<hex>.md` to `tenants/<t>/raw/<slug>/<hex>.md`, not into the modern `raw/sources/<slug>/` namespace. That is the convention the legacy flat `raw/<slug>.md` mirror already follows, it keeps the silo a faithful picture of the flat tree for a future flat retirement, and `listWorkbenchFilePaths` walks the whole silo `raw/` root, so visibility in Files does not depend on the modern spelling.

One helper, two roots, cost bound intact:

```ts
async function mirrorHashedTree(flatPrefix: string, siloPrefix: string) {
  const candidates = (await listSafe(flatPrefix)).filter(
    (f) => !f.isDirectory && !f.name.startsWith(".") && isRawSnapshotName(f.name),
  );
  if (candidates.length === 0) return 0;
  const mirrored = new Set((await listSafe(siloPrefix)).map((f) => f.name));
  // …copyAsset each name not in `mirrored`, counting copies.
}
```

Residual, accepted: a folder-import file named like a hash (`beef.md`) is indistinguishable from a snapshot by name alone. It can still be mirrored, and deleted from the silo, with a colliding page — but one file, never a tree, and never a subdirectory.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/silo.test.ts` -- expected: all tests pass, old and new.
- `pnpm vitest run src/lib/__tests__/raw.test.ts src/lib/__tests__/lifecycle.test.ts src/lib/__tests__/workbench-files-unresolved-tenant.test.ts` -- expected: no new failures.
- `npx tsc --noEmit` -- expected: exit 0.
- `pnpm lint` -- expected: clean.
- `pnpm test` -- expected: no failures beyond the pre-existing jsdom `localStorage` ones under `src/components/workbench/__tests__/`; confirm against the baseline if any appear.

## Auto Run Result

Status: done

**Implemented change.** The silo mirror now covers every address a page stores, and only what the page owns. `reconcileSilos` calls `syncSiloForPage` for every page; the wiki-md comparison survives purely as the classifier that picks the `synced`/`stale`/`alreadyCurrent` bucket, so a Source, revision, thread or asset that arrived after the md was mirrored is repairable by a routine reconcile (DW-608). One `mirrorHashedTree` helper serves both hashed roots — the modern `raw/sources/<slug>/` and the legacy `raw/<slug>/`, the latter mirrored address-preservingly into `tenants/<t>/raw/<slug>/` and skipped entirely for a slug naming a structural root under `raw/` (DW-610). "Page-owned" is now one exported predicate, `isRawSnapshotName` — a content-addressed `<hex>.<ext>` — so a folder import sharing `raw/sources/<name>/` with a colliding page slug is neither mirrored into that page's silo nor deleted with it, and removal deletes the page's snapshot files individually instead of recursively deleting a shared directory (DW-611).

**Files changed.**
- `src/lib/raw.ts` -- exported `isRawSnapshotName` and `RAW_STRUCTURAL_DIRS`; hoisted the snapshot extension regex out of `saveRawSourceBytes` so the writer and the predicate cannot disagree.
- `src/lib/silo.ts` -- new `mirrorHashedTree` / `removeHashedTree` helpers, both hashed roots wired into `syncSiloForPage` and `removeSiloForPage` with the structural-root skip, and the unconditional sync in `reconcileSilos` with `ReconcileResult`'s counter docs rewritten to say what they now classify.
- `src/lib/__tests__/silo.test.ts` -- eleven new tests plus an extended listing-cost spy: DW-608 repair under an already-current page, the legacy root (text, binary, address-preserving spelling), Files-tab visibility through `listWorkbenchFilePaths`, the structural-root skip on both the mirror and delete sides (`sources` and `assets`), import files spared by the mirror, foreign entries spared by the delete, and a page-only directory removed at both roots.
- `src/lib/__tests__/raw.test.ts` -- direct unit tests for `isRawSnapshotName`, including the accepted short-hex collision.

**Review findings breakdown.** 6 patches applied (2 medium, 4 low), 1 deferred (low), 15 rejected as noise. No intent gaps and no spec defects; zero repair loopbacks.

**Follow-up review recommendation:** `true`. Patched findings this pass: high 0, medium 2, low 4. Score = 3x2 + 1x4 = 10, which is at or above 5.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/silo.test.ts` -- 29/29 pass.
- `pnpm vitest run` over silo + raw + lifecycle + workbench-files-unresolved-tenant -- 157/157 pass.
- `npx tsc --noEmit` -- exit 0.
- `pnpm lint` -- exit 0 (the three `jsx-ast-utils` notices are pre-existing library warnings, not errors).
- `pnpm test` -- 8779 pass, 1 skipped; the only failure is `src/lib/__tests__/storage-fs.test.ts`'s `reapStrandedScratchFiles` CAP test timing out at 5s under full-suite load, plus its `afterEach` cascade. Confirmed pre-existing: stashing this change and re-running the full suite at baseline `7412875c8d0ba574cfd2610715656c1bf8d17dc8` fails on the same test, and the file passes 95/95 when run alone. `storage-fs.ts` is not touched by this change.
- Matrix test audit: all eight I/O rows have a covering test that ran and passed.

**Residual risks.**
- Accepted by design: `RAW_ID_RE` has no length bound, so a folder-import file named like a short hash (`beef.md`) still classifies as page-owned — mirrored into, and deleted from, a colliding page's silo. Bounded to a single file; never a subdirectory or a tree, which is the harm DW-611 named. Pinned by a test so a future tightening is visible.
- The per-page reconcile cost is the subrequest-budget decision DW-608 flagged, settled here in favour of correctness: every page now pays `syncSiloForPage`'s listings on every reconcile. Affordable because the only production caller is the fail-soft tail of `rebuildDerivedIndexes`, and bounded by the sync's own copy-only-new rule rather than by an opt-out. Reconcile itself still has no whole-run subrequest cap — pre-existing, and unchanged.
- A silo hashed directory left holding only a dotfile survives a page delete, since the delete treats anything the mirror would never have written as foreign. Deliberate, fail-closed.
- The deferred item above: legacy-address mirrors list in the Files tab but not in the Sources pane.
