---
title: 'Strict write-authorizing and merge-base reads across the remaining doors'
type: 'bugfix'
created: '2026-08-30'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
baseline_revision: '868d2009db0103734159db88dd7e075f560ba7cb'
---

<intent-contract>

## Intent

**Problem:** Fifteen reads still call `readWikiPage`/`readWikiPageWithFrontmatter` with no options, so a non-ENOENT storage failure comes back as `null` and is reported as an absent page. Eleven of them (DW-495) hand those same bytes to `writeWikiPageWithSideEffects` as `expectedContent`, so a blip either merges against bytes that are gone or silently takes the `createOnly` branch; `handleUpdatePage` does this while its own comment claims parity with the `PUT` route already fixed by DW-378/379. Three more (DW-496) authorize a write without being merge bases — the DELETE route's ACL read, and the create-conflict guards in `POST /api/wiki` and `handleCreatePage`, where a blip reads as "slug free" and lets a create proceed over a stored page. One (DW-497) is the revision-list `GET`, where the same blip tells a human reader their page is gone.

**Approach:** Pass the established `{ fresh: true, strict: true }` at all fifteen sites. Where a converted read's rethrow would be swallowed or misclassified, repair that too: `src/lib/agents.ts`'s two reads end in `.catch(() => null)` (so `strict` alone is a no-op), and the DELETE handler's catch ladder calls an unclassified error a 400. No change to `readWikiPage`'s `null` contract, no new option, no change to `ReadWikiPageOptions`.

## Boundaries & Constraints

**Always:**
- Use the established option literal `{ fresh: true, strict: true }` exactly as `src/lib/lint-fix.ts:60` and `src/lib/merge.ts:192` spell it. Let Prettier decide whether it wraps.
- A converted site's `null` answer keeps its existing meaning — page absent takes the same 404 / `page not found` / `createOnly` / `return null` path it took before. Only a non-ENOENT failure changes shape, from `null` to a throw.
- Every converted throw must reach a handler that answers 5xx (or, off HTTP, a message naming the storage failure) — never 404 and never 400. Verify the enclosing `catch` before converting, and repair the classification where it is wrong.
- Remove `src/lib/agents.ts`'s two `.catch(() => null)` tails when converting those reads; left in place they swallow the rethrow and the conversion means nothing.
- Every converted call site keeps its enclosing function's control flow; only the option literal (and, where named, the error classification) changes.
- Each converted site carries a short comment naming what the blip would otherwise have been reported as.

**Block If:**
- A converted read's rethrow can only reach a handler that answers 404 or 400 and the correct classification is not derivable from the code (i.e. fixing it would need a product decision about the wire contract).

**Never:**
- Do not change `ReadWikiPageOptions`, `readWikiPage`'s or `readWikiPageWithFrontmatter`'s `null` contract, or add an option.
- Do not convert reads that do not authorize a write and do not serve an existence answer — the pure display reads (`src/mcp.ts:157`, `:424`, `:489`, `:626`, `:690`, `:742`, `:793`, `:893`, `:1071`, `:1161`, `:1351`, `:1374`; `src/cli.ts:279`, `:327`; `src/lib/ingest.ts:275`, `:543`, `:1098`-`:1141`, `:1416`, `:1779`-`:1935`; `src/lib/source-cascade.ts:193`; `src/lib/ingest-bookkeeping.ts:242`) stay exactly as they are.
- Do not edit `src/lib/__tests__/lifecycle.test.ts` — it pins the NON-strict scan fallback and is the counter-check for this change.
- Do not "fix" the `page already exists` / `Page already exists` copy, the 409/404 statuses, or any ACL/cloak behavior.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DELETE, storage blip | page stored, `readFile` throws non-ENOENT for its `.md` | 5xx, body does NOT contain `page not found`; page still stored | rethrow classified 500 by a local wrap |
| DELETE, genuine absence | no stored file for slug | 404 `page not found: <slug>` | unchanged |
| `POST /api/wiki`, storage blip | page stored at slug, conflict read blips | 5xx, no 201, stored bytes untouched | outer catch already answers 500 |
| `POST /api/wiki`, free slug | nothing stored at slug | 201 created | unchanged |
| Revisions `GET`, storage blip | page stored, existence read blips | 5xx, body NOT `page not found: <slug>` | outer catch already answers 500 |
| Revisions `GET`, genuine absence | no stored file | 404 `page not found: <slug>` | unchanged |
| `handleUpdatePage`, storage blip | page stored, merge-base read blips | rejects with the storage message, NOT `Page not found` | thrown to MCP `isError` result |
| `handleUpdatePage`, genuine absence | no stored file | rejects `Page not found: <slug>` | unchanged |
| `handleCreatePage`, storage blip | page stored at slug, conflict read blips | rejects with the storage message; no page written | thrown to MCP `isError` result |
| `seedAgent`, storage blip | identity page stored, read blips | rejects with the storage message; does NOT take the `createOnly` branch | thrown to route catch → 500 |

</intent-contract>

## Code Map

Every anchor below is at `868d2009`. Each entry is `read line -> line that consumes it`.

**DW-495 — merge-base reads (11):**
- `src/mcp.ts:308` -> `:375` -- `handleUpdatePage`; `:310`/`:330` answer `Page not found`. The comment at `:313` claims parity with `PUT /api/wiki/[slug]`, which was already fixed.
- `src/mcp.ts:1420` -> `:1456` -- `handleRevertRevision`; `:1422` answers `page not found`.
- `src/cli.ts:431` -> `:468` -- `runUpdate`; `:433` prints `page "<slug>" not found` then `process.exit(1)`. A rethrow reaches `main().catch` at `:816`, which prints `Error: <message>` and exits 1 — correct already, no repair needed.
- `src/lib/query.ts:507` -> `:521` -- `saveAnswerToWiki`; `null` selects `createOnly`. Callers `src/app/api/query/save/route.ts:121` and `src/app/api/chat/conversations/[id]/save/route.ts:180` both answer 500 on an unclassified throw.
- `src/lib/ingest.ts:1432` -> `:1484` -- `attachIngestTrigger`; `null` returns "let the caller ingest normally", which under a blip forks the page. `src/app/api/ingest/route.ts:244` answers 500 for anything that is not a `ClientInputError`.
- `src/lib/document-sources.ts:94` -> `:127` -- `appendSourceFigures`; already throws on `null`, but with the wrong message.
- `src/lib/source-cascade.ts:229` -> `:263` -- `cascadeDeleteSource`; `null` silently drops the slug from the cascade. `src/app/api/workbench/source/route.ts:42` answers 500.
- `src/lib/agents.ts:792` -> `:832` and `:934` -> `:977` -- `updateAgent` / `seedAgent`. **Both end in `.catch(() => null)` (`:792-794`, `:934-936`) — delete those tails.** `src/app/api/agents/[id]/route.ts:286` and `src/app/api/agents/seed/route.ts:138` both fall through to 500.
- `src/lib/ingest-bookkeeping.ts:53` -> `:76` -- the `overview` regeneration.
- `src/lib/ingest-bookkeeping.ts:220` -> `:207` -- the read inside `findExistingSourceSummary` (`:213`), whose returned `content` becomes the `expectedContent` at `:207`. A skipped page here also produces a duplicate summary page.

**DW-496 — write-authorizing, not merge bases (3):**
- `src/app/api/wiki/[slug]/route.ts:50` -- inside `DELETE` (handler at `:26`); feeds `canWriteFrontmatter` at `:60`; `:51-56` answers 404. Its catch at `:79` is a ladder (`page not found` → 404, **else 400**) — the only site whose classification is wrong, so wrap this read locally.
- `src/app/api/wiki/route.ts:104` -- `POST` conflict guard; truthy → 409. Catch at `:171` already answers 500 for anything but `invalid slug`.
- `src/mcp.ts:248` -- `handleCreatePage` conflict guard; truthy → `Page already exists`.

**DW-497 — read surface (1):**
- `src/app/api/wiki/[slug]/revisions/route.ts:29` -- `GET` existence check; `:31-34` answers 404. Catch at `:87` already answers 500 for anything but `invalid slug`. The sibling `POST` in the same file (`:138`) is already `{ fresh: true, strict: true }` — this is the parity gap.

**Reference patterns (read-only, do not edit):**
- `src/lib/wiki.ts:338-399` -- `ReadWikiPageOptions`; the `strict` doc (`:370-391`) states its two gotchas.
- `src/app/api/wiki/[slug]/route.ts:196-206` -- the DW-378 comment + literal to mirror.
- `src/lib/__tests__/wiki-routes.test.ts:1820-1875` -- the DW-378 blip/absence test pair to model. Helpers: global `beforeEach` at `:66` (temp `WIKI_DIR`, clears `YOPEDIA_READONLY`), `getPrincipal` mocked at `:6-10` to `test-user`, `seed` at `:1511`, `storedBody` at `:1551`, `del` at `:686`.
- `src/lib/__tests__/mcp.test.ts:124` (temp `WIKI_DIR` `beforeEach`), `:684-691` (the `Page not found` absence row for `handleUpdatePage`).
- `src/lib/__tests__/agents.test.ts:45-48` (temp `WIKI_DIR`), `:528` (`seedAgent` describe, real storage).
- `src/lib/__tests__/lifecycle.test.ts` -- COUNTER-check; must stay green **unedited**.

## Tasks & Acceptance

**Execution:**
- `src/mcp.ts` -- pass `{ fresh: true, strict: true }` at `:248`, `:308`, `:1420`; comment at `:308` naming the `PUT`-parity claim it makes true, and at `:248` naming "a blip must not read as a free slug".
- `src/cli.ts` -- pass the option at `:431`; comment noting the rethrow surfaces through `main().catch` as `Error: <storage message>`, not the `not found` line.
- `src/lib/query.ts` -- pass the option at `:507`; comment naming the silent `createOnly` fork a blip would cause.
- `src/lib/ingest.ts` -- pass the option at `:1432`; comment naming the duplicate page a blip's `null` would create.
- `src/lib/document-sources.ts` -- pass the option at `:94`.
- `src/lib/source-cascade.ts` -- pass the option at `:229`; comment naming the silently-skipped page.
- `src/lib/agents.ts` -- pass the option at `:792` and `:934` **and delete both `.catch(() => null)` tails**, with a comment naming why the tail could not stay.
- `src/lib/ingest-bookkeeping.ts` -- pass the option at `:53` and `:220`; comment at `:220` naming the duplicate-summary hazard a skipped page causes.
- `src/app/api/wiki/[slug]/route.ts` -- convert the DELETE read at `:50` and wrap it in a local `try`/`catch` returning `{ error: getErrorMessage(err) }` at 500, with a comment naming the outer catch's 400 fall-through as the reason the wrap exists.
- `src/app/api/wiki/route.ts` -- convert the conflict read at `:104`; comment that a blip must not be read as a free slug.
- `src/app/api/wiki/[slug]/revisions/route.ts` -- convert the GET read at `:29`; comment pointing at the sibling POST at `:138` that already does this.
- `src/lib/__tests__/wiki-routes.test.ts` -- add a describe beside the DW-378 block covering six matrix rows: DELETE blip (5xx, body not `page not found`, page still stored), DELETE genuine absence (404), `POST /api/wiki` conflict-read blip (5xx, no 201, existing bytes untouched), `POST` free slug (201), revisions `GET` blip (5xx, not `page not found`), revisions `GET` genuine absence (404).
- `src/lib/__tests__/mcp.test.ts` -- add three rows: `handleUpdatePage` under a read blip rejects with the storage message and not `Page not found`; `handleUpdatePage` on an absent slug still rejects `Page not found`; `handleCreatePage` under a blip rejects and writes no page.
- `src/lib/__tests__/agents.test.ts` -- add one row: a read blip during `seedAgent` rejects with the storage message instead of taking the `createOnly` branch, pinning the `.catch` removal.

**Acceptance Criteria:**
- Given the fifteen call sites named in the Code Map, when this change lands, then each carries `{ fresh: true, strict: true }` and no other `readWikiPage`/`readWikiPageWithFrontmatter` caller is edited.
- Given `src/lib/agents.ts`, when this change lands, then neither converted read is followed by a `.catch(() => null)`.
- Given a converted read that rethrows a non-ENOENT storage error, when the failure reaches the nearest HTTP handler, then the status is 5xx — never 404 and never 400.
- Given `readWikiPage`'s signature, when this change lands, then `ReadWikiPageOptions` is unchanged.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures and `src/lib/__tests__/lifecycle.test.ts` is unedited.

## Spec Change Log

- **Record correction, 2026-09-05 — `:366` was removed from the `src/cli.ts` group in the pure-display-read Never bullet (DW-696).** That entry was never a display read: it names `runCreate`'s create-conflict guard, whose `null` answer is the sole authorization for the create below it. The site has since moved to `src/cli.ts:378` and was already converted to `await readWikiPage(slug, { fresh: true, strict: true })` by the `dw3-create-conflict-fresh-reads` sweep (`f1c69c6a`), whose commit message records the conversion as DW-425; DW-195 (freshness) and DW-378 (strictness) are the two reasons the guard's own comment block at `:366`–`:375` gives for the option pair, and a catch at `:379` prints `Error: could not read page "<slug>": … Nothing was created.` — so the old address is a comment line today. (Chase the commit rather than the id: the entry the ledger currently numbers DW-425 is an unrelated Settings keyboard observation.) Left in the list, the clause read as authority to revert that guard back to an option-less read. Only that one entry was removed: `src/cli.ts:279` and `:327` are still option-less `readWikiPageWithFrontmatter` calls whose answers are only printed, so the clause remains correct about them and the rest of the bullet is unchanged. This is a record correction, not an amendment of approved content — no decision, acceptance criterion or design ruling in this spec changes meaning, and its `status`, `## Code Map` and `## Tasks & Acceptance` are untouched.

## Review Triage Log

## Design Notes

The two `agents.ts` sites are the only ones where the option alone changes nothing: `readWikiPageWithFrontmatter(slug, { fresh: true, strict: true }).catch(() => null)` throws and is immediately swallowed back into the same `null` that takes the `createOnly` branch. The tail has to go for the conversion to exist at all — and removing it also stops an unparseable frontmatter block from being read as "no page here, create one".

The DELETE door is the only site whose enclosing handler misclassifies the rethrow. Its catch is a two-branch ladder (`page not found` → 404, else 400) rather than the `PUT` route's "else 500", so the repair is a local wrap rather than a change to the ladder — `invalid slug` and every other message keep the 400 they have today.

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
- `pnpm exec vitest run --project node src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/mcp.test.ts src/lib/__tests__/agents.test.ts src/lib/__tests__/agents-route.test.ts src/lib/__tests__/agents-id-route.test.ts src/lib/__tests__/query.test.ts src/lib/__tests__/document-sources.test.ts src/lib/__tests__/revisions.test.ts src/lib/__tests__/lifecycle.test.ts` -- expected: all pass. `lifecycle.test.ts` is the COUNTER-check (a non-strict `{ fresh: true }` read must still survive an index outage) and must stay green without being edited.
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm exec eslint src` -- expected: no new errors
- `pnpm test` -- expected: full suite green, no new failures
- The `strict: true` count across the eleven changed source files -- baseline is `3`, **expected after: exactly `18`**:

```sh
grep -c "strict: true" \
  src/mcp.ts src/cli.ts src/lib/query.ts src/lib/ingest.ts \
  src/lib/document-sources.ts src/lib/source-cascade.ts src/lib/agents.ts \
  src/lib/ingest-bookkeeping.ts src/app/api/wiki/route.ts \
  "src/app/api/wiki/[slug]/route.ts" \
  "src/app/api/wiki/[slug]/revisions/route.ts" \
  | awk -F: '{s+=$2} END {print s}'
```

- The `.catch(() => null)` tails are gone from the two converted agent reads -- **expected: no output**:

```sh
perl -0777 -ne 's/\s+/ /g;
  print "VIOLATION: swallowed strict read\n"
    while /readWikiPageWithFrontmatter\([^)]*strict: true[^)]*\)\s*\.catch/g;' \
  src/lib/agents.ts
```

- `git diff --stat -- src/lib/__tests__/lifecycle.test.ts` -- expected: no output
