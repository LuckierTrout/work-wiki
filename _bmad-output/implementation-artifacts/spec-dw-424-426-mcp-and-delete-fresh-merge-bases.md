---
title: 'Fresh+strict merge-base reads on the two remaining MCP write doors'
type: 'bugfix'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized', 'ledger-id-mismatch']
deferred:
  - summary: >-
      `handleRevertRevision` performs no write ACL at all, so on the HTTP MCP
      surface any authenticated principal can revert a Page they cannot edit
      through `update_page`.
    evidence: |-
      `src/mcp.ts:1421` declares `args: { slug; timestamp; author? }` — no
      `principal` — and the handler never calls `canWriteFrontmatter`; the
      lifecycle writer it delegates to adds none. Its REST twin runs
      `canWriteFrontmatter(existing.frontmatter, principal, "body")` with the
      404/403 cloak immediately after the identical fresh+strict read
      (`src/app/api/wiki/[slug]/revisions/route.ts:138` and just below), and the
      sibling MCP write doors (`handleUpdatePage`, `handleDeletePage`,
      `handleUpdateMetadata`) all take a `principal`. `src/lib/mcp-http.ts:763`
      registers `revert_revision` with `write: true` but passes only
      `author: p!.handle` (`:777`), so the caller's identity never reaches an
      authorization check. A caller `handleUpdatePage` would refuse can restore
      any prior revision of the same Page — including a private one in another
      owner's realm — which is a write-authorization bypass, not a wording bug.
      The only `revert_revision` rows in `src/lib/__tests__/mcp-http.test.ts`
      (`:1491-1552`) assert auth-required and author attribution; none asserts
      an ACL denial. Pre-existing and not named by this bundle; surfaced because
      this change converted the read whose frontmatter the missing check would
      have consulted.
    location: >-
      src/mcp.ts:1421
    severity: high
baseline_revision: '60f5f921b68275776263f62d1b4df856c797cc14'
---

<intent-contract>

## Intent

**Problem:** `handleUpdatePage` (`src/mcp.ts:318`) and `handleRevertRevision` (`src/mcp.ts:1430`) each call `readWikiPageWithFrontmatter(args.slug)` with no options and hand those exact bytes back to `writeWikiPageWithSideEffects` as `expectedContent` (`:385`, `:1466`) — `handleRevertRevision` also derives its title and `created` fallback from them (`:1440`, `:1445`). `pageCache` is module-global and ref-counted around bulk scans, so a concurrent scan can hold a superseded entry open and make the merge base a file that is no longer stored; and without `strict` a non-ENOENT storage blip flattens to `null`, so the agent is told `Page not found` / `page not found` when the page is only unreadable. `src/mcp.ts` has exactly one `fresh: true` call site today (`:258`, the create-conflict guard), while the swept twins at `src/lib/patch-metadata.ts:95` and `src/app/api/wiki/[slug]/revisions/route.ts:138` already pass `{ fresh: true, strict: true }`.

**Approach:** Pass the established `{ fresh: true, strict: true }` literal at both reads, with a comment matching the twins' FRESH/STRICT rationale. No new branch is needed: both handlers already let a thrown `Error` propagate to the MCP caller, so the rethrown storage error surfaces on its own. Add tests that pin both halves (strict classification and cache freshness) per site, mirroring the existing DW-496 rows in `src/lib/__tests__/mcp.test.ts:563-664`.

## Boundaries & Constraints

**Always:**
- Spell the literal exactly as the twins do — `{ fresh: true, strict: true }` passed as the second argument to `readWikiPageWithFrontmatter`. Let Prettier decide wrapping.
- Keep the existing `if (!existingPage)` / `if (!existing)` null branches and their message wording (`Page not found: ${args.slug}`, `page not found: ${args.slug}`) untouched — an absent page and an invalid slug still answer `null` under strict.
- Every new test must fail against the unconverted read. Use a ONE-SHOT storage spy for the strict rows so the write path's own re-reads still succeed (see `src/lib/__tests__/mcp.test.ts:571-580` for why).
- Assert on classification, not on provider wording: the strict rows assert the storage message reaches the caller AND that the "not found" sentence does not.

**Block If:**
- `readWikiPageWithFrontmatter` does not accept `{ fresh, strict }` as written, or `strict` does not rethrow a non-ENOENT `readFile` failure.

**Never:**
- Do not touch the DELETE ACL read at `src/app/api/wiki/[slug]/route.ts:64`. The intent's third item is already implemented: that read passes `{ fresh: true, strict: true }` and the DELETE catch already defaults an unclassified error to 500 (DW-496, `spec-dw-496-wiki-door-unreadable-contract.md`). There is no `PageUnreadableError` / `isPageUnreadableError` symbol in this repo — the intent's naming is aspirational; `strict` rethrowing the raw storage error is the actual mechanism.
- Do not convert any other unqualified read in `src/mcp.ts` (`:157`, `:434`, `:499`, `:636`, `:700`, `:752`, `:803`, `:903`, `:1081`, `:1171`, `:1361`, `:1384`). They are other DW entries and other bundles.
- Do not change `ReadWikiPageOptions`, `readWikiPage`'s `null` contract, or `deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| update happy path | stored page, normal storage | `handleUpdatePage` returns `{ updated: true }`, file on disk has new body | No error expected |
| update, merge-base read blips | page stored; one-shot non-ENOENT failure on that slug's `readFile` | Rejects with the storage message; message does NOT contain `Page not found`; stored bytes unchanged | Storage error rethrown by `strict` |
| update, stale cache open | `beginPageCache()` held; cached bytes superseded by newer bytes written straight to the flat path | Update merges into the STORED bytes — post-write file retains the newer stored marker line | No error expected |
| revert happy path | page + saved revision | `handleRevertRevision` restores the revision content | No error expected |
| revert, merge-base read blips | page stored; one-shot non-ENOENT failure on that slug's `readFile` | Rejects with the storage message; message does NOT contain `page not found` | Storage error rethrown by `strict` |
| revert, stale cache open | `beginPageCache()` held with superseded bytes; page has a revision | Title/`created` fallback and merge base come from the STORED bytes, not the cached ones | No error expected |
| absent page (both) | slug never written | Unchanged: `Page not found: <slug>` / `page not found: <slug>` | Existing null branch |

</intent-contract>

## Code Map

- `src/mcp.ts:318` -- `handleUpdatePage`'s merge-base read. `existingPage.content` becomes `expectedContent` at `:385`; `existingPage.frontmatter` also feeds the ACL at `:331` and the frontmatter merge at `:353`. THE FIRST EDIT.
- `src/mcp.ts:1430` -- `handleRevertRevision`'s merge-base read. `existing.content` becomes `expectedContent` at `:1466`; `existing.title` is the `extractTitle` fallback at `:1440` and `existing.frontmatter` seeds `mergedFrontmatter` at `:1445`. THE SECOND EDIT.
- `src/mcp.ts:258` -- the only converted read in the file today (`handleCreatePage`'s conflict guard). Reuse its call shape.
- `src/lib/patch-metadata.ts:92-98` -- swept twin. COPY THE COMMENT SHAPE from here: a `FRESH+STRICT (DW-379)` block above the read.
- `src/app/api/wiki/[slug]/revisions/route.ts:134-141` -- the REST revert twin; the surface `handleRevertRevision` mirrors.
- `src/lib/wiki.ts:338-415` -- `ReadWikiPageOptions` docs; `readWikiPage:416-500` is where `strict` rethrows (silo read `:461`, flat fallback `:484`, `getPageIndex({ strict })` `:471`). `readWikiPageWithFrontmatter:558` forwards `options` verbatim. READ-ONLY.
- `src/app/api/wiki/[slug]/route.ts:53-70` -- the DELETE ACL read. ALREADY `{ fresh: true, strict: true }`, catch already defaults 500. READ-ONLY — evidence that intent item 3 is done.
- `src/lib/__tests__/mcp.test.ts:563-664` -- the two DW-496 rows for `handleCreatePage`: a one-shot `storage.readFile` spy for the strict half, and a `beginPageCache()` + direct flat-path write for the fresh half. MIRROR THESE.
- `src/lib/__tests__/mcp.test.ts:760` (`describe("update_page")`) and `:4518` (`describe("revert_revision")`) -- where the new rows go.
- `src/lib/__tests__/mcp.test.ts:1-57` -- imports already include `handleUpdatePage`, `handleRevertRevision`, `handleListRevisions`, `readWikiPageWithFrontmatter`, `getStorage`, `parseFrontmatter`, `fs`, `path`, `vi`. `writeTestPage` / `writeIndex` are local helpers.

### Ledger ID mismatch (flagged, not acted on)

`intent.md` declares `dw_ids: DW-424, DW-426` and pastes those two entries verbatim, but both are `status: done 2026-08-28`, `archived: 2026-08-29`, and are about `ShortcutsHelp` / `aria-modal` — unrelated to this intent. The narrative Intent matches the still-open `DW-495` (`deferred-work.md:3707`, `location: src/mcp.ts:282`) and `DW-496` (`:3714`, already resolved by `spec-dw-496-wiki-door-unreadable-contract.md`). This spec implements the narrative Intent, which is self-contained and precise. Ledger write-back is the orchestrator's.

## Tasks & Acceptance

**Execution:**
- `src/mcp.ts` -- add `{ fresh: true, strict: true }` to the `readWikiPageWithFrontmatter` call at `:318` (`handleUpdatePage`), with a FRESH+STRICT comment above it naming `expectedContent` at `:385` as the merge base -- the bytes that authorize and seed the write must be the stored ones, and a blip must not read as a deletion.
- `src/mcp.ts` -- add the same literal and comment to the call at `:1430` (`handleRevertRevision`), noting that these bytes are both the merge base (`:1466`) and the title/`created` fallback (`:1440`, `:1445`) -- so a superseded entry would also rewrite the page's title and creation date.
- `src/lib/__tests__/mcp.test.ts` -- add two rows inside `describe("update_page")`: a one-shot-blip row and a stale-page-cache row, per the I/O matrix.
- `src/lib/__tests__/mcp.test.ts` -- add the matching two rows inside `describe("revert_revision")`.

**Acceptance Criteria:**
- Given `src/mcp.ts` after the change, when `grep -n "fresh: true" src/mcp.ts` runs, then it reports exactly three call sites: `:258`, and the two converted reads.
- Given a stored page and a one-shot non-ENOENT `storage.readFile` failure on its `.md`, when `handleUpdatePage` runs, then it rejects with the storage message, the rejection does not contain `Page not found`, and the stored bytes are unchanged byte for byte.
- Given the same blip, when `handleRevertRevision` runs against an existing revision, then it rejects with the storage message and the rejection does not contain `page not found`.
- Given an open `beginPageCache()` holding bytes that a direct flat-path write has superseded, when `handleUpdatePage` runs, then the resulting file is a merge over the STORED bytes (the newer marker survives), not over the cached ones.
- Given the same stale cache, when `handleRevertRevision` restores a revision, then the frontmatter it carries forward comes from the stored bytes (the stored-only frontmatter key survives).
- Given a slug that was never written, when either handler runs, then the existing not-found message is unchanged.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures.

## Design Notes

The two edits are one line each plus a comment. All the work is in the tests, and each site needs BOTH halves because `strict` and `fresh` are independently droppable: remove `fresh` and every strict row still passes.

Shape for the strict half (mirrors `mcp.test.ts:563`):

```ts
let blipped = false;
const readSpy = vi.spyOn(storage, "readFile").mockImplementation(async (p: string) => {
  if (!blipped && p.endsWith("blip-update.md")) { blipped = true; throw new Error("storage unavailable"); }
  return originalRead(p);
});
```

One-shot matters: a spy that failed every read would also break the write's own re-checks, so the call would reject either way and the row would pin nothing.

For the fresh half, seed the cache with a read, then write newer bytes DIRECTLY to `path.join(process.env.WIKI_DIR!, "<slug>.md")` (bypassing `writeWikiPage`, which invalidates), confirm the cached read is genuinely stale, then assert the handler's output reflects the stored bytes. For `update_page` the observable is a marker line present only in the stored bytes surviving into the post-update file; for `revert_revision` it is a frontmatter key present only in the stored bytes surviving into `mergedFrontmatter`.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/mcp.test.ts` -- expected: all rows pass, including the four new ones.
- Temporarily revert one converted read (drop the options argument), re-run the file, confirm that site's two new rows fail, then restore. Expected: each new row is load-bearing.
- `pnpm test` -- expected: full suite green, no new failures.
- `pnpm lint` -- expected: clean on the two touched files.
- `grep -n "fresh: true" src/mcp.ts` -- expected: exactly three hits.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** The two remaining merge-base reads on the MCP write doors now pass the established `{ fresh: true, strict: true }` literal, matching their swept REST twins. FRESH keeps the merge base, the write ACL's frontmatter, and (on revert) the title/`created` fallback pointed at the stored file rather than a superseded `pageCache` entry an open bulk scan is holding — without it a legitimate write is refused as a spurious conflict by the writer's own CAS for the duration of an unrelated scan. STRICT stops a non-ENOENT storage blip from flattening to `null` and posing as `Page not found` / `page not found`, a deletion the store never made. No new branch was needed: both handlers already let a thrown `Error` reach the MCP caller.

**Files changed.**
- `../../src/mcp.ts` -- `handleUpdatePage` (`:332`) and `handleRevertRevision` (`:1459`) converted, each under a FRESH+STRICT rationale comment citing DW-495.
- `../../src/lib/__tests__/mcp.test.ts` -- four rows added: per handler, a one-shot `storage.readFile` blip row (storage error reaches the caller, the not-found sentence does not, stored bytes byte-identical afterwards) and a stale-`beginPageCache` row (merge base and frontmatter come from storage).

**Review findings breakdown.** 5 patches applied (all low, all comment-accuracy or test-strength corrections — see the Review Triage Log). 1 item deferred (high: `handleRevertRevision` has no write ACL, an authorization bypass on the HTTP MCP door). 15 rejected: pre-existing siblings already carried by open ledger entries (`src/cli.ts:431` and the other DW-495 sites; `handleDeletePage` at `src/mcp.ts:443`, already deferred by `spec-dw-496-wiki-door-unreadable-contract.md`), test-scaffold DRY suggestions against this file's established inline convention, and edge cases the spec's Never clause or the twins' own shape excludes (narrowing `strict` around the page-index read, passing an `owner` hint, `validateSlug` ordering, the revert's `hasYamlBlock` snapshot-frontmatter path).

**Follow-up review recommendation.** Patched findings this pass: high 0, medium 0, low 5. Score = 3x0 + 1x5 = 5, which is >= 5, so `followup_review_recommended: true`.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/mcp.test.ts` -- 248/248 pass (before and after the patch round).
- Load-bearing check, run independently of the implementer: reverting either converted read fails exactly that site's two new rows and leaves the other site's two green. A full mutation matrix (no options / `fresh` only / `strict` only, at each site) confirmed each flag is independently pinned.
- `pnpm test` -- 357 files, 8547 passed, 1 skipped (pre-existing skip), no new failures.
- `pnpm lint` -- clean; only the pre-existing `jsx-ast-utils` TSNonNullExpression notices from unrelated JSX files.
- `grep -n "fresh: true" src/mcp.ts` -- exactly three sites: `:258`, `:332`, `:1459`.
- Matrix test audit: all seven I/O rows are covered by tests that ran and passed -- the two happy paths by the pre-existing `updates existing page` and `reverts a page to a previous revision` rows, the four blip/stale-cache rows by the new tests, and the absent-page row by the pre-existing `Page not found: nonexistent-page` and `page not found: no-such-page` rows.

**Residual risks.**
- The deferred `handleRevertRevision` ACL gap is a live authorization bypass on the HTTP MCP surface. This change did not create it and does not close it, but it converted the very read whose frontmatter the missing check would consult, so the fix is now one call away.
- Ledger ID mismatch (also in frontmatter `warnings`): the bundle declares `dw_ids: DW-424, DW-426`, but both are done, archived, and about `ShortcutsHelp` / `aria-modal`. The narrative Intent this run implemented corresponds to the still-open DW-495; DW-496's third item was already resolved before this run. The orchestrator's write-back will close the wrong two ids unless corrected.
- Concurrent session: `src/lib/document-extract.ts`, `src/lib/lint-checks.ts` and their tests were modified in this working tree by another bmad-loop run while this one was in flight. They are excluded from this run's commit.
