---
title: 'Finish the fresh+strict sweep: the last merge-base reads, the revisions GET, and the delete path second read'
type: 'bugfix'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `cascadeDeleteSource`'s enumeration read decides which pages enter the
      cascade at all, and a storage blip there drops a page silently while the
      raw source bytes are still deleted.
    evidence: |-
      `src/lib/source-cascade.ts:193` runs
      `readWikiPageWithFrontmatter(entry.slug)` with no options inside the loop
      that builds `summaries` and `others`. A non-ENOENT blip flattens to
      `null`, `if (!page) continue` skips the page, and the result is PERSISTED
      into the resume marker written at `:203` — after which `if (resumed)`
      skips enumeration entirely, so a retry inherits the omission. The cascade
      then reaches `deleteRawSourceBytes` at `:281` and removes the raw bytes
      anyway, returning success with the skipped page still carrying a
      `sources:` entry that points at bytes that no longer exist. This is
      verbatim the harm that justifies the conversion 40 lines below it at
      `:229`, which this bundle did convert. The new row in
      `src/lib/__tests__/strict-merge-base-reads.test.ts` deliberately arms
      AROUND this read to reach the converted one, so the gap is now documented
      in a test rather than closed. Out of scope on the intent's own authority:
      the bundle intent and DW-495's location list name `source-cascade.ts:229`
      only, and this read backs no `expectedContent`.
    location: >-
      src/lib/source-cascade.ts:193
    severity: medium
baseline_revision: 'bd8ed03ec572c5bbfdd223b276bdc2d2d7a555e1'
---

<intent-contract>

## Intent

**Problem:** Ten reads still call `readWikiPage`/`readWikiPageWithFrontmatter` with no options, so a non-ENOENT storage failure flattens to `null` and is reported as an absent page. Seven of them (DW-495) hand those cached bytes back as `expectedContent`, so a blip either merges against bytes that are gone or silently takes the `createOnly` / skip / duplicate branch. One (DW-497) is the revision-list `GET`, the read surface a human actually hits, where the blip answers `page not found`. Two (DW-691) are the delete path's own second read — `deleteWikiPage`'s title read and the MCP delete mirror — which still report a stored page as absent through the very door DW-496 just hardened, under a comment claiming parity with it.

**Approach:** Pass the established `{ fresh: true, strict: true }` at all ten sites, remove the two `.catch(() => null)` tails in `src/lib/agents.ts` that would otherwise swallow the rethrow, and pin each blip case with a test. No change to `readWikiPage`'s `null` contract, no new option, no change to `ReadWikiPageOptions`, no change to any error-classification ladder (every enclosing handler already answers 5xx / rethrows).

## Boundaries & Constraints

**Always:**
- Use the established option literal `{ fresh: true, strict: true }` exactly as `src/lib/lint-fix.ts:83` and `src/app/api/wiki/[slug]/route.ts:63` spell it. Let Prettier decide whether it wraps.
- A converted site's `null` answer keeps its existing meaning — page absent takes the same 404 / `page not found` / `createOnly` / skip path it took before. Only a non-ENOENT failure changes shape, from `null` to a throw.
- Every converted throw must reach a handler that answers 5xx (or, off HTTP, a rejection whose message names the storage failure) — never 404 and never 400. The Code Map records the verified handler for each site; if one turns out to misclassify, repair it locally rather than editing a shared ladder.
- Remove `src/lib/agents.ts`'s two `.catch(() => null)` tails when converting those reads; left in place they swallow the rethrow and the conversion means nothing.
- Every converted call site keeps its enclosing function's control flow; only the option literal changes.
- Each converted site carries a short comment naming what the blip would otherwise have been reported as.

**Block If:**
- A converted read's rethrow can only reach a handler that answers 404 or 400 and the correct classification is not derivable from the code (i.e. fixing it would need a product decision about the wire contract).

**Never:**
- Do not change `ReadWikiPageOptions`, `readWikiPage`'s or `readWikiPageWithFrontmatter`'s `null` contract, or add an option.
- Do not convert reads that neither authorize a write nor serve an existence answer — the display/scan reads (`src/lib/source-cascade.ts:193`, `src/lib/ingest-bookkeeping.ts:242`, `src/mcp.ts:157`/`:515`/`:652`/`:716`/`:768`/`:819`/`:919`/`:1097`/`:1187`/`:1390`/`:1413`, `src/lib/ingest.ts:277`/`:1135`-`:1178`/`:1915`/`:2048`-`:2075`) stay exactly as they are.
- Do not modify any existing test in `src/lib/__tests__/lifecycle.test.ts` — it exercises `runIngestBookkeeping` and `cascadeDeleteSource` for real and is the counter-check that this change is behaviour-neutral without a blip. New rows for those two modules go in a new file instead.
- Do not touch the DELETE / PUT / POST catch ladders, the `page not found` / `Page already exists` copy, the 404/409 statuses, or any ACL/cloak behavior.
- Do not add a `principal` to `handleRevertRevision` or otherwise act on DW-424's deferred authorization finding.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Revisions `GET`, storage blip | page stored, existence read blips | 5xx, body NOT `page not found` | outer catch already answers 500 |
| Revisions `GET`, genuine absence | no stored file | 404 `page not found: <slug>` | unchanged |
| Revisions `GET`, stored page | page stored, no blip | 200 with `revisions` array | unchanged |
| REST `DELETE`, blip on the SECOND read | ACL read succeeds, `deleteWikiPage`'s read blips | 5xx, body NOT `page not found`; page still stored | rethrow classified 500 by the route's existing default |
| REST `DELETE`, genuine absence | no stored file | 404 `page not found: <slug>` | unchanged |
| `handleDeletePage`, storage blip | page stored, ACL read blips | rejects with the storage message, NOT `page not found` | thrown to the MCP caller |
| `handleDeletePage`, genuine absence | no stored file | rejects `page not found: <slug>` | unchanged |
| `saveAnswerToWiki`, storage blip | page stored at slug, merge-base read blips | rejects with the storage message; does NOT take `createOnly`; stored bytes untouched | route catch answers 500 |
| `seedAgent`, storage blip | identity page stored, read blips | rejects with the storage message; does NOT take `createOnly` | route catch answers 500 |
| `updateAgent` `addPages`, storage blip | page stored, read blips | rejects with the storage message | route catch answers 500 |
| `preserveDocumentSources`, storage blip | page stored, figure read blips | rejects with the storage message, NOT `was not found` | propagates to the caller's boundary |
| `cascadeDeleteSource`, storage blip | cited page stored, read blips | rejects with the storage message; page is NOT silently dropped from the cascade | route catch answers 500 |
| `runIngestBookkeeping`, blip on the `overview` read | `overview` stored, read blips | rejects with the storage message; does NOT take `createOnly` over the stored overview | ingest route answers 500 |
| `runIngestBookkeeping`, blip on the summary scan | an existing source summary is stored, its read blips | rejects with the storage message; does NOT mint a duplicate summary page | ingest route answers 500 |

</intent-contract>

## Code Map

Every anchor is at `bd8ed03e`. Each entry is `read line -> line that consumes it`, then the verified handler.

**DW-495 — merge-base reads (7 remaining; the other four in the ledger entry are already converted at `src/mcp.ts:258`, `:1472`, `src/cli.ts:465`, `src/lib/ingest.ts:1537`):**
- `src/lib/query.ts:507` -> `:521` -- `saveAnswerToWiki` (`:398`); `null` selects `createOnly`. Handlers: `src/app/api/query/save/route.ts:105-119` → 500; `src/app/api/chat/conversations/[id]/save/route.ts` → 500; `src/mcp.ts:871` rethrows.
- `src/lib/document-sources.ts:94` -> `:127` -- `appendSourceFigures` (`:89`); already throws on `null`, but with the wrong message (`page "<slug>" was not found`). Called from `preserveDocumentSources` (`:137`) at `:198`.
- `src/lib/source-cascade.ts:229` -> `:263` -- `cascadeDeleteSource` (`:167`); `null` silently drops the slug from `others` and leaves the dead source reference in place. Handler: `src/app/api/workbench/source/route.ts:37-43` → 500.
- `src/lib/agents.ts:792` -> `:832` -- `updateAgent` (`:642`), `addPages` arm. **Ends in `.catch(() => null)` at `:792-794` — delete the tail.** Handler: `src/app/api/agents/[id]/route.ts:265-296` → 500 (its 400 branch matches only agent-validation copy).
- `src/lib/agents.ts:934` -> `:977` -- `seedAgent` (`:900`). **Same `.catch(() => null)` at `:934-936` — delete it.** Handler: `src/app/api/agents/seed/route.ts:119-138` → 500 (same shape).
- `src/lib/ingest-bookkeeping.ts:53` -> `:76` -- `regenerateOverview` (`:29`); `null` writes the overview with `createOnly` over a stored one.
- `src/lib/ingest-bookkeeping.ts:220` -> `:207` -- the read inside `findExistingSourceSummary` (`:213`), whose returned `content` becomes `expectedContent` in `ensureSourceSummary` (`:138`). A skipped page also mints a DUPLICATE summary page. Both bookkeeping sites reach `src/lib/ingest.ts:1941`/`:2420` → `src/app/api/ingest/route.ts:244` → 500.

**DW-497 — read surface (1):**
- `src/app/api/wiki/[slug]/revisions/route.ts:29` -- `GET` existence check; `:30-34` answers 404. Catch at `:84-88` answers 500 for anything but `invalid slug`. The sibling `POST` at `:138` is already `{ fresh: true, strict: true }` with the DW-379 comment to mirror — this is the parity gap.

**DW-691 — the delete path's own second read (2):**
- `src/lib/lifecycle.ts:1171` -- inside `deleteWikiPage` (`:1154`); throws `page not found: ${slug}` at `:1173`. Runs AFTER the route's now-strict ACL read, and `src/app/api/wiki/[slug]/route.ts:113` maps `message.startsWith("page not found")` → 404, so a blip here still answers "your page is gone" through the hardened door. Its locked sibling `deleteWikiPageWhileLocked` (`:1232`) is ALREADY strict — that is the in-file precedent.
- `src/mcp.ts:450` -- `handleDeletePage` (`:438`) ACL read; throws `page not found: ${args.slug}` at `:451-452`, under the parity comment at `:443`. Errors surface as MCP rejections; `src/lib/mcp-http.ts` maps no 404 for this tool.

**Reference patterns (read-only, do not edit):**
- `src/lib/wiki.ts:342-418` -- `ReadWikiPageOptions` + `readWikiPage` docs; `:458-467` and `:485-490` are where `strict` rethrows.
- `src/app/api/wiki/[slug]/route.ts:50-64` -- the DW-378/DW-195 comment + literal to mirror.
- `src/app/api/wiki/[slug]/revisions/route.ts:134-141` -- the DW-379 comment on the sibling POST.

**Test anchors:**
- `src/lib/__tests__/wiki-routes.test.ts:2099-2210` -- the DW-496 describe. Reuse its `seed`, `del`, `blipOn` shape; global `beforeEach` at `:66` (temp `WIKI_DIR`), `getPrincipal` mocked at `:6-10` to `test-user`.
- `src/lib/__tests__/mcp.test.ts:545-607` -- the DW-496 `handleCreatePage` blip row (the `storage unavailable` spy shape); temp-dir `beforeEach` at `:124`.
- `src/lib/__tests__/agents.test.ts:528` (`seedAgent` describe), `:749` (`updateAgent` describe); setup at `:41-51`. **`vi` is not yet imported at `:1` — add it.**
- `src/lib/__tests__/query.test.ts:890` -- `saveAnswerToWiki` describe; LLM/embeddings already mocked at `:17-27`.
- `src/lib/__tests__/document-sources.test.ts:37` -- `preserveDocumentSources` describe; setup at `:16-28`. **`vi` is not imported — add it.**
- `src/lib/__tests__/lifecycle.test.ts:1-76` -- the temp-dir/lock setup to copy into the new file; `:1658-1745` (bookkeeping) and `:1748-1830` (cascade) show how to drive those two modules.

## Tasks & Acceptance

**Execution:**
- `src/lib/query.ts` -- pass the option at `:507`; comment naming the silent `createOnly` fork over a stored page that a blip would otherwise cause.
- `src/lib/document-sources.ts` -- pass the option at `:94`; comment naming the misleading `was not found` message a blip would otherwise produce.
- `src/lib/source-cascade.ts` -- pass the option at `:229`; comment naming the silently-skipped page and the dead source reference left behind.
- `src/lib/agents.ts` -- pass the option at `:792` and `:934` **and delete both `.catch(() => null)` tails**, with a comment at each naming why the tail could not stay.
- `src/lib/ingest-bookkeeping.ts` -- pass the option at `:53` and `:220`; comment at `:53` naming the `createOnly` overwrite of a stored overview, and at `:220` naming the duplicate-summary page a skipped read causes.
- `src/app/api/wiki/[slug]/revisions/route.ts` -- convert the GET read at `:29`; comment pointing at the sibling POST at `:138` that already does this and naming the 404 a blip would otherwise answer a human reader.
- `src/lib/lifecycle.ts` -- convert the read at `:1171`; comment naming the route's `page not found` → 404 mapping this read reaches, and pointing at the already-strict sibling at `:1232`.
- `src/mcp.ts` -- convert the read at `:450`; comment naming the parity claim at `:443` that this makes true.
- `src/lib/__tests__/wiki-routes.test.ts` -- add a describe covering five matrix rows: revisions `GET` blip (5xx, body not `page not found`), revisions `GET` genuine absence (404), revisions `GET` on a stored page (200 + `revisions`), DELETE with the blip on the SECOND read only (5xx, not `page not found`, page still stored), DELETE genuine absence (404, unchanged).
- `src/lib/__tests__/mcp.test.ts` -- add two rows: `handleDeletePage` under a read blip rejects with the storage message and not `page not found`; `handleDeletePage` on an absent slug still rejects `page not found`.
- `src/lib/__tests__/agents.test.ts` -- add two rows pinning the `.catch` removals: a read blip during `seedAgent` rejects with the storage message instead of taking the `createOnly` branch, and the same for `updateAgent`'s `addPages` arm.
- `src/lib/__tests__/query.test.ts` -- add one row: `saveAnswerToWiki` over a stored slug whose merge-base read blips rejects with the storage message and leaves the stored bytes untouched.
- `src/lib/__tests__/document-sources.test.ts` -- add one row: `preserveDocumentSources` under a page-read blip rejects with the storage message, not `was not found`.
- `src/lib/__tests__/strict-merge-base-reads.test.ts` -- NEW file (so `lifecycle.test.ts` stays unedited). Copy the temp-dir/lock setup from `lifecycle.test.ts:36-76` and add three rows: `cascadeDeleteSource` blip on a cited page rejects instead of silently dropping it; `runIngestBookkeeping` blip on the stored `overview` rejects rather than taking `createOnly`; `runIngestBookkeeping` blip on the stored source summary during the scan rejects rather than minting a duplicate summary page.

**Acceptance Criteria:**
- Given the ten call sites named in the Code Map, when this change lands, then each carries `{ fresh: true, strict: true }` and no other `readWikiPage`/`readWikiPageWithFrontmatter` caller is edited.
- Given `src/lib/agents.ts`, when this change lands, then neither converted read is followed by a `.catch(() => null)`.
- Given a converted read that rethrows a non-ENOENT storage error, when the failure reaches the nearest HTTP handler, then the status is 5xx — never 404 and never 400.
- Given `readWikiPage`'s signature, when this change lands, then `ReadWikiPageOptions` is unchanged.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures and no existing test in `src/lib/__tests__/lifecycle.test.ts` is modified.

## Spec Change Log

- **Planning, 2026-09-03 — scope reconciliation.** The bundle intent's prose counts "six library sites" and omits `src/lib/ingest-bookkeeping.ts:220`, but DW-495's verbatim `reason` field names `src/lib/ingest-bookkeeping.ts:186 -> :207` (that read, at its `bd8ed03e` line number) as one of its eleven sites, and the intent's own headline is "finish the sweep on every write-authorizing or existence-answering read the earlier bundles enumerated past … Convert all of them." Resolving DW-495 while leaving a site it names unconverted would close the entry over a live hazard, so the site is IN. KEEP: the site inventory is reconciled against the ledger entry text, not against the intent's arithmetic.

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 1: (high 0, medium 1, low 0)
- reject: 15: (high 0, medium 2, low 13)
- addressed_findings:
  - `[medium]` `[patch]` The `fresh: true` half of all ten conversions was pinned by nothing — a reviewer stripped it from every site, kept `strict: true`, and the whole node project stayed green (each blip row throws from `storage.readFile`, which a cache hit never reaches). Added three stale-`pageCache` rows on the DW-496 precedent at `wiki-routes.test.ts:2260`, one per distinct observable: the delete ACL (`mcp.test.ts`, `handleDeletePage` off a rewritten `owner:`), the existence answer (`wiki-routes.test.ts`, revisions `GET` off a stale NEGATIVE cache entry), and a merge base (`query.test.ts`, `saveAnswerToWiki`). Each was mutation-checked: removing `fresh: true` from its own site fails that row and no other, and the ten-site sweep now fails exactly three rows.
  - `[low]` `[patch]` The revisions `GET` comment justified only `strict` and borrowed the sibling `POST`'s merge-base rationale for `fresh`, which does not transfer to a read that seeds no precondition. Rewritten: `fresh` now stands on `pageCache`'s NEGATIVE entries, which can manufacture the very `page not found` the conversion removes, and `strict`'s reach into `getPageIndex({ strict })` — a corrupt `derived-indexes/pages.json` now 500s this read surface instead of degrading to the scan fallback — is named as the deliberate trade.

## Design Notes

The two `agents.ts` sites are the only ones where the option alone changes nothing: `readWikiPageWithFrontmatter(slug, { fresh: true, strict: true }).catch(() => null)` throws and is immediately swallowed back into the same `null` that takes the `createOnly` branch. The tail has to go for the conversion to exist at all — and removing it also stops an unparseable frontmatter block from being read as "no page here, create one".

DW-691's REST row needs a blip that spares the FIRST read (the route's ACL read) and fails the SECOND (`deleteWikiPage`'s). A one-shot-inverted spy does that deterministically — serve the first successful `<slug>.md` read, fail every later one — because nothing between the two reads touches `<slug>.md`:

```ts
function blipAfterFirstServedRead(slug: string) {
  const storage = getStorage();
  const originalRead = storage.readFile.bind(storage);
  let served = 0;
  return vi.spyOn(storage, "readFile").mockImplementation(async (filePath: string) => {
    if (!filePath.endsWith(`${slug}.md`)) return originalRead(filePath);
    if (served > 0) throw new Error("storage unavailable");
    const content = await originalRead(filePath); // ENOENT still propagates unchanged
    served += 1;
    return content;
  });
}
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/mcp.test.ts src/lib/__tests__/agents.test.ts src/lib/__tests__/agents-route.test.ts src/lib/__tests__/agents-id-route.test.ts src/lib/__tests__/query.test.ts src/lib/__tests__/document-sources.test.ts src/lib/__tests__/strict-merge-base-reads.test.ts src/lib/__tests__/lifecycle.test.ts src/lib/__tests__/revert-attribution.test.ts src/lib/__tests__/workbench-epic2-routes.test.ts` -- expected: all pass. `lifecycle.test.ts` is the counter-check and must stay green **unedited**.
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm exec eslint src` -- expected: no new errors
- `pnpm test` -- expected: full suite green, no new failures
- The `strict: true` count across the eight changed source files -- baseline is `19`, **expected after: exactly `29`** (one added line per converted site):

```sh
grep -c "strict: true" \
  src/mcp.ts src/lib/query.ts src/lib/document-sources.ts \
  src/lib/source-cascade.ts src/lib/agents.ts src/lib/ingest-bookkeeping.ts \
  src/lib/lifecycle.ts "src/app/api/wiki/[slug]/revisions/route.ts" \
  | awk -F: '{s+=$2} END {print s}'
```

- The `.catch(() => null)` tails are gone from the two converted agent reads -- **expected: no output**:

```sh
perl -0777 -ne 's/\s+/ /g;
  print "VIOLATION: swallowed strict read\n"
    while /readWikiPageWithFrontmatter\([^)]*strict: true[^)]*\)\s*\.catch/g;' \
  src/lib/agents.ts
```

- `git diff -- src/lib/__tests__/lifecycle.test.ts` -- expected: no output

## Auto Run Result

Status: done

### Summary

Finished the fresh+strict read sweep across the ten remaining `readWikiPage` / `readWikiPageWithFrontmatter` call sites that flattened a non-ENOENT storage failure into `null` and reported it as an absent page — seven DW-495 merge bases, the DW-497 revision-list `GET`, and both DW-691 delete-path second reads. Each site now passes `{ fresh: true, strict: true }`, carries a comment naming what the blip would otherwise have been reported as, and is pinned by a test. `agents.ts`'s two `.catch(() => null)` tails were removed, without which the option would have been a no-op. No change to `ReadWikiPageOptions`, `readWikiPage`'s `null` contract, or any error-classification ladder.

### Files changed

- `src/lib/query.ts` -- `saveAnswerToWiki`'s merge base is fresh+strict; a blip no longer forks into `createOnly` over a stored page.
- `src/lib/document-sources.ts` -- `appendSourceFigures`'s merge base is fresh+strict; a blip no longer surfaces as `page "<slug>" was not found`.
- `src/lib/source-cascade.ts` -- the `others`-loop merge base is fresh+strict; a blip no longer drops the slug from the cascade silently.
- `src/lib/agents.ts` -- `updateAgent`'s `addPages` read and `seedAgent`'s section read are fresh+strict, and both `.catch(() => null)` tails are deleted.
- `src/lib/ingest-bookkeeping.ts` -- the `overview` merge base and the `findExistingSourceSummary` scan read are fresh+strict; a blip no longer overwrites the overview via `createOnly` or mints a duplicate source summary.
- `src/app/api/wiki/[slug]/revisions/route.ts` -- the `GET` existence check is fresh+strict, matching the sibling `POST`; the comment names both the negative-cache case `fresh` covers and `strict`'s reach into `getPageIndex`.
- `src/lib/lifecycle.ts` -- `deleteWikiPage`'s title read is fresh+strict, so a blip on the delete path's SECOND read no longer reaches the route's `page not found` → 404 mapping.
- `src/mcp.ts` -- `handleDeletePage`'s ACL read is fresh+strict, making its "mirrors the REST surface at DELETE /api/wiki/[slug]" comment true.
- `src/lib/__tests__/wiki-routes.test.ts` -- new describe: revisions `GET` blip / absence / stored page, DELETE with the blip on the SECOND read only, DELETE absence, plus a stale-NEGATIVE-cache row pinning `fresh`.
- `src/lib/__tests__/mcp.test.ts` -- new describe: `handleDeletePage` blip and absence rows, plus a stale-page-cache row pinning the ACL's `fresh`.
- `src/lib/__tests__/agents.test.ts` -- two rows pinning the `.catch(() => null)` removals (`seedAgent`, `updateAgent`); `vi` added to the vitest import.
- `src/lib/__tests__/query.test.ts` -- a `saveAnswerToWiki` blip row and a stale-page-cache merge-base row.
- `src/lib/__tests__/document-sources.test.ts` -- a `preserveDocumentSources` blip row; `vi` added to the vitest import.
- `src/lib/__tests__/strict-merge-base-reads.test.ts` -- NEW. Blip rows for `cascadeDeleteSource` and both `runIngestBookkeeping` sites, kept out of `lifecycle.test.ts` so that counter-check stays unedited.

### Review findings

- Patches applied: 2 — 1 medium (`fresh: true` was pinned by nothing at all ten sites; three stale-`pageCache` rows added and mutation-checked), 1 low (the revisions `GET` comment borrowed a rationale for `fresh` that did not transfer, and did not name `strict`'s page-index reach).
- Items deferred: 1 — `src/lib/source-cascade.ts:193` (medium), the cascade's enumeration read, whose blip drops a page from the cascade permanently via the resume marker while the raw bytes are still deleted. Out of scope on the intent's own authority.
- Items rejected: 15 — pre-existing optionless reads no open entry names (`handleListRevisions`, `handleReadRevision`, `handleCurateToVault`, `freeSummarySlug`, the page-render reads, `listRevisions`/`readRevision`); partial-state-on-throw concerns in `seedAgent`, `preserveDocumentSources`, `runIngestBookkeeping` and `cascadeDeleteSource` (control flow is preserved by spec, and both bookkeeping and cascade carry resume markers); the `canReadSlug` second 404 on the revisions `GET` (a deliberate, documented fail-closed ACL cloak — changing it trades a misreport for a disclosure and needs a product decision); one claim that `lifecycle.ts` lacked `fresh` (an artifact of another reviewer's in-flight mutation of the tree).

### Follow-up review recommendation

Patched findings by severity: high 0, medium 1, low 1. Score: no high-severity patch → `followup_review_recommended: false`.

### Verification performed

- `pnpm test` — 372 files, 9211 passed, 1 skipped, no failures.
- `pnpm exec vitest run --project node` over the eleven-file spec list — all pass; `lifecycle.test.ts` green and unedited (`git diff` on it is empty).
- `pnpm exec tsc --noEmit` — exit 0, no output.
- `pnpm exec eslint src` — no errors (only the pre-existing `jsx-ast-utils` advisory lines, unchanged from baseline).
- `strict: true` count across the eight changed source files — 29 (baseline 19, +10, one per converted site).
- The `perl` guard for a strict read followed by `.catch` in `agents.ts` — no output.
- Matrix test audit — all fourteen I/O rows are covered by a named test that ran and passed in the verbose run.
- Mutation checks — every blip row fails when its own source change is reverted; each of the three new `fresh` rows fails when `fresh: true` is removed from its own site and no other, and the ten-site sweep fails exactly those three.
- The non-comment source diff is exactly the ten option literals plus the two removed `.catch` tails — nothing else.

### Residual risks

- `strict` propagates into `getPageIndex({ strict })`, so a corrupt or unreadable `derived-indexes/pages.json` now 500s `GET /api/wiki/[slug]/revisions` instead of degrading to the scan fallback. This is the established contract of the option and is now named in the route comment, but no test faults the index against this route in either direction.
- `GET /api/wiki/[slug]/revisions` can still answer `page not found` under a blip on its SECOND existence answer: `canReadSlug` (`src/lib/authz.ts:158`) does its own fresh+strict read and ends in `catch { return false }`, which the route maps to a 404. That catch is a deliberate, documented fail-closed cloak — surfacing the fault there would disclose that a private page exists — so it was left alone rather than traded without a decision.
- A blip inside `runIngestBookkeeping` or `cascadeDeleteSource` now rejects where it previously resolved with degraded state (a duplicate summary, a dead source reference). Both carry resume markers and are retried by their callers, but the failure is visible to the user as a failed ingest or a 500 from the workbench source delete.
