---
title: 'DW-491/493/494 — Workbench raw read gate covers the assets subtree, and says what it means'
type: 'bugfix'
created: '2026-08-28'
status: 'done'
baseline_revision: 'cccbb27a73813a25064a290edfd58861bdc1fccb'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `/api/assets/[...path]` gates only on `visibility: private`, so the assets of a page
      the Knowledge tab hides for any OTHER reason are still served to anyone, unauthenticated.
    evidence: |-
      DW-491 closed the disclosure at the Workbench doors (`listWorkbenchFilePaths`,
      `readWorkbenchFile`, `readWorkbenchFileBytes`, `/api/workbench/media`), which all route
      through `rawPathAllowed`. `/api/assets/[...path]` reads the SAME bytes out of the same
      `raw/assets/<slug>/<file>` tree (route.ts:83, `rawRelPath("assets/" + segments.join("/"))`)
      and its only gate is `page.frontmatter.visibility === "private"` (route.ts:73-79).
      `hiddenSlugs` is broader than that: `workbenchSlugGate` refuses every slug the
      principal's index named that `buildKnowledgeTree` dropped — agent-scoped types and
      artifacts included, none of which need `visibility: private`. So after this change the
      Files tab withholds `raw/assets/agentpage/pic.png` while a plain
      `GET /api/assets/agentpage/pic.png` still returns the bytes. Pre-existing: that route's
      gate predates DW-491 and was not touched here. Whether the two gates SHOULD agree is a
      product decision — `/api/assets/` is deliberately no-auth so public pages skip principal
      resolution entirely — which is why this is recorded rather than patched.
    location: >-
      src/app/api/assets/[...path]/route.ts:73
    severity: medium
  - summary: >-
      The v1 rescan ROUTE's `v1SlugGate` -> `hiddenSlugs` wiring is still unpinned; DW-493
      pinned the forward inside `rescanSources`, one level below the door.
    evidence: |-
      DW-493's new case calls `rescanSources` directly and does pin the forward at
      src/lib/source-rescan.ts:126 (verified: replacing it with `new Set()` fails exactly that
      case and nothing else). What remains untested is the route that a real caller hits:
      `POST /api/v1/projects/[wikiId]/sources/rescan` derives the gate with
      `v1SlugGate(caller.principal)` and spreads it into the call (route.ts:82-88). Nothing
      asserts that derivation yields a NON-EMPTY `hiddenSlugs` for a hidden page, or how it
      composes with the route's own `!path.startsWith("raw/sources/")` -> 403 scope check —
      because `src/lib/__tests__/epic8-v1-routes.test.ts:54` mocks `@/lib/source-rescan`
      wholesale, so no test in the suite drives the real function through the POST door.
      Pre-existing: that mock and that wiring predate this change.
    location: >-
      src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts:82
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Three parity holes the 2026-08-27 review triaged `patch` but never applied. (1) `rawPathSlug` reads only the first segment under `raw/` after dropping `sources`, so the silo-mirrored `raw/assets/<slug>/<file>` tree derives the slug `assets` and `rawPathAllowed` admits it — the directory row `raw/assets/<hidden>/` still announces a page the Knowledge tab hides, which is exactly the disclosure DW-32 exists to stop. (2) `rescanSources`' forward of `hiddenSlugs` into `readWorkbenchFile` is the ONLY gate on the explicit-`paths` branch, and every call site in the suite passes an empty set, so replacing it with `new Set()` leaves the suite green. (3) `frontmatterOf`'s docblock and two comments in `workbench-preview.test.ts` claim the 403 they produce for an UNPARSEABLE frontmatter block is "the same answer `PUT /api/wiki/[slug]` gives"; that route lets `readWikiPageWithFrontmatter`'s throw reach its outer catch and answers 500.

**Approach:** Drop a leading `assets` segment under `raw/` exactly the way `sources` is dropped — introducing `RAW_ASSETS_DIR` in `raw.ts` so the gate and the two writers of that tree name one constant — and update the docblock that currently asserts the opposite. Add a `rescanSources` case with a non-empty `hiddenSlugs` that POSTs a hidden page's raw path and asserts refusal, plus a not-hidden control so the assertion pins the forward rather than the absence of bytes. Correct the three prose claims to say what the parity actually is: it holds for EMPTY metadata, not for the unparseable case.

## Boundaries & Constraints

**Always:** The `assets` drop is EXCLUSIVE with the `sources` drop — one structural root is consumed, never two — so a page genuinely slugged `assets` keeps deriving `assets` from `raw/sources/assets/<sha>.md` and from the legacy flat `raw/assets.md`. Every other first segment stays read as a slug (`raw/parsed/…` still derives `parsed`), which is the fail-CLOSED direction the existing docblock argues for and must keep arguing for. New tests assert refusal at every door DW-32 names (leaf, directory row, bytes), not just one.

**Block If:** Nothing here requires a human decision; the intent names the fix for each entry.

**Never:** Do not touch the deferred-work ledger or the source spec `spec-dw-32-42-workbench-read-write-gate-parity.md`. Do not change `frontmatterOf`'s BEHAVIOR — DW-494 is a documentation defect only; the catch and the `{}` it yields stay. Do not widen `rescanSources`' signature or add a gate it does not already have; DW-493 is test coverage for an existing forward.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Hidden page's asset | `rawPathSlug("raw/assets/agentpage/pic.png")` | `"agentpage"` | No error expected |
| Hidden page's asset, every door | `raw/assets/agentpage/pic.png` in the silo, `hiddenSlugs: {"agentpage"}` | absent from `listWorkbenchFilePaths` (leaf AND the `raw/assets/agentpage/` row), `readWorkbenchFile`/`readWorkbenchFileBytes` `null`, `workbenchFileExists` false, `truncated` false | Same `null` as an absent path — no oracle |
| Page slugged `assets` | `rawPathSlug("raw/sources/assets/ab12.md")`, `rawPathSlug("raw/assets.md")` | `"assets"` both — the `sources` drop already consumed the structural root, and the legacy flat name is not one | No error expected |
| Assets structural rows | `rawPathSlug("raw/assets")`, `rawPathSlug("raw/assets/")` | `null` — nothing spelled, nothing to disclose | No error expected |
| Non-page asset subtree | `rawPathSlug("raw/assets/illustrations/k.jpg")` | `"illustrations"` — conservative, same direction as `parsed` | No error expected |
| Rescan of a hidden path | `rescanSources({ paths: ["raw/sources/hidden-note.md"], hiddenSlugs: {"hidden-note"} })` after `saveRawSource("hidden-note", …)` | one outcome `{ queued: false, reason: "not_found" }`; no ingest job created | Refusal, not a throw |
| Rescan control | same path, `hiddenSlugs: {"someone-else"}` | `queued: true` | No error expected |

</intent-contract>

## Code Map

- `src/lib/raw.ts:30` -- `RAW_SOURCES_DIR = "sources"` and `RAW_PARSED_DIR = "parsed"` sit here with docblocks naming each as a structural root under `raw/`. `assets` has no constant; add `RAW_ASSETS_DIR` beside them.
- `src/lib/workbench-files.ts:165-212` -- `rawPathSlug`'s docblock currently states "`raw/assets/…` derives `assets` — deliberately conservative"; that sentence is the claim DW-491 falsifies. The drop is the ternary at :202-203 (`segments[1] === RAW_SOURCES_DIR ? slice(2) : slice(1)`).
- `src/lib/workbench-files.ts:232-239` -- `rawPathAllowed`, the single predicate; unchanged.
- `src/lib/workbench-files.ts:521, 690, 942` -- the three consumers (listing filter, rescan listing, `resolveWorkbenchFile`) all route through `rawPathAllowed`, so one `rawPathSlug` fix covers leaf, directory and bytes.
- `src/lib/silo.ts:148, 177` -- `assets/${slug}` built for the mirror and the delete; this is the writer that puts a page slug in the second segment.
- `src/lib/document-sources.ts:164` -- `rawRelPath("assets/${slug}/${storedName}")`, the original writer of those bytes.
- `src/lib/source-rescan.ts:113-126` -- the explicit-`paths` branch skips the listing entirely; `hiddenSlugs: input.hiddenSlugs` inside the `readWorkbenchFile` call at :126 is its only gate.
- `src/lib/__tests__/workbench-tree.test.ts:497-520` -- the `rawPathSlug` unit table. `writeSilo("raw", …)` (defined ~:615) and `hiding(...)` (:602) are the fixtures; the DW-32 rows sit at ~:1260-1300.
- `src/lib/__tests__/epic8-remediation.test.ts:1893-2125` -- the `rescanSources` cases. "abandons a job when enqueue throws after create" (:1919) is the closest template: tmp `DATA_DIR`, `_resetStorage`/`_resetLocks`, `saveRawSource(..., { owner: "alice" })`, `listIngestJobs`.
- `src/app/api/workbench/preview/route.ts:101-114` -- `frontmatterOf`'s docblock; the false sentence is "the same answer `PUT /api/wiki/[slug]` gives for the same unparseable file".
- `src/lib/__tests__/workbench-preview.test.ts:2107-2136` -- the two comments; the `bare.md` case (parity TRUE) and the `broken.md` case (parity FALSE).
- `src/app/api/wiki/[slug]/route.ts:203, 336` -- read-only evidence for the 500: the strict `readWikiPageWithFrontmatter` throws past the ACL check into the outer catch, whose classifier answers 400 only for `invalid slug`.

## Tasks & Acceptance

**Execution:**
- `src/lib/raw.ts` -- export `RAW_ASSETS_DIR = "assets"` beside `RAW_SOURCES_DIR`/`RAW_PARSED_DIR`, with a docblock naming it the structural root of the per-page binary tree that `syncSiloForPage` mirrors -- so the gate and the writers stop spelling the same root as three literals.
- `src/lib/workbench-files.ts` -- drop a leading `assets` segment in `rawPathSlug` exactly as `sources` is dropped, exclusively (one root consumed, not two), and rewrite the docblock paragraph that claims `raw/assets/…` derives `assets` to state the real rule and why `parsed` still does -- DW-491.
- `src/lib/silo.ts`, `src/lib/document-sources.ts` -- build the `assets/…` prefix from `RAW_ASSETS_DIR` -- one spelling shared by reader and writer.
- `src/lib/__tests__/workbench-tree.test.ts` -- extend the `rawPathSlug` table with the assets rows from the I/O matrix, and add a DW-491 row asserting a hidden page's `raw/assets/<slug>/<file>` is withheld as leaf, as directory row and as bytes -- the walk is where the disclosure was visible.
- `src/lib/__tests__/epic8-remediation.test.ts` -- add the rescan refusal case plus its not-hidden control -- DW-493; without the control the case would pass for bytes that were never written.
- `src/app/api/workbench/preview/route.ts` -- correct `frontmatterOf`'s docblock: parity with `PUT /api/wiki/[slug]` holds for EMPTY metadata (that route parses `{}` and refuses the same principals); for an UNPARSEABLE block that route answers 500, and this route deliberately does NOT -- DW-494.
- `src/lib/__tests__/workbench-preview.test.ts` -- correct the two comments the same way; the `bare.md` comment keeps the parity claim scoped to empty metadata, the `broken.md` comment states the divergence -- DW-494.

**Acceptance Criteria:**
- Given a hidden page with a mirrored binary asset, when the Files tab lists the tree, then no path containing the hidden slug appears and `truncated` is false.
- Given a page slugged `assets`, when its source and legacy flat paths are resolved, then the derived slug is still `assets` and the page's own subtree stays reachable.
- Given `hiddenSlugs: input.hiddenSlugs` at `src/lib/source-rescan.ts:126` is replaced with `new Set()`, when the suite runs, then the new rescan case fails.
- Given the corrected prose, when a reader compares it to `src/app/api/wiki/[slug]/route.ts`, then no comment claims a 403/500 parity that route does not give.

## Design Notes

The drop must be a single choice over one head segment, not two sequential drops:

```ts
const head = segments[1];
const rest =
  head === RAW_SOURCES_DIR || head === RAW_ASSETS_DIR
    ? segments.slice(2)
    : segments.slice(1);
```

Sequential drops would eat both roots and turn `raw/sources/assets/ab12.md` — a real page slugged `assets` — into the slug `ab12`, silently unhiding it. `queries/<leaf>` still works after the drop: `raw/assets/queries/leaf/pic.png` leaves `["queries","leaf","pic.png"]`, which the existing `queries` branch reads as `queries/leaf`.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/epic8-remediation.test.ts src/lib/__tests__/workbench-preview.test.ts` -- expected: all pass.
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Closed the three read-gate parity holes DW-491/493/494 named. `rawPathSlug` now treats `assets`
as a structural root under `raw/` and reads the PAGE SLUG beneath it, so the silo-mirrored
`raw/assets/<slug>/<file>` tree finally goes through `rawPathAllowed` — the directory row
`raw/assets/<hidden>/` no longer announces a page the Knowledge tab hides. The drop is
exclusive with the `sources` drop and carries one documented exception (`isLegacyAssetsLeaf`)
so the pre-`sources` residue of a page genuinely slugged `assets` keeps deriving `assets`.
`rescanSources`' `hiddenSlugs` forward — the only gate on its explicit-`paths` branch — is now
pinned by a test with a non-empty refusal set and a not-hidden control. The three prose claims
of parity with `PUT /api/wiki/[slug]` for an UNPARSEABLE frontmatter block are corrected: that
parity holds for EMPTY metadata; for an unparseable block that route answers 500, and a new
route test pins it so the claim cannot drift again.

### Files changed

- `src/lib/raw.ts` -- new `RAW_ASSETS_DIR`, the storage-root spelling shared by the silo mirror and the Workbench read gate.
- `src/lib/workbench-files.ts` -- `rawPathSlug` drops the `assets` head (with the legacy-leaf exception); docblocks corrected at the function, the summary and the module header.
- `src/lib/workbench-tree.ts` -- `workbenchSlugGate` docblock names the assets tree among what `hiddenSlugs` protects.
- `src/lib/silo.ts`, `src/lib/document-sources.ts` -- build the `assets/…` storage prefix from the constant.
- `src/app/api/workbench/preview/route.ts` -- `frontmatterOf` docblock: parity scoped to empty metadata, divergence and the read-only ordering stated.
- `src/lib/__tests__/workbench-tree.test.ts` -- `rawPathSlug` assets table, the legacy-leaf case, and two walk/door cases (hidden page's mirrored assets; hidden page slugged `assets`).
- `src/lib/__tests__/epic8-remediation.test.ts` -- rescan refusal for both the flat and sharded hidden shapes, plus the not-hidden control.
- `src/lib/__tests__/wiki-routes.test.ts` -- PUT answers 500 on unparseable stored frontmatter (the DW-494 guard).
- `src/lib/__tests__/workbench-preview.test.ts` -- the two comments corrected.

### Review findings

- Patches applied: 10 (medium 1, low 9).
- Deferred: 2 (both medium) — `/api/assets/` gates only on `visibility: private`; the v1 rescan route's own gate derivation is unpinned.
- Rejected: 7 (all low) — a media-route door test (`readWorkbenchFileBytes` is that route's only reach and is covered); a duplicate ledger entry for DW-492 (already open, root cause identical, noted in a code comment instead); using the file's `hiding()` fixture (the case needs a readable control slug, and the adjacent DW-32 case hand-rolls the same shape); an all-children-hidden assets-root case; dropping `raw/parsed/` too (contradicts the intent, and that tree is written only to the flat non-silo key); the mutation check missing from the Verification commands (it was run — see below); the spec's `deferred`/`followup` bookkeeping (set at finalize).

### Follow-up review recommendation

`true`. Patched counts: high 0, medium 1, low 9. Score = 3x1 + 9 = 12, which is >= 5.

### Verification performed

- `pnpm exec vitest run` on `workbench-tree`, `epic8-remediation`, `workbench-preview`, `wiki-routes`: 459 passed, 0 failed.
- `pnpm exec tsc --noEmit`: exit 0. `pnpm lint`: exit 0.
- Full suite: 323 files passed, 13 failed. Every failure is a `|dom|` component file dying at `window.localStorage.clear()`; confirmed pre-existing by stashing this change and re-running `icon-rail.test.tsx` / `preview-announcements.test.tsx` on the baseline commit, which fail identically (53/53). No non-dom failure.
- Mutation checks, all three restored and re-verified green afterwards:
  - `hiddenSlugs: input.hiddenSlugs` -> `new Set()` at `src/lib/source-rescan.ts:126` fails EXACTLY the new rescan case (1 of 72) — acceptance criterion 3, run rather than assumed.
  - Removing the `assets` half of the drop fails 3 `workbench-tree` cases.
  - Making the `assets` drop unconditional (reproducing the patched regression) fails 2, including the legacy-leaf door case. Both directions of the rule are pinned.
- I/O matrix audit: every row of the matrix is covered by an assertion that ran and passed — the six `rawPathSlug` rows and the every-door row in `workbench-tree.test.ts`, the two rescan rows in `epic8-remediation.test.ts`.

### Residual risks

- The two deferred items above are the real ones: the disclosure is closed at the Workbench doors but not at `/api/assets/`, and the v1 rescan route's own gate derivation remains untested.
- `RAW_ASSETS_DIR` binds three of the sites that touch `raw/assets/…`; five others still spell the literal because that string doubles as the markdown-facing and exported-vault ref namespace. The docblock now says so rather than claiming otherwise, but the two namespaces could still drift apart.
- `isLegacyAssetsLeaf` reads a file extension to tell a legacy source from a per-page directory. It is sound while `validateSlug` forbids dots in slugs; loosening that rule would silently break the discriminator.
