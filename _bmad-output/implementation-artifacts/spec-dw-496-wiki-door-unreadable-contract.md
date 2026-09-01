---
title: 'DW-496: strict write-authorizing reads on the DELETE ACL read and the two create-conflict guards'
type: 'bugfix'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The DELETE door DW-496 just hardened can still report a stored page as
      absent: `deleteWikiPage`'s own read, and the MCP delete mirror, are both
      still unqualified.
    evidence: |-
      `src/lib/lifecycle.ts:1179` runs `const page = await readWikiPage(slug)`
      with no options and throws `page not found: ${slug}` on the resulting
      `null`. That call happens AFTER the route's now-strict ACL read, and the
      route's catch keeps `page not found` -> 404, so a non-ENOENT blip landing
      on this second read still answers the caller "your page is gone" through
      the very door this bundle fixed. `src/mcp.ts:434` is the same shape on the
      agent-facing surface -- `readWikiPageWithFrontmatter(args.slug)` with no
      options, throwing `page not found: ${args.slug}` at :435-437 -- under a
      comment at :427 that claims it "mirrors the REST surface at
      DELETE /api/wiki/[slug]", a parity claim this change makes false.
      Neither site is named by DW-495 (merge-base reads), DW-496 (the three
      sites this bundle converted) or DW-497 (the revisions GET), so neither is
      covered by an open entry. Both are pre-existing and outside this bundle's
      enumerated scope; raised by three independent review layers.
    location: >-
      src/lib/lifecycle.ts:1179 and src/mcp.ts:434
    severity: low
baseline_revision: '484128227ef7963ba2b382f8c6032ea00f0dab0c'
---

<intent-contract>

## Intent

**Problem:** Three write-authorizing reads still call `readWikiPageWithFrontmatter`/`readWikiPage` with no options, so a non-ENOENT storage failure comes back as `null` and each caller treats that `null` as proof the Page does not exist: `DELETE /api/wiki/[slug]`'s realm-aware ACL read (`src/app/api/wiki/[slug]/route.ts:50`) answers `page not found: <slug>`, and the create-conflict guards in `POST /api/wiki` (`src/app/api/wiki/route.ts:104`) and `handleCreatePage` (`src/mcp.ts:248`) let a create proceed over a Page that is stored. Making the DELETE read strict alone would only move the misreport, because DELETE's catch tail (`:88-89`) sends every unclassified error out as a **400** — a storage fault reported as the caller's malformed request.

**Approach:** Pass the established `{ fresh: true, strict: true }` at all three reads, and flip DELETE's unclassified catch default from 400 to 500 so the rethrow lands as the fault it is — matching `PUT` (`:336`) and `PATCH` (`:421`), which already default 500. No change to `readWikiPage`'s `null` contract, no new option, no change to `ReadWikiPageOptions`.

## Boundaries & Constraints

**Always:**
- Use the existing `ReadWikiPageOptions` fields only (`src/lib/wiki.ts:338`, `strict` documented at `:408-414`). `fresh` because each read's result decides a mutation (DW-195); `strict` so a storage failure is rethrown rather than read as an absence (DW-378).
- Keep DELETE's `isReadOnlyError(err)` → 403 branch and its `message.startsWith("page not found")` → 404 branch byte-identical; only the final `: 400` becomes `: 500`.
- Under `strict`, an absent Page and an invalid slug still answer `null`, so every existing 404 / 409 / "Page already exists" path keeps its current status and copy.
- Each converted site gets a short comment naming DW-195 (`fresh`) and DW-378 (`strict`), in the style already used at `src/app/api/wiki/[slug]/route.ts:195-206`.

**Block If:**
- `strict` or `fresh` is no longer an option on `ReadWikiPageOptions`, or `readWikiPage` no longer forwards them.

**Never:**
- Do not touch `src/lib/wikis.ts:982` or `PUT /api/workbench/artifact` — that raw-errno door is DW-689, a different mechanism, and no open entry authorizes it here.
- Do not widen to DW-495 (merge-base reads across `mcp.ts`, `cli.ts`, `query.ts`, `ingest.ts`, `agents.ts`) or DW-497 (the revision-list `GET`). Both are open; neither is this bundle's entry.
- Do not change `PUT`'s or `PATCH`'s reads or catches — they are the parity target, not the work.
- Do not reintroduce `src/lib/page-read-failure.ts`, `PAGE_UNREADABLE_COPY` or `isPageUnreadableError`. That module was deleted by `f2458e1` and never returned; the repo settled on the read option.
- Do not add an `invalid slug` → 400 branch to DELETE: an invalid slug returns `null` from the read (strict or not) and is already answered by the 404 above, so it never reaches the catch.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DELETE, page stored and readable | owner deletes own private page | 200, page deleted (unchanged) | No error expected |
| DELETE, storage blip on the Page file | `storage.readFile` throws a non-ENOENT error for `<slug>.md` | status ≥ 500; body carries the storage message, NOT `page not found` | Read rethrows; catch's new 500 default classifies it |
| DELETE, slug genuinely absent | no stored file | 404 `page not found: <slug>` (unchanged) | ENOENT still yields `null` |
| DELETE, read-only flag flips mid-request | `deleteWikiPage` refuses | 403 (unchanged) | `isReadOnlyError` branch still wins |
| `POST /api/wiki`, slug already stored | existing page | 409 `page already exists: <slug>` (unchanged) | No error expected |
| `POST /api/wiki`, storage blip on the guard read | `readFile` throws non-ENOENT | 500 with the storage message; **nothing written** | Rethrow → existing 500 default at `route.ts:171` |
| `handleCreatePage`, slug already stored | existing page | throws `Page already exists: <slug>` (unchanged) | No error expected |
| `handleCreatePage`, storage blip on the guard read | `readFile` throws non-ENOENT | throws the storage error, NOT `Page already exists`; **nothing written** | Rethrow propagates to the MCP caller |

</intent-contract>

## Code Map

- `src/app/api/wiki/[slug]/route.ts:50` -- DELETE's ACL read, `const existing = await readWikiPageWithFrontmatter(slug)`. Its frontmatter feeds `canWriteFrontmatter` at `:60`; the `!existing` branch at `:51-56` answers `page not found`. **Site 1.**
- `src/app/api/wiki/[slug]/route.ts:88-89` -- DELETE's catch tail, `const status = message.startsWith("page not found") ? 404 : 400`. **Site 2** (400 → 500). The `isReadOnlyError` → 403 branch sits just above at `:82-84`.
- `src/app/api/wiki/[slug]/route.ts:195-212` -- PUT's read, the copy-and-comment parity target: `readWikiPageWithFrontmatter(slug, { fresh: true, strict: true })` with the DW-195/DW-378 comment block. Read-only reference.
- `src/app/api/wiki/[slug]/route.ts:335-337` and `:413-422` -- PUT's and PATCH's catches, both defaulting 500. Read-only parity reference.
- `src/app/api/wiki/route.ts:104` -- `POST /api/wiki`'s create-conflict guard, `const existing = await readWikiPage(slug)` → 409 at `:105-110`. **Site 3.** Its catch at `:170-172` already defaults 500, so no tail change is needed here.
- `src/mcp.ts:248` -- `handleCreatePage`'s mirror guard, `const existing = await readWikiPage(args.slug)` → `throw new Error("Page already exists: …")` at `:250`. **Site 4.** (DW-496 cites `:222`; it has drifted.)
- `src/lib/wiki.ts:338` -- `ReadWikiPageOptions`; `fresh` documented `:339-368`, `strict` at `:369-392` (reaches into `getPageIndex({ strict })`; does NOT cover slug validation). `readWikiPage` at `:415`. Read-only.
- `src/lib/__tests__/wiki-routes.test.ts:1474+` -- `describe("PUT /api/wiki/[slug] — the write precondition")`. Its `seed()` helper and the DW-378 rows at `:1832-1875` are the exact recipe to copy: spy `getStorage().readFile`, throw `new Error("storage unavailable")` for `<slug>.md`, assert `status >= 500` and `not.toContain("page not found")`. `getStorage` is already imported at `:22`; `@/lib/auth` is mocked at `:6-10` with `test-user` as principal.
- `src/lib/__tests__/wiki-routes.test.ts:654-700` -- the realm-ACL `describe` with an existing `del(slug)` helper (`:686-691`) showing how DELETE is invoked.
- `src/lib/__tests__/mcp.test.ts:530-542` -- `it("rejects duplicate slug")`, the sibling row for `handleCreatePage`. `handleCreatePage` imported at `:11`; this file does **not** yet import `getStorage`, so a blip row must add that import from `../storage` (it already imports `_resetStorage` from there at `:53`).
- `src/lib/__tests__/store-fault-routes.test.ts` -- read-only precedent that a store fault is a 500, never a 400.

## Tasks & Acceptance

**Execution:**
1. `src/app/api/wiki/[slug]/route.ts` -- at `:50`, pass `{ fresh: true, strict: true }` to the DELETE ACL read and add the DW-195/DW-378 comment in PUT's style; separately, at `:89`, change the unclassified fallback from `400` to `500`. -- A blip must not read as a deletion, and the rethrow it now produces must not be reported as the caller's bad request.
2. `src/app/api/wiki/route.ts` -- at `:104`, pass `{ fresh: true, strict: true }` to the create-conflict read, with the same comment. -- A blip must not read as "slug free" and let a create land over a stored Page. Catch already defaults 500.
3. `src/mcp.ts` -- at `:248`, pass `{ fresh: true, strict: true }` to `handleCreatePage`'s conflict read, with the same comment. -- The MCP mirror of task 2.
4. `src/lib/__tests__/wiki-routes.test.ts` -- add rows covering the DELETE and `POST /api/wiki` matrix scenarios (blip → ≥500 and no `page not found` / no write; genuine absence → 404; existing page → 409), following the DW-378 `readFile`-spy recipe at `:1832-1875`. -- Pins the classification, not the wording.
5. `src/lib/__tests__/mcp.test.ts` -- add a row beside `rejects duplicate slug` asserting a blip on the guard read rejects with the storage error rather than `Page already exists`, and writes nothing. -- Pins the MCP mirror.

**Acceptance Criteria:**
- Given a stored page whose file read fails with a non-ENOENT error, when `DELETE /api/wiki/[slug]` is called by its owner, then the response status is ≥ 500 and its `error` contains the storage message and not `page not found`.
- Given a slug with no stored file, when `DELETE /api/wiki/[slug]` is called, then the response is still 404 with `page not found: <slug>`.
- Given a deployment whose read-only flag flips mid-request, when `DELETE /api/wiki/[slug]` reaches its catch through `deleteWikiPage`'s refusal, then the response is still 403.
- Given a non-ENOENT read failure for slug `s`, when `POST /api/wiki` is called with `slug: s`, then the response is 500, the body carries the storage message rather than `page already exists`, and no file for `s` is written.
- Given the same failure, when `handleCreatePage({ slug: s, … })` runs, then it rejects with the storage error rather than `Page already exists`, and no file for `s` is written.
- Given `PUT` and `PATCH` on `/api/wiki/[slug]`, when the change is complete, then their reads and catch ladders are byte-identical to `48412822`.

## Spec Change Log

## Review Triage Log

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 2, low 2)
- defer: 1: (high 0, medium 0, low 1)
- reject: 14: (high 0, medium 1, low 13)
- addressed_findings:
  - `[medium]` `[patch]` `fresh: true` was written at all three converted reads but pinned by nothing — three reviewers independently showed the whole suite stays green with it removed. Added three discriminating rows on the `beginPageCache()` + direct-`fs.writeFile` recipe (`wiki-routes.test.ts:1761`), one per site, each mutation-checked to fail without `fresh` (DELETE: 200 instead of 404, authorizing off a stale owner; POST: 500 instead of 409; MCP: the write's sentence instead of the guard's).
  - `[medium]` `[patch]` The two create-blip rows blipped a slug that was never seeded, so "writes nothing" was vacuous and the stated harm was asserted nowhere. Both rows now seed the page, capture its bytes, and assert them byte-identical after the blip. Their comments were also corrected: `lifecycle.ts:487-497`'s `createOnly` / `storageFileExists` backstop means the pre-fix blip produced a misclassified error rather than an unconditional overwrite, with the sharper residual case being a Page stored only in another tenant's silo.
  - `[low]` `[patch]` The `mcp.test.ts` row's title promised "not `Page already exists`" but asserted only the storage message; the negative assertion its route sibling carries was added.
  - `[low]` `[patch]` The DELETE catch comment cited PUT `:336` / PATCH `:421`, both stale post-change (now `:360` / `:441`), and attributed the 400 → 500 flip to DW-378 rather than DW-496. Citations re-derived and attribution corrected.

## Design Notes

The `strict` option's reach is wider than the Page file: it forwards into `getPageIndex({ strict })`, which rethrows where the default logs "read failed; falling back to scan". So these three doors now also fail closed when only `derived-indexes/pages.json` is unreadable. That is the intended widening — the index resolves a Page to its silo, so a silent fallback there can answer "no such Page" for a Page that exists in another silo, which is exactly the wrong answer for a create guard or a delete ACL.

DELETE needs no `invalid slug` → 400 branch to match PUT: `readWikiPageWithFrontmatter` returns `null` for an invalid slug under `strict` (`src/lib/wiki.ts:387-392`), so DELETE answers 404 before any throw can reach the catch. PUT carries that branch because `parseFrontmatter` and the write path can throw past its read; DELETE's only post-read call is `deleteWikiPage`, whose refusals are already classified above the fallback.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/mcp.test.ts src/lib/__tests__/write-precondition.test.ts src/lib/__tests__/store-fault-routes.test.ts` -- expected: all pass, including the new rows.
- `npx tsc --noEmit` -- expected: no new errors.
- `npx eslint src/app/api/wiki src/mcp.ts src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/mcp.test.ts` -- expected: clean.
- `git diff -- src/app/api/wiki/\[slug\]/route.ts` -- expected: exactly two hunks, both inside `DELETE`; nothing in `PUT` or `PATCH`.

## Auto Run Result

Status: done

### Implemented change

DW-496 closed. The three write-authorizing reads that flattened a storage blip into "absent" now pass `{ fresh: true, strict: true }`, and DELETE's catch tail no longer reports the resulting rethrow as the caller's malformed request.

- `DELETE /api/wiki/[slug]`'s realm-aware ACL read is strict, so a non-ENOENT storage failure is rethrown instead of answering `page not found: <slug>` for a page that is stored and merely unreadable.
- That rethrow lands as a **500**: the catch's unclassified default moved 400 → 500, matching `PUT` and `PATCH`. The `isReadOnlyError` → 403 and `page not found` → 404 branches above it are unchanged.
- The create-conflict guards in `POST /api/wiki` and `handleCreatePage` are strict, so a blip can no longer read as "the slug is free". Both catches already defaulted 500.

`fresh` is the DW-195 half at each site: every one of these reads decides a mutation, and `pageCache` is module-global and ref-counted around bulk scans.

### Files changed

- `src/app/api/wiki/[slug]/route.ts` — two hunks, both inside `DELETE`: the strict/fresh ACL read, and the 400 → 500 catch default. `PUT` and `PATCH` byte-identical to baseline.
- `src/app/api/wiki/route.ts` — `POST`'s create-conflict guard reads strict/fresh.
- `src/mcp.ts` — `handleCreatePage`'s mirror guard reads strict/fresh.
- `src/lib/__tests__/wiki-routes.test.ts` — new `unreadable ≠ absent — DELETE ACL and the create guard (DW-496)` describe: 9 rows covering the blip, absence, happy-path, read-only-flip, 409, 201, and the two stale-page-cache rows that pin `fresh`.
- `src/lib/__tests__/mcp.test.ts` — two rows beside `rejects duplicate slug`: the blipped guard read, and the stale-page-cache row pinning `fresh`.
- `_bmad-output/implementation-artifacts/spec-dw-496-wiki-door-unreadable-contract.md` — this spec.

### Review findings

Four review layers ran in parallel (blind hunter, edge-case hunter, verification-gap, intent-alignment).

- **Patches applied: 4** — 2 medium, 2 low. See the Review Triage Log for each.
- **Deferred: 1** (low) — `src/lib/lifecycle.ts:1179` and `src/mcp.ts:434`, the delete path's remaining unqualified reads.
- **Rejected: 14** — the notable ones and why: the 500 body carrying the raw storage message is exactly what `PUT` already does and is the parity target (DW-689 is explicitly out of scope); `strict`'s widening into `getPageIndex` is documented in Design Notes as intended, and the verification-gap layer itself declined to raise it; a store fault preceding DELETE's 404 cloak is not a practical existence oracle, since a caller cannot induce the blip, and `PUT` has the identical ordering; `src/cli.ts:365` and the typed-classifier refactor are outside the intent's enumeration; closing the DW-496 ledger entry is the orchestrator's job and was forbidden to this run.
- **Follow-up review recommended: true.** Patched counts: high 0, medium 2, low 2 → score `3×2 + 1×2 = 8`, which is ≥ 5.

### Verification performed

- `npx vitest run src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/mcp.test.ts src/lib/__tests__/write-precondition.test.ts src/lib/__tests__/store-fault-routes.test.ts` — **401 passed**, 4 files.
- `npx tsc --noEmit` — exit 0. `npx eslint src/app/api/wiki src/mcp.ts` + both test files — exit 0.
- Matrix test audit: every I/O row has a named covering test that ran and passed (verified in `--reporter=verbose` output).
- Mutation checks: each of the three new `fresh` rows was run with `fresh: true` removed from its own source site and observed to fail (DELETE `expected 200 to be 404`; POST `expected 500 to be 409`; MCP the write's sentence instead of the guard's), then restored.
- `git diff` scoped against baseline: `PUT`, `PATCH`, `src/lib/lifecycle.ts`, `src/cli.ts`, `src/lib/wikis.ts` and the deferred-work ledger untouched; `src/lib/page-read-failure.ts` not reintroduced.

### Residual risks

- **Intended widening.** `strict` forwards into `getPageIndex({ strict })`, so these three doors now also fail closed when only `derived-indexes/pages.json` is unreadable or unparseable, where the default logged and fell back to a scan. One corrupt derived index therefore 500s every page create and delete. This is the contract DW-378 established and the spec's Design Notes argue for, but it is the change's largest blast radius and is pinned in `wiki.ts`'s own tests rather than at these doors.
- **The delete path is not fully closed** — see the deferred entry: a blip landing on `deleteWikiPage`'s own read still answers 404 `page not found` through this same door.
- **Concurrent-session interference.** A sibling bmad-loop session committed this run's source and spec changes into `9b7364fc`, a commit whose message names an unrelated bundle (`dw-email-worker-forward-reply-tail: DW-451, DW-452, DW-454`). The work is intact and present in history after the baseline; only the commit attribution is wrong. The four review patches were applied on top and committed separately by this run.
