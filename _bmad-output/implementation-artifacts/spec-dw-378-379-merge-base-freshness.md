---
title: 'Merge-base freshness sweep and UNREADABLE-page reporting'
type: 'bugfix'
created: '2026-08-27'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Merge-base reads outside the three files this bundle named still read
      through pageCache without strict, including the MCP edit door that
      documents itself as mirroring the PUT route this change fixed.
    evidence: |-
      Each site reads a page and hands those bytes back as `expectedContent`:
      src/mcp.ts:282 -> :349 (handleUpdatePage, whose comment at :286 says it
      "mirrors the REST surface at PUT /api/wiki/[slug]"), src/mcp.ts:1371 ->
      :1408, src/cli.ts:431 -> :468, src/lib/query.ts:507 -> :521,
      src/lib/ingest.ts:1432 -> :1484, src/lib/document-sources.ts:93 -> :126,
      src/lib/source-cascade.ts:229 -> :263, src/lib/agents.ts:792 -> :832 and
      :934 -> :977, src/lib/ingest-bookkeeping.ts:53 -> :76 and :186 -> :207.
      DW-379's location field named only patch-metadata.ts, merge.ts and
      lint-fix.ts, so these are out of this bundle's scope on the intent's own
      authority -- but they are the same hazard, and handleUpdatePage still
      answers "Page not found" (src/mcp.ts:284) for an unreadable page, which
      is DW-378 on the surface that claims parity with the fixed route.
    location: >-
      src/mcp.ts:282
    severity: medium
  - summary: >-
      Write-authorizing reads that are not merge bases -- the DELETE route's ACL
      read and the two create-conflict guards -- still swallow a storage blip as
      "absent" and read through pageCache.
    evidence: |-
      src/app/api/wiki/[slug]/route.ts:50 sits inside DELETE (handlers at 26 /
      146 / 356), not a GET: its frontmatter feeds canWriteFrontmatter at :60,
      and a non-ENOENT failure answers `page not found: <slug>` at :51-56, the
      exact DW-378 symptom on the delete door. src/app/api/wiki/route.ts:104
      and src/mcp.ts:222 are the mirror case: `const existing = await
      readWikiPage(slug)` refusing with 409 / "Page already exists" when
      truthy, so a blip reads as "absent" and lets a create proceed against a
      page that exists. Structurally identical to lint-fix.ts:351, which this
      bundle did convert. Not named by DW-378 or DW-379, so out of scope here.
      NOTE: this spec's Never clause misdescribes route.ts:50 as a GET read
      serving a response; the exclusion is right by the intent's enumeration,
      the stated reason is not.
    location: >-
      src/app/api/wiki/[slug]/route.ts:50
    severity: medium
  - summary: >-
      The revision-list GET still reports a storage blip as `page not found`, so
      DW-378's misreport survives on the read surface a human actually hits.
    evidence: |-
      src/app/api/wiki/[slug]/revisions/route.ts:29 reads without strict and
      turns the resulting null into a 404. DW-378's location field names only
      src/lib/wiki.ts:409 and the page write, and the read serves a response
      body rather than backing a write, so it is out of this bundle's scope --
      but the harm DW-378 describes (an answer that makes a human stop retrying
      and start recovering) applies to a reader at least as much as a writer.
    location: >-
      src/app/api/wiki/[slug]/revisions/route.ts:29
    severity: low
baseline_revision: 'be1548fb32621d23fa14f721e06dc9c3e3204e72'
---

<intent-contract>

## Intent

**Problem:** DW-379 — the read-modify-write paths in `src/lib/patch-metadata.ts`, the page revert in `src/app/api/wiki/[slug]/revisions/route.ts`, and nine sites in `src/lib/lint-fix.ts` still read their merge base through the module-global `pageCache`, so a concurrent bulk scan holding a superseded entry open makes the merge base a file that is no longer stored and the write lands it back. DW-378 — `readWikiPage` answers `null` for an UNREADABLE page as well as an absent one, so a storage blip on `PUT /api/wiki/[slug]`'s merge-base read is reported to the caller as `404 page not found`.

**Approach:** Finish the sweep `src/lib/merge.ts` already completed: pass `{ fresh: true, strict: true }` at every remaining read that feeds a write or authorizes a destructive fix. For DW-378 the stated blocker is gone — `strict` already exists on `readWikiPage`/`readWikiPageWithFrontmatter` (`src/lib/wiki.ts:404`), so `PUT` passes `strict: true` and its existing catch answers the rethrown storage failure as a 500. No change to `readWikiPage`'s `null` contract, and no new option.

## Boundaries & Constraints

**Always:**
- Use the established option literal `{ fresh: true, strict: true }` — the same spelling as `src/lib/merge.ts:390` and `src/lib/lint-fix.ts:60`.
- A read that is only a merge base or a write-authorizing guard changes; a read that merely serves a response body does not.
- A converted site's `null` answer keeps its existing meaning (page absent → the same 404 / `FixNotFoundError` it raised before). Only a non-ENOENT failure changes shape, from `null` to a throw.
- Every converted throw must reach a handler that answers 5xx, not 404 — verify the enclosing `catch` before converting a route.

**Block If:**
- A converted read has no enclosing error handler and the throw would escape to an unhandled rejection.

**Never:**
- Do not change `readWikiPage`'s `null` contract, add a new option to `ReadWikiPageOptions`, or touch its ~40 non-write callers.
- Do not convert `src/app/api/wiki/[slug]/route.ts:50` or `src/app/api/wiki/[slug]/revisions/route.ts:29` — those are `GET` reads that serve a response, not merge bases.
- Do not add write preconditions (`If-Match` gating) to any of these paths — the source spec's Never clause forbids it, and "do not gate it" is what this change preserves.
- Do not merge `src/lib/lint-fix.ts`'s adjacent `readWikiPage` + `readWikiPageWithFrontmatter` reads of the same slug into one call.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PUT storage blip | `PUT /api/wiki/<slug>` with a valid `If-Match`; the merge-base read fails with a non-ENOENT storage error | 500 carrying the storage error message | Rethrown by `strict`, classified 500 by the handler's existing catch |
| PUT genuinely absent page | `PUT /api/wiki/<slug>` for a slug with no stored file | Unchanged: 404 `page not found: <slug>` | No error expected |
| PATCH metadata storage blip | `patchMetadata` called while the page read fails with a non-ENOENT storage error | Throws; `PATCH /api/wiki/[slug]` answers 500, and no write runs | Error carries no `NOT_FOUND` code, so the status ladder falls through to 500 |
| Revert storage blip | `POST /api/wiki/<slug>/revisions` `{action:"revert"}` while the page read fails | 500; nothing written | Route's existing catch answers 500 |
| Fix under an open bulk scan | A lint fix runs while `pageCache` holds a superseded entry for the slug | The merge base is the stored file, not the cached entry | No error expected |
| Dangling-supersedes blip | `fixSupersededDangling` re-verifies the target while its read fails | Throws; the `supersedes` field is NOT cleared | A transient failure can never authorize the destructive clear |

</intent-contract>

## Code Map

- `src/lib/wiki.ts:404` -- `ReadWikiPageOptions.strict` already exists and is documented ("so a transient provider error can never authorize a destructive fix"); `readWikiPage` honours it at the silo read, the flat fallback, and `getPageIndex`. `readWikiPageWithFrontmatter` (`:534`) forwards `options` verbatim. READ-ONLY — no change here.
- `src/lib/merge.ts:182,390,396,503,523` -- the finished reference conversion. Copy this spelling.
- `src/app/api/wiki/[slug]/route.ts:197` -- `readWikiPageWithFrontmatter(slug, { fresh: true })`; the `!existing` 404 at `:199-202`. Catch at `:304-328` maps an unclassified error to 500 (`invalid slug` → 400 is the only other branch). **Change: add `strict: true`.**
- `src/app/api/wiki/[slug]/route.ts:347-414` -- `PATCH` delegates to `patchMetadata`; its status ladder keys off `err.code` (`LIFECYCLE_FIELD`/`NOT_OWNER`/`NOT_FOUND`), defaulting to 500. A raw storage error carries none of those. READ-ONLY.
- `src/lib/patch-metadata.ts:93` -- `readWikiPageWithFrontmatter(slug)`; its `existing.content` is the `expectedContent` merge base at `:185`. **Change.**
- `src/app/api/wiki/[slug]/revisions/route.ts:135` -- page revert's read; `existing.content` is `expectedContent` at `:207`. Catch at `:215` answers 500. **Change.** `:29` (GET) stays.
- `src/lib/lint-fix.ts:60,101,418,478,479,527` -- already converted; `:60` is the canonical shape.
- `src/lib/lint-fix.ts:161,168` -- `fixMissingCrossRef`'s source read (merge base at `:242`) and its separate frontmatter read for the HTML-artifact guard. **Both change, kept as two calls** — `src/lib/__tests__/lint-fix.test.ts:244-395` drives them through two distinct mocks (`mockedReadWikiPage` chained with `mockResolvedValueOnce`, `mockedReadWikiPageWithFrontmatter` separately).
- `src/lib/lint-fix.ts:185` -- `fixMissingCrossRef`'s target read (supplies the link title). **Change.**
- `src/lib/lint-fix.ts:278,283` -- `fixContradiction`'s source (merge base at `:308`) and other page. **Change.**
- `src/lib/lint-fix.ts:351` -- `fixMissingConceptPage`'s exists-guard before creating a page; twin of the converted `:101`. **Change.**
- `src/lib/lint-fix.ts:581,640,726` -- `fixStalePage`, `fixUnmigratedPage`, `fixSupersededDangling` merge bases (`expectedContent` at `:608`, `:704`, `:758`). **Change.**
- `src/lib/lint-fix.ts:736` -- `fixSupersededDangling`'s "did the target come back?" re-verification. Not in the ledger's enumeration but the same shape as the converted `:101`, and the one site where a swallowed blip directly authorizes a destructive clear. **Change.**
- `src/lib/__tests__/lint-fix.test.ts:867,876` -- the assertion idiom to copy: `expect(mockedReadWikiPage).toHaveBeenCalledWith("src", { fresh: true, strict: true })` plus a `mockRejectedValue` "fails closed" case asserting `writeWikiPageWithSideEffects` was not called.
- `src/lib/__tests__/wiki-routes.test.ts:1758-1815` -- the existing DW-195 fresh-merge-base test for `PUT`; extend near it, don't duplicate it.
- `src/lib/__tests__/patch-metadata.test.ts`, `src/lib/__tests__/lint-fix-route.test.ts` -- suites that exercise the other two converted paths.

## Tasks & Acceptance

**Execution:**
- `src/app/api/wiki/[slug]/route.ts` -- add `strict: true` to the `:197` merge-base read and rewrite its FRESH comment to say the read is also strict, and why the `:199` 404 now means only "absent" -- closes DW-378 without touching the `null` contract.
- `src/lib/patch-metadata.ts` -- pass `{ fresh: true, strict: true }` at `:93` with a one-line comment naming the merge base -- the `PATCH` frontmatter merge must not merge into cached bytes.
- `src/app/api/wiki/[slug]/revisions/route.ts` -- pass `{ fresh: true, strict: true }` at `:135` -- the revert's merge base.
- `src/lib/lint-fix.ts` -- pass `{ fresh: true, strict: true }` at `:161`, `:168`, `:185`, `:278`, `:283`, `:351`, `:581`, `:640`, `:726`, `:736` -- completes the file's sweep so no cached read feeds a write.
- `src/lib/__tests__/wiki-routes.test.ts` -- add a `PUT` case: merge-base read rejects with a non-ENOENT storage error, assert 500 and that the body is not `page not found`, and a companion asserting a genuinely absent page still answers 404 -- covers the DW-378 matrix rows.
- `src/lib/__tests__/lint-fix.test.ts` -- add per-fix assertions that each converted read was called with `{ fresh: true, strict: true }`, and a fails-closed case for `fixSupersededDangling` proving a rejected re-verification read does not clear `supersedes` -- covers the fix-path matrix rows.
- `src/lib/__tests__/patch-metadata.test.ts` -- assert `patchMetadata` reads with `{ fresh: true, strict: true }` and that a rejected read prevents any write -- covers the PATCH matrix row.
- `src/lib/__tests__/revert-attribution.test.ts` -- add revert cases: a rejected page read answers 5xx and writes nothing, an absent slug still answers 404, and a revert under an open stale `pageCache` still succeeds against the stored file -- covers the revert matrix row and pins both halves of the option.

**Acceptance Criteria:**
- Given a stored page and a concurrent bulk scan holding a superseded `pageCache` entry, when any converted path reads its merge base, then the bytes it merges into and writes back are the stored file's, not the cached entry's.
- Given the merge-base read fails with a non-ENOENT storage error, when a caller `PUT`s a page body, then the response status is 5xx and the message is not `page not found: <slug>`, and nothing is written.
- Given a slug that has no stored file, when a caller `PUT`s it, then the response is still 404 `page not found: <slug>`.
- Given `readWikiPage`'s signature and its ~40 existing callers, when this change lands, then `ReadWikiPageOptions` is unchanged and no caller outside the sweep list is edited.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures.

## Spec Change Log

_No bad_spec loopback occurred; this spec was never amended after implementation began._

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 2, low 7)
- defer: 3: (high 0, medium 2, low 1)
- reject: 13: (high 0, medium 0, low 13)
- addressed_findings:
  - `[medium]` `[patch]` `strict` forwards into `getPageIndex({ strict })`, so every converted write path now fails closed on an index-only outage -- a real widening no test observed (mutating `wiki.ts:446` left all suites green). Added two `PUT` rows to `wiki-routes.test.ts` failing only `derived-indexes/pages.json` (I/O error and malformed JSON), asserting 5xx and untouched bytes; both reproduce a silent 200 when reverted.
  - `[medium]` `[patch]` The wire-level claim "a fix-path blip answers 5xx, not 404" was asserted nowhere, though `lint-fix-route.test.ts` was in the Code Map. Added a real-storage row there plus an absent-page control; stripping `strict` from `lint-fix.ts:60` reproduces the 404.
  - `[low]` `[patch]` `patchMetadata` had no "genuinely absent still answers NOT_FOUND" companion to the `PUT`/revert rows. Added.
  - `[low]` `[patch]` The new DW-379 block in `lint-fix.test.ts` orphaned the "Human-only check types" banner from the describe it introduces. Block moved above it.
  - `[low]` `[patch]` `revert-attribution.test.ts`'s header still claimed the file covered only issue #500. Docblock extended to name the three merge-base rows.
  - `[low]` `[patch]` The three storage spies mixed `endsWith("<slug>.md")` and hardcoded `wikiRelPath(...)`, so a page that became silo-primary would silently stop being intercepted. Read spies unified on the suffix form; the exact-path `writeFile` that creates the stale-cache condition kept, with a comment on why the two differ.
  - `[low]` `[patch]` The `type: "html"` in the stale-cache fixture read as copy-paste misdirection. Investigated and NOT removed -- removing it turns the row red on the commons realm gate, so the argument is load-bearing; the misdirection was replaced with a comment naming the real reason.
  - `[low]` `[patch]` `readWikiPage`'s JSDoc still said it returns `null` on read failure and steered callers to `{ fresh: true }` alone. Documented that it can throw under `strict`, that `strict` reaches the page index, and that it does not cover slug validation. Docs only.
  - `[low]` `[patch]` This spec's own `grep` verification could not verify its claim (multi-line calls, and it never inspected the two route files). Replaced with a whitespace-collapsing walk over all four changed source files that prints only violations, confirmed silent on the clean tree and noisy under two separate mutations.

## Design Notes

`strict` is the pre-existing escape hatch, so the DW-378 fix is a two-word diff plus a comment, not a contract change: `readWikiPage` keeps answering `null` for an absent page for every other caller, and only the write paths opt into seeing the storage error. That is why the `PUT` 404 at `:199` survives — after the change it can only mean "absent", which is what it always claimed to mean.

The two adjacent reads in `fixMissingCrossRef` stay two reads. Only `sourcePage.content` is the merge base; the second read exists solely for the HTML-artifact `type` check, so there is no torn base to fix, and the suite distinguishes the two mocks.

```ts
// src/lib/lint-fix.ts — the shape to repeat
const sourcePage = await readWikiPage(slug, { fresh: true, strict: true });
if (!sourcePage) {
  throw new FixNotFoundError(`Source page not found: ${slug}`);
}
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/lint-fix.test.ts src/lib/__tests__/patch-metadata.test.ts src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/lint-fix-route.test.ts src/lib/__tests__/revert-attribution.test.ts src/lib/__tests__/lifecycle.test.ts src/lib/__tests__/wiki.test.ts` -- expected: all pass. `lifecycle.test.ts` is in the list as a COUNTER-check: it pins that a non-strict `{ fresh: true }` read still survives a page-index outage, the opposite of what the converted write paths must now do. It must stay green without being edited.
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm test` -- expected: full suite green, no new failures
- The option-literal invariant, across all four changed source files. The reads are multi-line in three of them and the two route files each keep one deliberate option-less `GET` read, so a line-oriented `grep` cannot express this. This collapses whitespace, walks every call, and prints only violations -- **expected: no output**:

```sh
perl -0777 -ne 's/\s+/ /g;
  while (/readWikiPage(?:WithFrontmatter)?\(([^)]*)\)/g) {
    my ($call, $args) = ($&, $1);
    next if $args =~ /fresh: true, strict: true/;      # converted: OK
    next if $ARGV =~ m{/api/} && $args !~ /fresh|strict/;  # route GET read: OK
    print "VIOLATION $ARGV: $call\n";
  }' \
  src/lib/lint-fix.ts src/lib/patch-metadata.ts \
  "src/app/api/wiki/[slug]/route.ts" "src/app/api/wiki/[slug]/revisions/route.ts"
```

  Confirmed to FAIL as intended: stripping `strict` from `lint-fix.ts` reports `VIOLATION ... readWikiPage(slug, { fresh: true })`, and stripping it from the `PUT` route reports the multi-line site as `VIOLATION ... readWikiPageWithFrontmatter(slug, { fresh: true, })`.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Finished the merge-base sweep DW-379 opened and closed DW-378 without touching `readWikiPage`'s `null` contract. Thirteen reads that back a write now pass `{ fresh: true, strict: true }` — the same literal `src/lib/merge.ts` already uses — so the bytes a write merges into are the stored file rather than a `pageCache` entry a concurrent bulk scan is holding, and a non-ENOENT storage failure is rethrown instead of collapsing into `null`. On `PUT /api/wiki/[slug]` that rethrow reaches the handler's existing catch and answers 5xx, so the 404 beside it now means only what it always claimed: nothing is stored here. `ReadWikiPageOptions` gained no new option and no caller outside the sweep changed.

### Files changed

- `src/app/api/wiki/[slug]/route.ts` — `PUT`'s merge base is now strict as well as fresh (DW-378); comment records why the 404 below it narrowed.
- `src/lib/patch-metadata.ts` — the `PATCH` frontmatter merge base is fresh + strict.
- `src/app/api/wiki/[slug]/revisions/route.ts` — the page revert's merge base is fresh + strict.
- `src/lib/lint-fix.ts` — the ten remaining reads (`:161 :168 :185 :278 :283 :351 :581 :640 :726 :736`) converted; `:736` is beyond the ledger's enumeration and is the one site where a swallowed blip directly authorized a destructive clear.
- `src/lib/wiki.ts` — documentation only: `readWikiPage` can throw under `strict`, `strict` reaches the page index, and it does not cover slug validation.
- `src/lib/__tests__/wiki-routes.test.ts` — `PUT` blip → 5xx, absent → 404, and two index-only-outage rows.
- `src/lib/__tests__/patch-metadata.test.ts` — stale-cache merge base, blip → throw without `NOT_FOUND`, absent → `NOT_FOUND`.
- `src/lib/__tests__/revert-attribution.test.ts` — revert blip → 5xx, absent → 404, stale-cache revert still succeeds.
- `src/lib/__tests__/lint-fix-route.test.ts` — the wire answer for a fix-path blip (5xx, not 404) plus an absent-page control.
- `src/lib/__tests__/lint-fix.test.ts` — per-site option-literal pins for all ten conversions and a fails-closed `fixSupersededDangling` row.

### Review findings

- Patches applied: 9 (medium 2, low 7) — see the Review Triage Log entry.
- Items deferred: 3 (medium 2, low 1) — recorded in frontmatter `deferred`.
- Items rejected: 13 — pre-existing patterns or disproved claims. The notable disproved one: `strict` was said to turn a genuinely absent page into a 500 on R2, but `src/lib/storage/r2.ts:453-460` mints an absence error carrying `code = "ENOENT"`, so `isEnoent` catches it and absence still answers `null`.
- Follow-up review recommended: **true**. Patched severities: high 0, medium 2, low 7 → 3 × 2 + 1 × 7 = 13, which is ≥ 5.

### Verification performed

- `pnpm exec tsc --noEmit` — clean.
- `pnpm lint` — clean (the three `jsx-ast-utils` notices are pre-existing; 0 errors, 0 warnings).
- `pnpm exec vitest run --project node` over the seven files named in `## Verification` — 433 passed.
- `pnpm test` — 328 files, 7567 passed, 1 skipped, 0 failed.
- The option-literal walk in `## Verification` — silent on the clean tree, and confirmed to report a violation when `strict` is stripped from either `src/lib/lint-fix.ts` or the `PUT` route.
- Every converted site was mutation-checked individually: reverting the literal at any one of the thirteen produces a failing test, so no site is unpinned. Both halves are pinned separately on the three paths that have real-storage coverage (dropping `fresh` fails a stale-cache row; dropping `strict` fails a blip row).
- Matrix audit: all six I/O rows have a covering test that ran and passed in the runs above.

### Residual risks

- The `<intent-contract>` Never clause misdescribes `src/app/api/wiki/[slug]/route.ts:50` as a `GET` read that serves a response. It is inside `DELETE` (handlers at 26 / 146 / 356) and is a write-authorizing ACL read. Excluding it was still correct — neither DW-378 nor DW-379 names it — but the stated reason is wrong, and the site is recorded in `deferred` so the misdescription does not bury it. The contract is read-only, so it was left as written.
- Nine of the ten `src/lib/lint-fix.ts` conversions are pinned by call-argument assertions against a wholesale `vi.mock` of `../wiki`, not by cached-versus-stored bytes; that suite has no `pageCache`. The behaviour those literals buy is pinned end-to-end elsewhere — `wiki.test.ts` for `fresh`, `wiki-routes` / `patch-metadata` / `revert-attribution` for both halves over real storage, and `lint-fix-route.test.ts` for the fix path's wire answer.
- `strict` narrows what an index outage permits: a readable page can no longer be saved while `derived-indexes/pages.json` is unreadable or malformed. This is deliberate (a silent scan fallback can resolve the wrong silo and change which page is the merge base) and is now pinned in both directions — `wiki-routes.test.ts` for the strict write paths, `lifecycle.test.ts:926-943` for the non-strict read that must keep surviving it.
