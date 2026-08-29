---
title: 'Strict merge-base and write-authorizing reads outside the first sweep'
type: 'bugfix'
created: '2026-08-28'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
baseline_revision: '144767a4fc2899698ae33bd65f34662aa46eb7c2'
---

<intent-contract>

## Intent

**Problem:** DW-495 — eleven merge-base reads outside the three files DW-379 named still read through the module-global `pageCache` without `strict`, so a concurrent bulk scan can make the merge base a file that is no longer stored, and a storage blip is reported as an absent page; `handleUpdatePage` (`src/mcp.ts:282`) does this while its own comment claims parity with the `PUT` route that was already fixed. DW-496 — three write-authorizing reads that are not merge bases do the same: the DELETE ACL read at `src/app/api/wiki/[slug]/route.ts:50`, and the create-conflict guards at `src/app/api/wiki/route.ts:104` and `src/mcp.ts:222`, where a blip reads as "absent" and lets a create proceed against a page that exists.

**Approach:** Extend the established `{ fresh: true, strict: true }` conversion to all fourteen sites. Where a converted read's rethrow would be misclassified by its enclosing handler, fix the classification too: `src/lib/agents.ts`'s two reads swallow every error with `.catch(() => null)` (so `strict` alone would be a no-op), and the DELETE handler's catch calls an unclassified error a 400. No change to `readWikiPage`'s `null` contract and no new option.

## Boundaries & Constraints

**Always:**
- Use the established option literal `{ fresh: true, strict: true }`, spelled on one line, exactly as `src/lib/search.ts:137` and `src/lib/lint-fix.ts:60` do.
- A converted site's `null` answer keeps its existing meaning (page absent → the same 404 / `page not found` / `createOnly` path it took before). Only a non-ENOENT failure changes shape, from `null` to a throw.
- Every converted throw must reach a handler that answers 5xx, not 404 and not 400 — verify the enclosing `catch` before converting, and repair the classification where it is wrong.
- Remove `src/lib/agents.ts`'s two `.catch(() => null)` tails when converting those reads: left in place they swallow the `strict` rethrow and the conversion means nothing.
- Every converted call site keeps its enclosing function's existing control flow; only the option literal (and, where named above, the error classification) changes.

**Block If:**
- A converted read has no enclosing error handler and the throw would escape to an unhandled rejection.

**Never:**
- Do not change `readWikiPage`'s `null` contract, add a new option to `ReadWikiPageOptions`, or touch its many non-write callers — in particular the response-serving reads at `src/mcp.ts:131/398/463/588/652/704/755/855/1033/1123/1302/1325`, `src/cli.ts:279/327`, `src/app/api/wiki/[slug]/revisions/route.ts:29`, and the slug-availability probes at `src/lib/ingest.ts:1098/1106/1141/1416` and `src/lib/ingest-bookkeeping.ts:242`.
- Do not convert `src/lib/ingest.ts:275`, `:543`, `:1779`, `:1908`, `:1917`, `:1935`, `:2051` or `src/lib/source-cascade.ts:193` — none of them is named by DW-495/DW-496.
- Do not widen the DELETE handler's fall-through status from 400 to 500 for every error; `invalid slug` and the other classified messages keep the statuses they have.
- Do not add write preconditions (`If-Match` gating) to any of these paths.
- Do not restructure `findExistingSourceSummary` into a discovery-then-reread pair; convert the read it already makes.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| MCP edit blip | `handleUpdatePage` while the page read fails with a non-ENOENT storage error | Throws the storage error; nothing written | Not `Page not found: <slug>` — the DW-378 symptom on the surface claiming PUT parity |
| MCP edit absent | `handleUpdatePage` for a slug with no stored file | Unchanged: throws `Page not found: <slug>` | No error expected |
| MCP create blip | `handleCreatePage` while the conflict read fails with a non-ENOENT storage error | Throws; no page is created | A blip may never be read as "absent" and authorize a create |
| DELETE door blip | `DELETE /api/wiki/<slug>` while the ACL read fails with a non-ENOENT storage error | 500 carrying the storage message; the page is still stored | Rethrown by `strict`, classified 500 at the read rather than 400 by the outer catch |
| DELETE door absent | `DELETE /api/wiki/<slug>` for a slug with no stored file | Unchanged: 404 `page not found: <slug>` | No error expected |
| DELETE door denied | Non-owner deleting a private page that reads fine | Unchanged: 404 cloak; owner-denied public page still 403 | No error expected |
| Create route blip | `POST /api/wiki` while the conflict read fails with a non-ENOENT storage error | 500; nothing written, the existing page is untouched | Outer catch already defaults to 500 |
| Create route free slug | `POST /api/wiki` for a slug with no stored file | Unchanged: 201 | No error expected |
| Agent seed/update blip | `seedAgent` / `updateAgent` while the identity-page read fails | Throws; route answers 500 and no page is written | `.catch(() => null)` removed, so the blip is no longer read as "page absent → createOnly" |
| Fresh merge base under an open scan | Any converted site runs while `pageCache` holds a superseded entry for the slug | The bytes handed on as `expectedContent` are the stored file's | No error expected |

</intent-contract>

## Code Map

Reference conversion to copy verbatim: `src/lib/search.ts:137` and `src/lib/lint-fix.ts:60`. Contract: `src/lib/wiki.ts:340-398` (`fresh`/`strict` JSDoc), `:404-470` (`readWikiPage`; `strict` reaches the silo read, the flat fallback and `getPageIndex`), `:534` (`readWikiPageWithFrontmatter` forwards `options` verbatim). All READ-ONLY.

Merge-base sites (DW-495) — each read's bytes become `expectedContent` at the arrow's target:

- `src/mcp.ts:282` → `:349` -- `handleUpdatePage`; the `!existingPage` throw at `:283-285` is the "Page not found" DW-495 calls out. **Change.**
- `src/mcp.ts:1371` → `:1408` -- `handleRevertRevision`. **Change.**
- `src/cli.ts:431` → `:468` -- `runUpdate`; a throw reaches `main().catch` at `src/cli.ts:688`, which prints and exits 1. **Change.**
- `src/lib/query.ts:507` → `:521` -- `saveAnswerToWiki`; `existing` truthy → `expectedContent`, falsy → `createOnly: true`. Callers `src/app/api/query/save/route.ts:89`, `src/app/api/chat/conversations/[id]/save/route.ts:92`, `src/mcp.ts:807`; both routes default to 500. **Change.**
- `src/lib/ingest.ts:1432` → `:1484` -- `attachIngestTrigger`; `if (!existing) return null` currently turns a blip into "index drifted, ingest normally", i.e. a duplicate page. Callers at `:288/:386/:458/:1534` propagate to ingest routes (500). **Change.**
- `src/lib/document-sources.ts:94` → `:126` -- `appendSourceFigures`; already throws on `!page`. Reached from `preserveDocumentSources` (`:137`) via `src/lib/ingest.ts:497/523`, `src/app/api/tasks/run/route.ts:684`, `src/app/api/email/ingest/route.ts:567` — all under catches that answer 500. **Change.**
- `src/lib/source-cascade.ts:229` → `:263` -- `cascadeDeleteSource`'s `others` loop; caller `src/app/api/workbench/source/route.ts:31` answers 500, and `writeMarker` has already persisted progress. **Change.** `:193` is a different loop and is NOT named — leave it.
- `src/lib/agents.ts:792` → `:826` -- `updateAgent`'s identity-page read, **and its `.catch(() => null)` tail at `:792-794` must go**; caller `src/app/api/agents/[id]/route.ts:257`, catch defaults to 500. **Change.**
- `src/lib/agents.ts:934` → `:977` -- `seedAgent`, same shape and same `.catch(() => null)` removal; caller `src/app/api/agents/seed/route.ts:110`, catch defaults to 500. **Change.**
- `src/lib/ingest-bookkeeping.ts:53` → `:76` -- `regenerateOverview`'s `overview` read. **Change.**
- `src/lib/ingest-bookkeeping.ts:220` → consumed at `:206` -- the ledger's stale `:186` anchor: `ensureSourceSummary` gets its `existing.content` merge base from `findExistingSourceSummary` (`:213-238`), whose per-page read is at `:220`. A skipped page there makes `ensureSourceSummary` mint a *second* summary page for the same source. Both reach `runIngestBookkeeping` (`:248`), whose throw is safe by design — `src/lib/ingest.ts:2290` documents that a bookkeeping throw is retryable. **Change `:220`.**

Write-authorizing non-merge-base sites (DW-496):

- `src/app/api/wiki/[slug]/route.ts:50` -- DELETE's ACL read; feeds `canWriteFrontmatter` at `:60` and the 404/403 cloak at `:51-74`. **Change, and wrap this one read in its own `try`/`catch` returning 500**: the handler's outer catch at `:79-92` maps `page not found` → 404 and *everything else to 400*, so a bare conversion would report a provider outage as the caller's bad request. `getErrorMessage` and `NextResponse` are already imported.
- `src/app/api/wiki/route.ts:104` -- `POST`'s create-conflict read; `existing` truthy → 409. Outer catch at `:158-172` already defaults to 500. **Change (option only).**
- `src/mcp.ts:222` -- `handleCreatePage`'s conflict read; throws `Page already exists` when truthy. **Change (option only).**
- `src/app/api/wiki/[slug]/route.ts:203-206` -- the already-converted PUT read; multi-line, so it will not match the one-line literal grep in Verification. READ-ONLY reference.

Tests:

- `src/lib/__tests__/wiki-routes.test.ts:1821-1875` -- the DW-378 idiom to copy: `vi.spyOn(getStorage(), "readFile")` with `filePath.endsWith("<slug>.md")` → `throw new Error("storage unavailable")`, asserting `status >= 500`, `error` not containing `page not found`, and stored bytes unchanged; `:1875` is the companion genuine-404 row. `del()` helper at `:685`, `seed()` at `:655`, POST helpers at `:103/:1126/:1276`.
- `src/lib/__tests__/mcp.test.ts:1-56` -- real temp-dir storage plus `_resetStorage`; `handleCreatePage` rows at `:452-560`. Same `getStorage().readFile` spy idiom applies.
- `src/lib/__tests__/agents.test.ts`, `agents-route.test.ts`, `agents-id-route.test.ts` -- suites covering the two agents.ts paths.
- `src/lib/__tests__/lifecycle.test.ts` -- COUNTER-check: pins that a non-strict `{ fresh: true }` read still survives a page-index outage. Must stay green **unedited**.

## Tasks & Acceptance

**Execution:**
- `src/mcp.ts` -- pass `{ fresh: true, strict: true }` at `:222`, `:282` and `:1371`; add a one-line comment at `:282` saying the read is strict *because* this door mirrors `PUT /api/wiki/[slug]`, and that the `Page not found` below it therefore means only "absent".
- `src/cli.ts` -- pass `{ fresh: true, strict: true }` at `:431` -- `runUpdate`'s merge base.
- `src/lib/query.ts` -- pass `{ fresh: true, strict: true }` at `:507` -- a blip must not silently flip the save from `expectedContent` to `createOnly`.
- `src/lib/ingest.ts` -- pass `{ fresh: true, strict: true }` at `:1432` and amend the `// index drifted` comment so it no longer claims a failed read means drift.
- `src/lib/document-sources.ts` -- pass `{ fresh: true, strict: true }` at `:94`.
- `src/lib/source-cascade.ts` -- pass `{ fresh: true, strict: true }` at `:229` only.
- `src/lib/agents.ts` -- pass `{ fresh: true, strict: true }` at `:792` and `:934` **and delete both `.catch(() => null)` tails**, with a comment naming why the tail could not stay -- otherwise `strict` is dead code.
- `src/lib/ingest-bookkeeping.ts` -- pass `{ fresh: true, strict: true }` at `:53` and at `findExistingSourceSummary`'s `:220`, with a one-line comment at `:220` naming the duplicate-summary hazard a skipped page causes.
- `src/app/api/wiki/[slug]/route.ts` -- convert the DELETE read at `:50` and wrap it in a local `try`/`catch` that returns `{ error: getErrorMessage(err) }` at 500, with a comment naming the outer catch's 400 fall-through as the reason the wrap exists.
- `src/app/api/wiki/route.ts` -- convert the create-conflict read at `:104`; note in a comment that a blip must not be read as a free slug.
- `src/lib/__tests__/wiki-routes.test.ts` -- add, beside the existing DW-378 block: a DELETE storage-blip row (5xx, body not `page not found`, page still stored), a DELETE genuine-absence control (404), a `POST /api/wiki` conflict-read blip row (5xx, existing page's bytes untouched, no 201), and a `POST` free-slug control (201) -- covers four matrix rows.
- `src/lib/__tests__/mcp.test.ts` -- add rows: `handleUpdatePage` under a read blip rejects with the storage message and not `Page not found`; `handleUpdatePage` on an absent slug still rejects with `Page not found`; `handleCreatePage` under a blip rejects and writes no page -- covers three matrix rows.
- `src/lib/__tests__/agents-route.test.ts` (or `agents-id-route.test.ts`, whichever already drives real storage) -- add a row proving a read blip during `seedAgent`/`updateAgent` answers 5xx instead of silently taking the `createOnly` branch -- covers the agents matrix row and pins the `.catch` removal.

**Acceptance Criteria:**
- Given the fourteen call sites named in the Code Map, when this change lands, then each carries `{ fresh: true, strict: true }` and no other `readWikiPage`/`readWikiPageWithFrontmatter` caller is edited.
- Given `src/lib/agents.ts`, when this change lands, then neither converted read is followed by a `.catch(() => null)`.
- Given a converted read that rethrows a non-ENOENT storage error, when the failure reaches the nearest HTTP handler, then the status is 5xx — never 404 and never 400.
- Given `readWikiPage`'s signature, when this change lands, then `ReadWikiPageOptions` is unchanged.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures and `src/lib/__tests__/lifecycle.test.ts` is unedited.

## Spec Change Log

## Review Triage Log

## Design Notes

The two `agents.ts` sites are the only ones where the option alone changes nothing: `readWikiPageWithFrontmatter(slug, { fresh: true, strict: true }).catch(() => null)` throws and is immediately swallowed back into the same `null` that took the `createOnly` branch. The tail has to go for the conversion to exist at all — and removing it also stops an unparseable frontmatter block from being treated as "no page here, create one".

The DELETE door is the only site where the enclosing handler misclassifies the rethrow. Its catch is a two-branch ladder (`page not found` → 404, else 400) rather than the PUT route's "else 500", so the wrap is local rather than a change to the ladder — `invalid slug` and every other message keep the 400 they have today.

```ts
// src/app/api/wiki/[slug]/route.ts — the shape for the DELETE read
let existing: Awaited<ReturnType<typeof readWikiPageWithFrontmatter>>;
try {
  existing = await readWikiPageWithFrontmatter(slug, { fresh: true, strict: true });
} catch (err) {
  // The outer catch calls an unclassified error a 400 — a provider outage
  // reported as the caller's malformed request. Classify it here instead.
  return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 });
}
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/mcp.test.ts src/lib/__tests__/agents.test.ts src/lib/__tests__/agents-route.test.ts src/lib/__tests__/agents-id-route.test.ts src/lib/__tests__/query.test.ts src/lib/__tests__/document-sources.test.ts src/lib/__tests__/lifecycle.test.ts` -- expected: all pass. `lifecycle.test.ts` is a COUNTER-check (a non-strict `{ fresh: true }` read must still survive an index outage) and must stay green without being edited.
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm exec eslint src` -- expected: no new errors
- `pnpm test` -- expected: full suite green, no new failures
- The conversion count, across the ten changed source files -- **expected: exactly `14`**:

```sh
grep -c "fresh: true, strict: true" \
  src/mcp.ts src/cli.ts src/lib/query.ts src/lib/ingest.ts \
  src/lib/document-sources.ts src/lib/source-cascade.ts src/lib/agents.ts \
  src/lib/ingest-bookkeeping.ts src/app/api/wiki/route.ts \
  "src/app/api/wiki/[slug]/route.ts" \
  | awk -F: '{s+=$2} END {print s}'
```

- The `.catch(() => null)` tails are gone from the two converted agent reads -- **expected: no output**:

```sh
perl -0777 -ne 's/\s+/ /g;
  print "VIOLATION: swallowed strict read\n"
    while /readWikiPageWithFrontmatter\([^)]*strict: true[^)]*\)\s*\.catch/g;' \
  src/lib/agents.ts
```
