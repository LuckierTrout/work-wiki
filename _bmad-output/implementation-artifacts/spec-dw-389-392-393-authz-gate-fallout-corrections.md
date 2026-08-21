---
title: 'Authz-gate fallout: disputed-clear guidance, the Revert session term, and index-drift readability'
type: 'bugfix'
created: '2026-08-21'
baseline_revision: '89924fb4a32c48796d10b1cccbf49e03285d30b1'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      `GET /api/ingest/history` still filters the ledger with the page index
      alone, so an orphaned page's history row is never listed and the
      `ingestIds` half of the DW-393 fallback is unreachable from the UI.
    evidence: |-
      The GET at `src/app/api/ingest/history/route.ts` builds `readable` from
      `listReadableWikiPages(principal)` and drops every ledger entry whose
      `primary_slug` the index does not carry. `RecentIngests.tsx` is the only
      producer of `ingestIds` and builds them exclusively from that GET's
      `entries`, so an orphan row can only be deleted by a caller hand-writing
      ids (CLI/MCP/direct HTTP). The `jobIds` half — the path DW-393's own
      harm statement describes ("a done job whose page is in that state") — is
      UI-reachable and is fixed. Left out deliberately: widening the GET would
      cost up to `MAX_BULK_DELETE` page reads on a hot listing path and change
      what the list shows, neither of which the intent asked for.
    location: >-
      src/app/api/ingest/history/route.ts:139
    severity: medium
  - summary: >-
      `maintenance_scan`'s tool description in `src/lib/mcp-http.ts` is a third
      copy of the disputed-clear fact and now disagrees with the shared clause.
    evidence: |-
      DW-389 named two sites and they now read one owner
      (`disputedClearInstruction`). `src/lib/mcp-http.ts:434` tells agents
      "clearing the flag is a human review", while the new clause tells humans
      that on a public knowledge page only an agent or a site admin can clear
      it. Pre-existing copy at a site outside the intent's two, so it was not
      moved with them, but it is the next place this fact can drift.
    location: >-
      src/lib/mcp-http.ts:434
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three surfaces the DW-121/269/270 gates left inaccurate or stuck. (DW-389) `src/lib/lint-fix.ts:751` and the check's `suggestion` at `src/lib/lint-checks.ts:727` both tell the reader to clear the Disputed toggle with a `PATCH /api/wiki/<slug>` metadata write that `canWritePage`'s realm branch (`src/lib/authz.ts:267`) refuses for every non-admin, non-service principal on a public knowledge page — so the copy names a loop most readers cannot complete. (DW-392) `canRevert` in `src/components/RevisionHistory.tsx:99` carries a realm term and a site-owner term but no signed-in term, so an anonymous viewer of a non-realm page is shown Revert and its irreversible-sounding confirm in front of a write the middleware 401s. (DW-393) The DW-270 read gate in `src/app/api/ingest/history/route.ts` keys readability on `listReadableWikiPages`, which filters the page INDEX; an orphan page — index/disk drift that `checkOrphanPages` (`src/lib/lint.ts:94`) exists to detect — therefore 404s the whole DELETE batch, clearing nothing else selected alongside it.

**Approach:** Move both disputed-page sentences together onto one shared clause in the client-safe `src/lib/lint-types.ts` that states the realm limit and names who can actually clear the flag. Add the `isSignedIn` term `ArticleActions` already reads one component over to `canRevert`, with no ownership term. And make the ingest-history DELETE readability check fall back to a direct page read plus `canReadFrontmatter` for any slug the readable index set does not carry, at both of its two check sites.

## Boundaries & Constraints

**Always:** Both disputed-page sites read ONE exported clause — neither re-types it, so they cannot drift apart again. `lint-types.ts` stays client-safe: type-only imports, no `./storage`/`./llm`/`./wiki`/`./config` reachable from it. The Revert gate stays NARROWER than the server's answer, never wider, and takes its identity from the shared `@/lib/viewer-handle` hook; `RevisionHistory.tsx` and `RevisionItem.tsx` import no server-only module. The index-drift fallback re-uses `canReadFrontmatter` — the very function `canReadEntry` delegates to — so a page the index would have denied is denied identically by the fallback. Both DELETE readability sites move together and answer the same `SELECTION_NOT_FOUND` sentence, so an unreadable page still looks like an unselectable one.

**Block If:** Closing any of the three would require changing what a route, gate or check does for a caller it already answered correctly (an admin on a disputed page, a signed-in viewer on a non-realm page, a page the index carries).

**Never:** Do not add an ownership term to `canRevert` — the revert route gates on the realm and the private-page ACL, not on page ownership, so an `isOwner` term would hide the control from viewers the server would have allowed. Do not widen `GET /api/ingest/history`'s index-based listing filter — it is a hot path that would take up to `MAX_BULK_DELETE` page reads per request, and changing what the list shows is beyond this intent. Do not relax the "page does not exist at all" 404 in the `ingestIds` preflight, or the `if (!page) continue` cleanup branch the `jobIds` path depends on. Do not touch `deferred-work.md`. Do not rename a frozen identifier. Do not import `read-only.ts` or `write-denial.ts` into a `"use client"` module.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Disputed lint issue | `checkDisputedPages` over a page with `disputed: true` | `suggestion` contains the shared clause verbatim, including the PATCH with the slug interpolated and the sentence naming an agent or a site admin | — |
| Disputed auto-fix attempt | `fixLintIssue("disputed-page", slug)` | Throws `FixValidationError` whose message still opens `Disputed pages cannot be auto-fixed.` and contains the identical shared clause | Error type unchanged |
| Revert, signed out | `RevisionHistory` with `realmDeniesRevert={false}`, no Clerk session | No Restore button on any row; View still offered; no read-only note (it would be orphaned) | No request, no `window.confirm` |
| Revert, session not yet loaded | `isLoaded: false` | Fail-closed: no Restore button until the session resolves | — |
| Revert, signed-in non-owner, non-realm page | `isSignedIn: true`, `realmDeniesRevert={false}` | Restore button offered exactly as before | — |
| Revert, signed-in on a realm page | `realmDeniesRevert={true}`, not the site owner | Still hidden — the realm term is unchanged | — |
| Bulk delete, orphan page via `jobIds` | done job whose slug is on disk, readable, absent from the index | 200: the page is deleted and every other selected record is cleared with it | — |
| Bulk delete, orphan page via `ingestIds` | ledger entry whose page is on disk, readable, absent from the index | 200, same batch behaviour as an indexed page | — |
| Bulk delete, unreadable page absent from the index | direct read answers a page `canReadFrontmatter` denies | 404 `SELECTION_NOT_FOUND`; no page or job deleted | Sentence names no slug, realm or permission |
| Bulk delete, `ingestIds` page gone entirely | direct read answers `null` | 404 `SELECTION_NOT_FOUND`, unchanged from today | — |
| Bulk delete, `jobIds` page gone entirely | direct read answers `null` inside the ACL loop | 200, job record cleared — the cleanup branch is untouched | — |

</intent-contract>

## Code Map

- `src/lib/lint-types.ts` (77 lines) -- the client-safe home for lint constants shared by server (`lint-checks`, `lint-fix`) and client (`LintFilterControls`, `LintIssueCard`). New home for the shared disputed clause. Its header sentence "Every import here is type-only, so this module emits no runtime dependency beyond the array itself" needs updating for a second value export.
- `src/lib/lint-checks.ts:727` -- `checkDisputedPages`'s `suggestion`, and the doc comment at `:705-712` that explains the clear path.
- `src/lib/lint-fix.ts:749-751` -- the `disputed-page` entry of `NOT_AUTO_FIXABLE`; already imports `type { AutoFixableCheckType } from "./lint-types"`, so the value import is a one-line change.
- `src/lib/authz.ts:255-270` -- `canWritePage`'s realm branch; `isRealmRestrictedWrite:186`; `canReadFrontmatter:120` (the direct-read ACL the fallback needs); `canReadEntry:112` delegates to the same `canReadPage`.
- `src/lib/write-denial.ts` -- `WRITE_DENIAL_REALM` is the canonical phrasing to echo ("Only an agent or a site admin can …"). Server-only; the lint clause must NOT import it (`lint-types.ts` is client-safe).
- `src/components/RevisionHistory.tsx:82-99` -- `useViewerHandle()` destructure, `isSiteOwner`, and `const canRevert = isSiteOwner || !realmDeniesRevert;`. The read-only note at `:249-256` is already gated on `canRevert`, so it follows the new term for free.
- `src/components/ArticleActions.tsx:111,154` -- the reuse pointer: `const { isLoaded, isSignedIn, handle: handleLc } = useViewerHandle();` and `const canCurate = isLoaded && !!isSignedIn && isCuratable;` — the exact shape to mirror.
- `src/lib/viewer-handle.ts` -- already exports `isSignedIn: boolean` (coerced). No change needed.
- `src/components/RevisionItem.tsx:103` -- `{canRevert && (...)}` is what actually removes the button. No change needed.
- `src/app/api/ingest/history/route.ts` -- `SELECTION_NOT_FOUND:34`; the `ingestIds` preflight at `:184-201`; the ACL loop's `if (!readable.has(slug))` at `:266`; `if (!page) continue` at `:232` (the cleanup branch that must survive). `GET`'s own index filter at `:92-98` stays as-is.
- `src/lib/wiki.ts:753` -- `listReadableWikiPages` = `listWikiPages()` filtered by `canReadEntry`, i.e. index-only. This is the drift source.
- `src/lib/lint.ts:94` -- `checkOrphanPages(diskSlugs, indexSlugs)`; the proof that index/disk drift is a real state here.
- `src/lib/__tests__/lint-checks.test.ts:910-941` -- disputed-page cases. `src/lib/__tests__/lint-fix.test.ts:994-1013` -- the `FixValidationError` case; both assertions are substring-based and survive, but must gain a parity assertion.
- `src/lib/__tests__/article-actions-gate.test.ts:94,160-170` -- SOURCE-SCAN suite; it pins `"const canRevert = isSiteOwner || !realmDeniesRevert;"` verbatim and will fail until updated. `HISTORY_SUBTREE` also scans both history files for server-only imports.
- `src/components/__tests__/page-write-read-only.test.tsx:45-47` -- mocks Clerk as `isSignedIn: false`; its two `RevisionHistory` cases will fail until the mock is signed in.
- `src/components/__tests__/article-actions-delete-gate.test.tsx:506-585` -- the mounted realm suite; its Clerk sessions are already signed in, so it is unaffected but is the model for the new signed-out case.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` -- `beforeEach:118-126` makes `readWikiPageWithFrontmatter` answer an `owner: owner / private` page by default; the case "cloaks ledger entries the caller cannot read" at `:160` sets `listReadable` to `[]` and will now PASS the fallback, so its page must be made genuinely unreadable. `@/lib/authz` is partially mocked with `importOriginal`, so the real `canReadFrontmatter` is already in play.

## Tasks & Acceptance

**Execution:**
- `src/lib/lint-types.ts` -- export `disputedClearInstruction(slug: string): string`, one clause used by both disputed sites: the PATCH loop with the slug interpolated, then the realm limit and who can clear it, echoing `WRITE_DENIAL_REALM`'s "only an agent or a site admin" without importing that server-only module. Update the module header for the second value export -- one owner for the sentence is what stops the two sites drifting again.
- `src/lib/lint-checks.ts` -- import the clause and build `checkDisputedPages`'s `suggestion` from it; correct the `:705-712` doc comment, which currently states the toggle as THE surviving clear path without the realm limit.
- `src/lib/lint-fix.ts` -- import the clause and build the `NOT_AUTO_FIXABLE["disputed-page"]` message from it, keeping the leading `Disputed pages cannot be auto-fixed.` sentence intact; correct the comment above the entry.
- `src/components/RevisionHistory.tsx` -- destructure `isSignedIn` from `useViewerHandle()` and make `canRevert` `isLoaded && isSignedIn && (isSiteOwner || !realmDeniesRevert)`, mirroring `ArticleActions`' `canCurate`; document the new term and record that NO ownership term is added and why -- an anonymous viewer must not be offered a write the middleware 401s.
- `src/app/api/ingest/history/route.ts` -- add one module-local readability helper taking the slug, the readable index set, the already-read page (or `null`) and the principal; call it from BOTH the `ingestIds` preflight (reading the page only when the index set misses) and the ACL loop (passing the page it already read). Import `canReadFrontmatter`. Document why an index miss is not a denial and why the fallback cannot widen access.
- `src/lib/__tests__/lint-checks.test.ts`, `src/lib/__tests__/lint-fix.test.ts` -- assert each surface contains `disputedClearInstruction(slug)` verbatim (the parity that pins the two sites together) and that the clause names an agent or a site admin; keep the existing substring assertions.
- `src/lib/__tests__/article-actions-gate.test.ts` -- update the pinned `canRevert` expression and add an assertion that `RevisionHistory` destructures `isSignedIn` and carries no `isOwner`/`owner`-derived term.
- `src/components/__tests__/page-write-read-only.test.tsx` -- sign the Clerk mock in (the read-only cases are about the deployment state, and Revert now requires a session) and say why in the comment that currently explains the opposite.
- `src/components/__tests__/revision-revert-session-gate.test.tsx` (new) -- mounted cases for the signed-out, not-yet-loaded, signed-in-non-owner and signed-in-realm rows of the matrix, asserting on the outermost surface: the presence/absence of the Restore control, that View survives, and that no request and no `window.confirm` occur.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` -- repair the now-readable cloak case by making its page genuinely unreadable, and add the orphan cases from the matrix for both selection paths plus the two "page gone entirely" controls.

**Acceptance Criteria:**
- Given a disputed page, when either the lint check's `suggestion` or the auto-fix refusal is read, then both contain the identical clause naming the PATCH and stating that on a public knowledge page only an agent or a site admin can clear the flag.
- Given `src/lib/lint-types.ts` after the change, when its import graph is followed, then it still reaches no server-only module and remains importable from a `"use client"` component.
- Given a signed-out viewer on a page the realm does not restrict, when the history panel is expanded, then no Restore control is rendered on any row, no read-only note is rendered, and View is still offered.
- Given a signed-in viewer, when the same panel is expanded, then the Restore control is offered exactly as it was before this change on non-realm pages and still hidden on realm pages for a non-site-owner.
- Given a completed ingest or done job whose page is on disk and readable but missing from the page index, when the owner deletes it alongside other selected records, then the page is deleted and every other selected record is cleared in the same request.
- Given a selected record whose page a direct read shows the caller may not read, when the batch is submitted, then the response is 404 with `SELECTION_NOT_FOUND` and nothing in the batch is deleted.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 1, low 8)
- defer: 2: (high 0, medium 1, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` `disputedClearInstruction` echoed `WRITE_DENIAL_REALM` with no parity pin — both new assertions ran the regex against the helper's own output, so the canonical table could drift freely. Added cases in `write-denial.test.ts` pinning the clause against every `WRITE_DENIAL_REALM` entry and pinning the fact it claims (`isRealmRestrictedFrontmatterWrite({visibility:"public"}, "metadata") === true`, false for private and artifact).
  - `[low]` `[patch]` `checkOrphanPages` cited as `@/lib/lint` in three comments; it is defined at `src/lib/lint-checks.ts:66` and is absent from `lint.ts`'s re-export block. Corrected all three.
  - `[low]` `[patch]` `canReadSelectedPage`'s docblock claimed "the page on disk is the authority and the index is the stale copy" — false in the index-HIT direction, which short-circuits before any read. Restated precisely: a hit is trusted exactly as before DW-393, the disk is consulted only on a miss.
  - `[low]` `[patch]` An index-missed slug on the `ingestIds` path was read twice (preflight, then the ACL loop). Added a per-request `readOnce` cache threaded to both sites; `null` is cached too.
  - `[low]` `[patch]` The clause's trailing referral read as unconditional advice on a check that fires for private pages and artifacts, where the owner's own PATCH is admitted. Made it explicitly conditional ("so on such a page, ask one of them…") without splitting the two sites.
  - `[low]` `[patch]` The mounted session suite could not distinguish the `isLoaded` term from `isSignedIn` (its only fail-closed case set both false). Added an `{isLoaded: false, isSignedIn: true}` case; mutation-tested.
  - `[low]` `[patch]` `page-write-read-only.test.tsx` mocked `username: "yuanhao"` — the documented `NEXT_PUBLIC_OWNER_HANDLE` (`.env.example:25`) — while asserting the viewer is NOT the site owner. The suite now deletes and restores that env var.
  - `[low]` `[patch]` The DW-392 source-scan case was filed inside the DW-120 Delete-gate `describe`. Moved to its own.
  - `[low]` `[patch]` The boundary this change moved was untested: an orphaned PUBLIC knowledge page now passes the read gate and reaches the realm 403 instead of the 404 cloak. Added a case pinning the 403 and its sentence, with the reason the sentence is correctly earned.

## Design Notes

The clause, one owner, client-safe:

```ts
export function disputedClearInstruction(slug: string): string {
  return `clear the Disputed toggle in the page editor (PATCH /api/wiki/${slug} with metadata { disputed: false }). On a public knowledge page that metadata write is refused — only an agent or a site admin can clear the flag there — so ask one of them once the claims are reconciled.`;
}
```

It ECHOES `WRITE_DENIAL_REALM` rather than importing it: `write-denial.ts` reaches `./authz` → `./commons` → storage/lock/wiki, and `lint-types.ts` is the module the lint UI imports from the browser. Same reason `read-only.ts`'s client mirrors are duplicated next to their components.

Why the fallback cannot widen access: `listReadableWikiPages` is `listWikiPages()` filtered by `canReadEntry`, and `canReadEntry` delegates to `canReadPage` over the index entry's `owner`/`visibility`/`type` — the same three fields `canReadFrontmatter` coerces off the page. So for a slug the index DOES carry, index-deny and direct-read-deny are the same decision, and falling back for every index miss (rather than only for "the index does not carry it") reaches the identical answer without a second full index read. Where they differ, the page on disk is the authority and the index is the stale copy.

The gate stays where DW-270 put it. In the ACL loop the fallback consumes the `page` that loop already read, so it costs nothing and `if (!page) continue` still runs first — the already-gone cleanup for `jobIds` is untouched. Only the `ingestIds` preflight adds reads, bounded by `MAX_BULK_DELETE` (50) and taken only for entries the index missed.

`canRevert` gains `isLoaded && isSignedIn` and nothing else. `isLoaded` was already guarding only the `isSiteOwner` term; hoisting it makes the hydration answer fail-closed for the whole gate, matching `ArticleActions`' `canCurate`. The realm term and the deliberate absence of an ownership term are unchanged.

## Verification

**Commands:**
- `npx vitest run` -- expected: all suites pass in both the `node` and `dom` projects.
- `npx eslint .` -- expected: exit 0 (three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices are not regressions).
- `npx tsc --noEmit -p tsconfig.json` -- expected: no errors.

## Auto Run Result

Status: done

**Implemented change.** Three corrections to fallout from the DW-121/269/270 authz gates.
DW-389: both disputed-page copy sites now read one shared clause in the client-safe
`lint-types.ts` that states the realm limit and names who can actually clear the flag.
DW-392: `canRevert` gained the `isLoaded && isSignedIn` term `ArticleActions` already
reads one component over, with no ownership term, so an anonymous viewer is no longer
offered Revert and its confirm in front of a write the middleware 401s. DW-393: the
ingest-history DELETE readability check now falls back to a direct page read plus
`canReadFrontmatter` for a slug the readable index set does not carry, at both of its
check sites, so an orphan page no longer 404s the whole batch.

**Files changed**
- `src/lib/lint-types.ts` -- new `disputedClearInstruction(slug)`, the one owner of the disputed-clear sentence.
- `src/lib/lint-checks.ts` -- `checkDisputedPages`'s `suggestion` built from the clause; the clear-path doc comment corrected.
- `src/lib/lint-fix.ts` -- `NOT_AUTO_FIXABLE["disputed-page"]` built from the same clause.
- `src/components/RevisionHistory.tsx` -- the session term on `canRevert`, with the absence of an ownership term documented.
- `src/app/api/ingest/history/route.ts` -- `readOnce` + `canReadSelectedPage`; both DELETE readability sites now tolerate index drift. `GET` untouched.
- `src/lib/__tests__/lint-checks.test.ts`, `src/lib/__tests__/lint-fix.test.ts` -- each surface pinned verbatim against the shared clause.
- `src/lib/__tests__/write-denial.test.ts` -- the echoed clause pinned against `WRITE_DENIAL_REALM` and against the realm predicate.
- `src/lib/__tests__/article-actions-gate.test.ts` -- the `canRevert` source pin updated; the session gate in its own describe.
- `src/components/__tests__/page-write-read-only.test.tsx` -- Clerk mock signed in, site-owner env var neutralized.
- `src/components/__tests__/revision-revert-session-gate.test.tsx` (new) -- six mounted cases for the session gate.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` -- the cloak case repaired, orphan cases for both selection paths, the gone-entirely control, and the orphan x realm boundary.

**Review findings breakdown.** 9 patches applied (1 medium, 8 low); 2 items deferred (1 medium, 1 low); 8 rejected as noise. 0 intent gaps, 0 spec repairs.

**Follow-up review recommendation:** true. Patched this pass: high 0, medium 1, low 8. Score = 3 x 1 + 1 x 8 = 11, which is >= 5.

**Verification.** `npx vitest run` -- 274 files, 6171 tests, all pass (node and dom projects). `npx eslint .` -- exit 0 (three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, not regressions). `npx tsc --noEmit -p tsconfig.json` -- exit 0. Every row of the I/O & Edge-Case Matrix is covered by a named test that ran and passed.

**Residual risks.**
- The `ingestIds` orphan path is fixed at the DELETE but the row is still not listed by `GET` (deferred above), so only the `jobIds` half of DW-393 is reachable from the UI. That is the path the ledger entry's own harm statement describes.
- An index HIT is still trusted without opening the page, unchanged from before this pass: a stale index entry that says a page is readable when the disk says otherwise still wins. Narrowing that would cost a read for every slug on a path that already reads them only inside the ACL loop.
- The DW-270 residue is unchanged and still documented in place: a `jobIds` selection whose page exists-but-is-unreadable answers 404 while an already-gone one answers 200, because the gate must stay after `if (!page) continue`.
- The implementation agent briefly reverted `src/components/RevisionHistory.tsx` to HEAD while mutation-testing and reapplied it; the restored file was re-verified independently (`canRevert` on line 115, full suite and source-scan pin green).
- An untracked `spec-dw-384-385-386-387-read-only-parity-completion.md` from a different bundle's interrupted run was present in the working tree before this session started. It was left untouched and is not part of this commit.
