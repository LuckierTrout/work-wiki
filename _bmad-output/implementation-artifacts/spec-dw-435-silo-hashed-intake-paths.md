---
title: 'DW-435: Silo sync and remove learn the hashed Intake tree'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
baseline_revision: '84519e63c0d5aa480b5b1158a0686058e1bbe551'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `reconcileSilos`' forward pass gates on the wiki md, so a page whose silo
      copy is already current never re-syncs its Sources — flat or hashed.
    evidence: |-
      src/lib/silo.ts:263-281 calls syncSiloForPage only when the silo
      `tenants/<t>/wiki/<slug>.md` is missing or its bytes differ from flat;
      otherwise the page counts as `alreadyCurrent`. lifecycle.ts writes silo
      and flat from the identical `op.content`, so a live page always lands on
      `alreadyCurrent`. A Source added after the page md was mirrored is
      therefore never repaired by reconcile. This predates DW-435 and applies
      identically to the flat `raw/sources/<slug>.md` mirror; widening the gate
      means listing raw sources for every page on every reconcile, which is its
      own subrequest-budget decision.
    location: >-
      src/lib/silo.ts:263
    severity: medium
  - summary: >-
      A normal page delete never routes through `removeSiloForPage`, so silo raw
      artifacts (flat source, hashed tree, discuss, assets) leak on deletion.
    evidence: |-
      lifecycle.ts:618-638 deletes the silo wiki md, the flat wiki md and both
      revision layouts directly; lifecycle.ts:932-936 records that the
      syncSiloForPage/removeSiloForPage mirror was deliberately retired from
      that path. removeSiloForPage's only production caller is the
      reverse-orphan pass (src/lib/silo.ts:311), which discovers ghosts by
      scanning `tenants/<t>/wiki/*.md` — a hard-deleted page's silo md is
      already gone, so its slug never appears. Pre-existing and identical for
      the assets directory and the discuss thread; DW-435's new deleteDirSafe
      inherits the shape rather than introducing it.
    location: >-
      src/lib/lifecycle.ts:618
    severity: medium
  - summary: >-
      The legacy hashed root `raw/<slug>/<rawId>.md` is still never mirrored into
      any silo, so pre-move hashed arrivals stay invisible in Files.
    evidence: |-
      `readRawSourceById` falls back to `rawRelPath(<slug>/<rawId>.md)` and
      `listRawSourceSnapshots` enumerates `rawRelPath("")` as a second root, so
      workspaces written before Sources moved under `raw/sources/` demonstrably
      hold hashed bytes only there. The flat legacy `raw/<slug>.md` IS mirrored
      two lines above for exactly that reason. DW-435's intent names only
      `raw/sources/<slug>/<rawId>.md`, so the widening is out of scope here.
    location: >-
      src/lib/silo.ts:121
    severity: low
  - summary: >-
      `raw/sources/<name>/` is shared by page slugs and folder-import roots;
      nested import content is never mirrored but IS recursively deleted.
    evidence: |-
      `saveRawSourceTree` (src/lib/raw.ts:459) writes `raw/sources/<dir>/<file>`
      at any depth with every segment validateSlug'd, so a folder-import root
      can collide with a page slug. The new sync loop copies top-level files
      only, while `deleteDirSafe` is recursive on both providers
      (filesystem.ts fs.rm recursive; r2.ts prefix sweep). A page slugged the
      same as an import root therefore mirrors that import's top-level files
      into its silo and deletes the whole import tree with the page. The
      namespace ambiguity predates DW-435; this change exercises it.
    location: >-
      src/lib/silo.ts:223
    severity: low
---

<intent-contract>

## Intent

**Problem:** `syncSiloForPage` / `removeSiloForPage` (`src/lib/silo.ts:95-115`, `:166-180`) address only the flat `raw/sources/<slug>.md` and the legacy `raw/<slug>.md`, so hashed Intake arrivals written under `raw/sources/<slug>/<rawId>.<ext>` are never mirrored into the owner's silo and are never removed when the page goes. Because the Workbench resolves `raw/` strictly inside `tenants/<tenant>/raw/` (DW-40), an ingest caller that omits `{ owner }` leaves those arrivals invisible in Files forever, and reverse-orphan cleanup leaves them behind as silo ghosts.

**Approach:** Teach both directions the per-slug hashed tree alongside the flat paths: sync mirrors the not-yet-mirrored entries of `raw/sources/<slug>/` into `tenants/<tenant>/raw/sources/<slug>/`, and remove deletes that silo directory. Keep the existing skip-when-absent shape — a slug with only the flat layout must cost one extra missing-directory listing, not a second write.

## Boundaries & Constraints

**Always:**
- Mirror hashed entries byte-exactly (`copyAsset`), since the tree holds binaries (`.pdf`, `.docx`, `.jpg` from `saveRawSourceBytes`) beside extracted `.md`.
- Treat hashed arrivals as IMMUTABLE: diff against the silo side and copy only entries not already mirrored, matching the revision/asset loops that bound a per-write sync on the Workers subrequest budget.
- Absent hashed tree costs exactly ONE listing: list the flat side first and skip the silo-side listing entirely when it is empty.
- Count every copied hashed entry in the `number` `syncSiloForPage` returns.
- Skip subdirectory entries at the top level of `raw/sources/<slug>/`, exactly as the `raw/assets/<slug>` loop does.
- Removal deletes the silo directory `tenants/<tenant>/raw/sources/<slug>` via `deleteDirSafe`, inside the existing `Promise.all`.

**Block If:** Nothing here needs a human. If `deleteDirectory` turns out not to exist on the storage interface, HALT `blocked` with that as the condition.

**Never:**
- Never touch the FLAT `raw/sources/<slug>/` tree — this is a silo mirror/cleanup change, not a source deleter. Flat hashed bytes are cascade delete's job (`deleteRawSourceBytes`, `src/lib/raw.ts:688`).
- Never add a legacy hashed root (`raw/<slug>/<rawId>.md`) mirror: nothing has ever WRITTEN `tenants/<t>/raw/<slug>/`, so there is no pre-move silo layout to keep answering or to clean up.
- Never change `listRawSources`, `listRawSourceSnapshots`, `mirrorSourceToSilo`, or any ingest caller's `{ owner }` handling.
- Never rewrite an already-mirrored hashed key.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Hashed-only page | `wiki/<slug>.md` + `raw/sources/<slug>/<hex>.md` present; no flat `raw/sources/<slug>.md` | `syncSiloForPage` returns 2; `tenants/<t>/raw/sources/<slug>/<hex>.md` holds the same bytes | No error expected |
| Binary arrival | `raw/sources/<slug>/<hex>.pdf` with non-UTF-8 bytes | Mirrored byte-for-byte via `copyAsset` | No error expected |
| Re-sync | Hashed entry already mirrored | Second sync copies it again 0 times (count excludes it) | No error expected |
| New arrival after sync | A second `<hex2>.md` lands | Next sync copies only the new one | No error expected |
| No hashed tree | Flat-only slug | Count unchanged from today; one `listSafe` on the absent flat prefix, no silo-side listing | `listSafe` answers `[]` on ENOENT |
| Nested folder-import dir | `raw/sources/<slug>/<subdir>/…` | Subdirectory skipped; sibling files still mirrored | No error expected |
| Page removal | Silo holds `tenants/<t>/raw/sources/<slug>/<hex>.md` | `removeSiloForPage` leaves the directory gone | `deleteDirSafe` swallows ENOENT |

</intent-contract>

## Code Map

- `src/lib/silo.ts:91-160` -- `syncSiloForPage`. Flat raw copies at `:99-115`; the immutable-diff pattern to copy is the revisions loop `:123-136` and the assets loop `:148-159`. Insert the hashed block after the flat raw copies.
- `src/lib/silo.ts:166-180` -- `removeSiloForPage`. Add one `deleteDirSafe` to the existing `Promise.all`.
- `src/lib/silo.ts:36-80` -- helpers already in file: `copyText`, `copyAsset`, `listSafe`, `deleteSafe`, `deleteDirSafe`. Reuse; add none.
- `src/lib/raw.ts:72-84` -- `rawSourceRelPath` / `tenantRawSourceRelPath`: the exact flat and silo spellings for `raw/sources/<rest>` and `tenants/<t>/raw/sources/<rest>`. Already imported by `silo.ts:32`.
- `src/lib/raw.ts:296-320,432-452` -- `saveRawSourceBytes` / `saveRawSourceFor`: the writers that produce `<slug>/<rawId>.<ext>` and `<slug>/<rawId>.md`. Confirms both binary and text live in one tree.
- `src/lib/raw.ts:455-490` -- `saveRawSourceTree`: folder-import writes `raw/sources/<dir>/<file>` and can nest deeper — the reason the loop skips directories.
- `src/lib/raw.ts:86-99` -- `SaveRawSourceOptions.owner` docblock: states ingest callers leave `owner` unset and rely on `syncSiloForPage`. READ-ONLY evidence for the gap.
- `src/lib/storage/types.ts:87-94,199,236` -- `FileEntry { name, isDirectory }`, `listFiles(prefix)`, `deleteDirectory(path)`. All exist; no interface change.
- `src/lib/__tests__/silo.test.ts:62-111` -- the Story 2.1 flat-source test is the template for the new hashed test (real filesystem storage, `getStorage().writeFile`).
- READ-ONLY: `src/lib/source-cascade.ts:279` + `src/lib/raw.ts:685-706` -- Story 2.10's cascade delete already removes flat + silo hashed bytes for a SINGLE source. Page-level removal is still missing, which is what this fixes. Do not modify.

## Tasks & Acceptance

**Execution:**
- `src/lib/silo.ts` -- in `syncSiloForPage`, after the flat `raw/sources/<slug>.md` and legacy `raw/<slug>.md` copies, list `rawSourceRelPath(slug)`; if non-empty, build a `Set` of names already under `tenantRawSourceRelPath(tenant, slug)` and `copyAsset` each non-directory, not-yet-mirrored entry into the silo, incrementing `n` per copy -- mirrors hashed Intake arrivals for ingest callers that omit `{ owner }`, without re-copying immutable keys or paying a silo listing for flat-only slugs.
- `src/lib/silo.ts` -- in `removeSiloForPage`, add `deleteDirSafe(tenantRawSourceRelPath(tenant, slug))` to the existing `Promise.all` -- a deleted page must not leave hashed Sources in the silo for reverse-orphan cleanup to trip over.
- `src/lib/silo.ts` -- extend the flat-paths comment block to name the hashed tree and why it is copy-only-new -- the file's existing convention is to record why each address is mirrored.
- `src/lib/__tests__/silo.test.ts` -- add tests covering the I/O matrix: hashed-only page mirrors and counts, binary bytes survive byte-exactly, re-sync copies nothing, a newly added hex entry is picked up, subdirectories are skipped, a flat-only slug's count is unchanged, and `removeSiloForPage` clears the hashed silo directory -- pins both directions on a page that has hashed sources only.

**Acceptance Criteria:**
- Given a page whose only Source is `raw/sources/<slug>/<hex>.md`, when `syncSiloForPage(slug, tenant)` runs, then `tenants/<tenant>/raw/sources/<slug>/<hex>.md` holds identical bytes and the returned count includes it.
- Given that same page, when `removeSiloForPage(slug, tenant)` runs, then no key remains under `tenants/<tenant>/raw/sources/<slug>/`.
- Given a slug with no hashed tree, when `syncSiloForPage` runs, then the returned count is exactly what it was before this change.
- Given `pnpm test`, when the suite runs, then every previously passing silo, raw, and lifecycle test still passes.

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 4: (high 0, medium 2, low 2)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[low]` `[patch]` The flat-only test asserted only the copy count, so the "no silo-side listing" half of the cost constraint had no guard — added a `vi.spyOn(getStorage(), "listFiles")` assertion pinning that `raw/sources/<slug>` is listed exactly once and the silo prefix never; mutation-checked by hoisting the silo listing, which fails the new test.
  - `[low]` `[patch]` The realistic mixed layout (a slug written both flat and hashed by `ingest()`) was untested — added a test asserting the count is 3 and both silo keys hold their bytes.
  - `[low]` `[patch]` The loop mirrored every non-directory entry, so a stray dotfile would become Workbench-visible — added a `f.name.startsWith(".")` skip matching `listRawSources`/`listRawSourceSnapshots`, plus a `.DS_Store` test.
  - `[low]` `[patch]` The comment justified skipping the legacy hashed root by arguing the DESTINATION was never written, which is not why the legacy flat path is mirrored — rewrote it to state that `raw/<slug>/<rawId>.md` is a real source location deliberately left out of DW-435's scope.
  - `[low]` `[patch]` `deleteRawSourceBytes`' docblock claimed `removeSiloForPage` does not know the hashed address, which this change made false — rewrote it to contrast per-source (flat + silo) against per-page (silo directory).
  - `[low]` `[patch]` The comment implied the mirrored-name Set provided the immutability guarantee — clarified that it is a cost bound, that `copyAsset` ends in an unconditional `writeAsset` unlike the create-only doors in `raw.ts`, and that content-addressing is what makes the open window safe.

## Design Notes

`copyAsset`, not `copyText`, for the hashed tree: `saveRawSourceBytes` publishes PDFs/DOCX/JPEGs into the same `<slug>/<rawId>.<ext>` namespace as the extracted `.md`, and round-tripping those through a UTF-8 string would mangle them — the same reason `storeRawSourceBytes` uses `writeAssetIfAbsent`. On the filesystem and R2 providers a `.md` read as bytes is identical to reading it as text, so one door serves both.

Listing order matters for the cost constraint. Flat side first:

```ts
const hashed = await listSafe(rawSourceRelPath(slug));
if (hashed.length > 0) {
  const mirrored = new Set(
    (await listSafe(tenantRawSourceRelPath(tenant, slug))).map((f) => f.name),
  );
  for (const f of hashed) {
    if (f.isDirectory || mirrored.has(f.name)) continue;
    if (await copyAsset(/* flat */, /* silo */)) n++;
  }
}
```

A flat-only slug pays one listing on an absent prefix and stops.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/silo.test.ts` -- expected: all tests pass, including the new hashed-tree cases.
- `pnpm test` -- expected: no new failures anywhere in the suite.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** `syncSiloForPage` and `removeSiloForPage` now know Workbench Intake's per-slug hashed tree `raw/sources/<slug>/<rawId>.<ext>`, not just the flat `raw/sources/<slug>.md` and legacy `raw/<slug>.md`. Sync lists the flat side first and, only when it is non-empty, lists the silo side to build a mirrored-name set and `copyAsset`s each not-yet-mirrored, non-directory, non-dotfile entry into `tenants/<tenant>/raw/sources/<slug>/`, counting each copy. Remove adds one `deleteDirSafe` on that silo directory inside the existing `Promise.all`. A slug with only the flat layout pays exactly one listing on an absent prefix and stops.

**Files changed.**
- `src/lib/silo.ts` -- hashed-tree mirror block in `syncSiloForPage`; `deleteDirSafe(tenantRawSourceRelPath(tenant, slug))` in `removeSiloForPage`; comments recording the copy-only-new bound, the `copyAsset` choice, the listing order, and the deliberate exclusion of the legacy hashed root.
- `src/lib/raw.ts` -- corrected `deleteRawSourceBytes`' docblock, which claimed `removeSiloForPage` does not know the hashed address.
- `src/lib/__tests__/silo.test.ts` -- nine new tests covering every I/O matrix row plus the mixed-layout, dotfile, and listing-order cases.

**Review findings breakdown.** 6 patches applied (all low severity), 4 items deferred (2 medium, 2 low), 10 rejected as noise. No intent gaps and no spec defects; zero repair loopbacks.

**Follow-up review recommendation:** `true`. Patched findings this pass: high 0, medium 0, low 6. Score = 3x0 + 1x6 = 6, which is at or above 5.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/silo.test.ts` -- 20/20 pass.
- `pnpm vitest run src/lib/__tests__/raw.test.ts src/lib/__tests__/lifecycle.test.ts` -- 121/121 pass (carries the Story 2.10 cascade-delete cases).
- `npx tsc --noEmit` -- exit 0.
- `pnpm lint` -- exit 0 (the three `jsx-ast-utils` notices are pre-existing library warnings, not errors).
- `pnpm test` -- 233 failures across 13 files under `src/components/workbench/__tests__/`, all `window.localStorage` being undefined in jsdom. Confirmed pre-existing: stashing this change and running `workbench-split-wiring.test.tsx` at baseline `84519e63c0d5aa480b5b1158a0686058e1bbe551` fails identically (29/29). No new failures.
- Matrix test audit: all seven I/O rows have a covering test that ran and passed.

**Residual risks.** The four deferred items above, chiefly that `reconcileSilos` only reaches the new mirror when a page's silo md is missing or stale, so existing pages with unmirrored hashed arrivals are repaired by `migrateToTenants` but not by a routine reconcile. The full suite is not green on this branch for the unrelated jsdom `localStorage` reason recorded above.
