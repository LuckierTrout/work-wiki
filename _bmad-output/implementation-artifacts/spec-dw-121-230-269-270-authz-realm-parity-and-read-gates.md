---
title: 'Authz realm parity and read gates (DW-121, DW-230, DW-269, DW-270)'
type: 'refactor'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The `disputed-page` lint guidance still tells the reader to clear the
      Disputed toggle with a PATCH that DW-121 now refuses for every non-admin.
    evidence: |-
      `src/lib/lint-fix.ts:729-730` and the check's own `suggestion` at
      `src/lib/lint-checks.ts:727` both say: clear the Disputed toggle in the
      page editor (PATCH /api/wiki/<slug> with metadata { disputed: false }).
      After DW-121 that PATCH is refused for every non-admin principal on a
      public knowledge page, so the instruction names a loop only an agent
      token's owner-as-admin, a service principal or a site admin can complete.
      In this deployment the human IS the site owner and therefore an admin, so
      the action still works for them; the copy is inaccurate for anyone else.
      The spec scoped lint copy out of this pass (Design Notes, "Non-admin
      metadata loop"). Both sites must move together — closing only lint-fix.ts
      leaves half the copy wrong.
    location: >-
      src/lib/lint-fix.ts:729-730 and src/lib/lint-checks.ts:727
    severity: medium
  - summary: >-
      Deleting the reconciliation-thread writer took the last programmatic
      caller of the whole talk thread API with it.
    evidence: |-
      `listThreads`, `createThread`, `getThread`, `addComment`, `resolveThread`
      and `hasOpenThread` now have no non-test callers; only `deleteDiscussions`
      (lifecycle.ts), `getDiscussRelPrefix` (discuss-stats-index.ts,
      contributors.ts) and `getDiscussionStatsForSlugs` (browse.ts) are still
      read, and the talk HTTP surfaces that drove the rest are retired. A knock-on:
      `browse.ts:184` still renders a per-page discussion count that nothing can
      increase any more, and pre-existing reconciliation threads stay on disk
      feeding it. Retiring that surface — and the discuss-stats/contributor
      indexes hanging off it — is wider than DW-230 asked, and the spec's Never
      list forbids touching talk.ts's remaining readers, so it is recorded
      rather than resolved. The retirement banner in talk.ts says the same thing
      so the dead surface is not mistaken for live API.
    location: >-
      src/lib/talk.ts, src/lib/browse.ts:184
    severity: medium
  - summary: >-
      A non-admin page owner can no longer take their own public knowledge page
      private — the realm became a one-way door for them.
    evidence: |-
      `patchMetadata`'s realm ACL (`src/lib/patch-metadata.ts:106`) runs above
      the owner-only visibility guard, so `{ visibility: "private" }` on a
      public, non-agent-scoped, non-artifact page is now refused for its own
      owner over both REST and MCP, and that guard is unreachable for them. This
      follows directly from the recorded DW-121 decision (metadata is refused
      wherever body is), and the visibility-guard suite had to reseed onto an
      `html` artifact to keep exercising the guard at all — which is the signal
      that the plain-public path changed underneath it. In this deployment the
      human is the site owner and therefore an admin, so it does not bite here;
      a multi-user deployment would feel it, and there is no non-admin exit from
      the realm.
    location: >-
      src/lib/patch-metadata.ts:106-140
    severity: medium
  - summary: >-
      Revert is still offered to signed-out viewers on every page the realm does
      not restrict.
    evidence: |-
      `canRevert` in `src/components/RevisionHistory.tsx` carries a realm term
      and a site-owner term but no `isSignedIn` term, so an anonymous viewer of
      a public artifact or an agent-scoped page is still shown Revert and its
      irreversible-sounding confirm in front of a write the middleware 401s.
      This predates DW-269 (the control was ungated for everyone), and the
      recorded intent asked only for "the same realm term the Delete gate got",
      with the spec's Never list forbidding an ownership term — so the signed-in
      half was deliberately left alone. `ArticleActions` reads `isSignedIn` for
      exactly this purpose one component over.
    location: >-
      src/components/RevisionHistory.tsx
    severity: medium
  - summary: >-
      An orphan page — on disk but absent from the page index — now makes its
      ingest-history row undeletable and fails the whole batch.
    evidence: |-
      The DW-270 gate keys on `listReadableWikiPages`, which filters the page
      INDEX, not a per-page read. `src/lib/lint.ts:94`'s `checkOrphanPages`
      exists because index/disk drift is a real state here. A done job whose
      page is in that state used to delete the page and clear the job record; it
      now answers 404 for the entire request, clearing nothing else selected
      alongside it. This is exact parity with the pre-existing `ingestIds`
      preflight, which has always behaved this way, so DW-270 inherited the
      behaviour rather than inventing it.
    location: >-
      src/app/api/ingest/history/route.ts
    severity: medium
baseline_revision: 'b6249adc7223d10f7b1d93e4566ed68b5fb2218f'
---

<intent-contract>

## Intent

**Problem:** Four authz surfaces disagree with the routes behind them: the commons realm gate refuses `body`/`delete` but still admits `metadata`, so `authz.ts` claims metadata is "collectively editable" while the only UI that reaches it (the edit page) refuses everything (DW-121); Re-ingest and Revert are still offered where the same realm branch refuses them, the shape DW-120 already fixed for Delete (DW-269); the `jobIds` path of `DELETE /api/ingest/history` reaches the delete ACL holding a page the caller was never read-gated on (DW-270); and disputed transitions still write talk reconciliation threads that no surface can read (DW-230).

**Approach:** Extend the realm predicate to every `WriteKind` so a metadata patch is refused exactly where a body rewrite is, and retire the "collectively editable" prose that contradicts it; thread the realm fact for body writes into the Re-ingest and Revert affordances the same way DW-120 threaded it into Delete; read-gate every slug that reaches the bulk-delete ACL; and delete the three `ensureReconciliationThread` call sites plus the now-unreachable writer, keeping `talk.ts` for its remaining readers.

## Boundaries & Constraints

**Always:**
- The realm predicate stays the single expression every gate and every refusal sentence reads — no re-spelled copies, and the client islands keep getting it as a threaded prop (`@/lib/commons` must never enter a `"use client"` import graph).
- Client affordance gates may be NARROWER than the server's answer, never wider. The site owner (`isOwnerHandle` ⇒ server `isAdmin`) keeps every door DW-120 kept open for Delete.
- Read cloaks stay first: an unreadable page must 404 before any ACL sentence can describe it.
- Existing refusal WORDING in `WRITE_DENIAL` / `WRITE_DENIAL_REALM` is unchanged — this pass changes which sentence is reached, not what it says.
- Prose that a behaviour change falsifies must be rewritten in the same edit (docblocks in `authz.ts`, `write-denial.ts`, `patch-metadata.ts`, and the suites that argue reachability).

**Block If:**
- Making metadata realm-restricted would break a loop the app still needs from a NON-admin human (audit `lint-fix.ts`'s `disputed-page` guidance and the WikiEditor metadata PATCH before assuming otherwise).

**Never:**
- Do not remove the `WriteKind` parameter from `canWritePage` / `canWriteFrontmatter` / `resolveWriteDenial`, and do not delete the `WriteKind` type — the refusal verb and the attempted write kind stay expressible.
- Do not add an ownership gate to Revert (the ledger observes it; the recorded intent asks only for the realm term).
- Do not touch `talk.ts`'s remaining readers (`deleteDiscussions`, `getDiscussRelPrefix`, `getDiscussionStatsForSlugs`, `listThreads`, `createThread`), the retired talk HTTP surfaces, or `belongsInCommons` itself.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Metadata patch on public knowledge page, non-admin human | `patchMetadata` on `{visibility:"public"}`, principal `bob` | Throws `NOT_OWNER` carrying `WRITE_DENIAL_REALM.edit` | 403 at the REST/MCP door |
| Metadata patch, service principal or admin | same page, `service:*` / `ADMIN_HANDLES` handle | Patch applies | No error |
| Metadata patch on unreadable private page | `{visibility:"private", owner:"alice"}`, principal `bob` | Throws `NOT_FOUND` cloak, no realm wording | Unchanged |
| Realm predicate over every write kind | `isRealmRestrictedWrite({visibility:"public"}, k)` for k ∈ body/metadata/delete | `true` for all three | n/a |
| Realm predicate on excluded page classes | artifact (`html`/`slides`), agent-scoped, private | `false` for every kind | n/a |
| Re-ingest affordance, page owner on realm page | `ownsOrContributes`, `hasSourceUrl`, realm-restricted | Button not rendered | n/a |
| Re-ingest affordance, site owner on realm page | `isOwnerHandle(username)` | Button rendered (server admits) | n/a |
| Revert affordance, ordinary viewer on realm page | history expanded, realm-restricted | Revert button not rendered; View still is | n/a |
| Revert affordance, non-realm page | private/agent/artifact page | Unchanged — Revert rendered as today | n/a |
| Bulk delete, `jobIds` job whose page is unreadable | job owned by caller, `slug` page exists and is private to another user | 404 `"One or more selected ingests were not found."` before any ACL sentence | Nothing deleted |
| Bulk delete, `jobIds` job whose page is already gone | done job, `slug` no longer stored | Job record cleared, 200 | Unchanged cleanup |
| Disputed false→true via ingest / merge / patch | page flips `disputed: true` | Page written, `listThreads(slug)` stays empty | Unchanged write result |

</intent-contract>

## Code Map

- `src/lib/authz.ts:170-185` -- `isRealmRestrictedWrite` (+ `isRealmRestrictedFrontmatterWrite` :188-202). The one expression the realm branch, the client gates and every refusal sentence read. `canWritePage` :225-265 has the branch at :251 and a docblock bullet ("Public metadata patches are still collectively editable") plus an inline comment at :244-250 that this change falsifies.
- `src/lib/commons.ts:44-56` -- `belongsInCommons`: public ∧ ¬agent-scoped ∧ ¬artifact. Unchanged; reached via storage/lock/wiki, which is why the client seam exists.
- `src/lib/patch-metadata.ts:98-124` -- the metadata ACL, its "collectively editable" comment, and the `resolveWriteDenial("edit", fm, "metadata")` call whose "generic by construction" argument dies here. :190-201 holds the `ensureReconciliationThread` call to delete (`wasDisputed`/`nowDisputed` at :175-177 become unused).
- `src/lib/write-denial.ts:1-70` -- module docblock: the "ninth site is half-cloaked" argument (DW-270 closes it) and the "WHAT `patchMetadata` ACTUALLY CONTRIBUTES" paragraph (DW-121 kills it). `resolveWriteDenial` :140-172 — `@param writeKind` prose only; behaviour unchanged.
- `src/components/ArticleView.tsx:186-210` -- server-side `realmMeta` coercion + `realmDeniesDelete`. Add the body-write sibling here; renders `<RevisionHistory>` :498 and `<ArticleActions>` :500-509.
- `src/components/ArticleActions.tsx:20-36,132-137,160-162` -- the `realmDeniesDelete` prop docblock, `canDelete = isSiteOwner || (isOwner && !realmDeniesDelete)`, and the ungated `{hasSourceUrl && ownsOrContributes && <ReingestButton …/>}`. `isSiteOwner` comes from `@/lib/owner` + `@clerk/nextjs` (the only identity imports the island may have).
- `src/components/RevisionHistory.tsx` -- `"use client"`, no identity awareness today; renders `<RevisionItem …/>` for every viewer. `src/components/RevisionItem.tsx:14-36,85-100` -- the Revert button and its `readOnly`/`readOnlyNoteId` props.
- `src/app/api/ingest/history/route.ts:174-245` -- `readable` set built at :175-177 from `listReadableWikiPages`; `ingestIds` preflight :179-190; `jobIds` loop :192-208 (owner + terminal-status only); the ACL loop :214-243 that already reads each page.
- `src/lib/talk.ts:190-229` -- `RECONCILE_THREAD_TITLE` + `ensureReconciliationThread` (only readers are tests); `isAgentHandle` import :15 is used only there.
- `src/lib/ingest.ts:13,2008-2016` and `src/lib/merge.ts:27,281-285` -- the other two call sites.
- Routes that pass a write kind and stay untouched: `src/app/api/wiki/[slug]/route.ts:57,204`, `.../revisions/route.ts:146`, `src/app/api/ingest/reingest/route.ts:58`, `src/mcp.ts:293,397`, `src/lib/mcp-http.ts:406-420`, `src/app/u/[handle]/[slug]/edit/page.tsx:92`.
- Suites that encode the current behaviour and must move with it: `src/lib/__tests__/authz.test.ts:209-287`, `src/lib/__tests__/write-denial.test.ts` (`REALM_KINDS` :53, metadata-generic :119-127, cross-check :190-215, "no permissive default" :218-233), `src/lib/__tests__/patch-metadata.test.ts:134-222` (+ disputed-thread cases :226-283), `src/lib/__tests__/ingest-history-delete-route.test.ts:185-256`, `src/lib/__tests__/talk.test.ts:428-470`, `src/lib/__tests__/ingest.test.ts:665-680`, `src/lib/__tests__/merge.test.ts:26,220-230`, `src/lib/__tests__/article-actions-gate.test.ts` (source-scan seam), `src/components/__tests__/article-actions-delete-gate.test.tsx:170-180`, `src/components/__tests__/page-write-read-only.test.tsx:450-530`.

## Tasks & Acceptance

**Execution:**
- `src/lib/authz.ts` -- make `isRealmRestrictedWrite` return `belongsInCommons(meta)` for every `WriteKind` via an exhaustive `switch` over `"body" | "metadata" | "delete"` (no `default`, so a future kind is a compile error rather than a silent permissive answer); rewrite the docblock and `canWritePage`'s realm bullet/inline comment so nothing still claims metadata is collectively editable -- the predicate is the single source both the gate and the sentences read.
- `src/lib/patch-metadata.ts` -- rewrite the ACL comment and the `resolveWriteDenial(..., "metadata")` note: the realm CAN now refuse a metadata patch, and readable-but-denied implies the realm, so `NOT_OWNER` now carries the realm sentence. Delete the `ensureReconciliationThread` block and the now-dead `wasDisputed`/`nowDisputed` capture -- DW-230.
- `src/lib/write-denial.ts` -- update the module docblock: all nine sites now read-cloak (DW-270), `patchMetadata` no longer keeps the generic sentence by construction (DW-121), and record where `WRITE_DENIAL` is still reachable (`fm === null`, and non-realm pages at the resolver) -- prose that outlives its behaviour is the drift this module exists to prevent.
- `src/lib/talk.ts` -- delete `ensureReconciliationThread`, `RECONCILE_THREAD_TITLE` and the now-unused `isAgentHandle` import -- a writer whose threads no surface can read is the residue DW-230 names; leave every other export alone.
- `src/lib/ingest.ts`, `src/lib/merge.ts` -- delete the `ensureReconciliationThread` import and call site, and the comments promising the thread -- DW-230.
- `src/components/ArticleView.tsx` -- add `const realmDeniesBodyWrite = isRealmRestrictedWrite(realmMeta, "body");` beside `realmDeniesDelete`, note in a comment that the two currently agree because DW-121 made the realm kind-independent while each still names the kind its routes pass, and thread it to `<ArticleActions>` and `<RevisionHistory>` -- the server is the only side that may evaluate the predicate.
- `src/components/ArticleActions.tsx` -- accept required `realmDeniesBodyWrite: boolean` (documented like `realmDeniesDelete`) and gate Re-ingest as `hasSourceUrl && (isSiteOwner || (ownsOrContributes && !realmDeniesBodyWrite))` -- `POST /api/ingest/reingest` denies on the same branch, and the site owner is an admin there.
- `src/components/RevisionHistory.tsx`, `src/components/RevisionItem.tsx` -- accept required `realmDeniesRevert: boolean` on the panel, resolve `canRevert = isSiteOwner || !realmDeniesRevert` from `@clerk/nextjs` + `@/lib/owner` (mirroring `ArticleActions`), and pass a required `canRevert` down so `RevisionItem` renders the Revert button only when it is true -- View stays available to everyone.
- `src/app/api/ingest/history/route.ts` -- in the ACL loop, after the `if (!page) continue` cleanup branch and before `canWriteFrontmatter`, 404 with the existing selection sentence when `!readable.has(slug)`; explain that this makes "everything reaching the delete ACL is readable" true for BOTH selection paths while preserving the already-gone cleanup only the `jobIds` path has -- DW-270.
- `src/lib/__tests__/authz.test.ts`, `src/lib/__tests__/write-denial.test.ts` -- flip the metadata expectations (every `WriteKind` is realm-restricted on a commons page; the resolver answers the realm sentence for `"metadata"`), widen `REALM_KINDS` to all three, and rewrite the "no permissive default" block to pin exhaustiveness instead of the old kind asymmetry.
- `src/lib/__tests__/patch-metadata.test.ts` -- replace the "generic by construction" and "PUBLIC pages stay collectively patchable" cases with the realm refusal (non-owner AND page owner denied, admin/service still allowed), keep the private-page cloak case, and turn the two disputed cases into "no reconciliation thread is written" (`listThreads` empty).
- `src/lib/__tests__/ingest-history-delete-route.test.ts`, `src/lib/__tests__/ingest.test.ts`, `src/lib/__tests__/merge.test.ts`, `src/lib/__tests__/talk.test.ts` -- turn the leak case into a 404 case (job owned by the caller, page unreadable, nothing deleted, no realm wording), keep a case proving a readable job slug still deletes, and drop/replace the reconciliation-thread assertions.
- `src/lib/__tests__/article-actions-gate.test.ts`, `src/components/__tests__/article-actions-delete-gate.test.tsx`, `src/components/__tests__/page-write-read-only.test.tsx` -- extend the source-scan seam to the new props (computed on the server, required on the island, subtree still free of `@/lib/commons`/`@/lib/authz`/`@/lib/wiki`) and pass the new required props at every mount site.

**Acceptance Criteria:**
- Given a public, non-agent, non-artifact page and a non-admin authenticated principal, when `canWritePage(meta, principal, "metadata")` is called, then it returns `false` and `resolveWriteDenial("edit", meta, "metadata")` returns `WRITE_DENIAL_REALM.edit`.
- Given the same page and a service principal or an `ADMIN_HANDLES`/site-owner principal, when any write kind is attempted, then it is still permitted.
- Given `src/lib/authz.ts` after the change, when the file is read, then no comment or docblock still asserts that public metadata patches are collectively editable.
- Given a realm-restricted page rendered for its non-site-owner page owner, when the article and its history are viewed, then neither the Re-ingest button nor any Revert button is present, while View-raw, Graphify, Save-to-vault and per-revision View are unchanged.
- Given the same page viewed by the site owner, when the article and its history are viewed, then Re-ingest and Revert are both offered.
- Given a caller who owns a done ingest job whose `slug` page exists and is unreadable to them, when they `DELETE /api/ingest/history` with that `jobIds` entry, then the response is 404 with the selection sentence, no page or job is deleted, and no realm wording or slug appears in the body.
- Given a caller who owns a done ingest job whose `slug` page no longer exists, when they delete it, then the job record is cleared and the response is 200.
- Given a disputed `false → true` transition through ingest, merge, or a metadata patch, when the write completes, then the page is written as before and `listThreads(slug)` returns no threads.
- Given `pnpm exec tsc --noEmit`, `pnpm test` and `pnpm lint`, when run, then all pass with no new warnings.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 4, low 6)
- defer: 5: (high 0, medium 5, low 0)
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[low]` `[patch]` `RevisionHistory` rendered the read-only note independently of `canRevert`, so a realm page on a read-only deployment showed the revert refusal with no Revert button and an `aria-describedby` target with zero referrers — note now gated on `canRevert`.
  - `[low]` `[patch]` `RevisionHistory` dropped `isLoaded` from `useUser()`, so the site owner's Revert buttons popped in after hydration on a realm page — the site-owner term is now load-guarded, mirroring `ArticleActions`.
  - `[medium]` `[patch]` The Clerk handle resolution was copy-pasted verbatim into `RevisionHistory` from `ArticleActions`, with only the `username` branch tested — extracted to `src/lib/viewer-handle.ts` (`useViewerHandle`), imported by both islands, with the seam scan in `article-actions-gate.test.ts` extended to cover it.
  - `[low]` `[patch]` `"One or more selected ingests were not found."` had become a bare literal at three sites in the history route while a comment promised it was verbatim — hoisted to one `SELECTION_NOT_FOUND` constant.
  - `[low]` `[patch]` The read-gate placement comment defended the ordering but never named the residue it leaves (exists-but-unreadable 404 vs already-gone 200 remain distinguishable to a job owner) — now stated as the deliberate trade it is.
  - `[low]` `[patch]` The rewritten `write-denial.ts` docblock named the HTTP MCP `reingest` tool as the `fm === null` resolver caller (it never calls the resolver with a null page) and folded its after-the-ACL merged cloak into "all nine read-cloak" — both restated accurately.
  - `[medium]` `[patch]` Five prose sites DW-121 falsified still said public knowledge pages are collectively editable/manageable, missed by the spec's grep because of hyphenation and line wrapping — `mcp-http.ts:399`, `wiki/[slug]/route.ts:44`, `api/mcp/route.ts:71`, `query.ts:203`, `query-search.ts:374` all corrected.
  - `[medium]` `[patch]` The DW-230 retirement banner claimed "every other export in this module still has live readers", which is false for six thread-API exports — corrected to name the three that are still read.
  - `[low]` `[patch]` `ingest-history-delete-route.test.ts`'s mock comment still called the route "the one deny site with no read cloak" after DW-270 closed it — premise updated, reason for keeping the realm predicate real preserved.
  - `[medium]` `[patch]` `dispatchMcp — update_metadata` had no deny case, and the reseeded happy path could not fail if `principal: p` were dropped from `mcp-http.ts` (the handler substitutes a write-anything `service:mcp` principal) — two deny cases added and confirmed to fail under that mutation.

## Design Notes

**Why the switch, not `belongsInCommons(meta)` alone.** DW-121 makes the realm kind-independent, so the argument could be dropped — but `canWritePage`, `canWriteFrontmatter` and `resolveWriteDenial` all still take a `WriteKind`, and collapsing the type would be a far wider refactor than the recorded decision. An exhaustive switch keeps the parameter live and lint-clean, and makes a future fourth kind a compile error instead of inheriting the permissive answer the existing docblock warns about:

```ts
export function isRealmRestrictedWrite(meta: PageReadMeta, writeKind: WriteKind): boolean {
  switch (writeKind) {
    case "body":
    case "metadata":
    case "delete":
      return belongsInCommons(meta);
  }
}
```

**Why two realm booleans on the client seam.** `realmDeniesDelete` and `realmDeniesBodyWrite` are provably equal today. They stay separate because each names the write kind the route behind its door actually passes (`"delete"` for `DELETE /api/wiki/[slug]`, `"body"` for reingest and revert), so the seams survive a future rule that splits by kind again. Say this in a comment so the equality does not read as an oversight.

**Why the read-gate lands in the ACL loop.** That loop already reads each page, so the check costs nothing, applies to both selection paths at once, and sits after `if (!page) continue` — which keeps the "already gone, clear the record" cleanup that only the `jobIds` path exercises. A flat gate in the `jobIds` preflight would 404 exactly those cleanups.

**Reachability after this pass.** Every one of the nine deny sites now cloaks before it speaks, so readable + denied ⇒ realm at all of them, and `WRITE_DENIAL` is reachable only at the resolver itself (a non-realm page, or `fm === null`). The `write-denial.ts` docblock must say this — the previous version's proof was built on the two exceptions this pass removes.

**Non-admin metadata loop.** `lint-fix.ts`'s `disputed-page` message tells the owner to clear the toggle via the page editor. On a realm page the edit page already refused before this change (DW-121's complaint), so the loop was not working there; this pass makes the API agree with the screen rather than breaking a working path. In this deployment the human is the site owner and therefore an admin, so the clear action still works for them. Flag it as a deferred finding rather than rewriting lint copy here.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean (catches every mount site missing a new required prop).
- `pnpm test` -- expected: full suite green.
- `pnpm lint` -- expected: no new errors or warnings.
- `grep -rn "ensureReconciliationThread\|RECONCILE_THREAD_TITLE" src` -- expected: no matches.
- `grep -rn "collectively editable" src` -- expected: no matches.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

Four deferred-work entries closed in one pass. **DW-121:** `isRealmRestrictedWrite` is now an exhaustive `switch` over `WriteKind` returning `belongsInCommons(meta)` for `body`, `metadata` and `delete` alike, so a metadata patch on a public knowledge page is refused exactly where a body rewrite is; the "collectively editable" claim is retired everywhere in `src`, and `patchMetadata`'s `NOT_OWNER` branch is now reachable and carries the realm sentence. **DW-269:** `ArticleView` computes `realmDeniesBodyWrite` beside `realmDeniesDelete` and threads it to Re-ingest (`ArticleActions`) and Revert (`RevisionHistory` → `RevisionItem`), each keeping the `isSiteOwner` escape DW-120 established. **DW-270:** every slug reaching the bulk-delete ACL is now read-gated, placed after the "already gone" cleanup branch so both selection paths are covered without breaking the cleanup only `jobIds` exercises. **DW-230:** the reconciliation-thread writer, its title constant and all three call sites are gone; `talk.ts` keeps its remaining readers.

### Files changed

- `src/lib/authz.ts` — realm predicate covers every write kind; docblocks retired.
- `src/lib/patch-metadata.ts` — ACL comment rewritten; `ensureReconciliationThread` call and dead disputed capture removed.
- `src/lib/write-denial.ts` — module docblock re-derived for the new cloak and realm topology.
- `src/lib/talk.ts` — writer + title constant deleted, retirement banner names the three exports still read.
- `src/lib/ingest.ts`, `src/lib/merge.ts` — reconciliation-thread call sites removed.
- `src/components/ArticleView.tsx` — computes and threads the body-write realm fact.
- `src/components/ArticleActions.tsx` — required `realmDeniesBodyWrite`; Re-ingest gate.
- `src/components/RevisionHistory.tsx`, `src/components/RevisionItem.tsx` — required `realmDeniesRevert` / `canRevert`; Revert gate and its read-only note.
- `src/lib/viewer-handle.ts` (new) — `useViewerHandle`, the one client-safe Clerk handle resolution both islands read.
- `src/app/api/ingest/history/route.ts` — read gate in the ACL loop; `SELECTION_NOT_FOUND` constant.
- `src/lib/mcp-http.ts`, `src/app/api/mcp/route.ts`, `src/app/api/wiki/[slug]/route.ts`, `src/lib/query.ts`, `src/lib/query-search.ts`, `src/lib/untrusted.ts` — prose DW-121 falsified.
- Test suites moved with the behaviour: `authz`, `write-denial`, `patch-metadata`, `wiki-routes`, `mcp-http`, `ingest`, `merge`, `talk`, `ingest-history-delete-route`, `article-actions-gate`, `article-actions-delete-gate`, `page-write-read-only`.

### Review findings

- Patches applied: 10 (medium 4, low 6) — see the Review Triage Log.
- Deferred: 5 (all medium) — see frontmatter `deferred`.
- Rejected: 4 — an unreachable contributor/private-page Re-ingest row (a non-owner cannot read a private page, so the article never renders), an unused `expectDelete` field on the Re-ingest test rows, "missing" mixed-selection coverage already provided by the existing batch case, and comment-length preferences at odds with house style.
- Follow-up review recommended: **true** (0 high patched; 3 × 4 medium + 1 × 6 low = 18 ≥ 5).

### Verification

- `npx tsc --noEmit` — exit 0.
- `npx vitest run` — 268 files / 5913 tests, all passing.
- `npx eslint` — exit 0; output byte-identical to the pre-change baseline (three pre-existing `jsx-ast-utils` notices).
- `grep -rn "ensureReconciliationThread\|RECONCILE_THREAD_TITLE" src` — no matches.
- `grep -rn "collectively editable" src` — no matches.
- Matrix audit: every row in the I/O & Edge-Case Matrix is covered by a test that ran and passed (`patch-metadata.test.ts` for the four metadata rows and the two disputed rows, `authz.test.ts` / `write-denial.test.ts` for the two predicate rows, `article-actions-delete-gate.test.tsx` for the four affordance rows, `ingest-history-delete-route.test.ts` for the two bulk-delete rows, `page-write-read-only.test.tsx` for Revert on a non-realm page).
- Mutation-checked at review: deleting `principal: p` from the HTTP MCP `update_metadata` binding now fails two tests and nothing else.

### Residual risks

- The realm is now a one-way door for a non-admin page owner: they cannot take their own public knowledge page private, because the metadata ACL runs above the owner-only visibility guard. This follows directly from the recorded DW-121 decision. In this deployment the human is the site owner and therefore an admin, so it does not bite here. Deferred.
- Per-user MCP agent tokens resolve to an `agent:<id>` principal, which is neither `service:` nor admin, so those agents can no longer patch `disputed`/`confidence`/`tags`/`expiry` on public knowledge pages — only the deployment service token can. Consistent with the decision (metadata now follows body, which was already refused for them); the prose describing that door was corrected.
- The bulk-delete gate keys on the page index, so an orphan page (on disk, absent from the index) makes its history row undeletable and fails the batch — exact parity with the pre-existing `ingestIds` preflight. Deferred.
- `edit/page.tsx` is deliberately untouched: the recorded decision says the realm change makes its single `"body"` gate accurate rather than asking for the gate to be split or a metadata-only surface to be built. Nothing at that surface is tested by this pass; the argument for its correctness is the ACL parity itself.
