---
title: 'Owner-scoped anchor coverage for the DW-590 and DW-699 call sites'
type: 'chore'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred: []
baseline_revision: '633964a1f9559bbf7d3accbb10d685165eb9fff1'
---

<intent-contract>

## Intent

**Problem:** Five `hrefForSlug` call sites converted in the 308-shim sweep have no test that renders them, so reverting any of them to a `/u/yopedia/<slug>` answer leaves the whole suite green while every link in that surface takes a wrong-handle redirect hop. Review demonstrated exactly that for `IngestSuccess`, `BatchItemRow`, `useGlobalSearch`'s `router.push` (DW-590) and for `QueryResultPanel`'s Sources chip and saved-answer "View" link (DW-699).

**Approach:** Extend `src/components/__tests__/owner-scoped-anchors.test.tsx` — the per-component sibling of the renderer suite — with rendered-`href` assertions for the four plain-prop surfaces, and one `nav.router.push` assertion for the navigation. Reuse that file's existing map fixture so every wrong answer stays distinguishable from the right one.

## Boundaries & Constraints

**Always:**
- Assert on the RENDERED `href` (or, for the navigation, on the argument `router.push` actually received) — never on whether a component imports the hook.
- Resolve every expected href through the file's existing `SLUG_TENANTS` fixture (`target`→alice, `other`→bob), so a reverted call site emits `/u/yopedia/…` and fails distinguishably.
- Route every new `fetch` through the file's existing per-test `routes` table; a URL no fixture describes must keep hitting the `unexpected fetch` guard.
- Where a component receives `hrefForSlug` as a prop in production, obtain it from the real `useSlugTenants()` hook in the test too, so the map stays load-bearing.

**Block If:**
- A new assertion cannot be made to fail on a `slugPath(...)` revert without changing production code.

**Never:**
- Do not modify any file under `src/` other than `src/components/__tests__/owner-scoped-anchors.test.tsx`. These are coverage gaps, not behavior bugs — the production call sites are already correct.
- Do not drive `BatchIngestForm`'s streaming upload or `BulkDocumentImport`-style pollers to reach a row; the ledger's own prescription is the plain-prop render.
- Do not duplicate the in-content-wikilink coverage that `renderer-slug-tenant-adoption.test.tsx` already owns.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ingest success, primary link | `<IngestSuccess slug="target" relatedUpdated={["other"]} />`, map warm | The `View “target” →` link's `href` is `/u/alice/target` | No error expected |
| Ingest success, related row | Same mount | The `other` link's `href` is `/u/bob/other` — a second owner, so one lookup per row | No error expected |
| Batch row, success item | `BatchItemRow` fed `hrefForSlug` from `useSlugTenants()`, items `target` + `other` | Row hrefs are `/u/alice/target` and `/u/bob/other` | No error expected |
| Answer source chips | `QueryResultPanel` with `sources: ["target", "other"]`, `streaming={false}` | Chip hrefs are `/u/alice/target` and `/u/bob/other` | No error expected |
| Saved answer, no url in response | `/api/query/save` answers `{ slug: "target" }` (no `url`) | The `View →` link falls back to the map: `/u/alice/target` | No error expected |
| Global search navigation | `/api/wiki` lists `target`; user focuses, types, mousedowns the result | `nav.router.push` is called with `/u/alice/target` | No error expected |

</intent-contract>

## Code Map

- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- THE ONLY FILE TO EDIT. 782 lines. Header doctrine at :20-45 ("The seven components below") must be updated to the new count. Fixture at :47-53 (`SLUG_TENANTS`, `ALICE_TARGET`, `BOB_OTHER`, `DANA_SIBLING`). `nav` hoisted mock with `router.push` at :61-69 — shared across the file, so a navigation case must `mockClear()` it. `routes`/`fetchMock` table + `await loadSlugTenants()` warm-up in `beforeEach` at :136-172. `hrefOf(name)` helper at :173-177. Insert the new describes after the `BulkDocumentImport` describe closes (:678) and BEFORE the "degraded map" section header (:680) — that section calls `_resetSlugTenants()` and stages an outage, so anything appended after it would run against a cold map.
- `src/components/IngestSuccess.tsx` -- call sites at :20 (primary `View “{slug}” →`) and :35 (each `relatedUpdated` row). Plain props `{ slug, relatedUpdated, onReset }`; gets the map from `useSlugTenants()` itself. Both anchors render unconditionally given a non-empty `relatedUpdated`.
- `src/components/BatchItemRow.tsx` -- call site at :43, inside the `item.status === "success" && item.slug` branch. Takes `hrefForSlug` as a PROP (`BatchItemRowProps`, :23-27); `BatchIngestForm.tsx:14` obtains it from `useSlugTenants()` and hands it down at :319. Reuse that wiring in a tiny harness instead of driving the form's NDJSON stream.
- `src/components/QueryResultPanel.tsx` -- Sources chip at :201 inside the `result.sources.length > 0` branch (:192); saved-answer `View →` at :281 inside `saveState.status === "saved" && saveState.slug` (:277), whose href is `saveState.url ?? hrefForSlug(saveState.slug)` — the FALLBACK half is the `hrefForSlug` site. `handleSaveClick` (:101) pre-fills the title from `question`, so the form's submit is enabled with no typing; `handleSaveSubmit` POSTs `/api/query/save` and, with `currentHistoryId={null}`, skips the `/api/query/history` follow-up.
- `src/hooks/useGlobalSearch.ts` -- `router.push(hrefForSlug(slug))` at :197 inside `navigate(slug)`. `handleInputFocus` (:245) sets `open` and calls `fetchPages()` → `GET /api/wiki` expecting `{ pages: [{ slug, title }] }`. `handleInputChange` (:239) sets the query and schedules a 300ms-debounced `GET /api/wiki/search?q=<q>` for queries ≥3 chars.
- `src/components/GlobalSearch.tsx` -- the hook's only consumer. Input has `aria-label="Search wiki pages"`; results render as `SearchResultItem` `<li role="option">` whose `onMouseDown` calls `navigate(page.id)`. Dropdown shows only when `open && query && results.length > 0`.
- `src/components/__tests__/renderer-slug-tenant-adoption.test.tsx` -- READ-ONLY reference. Owns the in-content-wikilink half for `QueryResultPanel` (:109-124); do not restate it.
- `vitest.config.ts` -- the `dom` project (jsdom) at :99-103 is the one that runs this file.

## Tasks & Acceptance

**Execution:**
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- Add an `IngestSuccess` describe asserting the primary and related-row hrefs -- pins both call sites (:20 and :35) named by DW-590.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- Add a `BatchItemRow` describe with a harness component that reads `useSlugTenants()` and forwards `hrefForSlug`, mirroring `BatchIngestForm.tsx:319`, over two success rows with different owners -- pins :43 while keeping the map load-bearing.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- Add a `QueryResultPanel` describe with one case for the Sources chips and one that saves an answer against a `/api/query/save` response carrying no `url` -- pins :201 and the `?? hrefForSlug(...)` fallback at :281.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- Add a `GlobalSearch` describe that stages `/api/wiki`, drives focus→type→mousedown, and asserts the argument `nav.router.push` received, clearing that shared mock in its own `beforeEach` -- pins `useGlobalSearch.ts:197`.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- Update the file header's component count and its list of what the sweep left unwitnessed -- the doctrine block is the file's contract and must stay true.

**Acceptance Criteria:**
- Given the four new describes, when `pnpm vitest run --project dom` runs on the unmutated tree, then every test passes at exactly 73 files / 1129 tests — the 1120 baseline plus the nine new cases. (The file count cannot grow: the **Never** clause confines the change to one existing file.)
- Given `IngestSuccess.tsx:20` or `:35` is reverted to `slugPath(...)`, when the dom project runs, then the `IngestSuccess` describe fails with the observed href `/u/yopedia/…` against the expected canonical one.
- Given `BatchItemRow.tsx:43` is reverted to `slugPath(item.slug)`, when the dom project runs, then the `BatchItemRow` describe fails.
- Given `QueryResultPanel.tsx:201` or the `hrefForSlug` half of `:281` is reverted, when the dom project runs, then the `QueryResultPanel` describe fails.
- Given `useGlobalSearch.ts:197` is reverted to `router.push(slugPath(slug))`, when the dom project runs, then the `GlobalSearch` describe fails on the argument `push` received.
- Given no production file is edited, when `git status` is inspected after the change, then `src/components/__tests__/owner-scoped-anchors.test.tsx` is the only modified file under `src/`.

## Spec Change Log

## Design Notes

The file's existing doctrine is that every wrong answer must be a DISTINGUISHABLE one. Keep that: `target` belongs to alice and `other` to bob, so a dropped map falls back to `/u/yopedia/…` and a per-list single tenant is visible as both rows sharing an owner. That is why each new multi-anchor case uses two slugs with two owners rather than one slug twice.

The `BatchItemRow` harness is the whole point of the prop-fed case — it reproduces the parent's wiring without the stream:

```tsx
/** `BatchIngestForm.tsx:319`'s wiring, minus its NDJSON upload. */
function BatchRows({ items }: { items: BatchItem[] }) {
  const { hrefForSlug } = useSlugTenants();
  return (
    <ul>
      {items.map((item, i) => (
        <BatchItemRow key={i} item={item} hrefForSlug={hrefForSlug} />
      ))}
    </ul>
  );
}
```

For the search navigation, register `/api/wiki/search?q=<query>` in `routes` even though the 300ms debounce is normally cleared by unmount: the strict stub throws on any undescribed URL, and a case that happens to stay mounted past the debounce should not fail as "unexpected fetch".

## Verification

**Commands:**
- `pnpm vitest run --project dom` -- expected: all files pass, with strictly more than 73 files / 1120 tests.
- `pnpm lint` -- expected: no new errors.
- `npx tsc --noEmit` -- expected: no new type errors.
- Mutation check (revert, run, restore): temporarily replace each of the five call sites with a `/u/yopedia/${slug}` answer and confirm the corresponding new describe fails -- expected: each revert produces at least one failure.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

Added rendered-anchor coverage for the five `hrefForSlug` call sites that the 308-shim conversion left unwitnessed (DW-590, DW-699). Every one of them could previously be reverted to a `/u/yopedia/<slug>` answer with the whole suite green. Test-only change; no production code was touched.

### Files changed

- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- four new describes (`IngestSuccess`, `BatchItemRow`, `QueryResultPanel`, `GlobalSearch`), nine new cases, plus a corrected doctrine header. Inserted before the degraded-map section so they run against the warm map.
- `_bmad-output/implementation-artifacts/spec-dw-590-699-owner-scoped-anchor-coverage.md` -- this spec.

### Review findings breakdown

- Patches applied: 9 (all low severity) -- see the Review Triage Log above.
- Items deferred: 0.
- Items rejected: 14. The two substantive ones, both demonstrated real by the reviewers but out of this bundle's scope:
  - `LintIssueCard.tsx:101`, fed from `LintClient.tsx:100`, is the one remaining prop-fed `hrefForSlug` anchor with no map-backed witness -- `lint-check-parity.test.tsx:166` hands it a stub returning `/u/yopedia/<slug>` and asserts that same string, so it passes on a reverted call site. DW-699 names `LintClient` as a PRIOR story's scope and this bundle's `dw_ids` are 590/699 only, so sweeping it in has no intent authority. It is a sibling call site behind a same-shape mock, so it was not filed as new deferred work either.
  - `BatchIngestForm.tsx:319`'s prop hand-off is replicated by the test harness rather than executed, so mutating it stays green. The bundle named this site and prescribed the plain-prop render for it; `BatchIngestForm` is additionally mounted by no route in the repo, so the uncovered half has no reachable surface. Recorded in the test's own doctrine comment instead of as a ledger row.

### Follow-up review recommendation

`true`. Patched findings by severity: high 0, medium 0, low 9. Score = 3x0 + 1x9 = 9, which is >= 5.

### Verification performed

- `pnpm vitest run --project dom` -- 73 files / 1129 tests, all passing (baseline before this change: 73 / 1120).
- `npx tsc --noEmit` -- exit 0.
- `pnpm lint` -- exit 0. The three `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing and come from the `BulkDocumentImport` describe's `input!`, not from the new code.
- Mutation check, all seven anchors, each reverted to a `/u/yopedia/<slug>` answer one at a time and restored from a file copy: `IngestSuccess.tsx:20` -> 2 failures, `:35` -> 2, `BatchItemRow.tsx:43` -> 1, `QueryResultPanel.tsx:201` -> 1, `:281` `??` half -> 1, `:281` `url` half -> 1, `useGlobalSearch.ts:197` -> 1. Each failure landed in the matching new describe.
- Flake check: 20 consecutive runs of the file, 0 failures. (A reviewer reported one unreproduced `GlobalSearch` failure; they could not reproduce it in 40 further runs and identified no mechanism, and the 20 runs here were clean.)
- Matrix test audit: each of the six I/O matrix rows maps to a named case that ran and passed in the verbatim run output.

### Residual risks

- `BatchIngestForm.tsx:319` and `LintIssueCard.tsx:101` remain revertible with the suite green, as described under rejected items above. Both are recorded here rather than closed.
- Process note: partway through verification, a `git checkout --` used to restore a mutated production file also reverted the uncommitted test file, destroying the implementation. It was reconstructed verbatim and re-verified (identical 1128-test result, then 1129 after patches), and all later mutation runs restored from file copies with an md5 check confirming the test file was untouched. No content was lost, but the diff was rebuilt rather than written once.
