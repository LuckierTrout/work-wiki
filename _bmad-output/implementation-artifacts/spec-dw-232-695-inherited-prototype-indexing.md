---
title: 'DW-232 + DW-695: close inherited-prototype indexing at the map construction sites'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      extractPptx accepts any archive entry as a slide, so a crafted
      presentation rel aimed at a real non-slide part (an image, docProps)
      passes the existence filter, makes `ordered` non-empty and silently
      replaces the deck's real slides.
    evidence: |-
      src/lib/document-extract.ts:605 filters the presentation-order list with
      `Boolean(files[slide.path])` only — it never checks that the resolved path
      is a slide part. `resolveArchiveTarget("ppt/presentation.xml",
      "media/photo.jpg")` yields `ppt/media/photo.jpg`, a key the archive really
      holds, so the bogus entry survives, `ordered.length` is non-zero and it
      overrides `fallbackSlides`. The deck's readable
      `ppt/slides/slideN.xml` parts are then never extracted and the image bytes
      are decoded as slide XML, producing an empty section instead. Reachable
      through the live ZIP door (`extractDocumentTextAsync`'s zip branch), and
      distinct from the inherited-prototype defect this bundle closed: it is
      path confusion, not prototype indexing, and a null-prototype archive does
      not address it. A `/^ppt\/slides\/slide\d+\.xml$/i` test on
      `slide.path` alongside the existence check is the shape of the fix.
    location: >-
      src/lib/document-extract.ts:605
    severity: low
baseline_revision: '084124edd4a27614028dd6c6c3d23aa3511b10da'
---

<intent-contract>

## Intent

**Problem:** Two plain object literals are still indexed with content- or attacker-supplied keys, so an inherited `Object.prototype` member answers instead of a miss. `tenantForSlug` (`src/lib/wiki.ts:126`) indexes both the page-metadata index and the slug→tenant map, so a page slugified to `constructor` short-circuits the fast path or returns a *function* as a tenant (DW-232 — inert today, test-only callers). `extractPptx` (`src/lib/document-extract.ts:595,602`) indexes the unzipped archive with a relationship-derived path, so a crafted PPTX whose `Target="../constructor"` resolves to the bare key `constructor` keeps a bogus slide, overrides the deck's real fallback slides, and throws an uncaught `TypeError` — not a `ClientInputError` — so the ingest door answers 500 instead of the promised 400 and the readable `ppt/slides/slide1.xml` is never extracted (DW-695).

**Approach:** Fix at the map CONSTRUCTION sites, not at each lookup: build the slug→tenant maps, the page-metadata index, and the unzipped Office archive with a null prototype, so every existing `map[key]` read answers `undefined` for a non-entry. Pin both with tests, including the crafted-PPTX fixture three reviewers reproduced.

## Boundaries & Constraints

**Always:**
- Every changed map keeps its existing TypeScript type (`Record<string, …>`), its own entries, and its JSON serialization (`JSON.stringify` and `NextResponse.json` are prototype-agnostic).
- The PPTX fix must leave the readable `ppt/slides/slideN.xml` fallback slides in place when the presentation-order list resolves to nothing.
- A crafted archive that yields no slides at all must still exit through `ClientInputError` (the 400 door), never a `TypeError`.

**Block If:** A construction site cannot be made null-prototype without changing an existing consumer's behavior — e.g. a consumer that calls `map.hasOwnProperty(...)` on it, or one that passes it across a React Server→Client component boundary today (React rejects null prototypes in the RSC payload).

**Never:**
- Do not add per-lookup `ownLookup`/`hasOwnProperty` guards at the sites this spec fixes at construction. The existing `ownLookup` calls in `document-extract.ts` stay exactly as they are.
- Do not change `resolveSlugPath` (`src/lib/links.ts:220`), `useSlugTenants`, or the client-side JSON-parsed map — already guarded, wrong layer for this fix.
- Do not add an HTTP route test. Every HTTP door diverts a bare `.pptx` to the sidecar (see Design Notes); the live Worker-side path is the library contract, and that is where the fixture belongs.
- Do not touch `deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Crafted PPTX, real slide present | `Target="../constructor"` in `ppt/_rels/presentation.xml.rels`, plus `ppt/slides/slide1.xml` | slide1's text is extracted — fallback slides survive | No error expected |
| Crafted PPTX, no readable slide part | same crafted rels, no `ppt/slides/slideN.xml` | `ClientInputError("The PPTX file has no slides.")` → the 400 door | ClientInputError, never TypeError |
| ZIP wrapping a crafted PPTX | `.zip` containing the crafted deck (the live Worker-side door) | nested deck's real slide text appears in the ZIP sections | No TypeError escapes `extractDocumentTextAsync` |
| Normal PPTX | existing `deck.pptx` fixture | unchanged: presentation order, speaker notes, assets | No error expected |
| `tenantForSlug("constructor")`, slug absent from a seeded index | page-metadata index from `getPageIndex()` | fast path records a miss, slow path resolves the real tenant | No error expected |
| `buildSlugTenantMap()` read for an absent slug | any slug naming an `Object.prototype` member | `undefined` → `DEFAULT_TENANT` | No error expected |

</intent-contract>

## Code Map

- `src/lib/wiki.ts:115-136` -- `buildSlugTenantMap` builds `const map: Record<string,string> = {}` (construction site); `tenantForSlug` reads `pageIdx[slug]` (:130) and `map[slug] ?? tenantForOwner(undefined)` (:136). The truthy inherited `constructor` at :130 is what wrongly suppresses the slow path.
- `src/lib/page-index.ts:136-158` -- `getPageIndex()` is the ONLY production supplier of `pageIdx`; it returns `JSON.parse(...)` or the legacy `getStorage().getIndex(...)`, both plain objects. Null-prototype it here and `wiki.ts:130`, `:312` (`wikiPageExists`) and `:470` (`readWikiPage`) all stop reading inherited members. Consumers only index / `in` / `delete` / `JSON.stringify` it (`src/mcp.ts:1172`, `src/lib/vault-explorer.ts:150`, `page-index.ts:169-195`) — no `hasOwnProperty` call on it anywhere, and both storage backends persist it as JSON (`src/lib/storage/filesystem.ts:824`, `src/lib/storage/r2.ts:297`).
- `src/app/api/wiki/routes/route.ts:17-19` -- second slug→tenant construction site; result goes straight to `NextResponse.json(map)`.
- `src/app/wiki/log/page.tsx:37-44` -- third construction site, the readability-gated `slugTenants` literal. Keep its header comment (lines 21-36) intact — it explains why the map is gated and why it is server-only today.
- `src/components/MarkdownRenderer.tsx:1-11` -- confirmed no `"use client"`; `ArticleView.tsx:162,455` passes `buildSlugTenantMap()`'s result to it server-side, so no RSC boundary is crossed today.
- `src/lib/links.ts:220-229` -- `resolveSlugPath`, the DW-89 own-property guard. Read-only reference for the idiom; do not change.
- `src/lib/document-extract.ts:403-448` -- `openOfficeArchive` returns `unzipSync(...)` directly: the archive construction site shared by docx/pptx/xlsx/epub/odt.
- `src/lib/document-extract.ts:576-602` -- `extractPptx`: `.filter((slide) => Boolean(files[slide.path]))` (:595) and `const bytes = files[path]` (:602), where `path` comes from `relationshipMap` → `resolveArchiveTarget` (:551-573) over an uploaded `Target`.
- `src/lib/document-extract.ts:452-470` -- `assetFromArchive` already uses `ownLookup(files, target)` (the DW-365 fix) with a comment naming this exact hazard; leave it.
- `src/lib/document-extract.ts:957-996` -- the ZIP branch of `extractDocumentTextAsync` recurses into a nested `.pptx` and rethrows anything that is not a "no extractable text layer" `ClientInputError`. This is the live Worker-side route to `extractPptx`.
- `src/lib/document-formats.ts:160-162` -- `ownLookup`, the existing own-property helper.
- `src/app/api/ingest/document/route.ts:108-137,193-198` -- office formats are diverted to `enqueueExtract` (`intakeRequiresExtract`, `src/lib/workbench-intake.ts:87-96,247`); `ClientInputError` → 400, everything else → 500. Read-only evidence.
- `src/lib/__tests__/document-extract.test.ts:10-22,175-207` -- the `office(filename, files)` zip helper and the existing PPTX + `prototype-named.pptx` fixtures to model the new ones on; `:286-289` shows the raw `zipSync` idiom for a `.zip` fixture.
- `src/lib/__tests__/tenant-paths.test.ts:14-20,108-152` -- the `tenantForSlug` suite; it MOCKS `../page-index`, so the mock must mirror the null-prototype contract for the new fall-through case to mean anything.
- `src/lib/__tests__/page-index.test.ts:24-66` -- real-storage tmpdir harness (`rebuildPageIndex` seeds); the right place to pin `getPageIndex`'s construction contract.

## Tasks & Acceptance

**Execution:**
- `src/lib/document-extract.ts` -- return the unzipped archive from `openOfficeArchive` as a null-prototype map (`Object.assign(Object.create(null), unzipSync(...))`), with a short comment naming the relationship-derived-key hazard and pointing at `extractPptx` -- closes DW-695 at the construction site so no `files[path]` read in this file can answer with an inherited member, for any format.
- `src/lib/__tests__/document-extract.test.ts` -- add the three crafted-archive cases from the I/O matrix: the crafted deck with a real slide (real slide text extracted, no throw), the same crafted rels with no readable slide part (`toThrow(/no slides/i)`), and a `.zip` wrapping the crafted deck through `extractDocumentTextAsync` -- pins the fixture three reviewers reproduced, the 400 door, and the live Worker-side path.
- `src/lib/page-index.ts` -- have `getPageIndex()` return a null-prototype map on both the `JSON.parse` and the legacy `getIndex` branches, keeping the existing `typeof idx !== "object"` presence check and the `PageMetaIndex` type -- fixes the `pageIdx[slug]` leg of DW-232 for `tenantForSlug`, `wikiPageExists` and `readWikiPage` at once.
- `src/lib/wiki.ts` -- build `buildSlugTenantMap`'s map with `Object.create(null)` -- fixes the slow-path leg of DW-232.
- `src/app/api/wiki/routes/route.ts` -- build the response map with `Object.create(null)` -- second construction site; the response JSON is byte-identical.
- `src/app/wiki/log/page.tsx` -- build the gated `slugTenants` literal with `Object.create(null)` -- third construction site.
- `src/lib/__tests__/page-index.test.ts` -- pin that a seeded `getPageIndex()` returns a null-prototype map whose `constructor` key reads `undefined` while real entries still resolve.
- `src/lib/__tests__/tenant-paths.test.ts` -- make the `getPageIndex` mock hand back a null-prototype index (mirroring production) and add a case where a page slugified to `constructor` is missing from the index and must resolve through the slow path instead of short-circuiting on the fast path.

**Acceptance Criteria:**
- Given a PPTX whose `presentation.xml.rels` resolves a slide target to a bare `Object.prototype` key, when it is extracted (directly or nested inside a ZIP), then the deck's real `ppt/slides/slideN.xml` slides are extracted and no `TypeError` escapes the extractor.
- Given a slug that names an `Object.prototype` member and is absent from the page-metadata index, when `tenantForSlug` runs, then the fast path records a miss and the slow-path map resolves it (or falls back to `DEFAULT_TENANT`), never returning a function-derived tenant.
- Given the existing suites, when `pnpm test` and `pnpm lint` run, then they pass with no new failures and the unchanged PPTX/DOCX/page-index/log-page expectations still hold.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 2, low 7)
- defer: 1: (high 0, medium 0, low 1)
- reject: 12: (high 0, medium 1, low 11)
- addressed_findings:
  - `[medium]` `[patch]` All three crafted-PPTX fixtures emptied `ordered`, so none reached the ledger's actual complaint — a bogus slide OVERRIDING `fallbackSlides`. Added a mixed-rels fixture (one real `slides/slide1.xml` target plus crafted ones) where `ordered.length` is non-zero and only the crafted entries must drop.
  - `[medium]` `[patch]` The intent's stated harm (400 vs 500 at the ingest door) was asserted only against a direct library call. Added a ZIP-wrapping-a-crafted-deck case asserting `extractDocumentTextAsync` rejects with `ClientInputError`, not `TypeError` — the exact value `src/app/api/ingest/document/route.ts:193-198` maps to 400, pinned through the live Worker-side door without an HTTP harness.
  - `[low]` `[patch]` Crafted fixtures covered only `constructor`; broadened to `__proto__` / `toString` / `valueOf` (`__proto__` yields an object, not a function), matching the existing loop idiom in the suite.
  - `[low]` `[patch]` Dropped the non-discriminating `not.toContain("constructor")` assertion in favour of a `## Slide N` heading count that fails under the bug.
  - `[low]` `[patch]` `openOfficeArchive`'s comment claimed the fix covers "every `files[...]` read in this file, for every format"; the ODT/ODS/ODP and EPUB paths build their own plain maps. Rescoped the claim and recorded why the hazard does not reach them.
  - `[low]` `[patch]` The `/api/wiki/routes` and log-page comments justified the change with a bare `map[slug]` read neither path performs. Rewrote both to state the real rationale (construction-site consistency; `resolveSlugPath` is what guards the lookups) without the false claim.
  - `[low]` `[patch]` Annotated `assetFromArchive`'s DW-365 comment so the surviving `ownLookup` reads as deliberate defence-in-depth rather than a contradiction of the now null-prototype archive.
  - `[low]` `[patch]` `rebuildPageIndex` still built its map with a plain literal ten lines below the new read-side comment; made it `Object.create(null)` for consistency.
  - `[low]` `[patch]` Two of the three ledger-named slug→tenant construction sites had no coverage; pinned the log page's map prototype in the existing `log-slug-tenant-gate` suite (the route's map is unobservable once serialized, so no route-side prototype test).

## Design Notes

Construction-site fix, not lookup guards — one edit per map instead of one per read, and it holds for reads added later:

```ts
// document-extract.ts — openOfficeArchive
return Object.assign(Object.create(null), unzipSync(input, { filter(file) { … } }));

// page-index.ts — both branches converge on the same return
if (!idx || typeof idx !== "object") return null;
return Object.assign(Object.create(null), idx) as PageMetaIndex;
```

Why not `ownLookup` at `extractPptx:595/602`: `ownLookup` returns `null`, and `new TextDecoder().decode()` rejects `null` (it accepts `undefined`), so a lookup guard needs a second branch at each site while leaving every other archive read in the file exposed.

Reachability correction for DW-695: the ledger names `/api/ingest/document`, but Epic 7 moved office parsing to the sidecar — a bare `.pptx` at that door (and at `/api/email/ingest`, `src/app/api/email/ingest/route.ts:441-448`) is diverted to `enqueueExtract` and never reaches `extractPptx` on the Worker. `zip` is NOT an extract format, so a ZIP wrapping the crafted deck keeps the inline path and reaches it through `extractDocumentTextAsync`'s recursion, where a `TypeError` is rethrown and answered 500. The defect and the 500 are real; the fixture pins the library contract, which is the surface every remaining caller shares.

A null prototype is invisible to `JSON.stringify`, `Object.entries`, `in`, `delete` and spread — the only operations these maps see. The one place it WOULD surface is a React Server→Client prop boundary; `MarkdownRenderer` has no `"use client"` today, so `ArticleView`'s and the log page's maps stay server-side. If that ever changes, the failure is a loud dev-time RSC error rather than the silent leak the log page's comment already guards against.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/document-extract.test.ts src/lib/__tests__/tenant-paths.test.ts src/lib/__tests__/page-index.test.ts` -- expected: all pass, including the new crafted-archive and prototype-slug cases
- `pnpm test` -- expected: no new failures versus the pre-change baseline
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done

**Implemented change.** Closed both remaining inherited-prototype indexing sites at the map CONSTRUCTION sites rather than at each lookup. Five maps now carry a null prototype: the unzipped OOXML archive (DW-695), and the page-metadata index plus the three slug→tenant literals the ledger names (DW-232). A crafted PPTX whose `presentation.xml.rels` resolves a slide target to a bare `Object.prototype` key no longer keeps a bogus slide, no longer overrides the deck's real slides, and no longer throws an uncaught `TypeError` — it either extracts the readable slides or exits through `ClientInputError`, the value the ingest door maps to 400.

**Files changed.**
- `../../src/lib/document-extract.ts` -- `openOfficeArchive` returns a null-prototype archive map; `assetFromArchive`'s DW-365 comment annotated so the surviving `ownLookup` reads as deliberate defence-in-depth.
- `../../src/lib/page-index.ts` -- `getPageIndex` returns a null-prototype map on both read branches; `rebuildPageIndex` builds its map the same way.
- `../../src/lib/wiki.ts` -- `buildSlugTenantMap` builds with `Object.create(null)`.
- `../../src/app/api/wiki/routes/route.ts` -- response map built with `Object.create(null)`; response body byte-identical.
- `../../src/app/wiki/log/page.tsx` -- gated `slugTenants` built with `Object.create(null)`; existing header comment preserved.
- `../../src/lib/__tests__/document-extract.test.ts` -- five crafted-archive cases: fallback slides survive, mixed real/crafted order drops only the crafted entries, no-readable-slide throws `ClientInputError`, and both ZIP-nested variants (extraction succeeds / rejects as `ClientInputError`).
- `../../src/lib/__tests__/page-index.test.ts` -- pins `getPageIndex`'s null-prototype construction, that real entries still resolve, and that enumeration/serialization are unchanged.
- `../../src/lib/__tests__/tenant-paths.test.ts` -- mock mirrors production's null-prototype contract; new case pins the fast-path miss and slow-path fall-through for a prototype-named slug.
- `../../src/app/wiki/log/__tests__/log-slug-tenant-gate.test.tsx` -- pins the log page map's null prototype.

**Review findings breakdown.** 9 patches applied (2 medium, 7 low); 1 item deferred (low — `extractPptx` accepts any archive entry as a slide, so a rel aimed at a real non-slide part still overrides the deck's real slides; path confusion, not prototype indexing); 12 rejected; 0 intent gaps, 0 spec repairs.

**Follow-up review recommendation.** `true`. Patched findings this pass: high 0, medium 2, low 7 → score `3 × 2 + 7 = 13`, which is ≥ 5.

**Verification.**
- `pnpm vitest run` over the four touched suites -- 44 passed.
- `pnpm test` -- 9038 passed, 1 skipped, 1 failed: `storage-fs.test.ts > reapStrandedScratchFiles > stops at STRANDED_SCRATCH_CANDIDATE_CAP`, a 5s test timeout under full-suite load. Confirmed pre-existing: the same single test fails identically on a stashed, unmodified tree at `baseline_revision`, and the file passes 95/95 in isolation. No file in this change is imported by that suite.
- `pnpm lint` -- clean (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices).
- `npx tsc --noEmit` -- clean.
- Negative control: with the five source hunks stashed, all 8 new tests fail — every added test is load-bearing.

**Residual risks.**
- A null prototype is invisible to `JSON.stringify`, `Object.entries`, `in`, `delete` and spread, which is all these maps see today. The one boundary that would reject it is a React Server→Client prop: `MarkdownRenderer` carries no `"use client"`, so `ArticleView`'s and the log page's maps stay server-side. If that ever changes, the failure is a loud dev-time RSC error, not a silent leak.
- `getPageIndex` now hands back a shallow copy. No caller ever shared a live object (both storage backends parse fresh JSON per call), so nothing observes it, but a future caller that mutates the returned map expecting the write to persist would silently no-op.
