---
title: 'Every merge base reads past the page cache (DW-379)'
type: 'bugfix'
created: '2026-08-21'
baseline_revision: '05c4c9a519e0469b2698024d33d1e2e86239d37d'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The MCP page-write tools merge into `pageCache` bytes exactly as the REST
      doors did before this sweep.
    evidence: |-
      `handleUpdatePage` (`src/mcp.ts:279`) reads
      `readWikiPageWithFrontmatter(args.slug)` unqualified and re-serializes that
      frontmatter into its write; `handleRevertPage` (`src/mcp.ts:1366`) does the
      same and also takes its title fallback from it. These are the byte-for-byte
      twins of `patch-metadata.ts:96` and the revert route at
      `revisions/route.ts:145`, both swept here. Out of scope for this bundle:
      the ledger entry's `location` names `patch-metadata.ts`, `merge.ts` and
      `lint-fix.ts`, and the intent adds only the revisions route — `src/mcp.ts`
      is named nowhere. The same bulk scan makes an agent-driven update or revert
      revert an intervening save.
    location: src/mcp.ts:279, src/mcp.ts:1366
    severity: medium
  - summary: >-
      The create-conflict guards decide from a cached read, so a cached NEGATIVE
      entry lets a create write straight over a live page.
    evidence: |-
      `POST /api/wiki` (`src/app/api/wiki/route.ts:104`), `handleCreatePage`
      (`src/mcp.ts:221`) and the CLI (`src/cli.ts:366`, `:429`) each do
      `const existing = await readWikiPage(slug)` and refuse with 409 / an error
      when it answers a page. `readWikiPage` caches `null` too, so a scan that
      missed the slug before it was created leaves a negative entry that turns
      the guard off — the same failure this bundle closed for `fixStaleIndex`
      and `fixMissingConceptPage`, but with a full-page overwrite rather than a
      dropped index entry as the damage. Out of scope: none of these files is
      named by the intent or the ledger entry.
    location: src/app/api/wiki/route.ts:104, src/mcp.ts:221, src/cli.ts:366
    severity: medium
  - summary: >-
      `DELETE /api/wiki/[slug]` reads its ACL frontmatter through the cache and
      answers a storage blip as `page not found`.
    evidence: |-
      `src/app/api/wiki/[slug]/route.ts:53` reads unqualified and then decides
      `canWriteFrontmatter(existing.frontmatter, …)` from those bytes — an
      authorization verdict taken from a possibly superseded copy — and answers
      `null` as a 404 where `PUT` and `PATCH` beside it now answer 503 for the
      same fault. Out of scope: the delete is not a read-modify-write merge base
      and the intent names neither it nor the `DELETE` verb; closing it is the
      same one-line adoption plus the 503 branch its siblings already carry.
    location: src/app/api/wiki/[slug]/route.ts:53
    severity: medium
  - summary: >-
      The ingest write path's frontmatter merge bases still read through
      `pageCache`.
    evidence: |-
      `attachIngestTrigger` (`src/lib/ingest.ts:1381`) reads unqualified and
      re-serializes that page at `:1424` (`serializeFrontmatter(frontmatter,
      existing.body)`); the re-ingest merge base at `:1819` (which carries
      `created`, `source_count`, `tags`, `authors`, `owner`, `sources`) and
      `reingest`'s own read at `:521` have the same shape. Structurally identical
      to the `patchMetadata` site swept here, and the highest-traffic
      read-modify-write in the codebase. Out of scope: `ingest.ts` is named
      neither by the intent nor by the ledger entry's `location`.
    location: src/lib/ingest.ts:1381, src/lib/ingest.ts:1819, src/lib/ingest.ts:521
    severity: medium
  - summary: >-
      On the editor's two-leg save, a `PATCH` refusal now tells the owner
      "nothing was changed" after the body leg has already landed.
    evidence: |-
      `src/components/WikiEditor.tsx:259-303` saves the body with `PUT` and then
      `PATCH`es metadata, relaying the served `{ error }` verbatim into its error
      banner. With the 503 branch added here, a read blip on the second leg shows
      `PAGE_UNREADABLE_COPY` — "so nothing was changed" — to an owner whose body
      write did land. The previous answer (`page not found`) was also wrong, but
      it did not make a claim about what was written. Not closable inside this
      bundle: the spec's Never clause forbids new copy, and the alternative is a
      client change to the save flow (e.g. reporting the legs separately), which
      the intent does not reach.
    location: src/components/WikiEditor.tsx:288
    severity: medium
---

<intent-contract>

## Intent

**Problem:** DW-195 gave `readWikiPage` / `readWikiPageWithFrontmatter` a `{ fresh: true }` option and adopted it on the three precondition-bearing reads, but every OTHER read-modify-write path still merges into `pageCache` bytes: the `PATCH` frontmatter merge (`patch-metadata.ts:93`), the page revert (`revisions/route.ts:135`), `merge.ts:123,:165,:167`, and every read in `lint-fix.ts`. `pageCache` is module-global and ref-counted around bulk scans (`lint.ts`, `search.ts`, `query.ts`, `dataview.ts`), so a scan holding a superseded entry open across one of these requests makes the merge base a file that is no longer stored — and the write lands it back, silently reverting whatever else was saved in between.

**Approach:** A call-site sweep. Pass `{ fresh: true }` at every read on those paths whose result feeds the write that follows it, exactly as `PUT /api/wiki/[slug]` already does. Because a fresh read REFUSES a non-ENOENT storage failure (`PageUnreadableError`, DW-378/DW-380) instead of answering `null`, each door that can now surface that refusal classifies it into the answer the codebase already owns — 503 with `PAGE_UNREADABLE_COPY` — rather than letting it fall through to an unclassified 500.

## Boundaries & Constraints

**Always:**
- A read whose bytes, frontmatter, title or existence verdict decides a write on these paths is `{ fresh: true }`. That includes the re-verification guards (`fixStaleIndex`, `fixMissingConceptPage`, `fixSupersededDangling`), where a cached NEGATIVE entry is the same staleness pointed the other way: it drops the index entry of a page that exists, or clears a reference that has since become valid.
- Reads that feed no write stay cached. `GET /api/wiki/[slug]/revisions`'s existence check is a read; it does not change.
- The read contract is untouched: no signature change, no new option, no change to `pageCache`, its ref-counting, or the default (cached, fail-soft) behaviour any other caller sees.
- Where a door now meets `PageUnreadableError`, it answers `PAGE_UNREADABLE_STATUS` / `PAGE_UNREADABLE_COPY` from `src/lib/page-read-failure.ts` — imported, never re-worded, never a second constant.
- A genuinely absent page keeps its current answer everywhere: ENOENT is still `null`, still `page not found` / `FixNotFoundError`, still 404.
- Every new test row is mutation-checked: removing the `{ fresh: true }` it covers must make it fail.

**Block If:** closing a site would require gating a route with a write precondition, or changing `readWikiPage`'s null contract. Neither is needed — `{ fresh: true }` already exists and is opt-in per call.

**Never:**
- Do not gate `PATCH /api/wiki/[slug]`, the revisions/revert route, `POST /api/lint/fix`, `mergePages`, or `src/mcp.ts` with `If-Match` or any other precondition — the DW-193/195 spec's Never clause forbids it, and this bundle does not revisit it.
- Do not change `src/app/api/tasks/run/route.ts`. Its 4xx/5xx contract is queue semantics (4xx = ack and drop, 5xx = retry); a transient read failure is exactly what should be retried, so the unclassified 5xx is the right answer there.
- Do not add a status vocabulary to the MCP tools — they answer `isError` text, and the sentence already travels in the message.
- No new copy, no new error class, no new dependency, no refactor of the fix functions, no change to `merge.ts`'s merge semantics.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stale entry, `PATCH` metadata | `pageCache` open and holding superseded bytes for `slug` | The merge base is the STORED file: another actor's intervening change survives the patch | No error expected |
| Stale entry, page revert | `pageCache` open and stale; `POST .../revisions {action:"revert"}` | Frontmatter and title come from the stored file, not the cached one | No error expected |
| Stale entry, merge | `pageCache` open and stale for `into` and/or `from` | The survivor is folded from the stored bytes of both sides | No error expected |
| Stale entry, lint auto-fix | `pageCache` open and stale for the fixed page | The rewrite is applied to the stored bytes; the cached copy is never written back | No error expected |
| Cached negative entry, `stale-index` fix | `pageCache` holds `null` for a slug whose file exists | The index entry is KEPT — `Page "<slug>" exists — index entry is not stale` | No error expected |
| Cached negative entry, dangling `supersedes` | Cache holds `null` for the supersedes target, which exists | The reference is NOT cleared | No error expected |
| Read fails, `PATCH` | Non-ENOENT storage failure on the page read | 503, `PAGE_UNREADABLE_COPY`, nothing written | Not 404, not 500 |
| Read fails, revert | Non-ENOENT storage failure on the page read | 503, `PAGE_UNREADABLE_COPY`, nothing written | Not 404, not 500 |
| Read fails, lint fix | Non-ENOENT storage failure on the page read | 503, `PAGE_UNREADABLE_COPY`, nothing written | Not 404, not 500 |
| Page genuinely absent | ENOENT on every path | Unchanged: 404 `page not found: <slug>` / `FixNotFoundError` | — |
| Cache inactive | No scan open | Byte-identical behaviour to today | — |

</intent-contract>

## Code Map

- `src/lib/wiki.ts:326-372` -- `ReadWikiPageOptions.fresh`, already documented ("neither consults nor mutates the cache"; refuses a non-ENOENT failure). READ-ONLY: this bundle adds no option and changes no default.
- `src/lib/page-read-failure.ts` -- `PAGE_UNREADABLE_COPY`, `PAGE_UNREADABLE_STATUS` (503), `isPageUnreadableError`. Zero-dependency on purpose; import it at each new door.
- `src/app/api/wiki/[slug]/route.ts:206` -- the reference adoption (`existing` read + the comment explaining why). `:337-341` -- the 503 branch to copy into the PATCH ladder at `:419-430` (imports at `:18-20` already exist in this file). `PUT` itself is unchanged.
- `src/lib/patch-metadata.ts:93` -- `readWikiPageWithFrontmatter(slug)`; its frontmatter and body are re-serialized at `:150-176` and written at `:176`. One site.
- `src/app/api/wiki/[slug]/revisions/route.ts:135` -- `existing` read; supplies the merge frontmatter (`:183-198`) and the title fallback (`:174`). Catch ladder at `:213-225`. The `GET` read at `:29` stays cached.
- `src/lib/merge.ts:123` -- backlink source read, rewritten and written back at `:135`; the `null` branch at `:124-132` already documents that a transient fault must abort — a fresh read now makes that refusal explicit, so update that comment. `:165` `from` (body folded into the survivor, then hard-deleted) and `:167` `into` (the survivor's merge base) — all three fresh.
- `src/lib/lint-fix.ts` -- thirteen reads, every one feeding a write: `:55` (`fixOrphanPage`, writes the read bytes back verbatim), `:95` (`fixStaleIndex` guard), `:167`/`:174`/`:191` (`fixMissingCrossRef` source, artifact-type gate, target title), `:283`/`:288` (`fixContradiction` source + the other page, both LLM inputs for a full-body rewrite), `:355` (`fixMissingConceptPage` race guard), `:421` (`fixBrokenLink`), `:478` (`fixStalePage`), `:536` (`fixUnmigratedPage`), `:621`/`:631` (`fixSupersededDangling` base + target guard). The ledger's "several"/the bundle's "eleven" are the same sweep counted without `:191` and `:288`; both are included here because a stale title lands in the written link and a stale other-page shapes the LLM rewrite. `fixEmptyPage:134` reads nothing — unchanged.
- `src/app/api/lint/fix/route.ts:60-82` -- the fix door's catch ladder; add the 503 branch after the read-only branch, leaving `FixValidationError` 400 and `FixNotFoundError` 404 intact.
- `src/mcp.ts:369,421` -- `patchMetadata` / `mergePages` callers. READ-ONLY: MCP answers `isError` text, so the sentence travels as-is.
- `src/lib/__tests__/wiki-routes.test.ts:1595-1650` -- the DW-195 stale-cache row (populate cache → `fs.writeFile` past `writeWikiPage` → assert). `:1771-1840` -- `failReadsOfPage`, the exact-path storage-failure spy to reuse for the 503 rows.
- `src/lib/__tests__/wiki.test.ts:1940-2050` -- the `fresh` unit rows; the idiom for a cached-vs-stored assertion.
- `src/lib/__tests__/patch-metadata.test.ts`, `merge.test.ts`, `lint-fix.test.ts`, `lint-fix-route.test.ts` -- real temp-dir harnesses (`WIKI_DIR`/`RAW_DIR` per test); `beginPageCache` is exported from `../wiki`.

## Tasks & Acceptance

**Execution:**
- `src/lib/patch-metadata.ts` -- pass `{ fresh: true }` at `:93` with a one-line comment naming DW-379 and what the read is (the merge base for the frontmatter re-serialize) -- a `PATCH` must not re-serialize a body and frontmatter that are no longer stored.
- `src/app/api/wiki/[slug]/revisions/route.ts` -- fresh read at `:135`; add the `isPageUnreadableError` → 503 branch to the POST catch, above the `invalid slug` string match -- the revert's frontmatter merge base must be the stored file, and a blip is not "not found" or a server fault.
- `src/lib/merge.ts` -- fresh at `:123`, `:165`, `:167`; refresh the `:124-132` comment so it states that a transient fault now REFUSES (the `null` branch is the genuinely-absent case) -- a merge folds two bodies and then hard-deletes one of them; a stale side loses whatever was written in between with no revision of it anywhere.
- `src/lib/lint-fix.ts` -- fresh at all thirteen reads listed in the Code Map, with a short block comment at the top of the fix section stating the rule once (every read on this path decides a write) rather than repeating it thirteen times -- auto-fixes run right after a lint scan, whose `withPageCache` is the very cache that goes stale.
- `src/app/api/wiki/[slug]/route.ts` -- add the `isPageUnreadableError` → 503 branch to the PATCH catch ladder only; PUT and its imports are unchanged -- `patchMetadata`'s fresh read can now refuse, and the existing ladder would answer 500.
- `src/app/api/lint/fix/route.ts` -- import `isPageUnreadableError` / `PAGE_UNREADABLE_COPY` / `PAGE_UNREADABLE_STATUS` and answer 503, keeping the 400/404 branches -- same reason, one door over.
- `src/lib/__tests__/patch-metadata.test.ts` -- add a stale-cache row: open `beginPageCache`, read to populate, `fs.writeFile` a changed file directly past `writeWikiPage`, then `patchMetadata` and assert the stored change survives -- the merge base is what this bundle is about.
- `src/lib/__tests__/merge.test.ts` -- add a stale-cache row covering `into` and `from` -- one row, two sites, asserting the survivor carries the stored bytes of both.
- `src/lib/__tests__/lint-fix.test.ts` -- add three rows: `fixOrphanPage` (stale entry must not be written back), `fixStalePage` (stale frontmatter must not become the base), `fixStaleIndex` (a cached `null` for an existing page must not drop its index entry) -- one write-base, one frontmatter-base, one negative-entry guard.
- `src/lib/__tests__/wiki-routes.test.ts` -- add a revert stale-cache row and 503 rows for PATCH and revert, reusing `failReadsOfPage` -- the two route doors this bundle changes.
- `src/lib/__tests__/lint-fix-route.test.ts` -- add a 503 row for `POST /api/lint/fix` on an unreadable page -- the third door.

**Acceptance Criteria:**
- Given a bulk scan holds a superseded `pageCache` entry for a page, when any of `PATCH /api/wiki/[slug]`, the revert route, `mergePages`, or a lint auto-fix writes that page, then the bytes it merged into are the stored file's and the intervening change is still present afterwards.
- Given a cached NEGATIVE entry for a slug whose file exists, when `fixStaleIndex` runs for that slug, then the index entry is kept and the result reports the page exists.
- Given a non-ENOENT storage failure on the page read, when PATCH, revert, or `POST /api/lint/fix` is called, then the response is 503 with exactly `PAGE_UNREADABLE_COPY` and nothing is written.
- Given a page that is genuinely absent, when any of these paths runs, then the answer is what it is today (404 / `FixNotFoundError`), unchanged.
- Given each new test row, when its `{ fresh: true }` is removed from the source, then that row fails.
- Given the full suite, when `pnpm test` runs, then it passes with no new type or lint errors.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 6, low 2)
- defer: 5: (high 0, medium 5, low 0)
- reject: 13
- addressed_findings:
  - `[medium]` `[patch]` `merge.ts:127`'s fresh read was covered by nothing — the stale-cache row seeded no linker, and removing `{ fresh: true }` left the whole suite green. Added a re-point row that seeds a linking page, supersedes it under an open cache, and asserts the re-point used the stored bytes.
  - `[medium]` `[patch]` `fixMissingConceptPage`'s guard (`lint-fix.ts:376`) is the one negative-entry case where staleness CAUSES a write (a stub over a live page) rather than suppressing one, and had no row. Added one.
  - `[medium]` `[patch]` Every lint-fix staleness row lived in a file that mocks `../wiki`, so they asserted the argument, not the cache. Added a real-storage row in `lint-fix-route.test.ts` that opens a genuine `beginPageCache` and drives a fix through the route.
  - `[low]` `[patch]` The lint-fix 503 row asserted status and body only; the matrix says "nothing written". It now checks page content and the activity log before and after.
  - `[medium]` `[patch]` A `PageUnreadableError` out of `repointBacklinks` relayed "so nothing was changed" even though earlier linkers may already have been re-pointed and written. It is now caught and rethrown as the accurate `merge aborted: backlink source …` message with the refusal as `cause`; the rewritten `null`-branch comment no longer claims `null` means "genuinely absent".
  - `[medium]` `[patch]` `page-read-failure.ts` claimed "Both doors that consume a fresh read import this module" and "IT REACHES THE OWNER ON THE SAVE DOOR, AND ONLY THERE" — both false after this sweep. Updated, including the note that `merge.ts` deliberately does not relay the sentence.
  - `[medium]` `[patch]` `wiki.ts`'s `fresh` docblock was still framed "FOR PRECONDITION-BEARING READS" and its logging note still said "BOTH doors". Widened to the rule this bundle establishes (does this read decide the write that follows it), comments only.
  - `[low]` `[patch]` The `failReadsOfPage` copy in `lint-fix-route.test.ts` carried an unused `owner?` param whose default differed from the original's; dropped. The two new door branches now note the refusal lands below the ACL cloak — the same residual `PUT` already documents and accepts.

## Design Notes

The sweep is mechanical; two judgment calls are not.

**Guards are in scope.** `fixStaleIndex`, `fixMissingConceptPage` and `fixSupersededDangling` read to decide whether to write, not to build the bytes. `pageCache` caches `null` too (`wiki.ts:481-483`), so a scan that missed a page before it was created holds a negative entry — and the guard then drops a live index entry or clears a live reference. Same failure, same fix.

**The doors classify, they do not gate.** Adopting `fresh` inherits DW-378/DW-380's refusal: a non-ENOENT failure throws instead of answering `null`. Without a branch, `PATCH` answers 500 for a condition this codebase already answers 503 for two doors over — so each door gets the same three-line branch `PUT` has, importing the same constants. That is not a precondition and adds no vocabulary: the status and sentence already exist.

```ts
// src/app/api/wiki/[slug]/route.ts — PATCH catch, above the `invalid slug` ladder
if (isPageUnreadableError(err)) {
  return NextResponse.json(
    { error: PAGE_UNREADABLE_COPY },
    { status: PAGE_UNREADABLE_STATUS },
  );
}
```

`src/app/api/tasks/run/route.ts` deliberately keeps its unclassified 5xx: there the status IS the retry decision, and a transient read failure should be retried.

## Verification

**Commands:**
- `pnpm test` -- expected: full suite green, including the new stale-cache and 503 rows.
- `pnpm lint` -- expected: no new errors.
- `npx tsc --noEmit` -- expected: clean.
- `grep -n "readWikiPage\(WithFrontmatter\)\?(" src/lib/lint-fix.ts src/lib/merge.ts src/lib/patch-metadata.ts` -- expected: every hit that precedes a write carries `{ fresh: true }`.

**Manual checks (if no CLI):**
- For each new test row, delete the `{ fresh: true }` it targets and confirm that row fails, then restore it.

## Auto Run Result

Status: done
Blocking condition: none

**What was implemented.** Every read on the named read-modify-write paths now passes `{ fresh: true }`, so no write on those paths can merge into `pageCache` bytes: `patch-metadata.ts` (1 site), `merge.ts` (3), `lint-fix.ts` (13) and the page revert (1). Because a fresh read refuses a non-ENOENT storage failure rather than answering `null` (DW-378/DW-380), the three doors that can now meet that refusal classify it as the 503 / `PAGE_UNREADABLE_COPY` this codebase already owns, and `merge.ts` re-words it into its own abort where "nothing was changed" would be false. No precondition was added, `readWikiPage`'s contract and `pageCache` are untouched, and `tasks/run` keeps its 5xx-means-retry answer deliberately.

**Files changed.**
- `src/lib/patch-metadata.ts` -- fresh merge-base read for the `PATCH` frontmatter merge.
- `src/lib/merge.ts` -- fresh reads for `from`, `into` and each backlink source; a `PageUnreadableError` from the re-point loop is rethrown as the accurate `merge aborted: …` message with the refusal as `cause`.
- `src/lib/lint-fix.ts` -- all thirteen reads fresh, with the rule stated once in a section comment.
- `src/app/api/wiki/[slug]/revisions/route.ts` -- fresh merge-base read for the revert; 503 branch in the POST catch.
- `src/app/api/wiki/[slug]/route.ts` -- 503 branch in the PATCH catch (PUT unchanged).
- `src/app/api/lint/fix/route.ts` -- 503 branch in the catch ladder.
- `src/lib/page-read-failure.ts`, `src/lib/wiki.ts` -- documentation corrected for the wider consumer set (comments only).
- `src/lib/__tests__/patch-metadata.test.ts`, `merge.test.ts`, `lint-fix.test.ts`, `lint-fix-route.test.ts`, `wiki-routes.test.ts` -- stale-cache, negative-entry, 503 and 404-control rows.

**Review findings.** 8 patches applied (6 medium, 2 low), 5 items deferred (all medium), 13 rejected, 0 intent gaps, 0 spec repairs. Follow-up review recommended: **true** — patched counts high 0, medium 6, low 2; score 3x6 + 1x2 = 20, which is 5 or more.

**Verification.**
- `npx vitest run` -- 273 files, 6150 tests, all passing.
- `npx tsc --noEmit` -- clean.
- `npx next lint --max-warnings=0` -- no warnings or errors.
- Sweep-completeness grep over the three library files -- every `readWikiPage` / `readWikiPageWithFrontmatter` call carries `{ fresh: true }`.
- Every new test row mutation-checked: removing the `{ fresh: true }` (or the 503 branch, or the re-point rethrow) it covers makes exactly that row fail; all mutations reverted.
- Matrix audit: all eleven I/O rows are covered by rows that ran and passed. The "cache inactive" row is covered by the pre-existing suites for these same functions, which run with no cache open, plus `wiki.test.ts`'s "is a no-op difference when the cache is inactive".

**Residual risks.**
- `fresh` bypasses `pageCache` and only that: a lagging `getPageIndex()` can still route a read at the flat file while the write targets the silo one. Pre-existing, documented on the option, and unchanged here.
- These paths remain ungated by design, so this closes the cache-staleness window, not the read-to-write race with a concurrent writer.
- The same bug class remains open on surfaces the intent did not name (MCP, ingest, the create guards, `DELETE`) — all five recorded in `deferred` above rather than swept.
- `merge.ts`'s rethrow uses `new Error(msg, { cause })`, the only plain-`Error` use of that form here; the new row asserts `cause.name`, so a runtime regression fails loudly.
