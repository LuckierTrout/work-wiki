---
title: 'A failed page-index read must not re-open DW-378/DW-380 on the two doors that seed a write precondition'
type: 'bugfix'
created: '2026-08-31'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
baseline_revision: 'e5dc6724d36cd57af3f28ebc816b065fe980c30c'
---

<intent-contract>

## Intent

**Problem:** Exactly two of the fifty-odd `{ fresh: true }` callers never pass `strict`, and both are the precondition SEEDERS their own comments say they are: `src/app/api/workbench/preview/route.ts:183` and `src/app/u/[handle]/[slug]/edit/page.tsx:28`. So every non-ENOENT storage failure they meet is flattened to `null` and shown to the owner as "this page does not exist" — the preview's shared 404, the edit screen's "Page not found — nothing to edit". Three failures take that path: the page index (`getPageIndex` logs "falling back to scan", `page-index.ts:157-159`), the flat page file (`wiki.ts:483-486`) and the silo copy (`wiki.ts:455-462`, which correctly refuses the flat fallback but can only say `null`). That is DW-378's lie standing on the two doors that hand out the `If-Match` a save will carry, and `PUT /api/wiki/[slug]` already refuses that same blip with a 500 — so today an index outage lets an owner open an editor whose every save is guaranteed to fail.

**Approach:** Convert both reads to the established option literal `{ fresh: true, strict: true }`, the same conversion the other fourteen write-authorizing sites took in `spec-dw-495-496-write-authorizing-strict-reads.md`. The preview route's existing GET catch (`route.ts:135-145`) already answers 500 `{ error }`; the edit page already throws on unparseable frontmatter and is covered by `src/app/u/[handle]/[slug]/error.tsx`. No new option, no change to `readWikiPage`, no change to `getPageIndex`.

## Boundaries & Constraints

**Always:**
- Use the established literal `{ fresh: true, strict: true }`, spelled exactly as `src/lib/lint-fix.ts:60` and `src/app/api/wiki/route.ts:114` do.
- A `null` answer keeps its existing meaning at both doors: an ABSENT page still gets the preview route's one shared 404 body and the edit page's "Page not found" screen. Only a non-ENOENT failure changes shape, from `null` to a throw.
- An invalid slug still returns `null` under strict (`readWikiPage`'s early return), so both doors keep their current answer for one.
- Comment each converted site with the reason, naming DW-378/DW-380 and the index, in the style of `src/lib/patch-metadata.ts:92-94`.
- Pin both doors against an index-only failure with the reference shape from `src/lib/__tests__/wiki-routes.test.ts:1929-2000`: spy `getStorage().readFile` to fail only for `derived-indexes/pages.json`, leaving the page file readable.

**Block If:**
- Either converted read turns out to have no enclosing handler and its throw would escape as an unhandled rejection.

**Never:**
- Do not reintroduce `src/lib/page-read-failure.ts`, `PAGE_UNREADABLE_COPY` or `isPageUnreadableError`, and do not answer 503. That module was deleted by `f2458e1`; the repo settled on the read option plus a 500, the same Never `spec-dw-496-wiki-door-unreadable-contract.md` records. The bundle intent's `PageUnreadableError` wording predates that decision.
- Do not add a new option to `ReadWikiPageOptions`, and do not make `fresh` imply index-strictness inside `readWikiPage` — `fresh` and `strict` stay orthogonal, as `wiki.ts:338-398` documents.
- Do not touch `getPageIndex`, `syncPageIndexForPage`, `removePageIndexForSlug` or `rebuildPageIndex`: the strict variant and the sync helpers' use of it are already correct.
- Do not convert any other `readWikiPage` caller — in particular the response-serving reads (`src/app/u/[handle]/[slug]/page.tsx:30/71`, `src/mcp.ts`, `src/cli.ts`) and the `kind=file` / `raw/` branches of the preview route, which are DW-420's bundle and not this one.
- Do not change the preview route's shared 404 body, its `NO_STORE` header, `frontmatterOf`'s deliberate swallow, or any payload field.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Preview index blip | `GET ?kind=page&slug=alpha`, `derived-indexes/pages.json` read throws, page file fine | 500 `{ error }`, no `version` — where today the flat routing hint recovers a 200 | Rethrown by `getPageIndex({ strict })`, caught by the GET catch. Deliberate: see Design Notes |
| Preview index malformed | same, index returns `{ this is not json` | 500 `{ error }` | `JSON.parse` throw rethrown under strict |
| Preview page absent | `?kind=page&slug=ghost` | Unchanged: 404, the one shared body | `null`, unchanged |
| Preview page file blip | `?kind=page&slug=alpha`, `wiki/alpha.md` read throws `EIO` | 500 `{ error }` — no longer 404 | Rethrown at the flat read (`wiki.ts:484`) |
| Preview silo blip | indexed page whose `tenants/<t>/wiki/alpha.md` read throws `EIO` | 500 `{ error }` — no longer 404 | Rethrown at `readSilo` (`wiki.ts:459`); still never serves the flat copy |
| Preview readable page | `?kind=page&slug=alpha`, everything readable | Unchanged: 200 with `body`, `slug`, `version`, `editable` | No error expected |
| Edit index blip | `/u/owner/alpha/edit`, index read throws, page file fine | The component REJECTS; the segment error boundary renders "Page error" | Not the "Page not found" screen |
| Edit page file blip | `/u/owner/alpha/edit`, `wiki/alpha.md` read throws `EIO` | REJECTS; error boundary | Not "Page not found" |
| Edit page absent | `/u/owner/ghost/edit` | Unchanged: alias forward if one exists, else "Page not found" | `null`, unchanged |
| Edit invalid slug | a slug `validateSlug` rejects | Unchanged: `null` → "Page not found" | Strict does not cover slug validation |
| Non-converted caller | `readWikiPage(slug)` with no options during an index outage | Unchanged: falls back to the scan | `lifecycle.test.ts` pins this asymmetry |

</intent-contract>

## Code Map

- `src/app/api/workbench/preview/route.ts:176-184` -- the `kind=page` branch. Its own comment already says "This read SEEDS a precondition: `version` below is what the editor sends back as `If-Match`". `readWikiPage(slug, { fresh: true })` at `:183`; `if (!page) return notFound()` at `:184`; `version: contentVersion(page.content)` at `:204`. THE conversion site.
- `src/app/api/workbench/preview/route.ts:135-145` -- `GET` wraps `handle()` and answers `json({ error: getErrorMessage(error) }, 500)`. Its comment already names "the index read" as a throw it exists to catch, so the converted throw lands on a handler that is already correct. Read-only.
- `src/app/api/workbench/preview/route.ts:71-73` -- `notFound()`, the one shared 404 body. Read-only; absent keeps taking it.
- `src/app/u/[handle]/[slug]/edit/page.tsx:20-28` -- the edit screen's seeding read, `readWikiPageWithFrontmatter(slug, { fresh: true })` at `:28`, with the same FRESH comment. `initialVersion` is derived from it further down. THE second conversion site.
- `src/app/u/[handle]/[slug]/edit/page.tsx:31-50` -- the `!page` branch: alias forward, else the "Page not found" screen. Unchanged; only a FAILED read stops reaching it.
- `src/app/u/[handle]/[slug]/error.tsx` -- the segment error boundary (`PageError`, "Page error" + reset) that catches the converted throw. Read-only; already exists.
- `src/lib/wiki.ts:370-391` -- the `strict` JSDoc, which already documents that the option reaches into `getPageIndex({ strict })` and that non-strict callers keep the scan fallback. Read-only.
- `src/lib/wiki.ts:445-470` -- `readSilo` + `const pageIdx = await getPageIndex({ strict })`; `:471` `pageIdx?.[slug]`; `:472-475` the silo branch gated on `indexedEntry`; `:478-487` the flat fallback. The mechanism, unchanged.
- `src/lib/wiki.ts:476-528` -- the flat fallback (`:478-487`, its non-ENOENT branch at `:483-486`) and the flat-as-routing-hint repair (`:508-528`): when the index gave no entry, the flat copy's own `owner` frontmatter re-routes to the silo and silo bytes win. This is why an index blip is usually NOT a stale-version bug today, and why the fix's honest claim is DW-378, not DW-380. Read-only.
- `src/lib/__tests__/lifecycle.test.ts:884-942` -- "does not expose a stale public flat copy during a later page-index outage": a NON-strict `{ fresh: true }` read that must keep succeeding through an index outage. Must stay green; it reads `readWikiPageWithFrontmatter` directly, not through either converted door.
- `src/lib/page-index.ts:136-160` -- `getPageIndex(options?: { strict?: boolean })`: rethrows under strict, logs and returns `null` otherwise; `!idx || typeof idx !== "object"` still returns `null` (never-seeded stays fail-soft under strict). Read-only — already correct.
- `src/lib/__tests__/wiki-routes.test.ts:1912-2000` -- the reference index-blip rows for the PUT door (`INDEX_PATH`, the `readFile` spy, the malformed-JSON half) and the docblock recording the deliberate asymmetry with `lifecycle.test.ts`. Copy this shape.
- `src/lib/__tests__/workbench-preview.test.ts:1543-1572` -- `writePage`/`writeIndex`/`get()` harness on real filesystem storage; `:1617-1641` the existing "ONE body for gated-out, absent and traversal alike" row that must keep passing. Home for the preview rows.
- `src/lib/__tests__/edit-raw-alias-forwarding.test.ts:23-70` -- the pattern for driving the real `EditWikiPage` server component against a tmpdir store with `next/navigation` mocked. Model for the new edit-page suite.

## Tasks & Acceptance

**Execution:**
- `src/app/api/workbench/preview/route.ts` -- change the `kind=page` read at `:183` to `{ fresh: true, strict: true }` and extend the FRESH comment above it with why strict is there (a failed page-index read would skip the silo and seed a version describing the flat copy — DW-380 — or report a silo-only page as absent — DW-378; the GET catch answers 500) -- the door hands out an `If-Match` a blip can make wrong.
- `src/app/u/[handle]/[slug]/edit/page.tsx` -- change the read at `:28` to `{ fresh: true, strict: true }` and extend its FRESH comment the same way, naming the segment error boundary as where the throw lands -- same seeding contract, same blip.
- `src/lib/__tests__/workbench-preview.test.ts` -- add index-blip and malformed-index rows for `kind=page` (500, body not a 404, no `version`), plus a page-file `EIO` row, using the `readFile` spy shape from `wiki-routes.test.ts` -- the I/O matrix's preview rows.
- `src/lib/__tests__/precondition-seed-strict-reads.test.ts` -- new suite driving the real `EditWikiPage` against a tmpdir store: index-blip rejects, absent still renders "Page not found", with a docblock recording why a seeding read may not fall back to the scan -- the I/O matrix's edit rows; no existing suite owns this door's failure contract.

**Acceptance Criteria:**
- Given a stored page whose `wiki/<slug>.md` read fails with a non-ENOENT error, when the owner opens the Preview for it, then the route answers 500 with an `{ error }` body and no `version`, where today it answers the shared 404.
- Given the same page-file failure, when the owner opens `/u/<handle>/<slug>/edit`, then the render rejects into the segment error boundary, where today it renders "Page not found — nothing to edit".
- Given a page whose `derived-indexes/pages.json` read fails while the page file is readable, when either door is opened, then it refuses rather than seeding an editor whose every save `PUT /api/wiki/[slug]` will already 500 — accepting the loss of the flat routing hint's recovery, which is the change's largest blast radius.
- Given an ABSENT page and a healthy index, when either door is opened, then the answer is byte-identical to today's (the shared 404 body / the "Page not found" screen), and an invalid slug likewise.
- Given an index outage, when a caller that passes neither `fresh` nor `strict` reads a page, then it still falls back to the scan and succeeds — `lifecycle.test.ts:884` stays green.

## Design Notes

**Why the option literal and not a new mechanism.** The bundle intent asks to "add a strict variant or options flag that propagates the throw". That variant already exists — `getPageIndex({ strict })`, added with `readWikiPage`'s `strict` option and documented at `wiki.ts:370-391` — and `spec-dw-496-wiki-door-unreadable-contract.md` records the widening into the index as intended. The only thing still missing is that two seeding doors never opted in. So this is a two-line conversion in the established idiom, not a new contract.

**Why not gate the index read on `fresh` instead.** Making `readWikiPage` pass `getPageIndex({ strict: strict || fresh })` would reach the same two doors, but it collapses a line `wiki.ts:339-369` draws on purpose: `fresh` means "not served from `pageCache`", nothing more. Every other `{ fresh: true }` caller already pairs it with `strict`, so the two designs differ only in which door future callers fall through, and the orthogonal one keeps the docblock true.

**The availability trade, and why it is the right way round.** With `strict`, a corrupt or unreadable `derived-indexes/pages.json` now 500s the Preview and the edit screen, where today `wiki.ts:508-528` often recovers correct silo bytes from the flat copy's `owner` and answers 200. That looks like a loss until you follow the owner: `PUT /api/wiki/[slug]` has passed `{ fresh: true, strict: true }` since DW-378, so on that same corrupt index every save already fails 500. Today's graceful read therefore only invites someone to type into an editor that cannot save. Refusing at the door is the honest answer, and it is the answer the create, delete and save doors already give.

**What this does NOT claim.** The routing-hint repair means an index blip is usually not a wrong-`version` bug, so DW-380's stale-copy half is already defended for pages with a readable flat copy carrying an owner. The lie that remains — and the one this closes — is DW-378's: a storage failure on the index, the flat file or the silo reported to the owner as an absent page.

**Ledger-id note.** This bundle's `dw_ids` field says `DW-422`, but ledger `DW-422` is the withdrawn-`PreviewColumn` lifecycle entry already specced in `spec-dw-422-519-520-522-withdrawn-surface-lifecycle.md`. The ids in this run's bundle files predate a ledger renumber; the bundle's Intent prose is what identifies the work, exactly as `spec-dw-420-workbench-preview-unreadable-file.md` treated the same mismatch.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/precondition-seed-strict-reads.test.ts src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/lifecycle.test.ts` -- expected: all pass, including the pre-existing absent/gated-out 404 rows and `lifecycle.test.ts`'s non-strict scan-fallback row.
- `pnpm test` -- expected: full suite green.
- `pnpm lint` -- expected: no new findings.
