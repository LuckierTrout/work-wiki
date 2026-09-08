---
title: 'Commons-realm deny parity: one client gate, one explanation, one ordering'
type: 'bugfix'
created: '2026-08-19'
status: 'done'
baseline_revision: 'ffbebf43578a026b1d0423ac66483de7559fa325'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The Re-ingest and Revert client affordances are still offered where the same
      commons-realm gate refuses them — the exact shape DW-120 fixed for Delete.
    evidence: |-
      `src/components/ArticleActions.tsx` renders `<ReingestButton>` on
      `hasSourceUrl && ownsOrContributes` with no realm term, while
      `POST /api/ingest/reingest` denies through `canWriteFrontmatter(fm, principal, "body")`
      — the same realm branch and the same write kind. `RevisionHistory` renders Revert
      for every viewer with no ownership or realm gate, and the revert route now answers
      `WRITE_DENIAL_REALM.revert`. Both predate this pass (unchanged at `ffbebf4`), and the
      bundle intent named only the Delete gate, so both were left alone — but this pass
      makes the divergence louder by giving those doors the realm sentence to shout.
      Consequence: on an ordinary URL-ingested public knowledge page, the owner presses a
      live-looking Re-ingest button and meets the refusal as a red error string.
    location: >-
      src/components/ArticleActions.tsx:161
    severity: medium
  - summary: >-
      The `jobIds` path of `DELETE /api/ingest/history` reaches the delete ACL holding a
      page the caller was never read-gated on.
    evidence: |-
      The route preflights `ingestIds` against `listReadableWikiPages(principal)` and 404s
      unreadable ones, but the `jobIds` path checks only `job.owner !== principal.handle`;
      the job's `slug` page is never read-checked. This pass made the *sentence* safe there
      (the resolver only speaks of a realm it evaluated, pinned by the rewritten leak test),
      but the missing read-gate itself is a separate authz question this pass did not touch.
    location: >-
      src/app/api/ingest/history/route.ts
    severity: medium
  - summary: >-
      `src/lib/commons.ts` imports two client-safe predicates through `./wiki`, so every
      route test that mocks `@/lib/wiki` must stub them or get a 500 where it means 403.
    evidence: |-
      `commons.ts` imports `isAgentScopedType`/`isArtifactType` from `./wiki`, which merely
      re-exports them from the client-safe `./page-types`. Because `belongsInCommons` is now
      on the 403 path, two suites (`ingest-history-delete-route.test.ts`,
      `ingest-routes.test.ts`) had to widen their `vi.mock("@/lib/wiki")` factories to keep
      the predicate from calling `undefined`. Importing from `./page-types` directly would
      remove the trap for every future route suite at no behavioural cost. The import is
      pre-existing and unchanged by this pass.
    location: >-
      src/lib/commons.ts:17
    severity: low
---

<intent-contract>

## Intent

**Problem:** The commons-realm write deny (`canWritePage`'s `belongsInCommons` branch) reads differently at every surface it reaches: `ArticleActions.tsx` offers Delete to a non-admin page owner the server then refuses, nine server call sites answer a generic "You don't have permission to …" where the edit page now explains the realm, and the edit page renders its refusal *before* the canonical-tenant 308, so a non-canonical edit URL shows a screen whose back-link points at a different handle.

**Approach:** Derive the client Delete gate from the same realm predicate `canWritePage` uses (threaded from the server, never re-guessed client-side), give every server deny one shared realm explanation that is stated only when the realm actually applies, and move the edit page's write-denial branch after the canonical-tenant `permanentRedirect`.

## Boundaries & Constraints

**Always:**
- The realm sentence is emitted ONLY where `belongsInCommons(meta)` actually holds — a deny that is not the realm deny keeps its generic sentence. No surface may claim a page's realm it has not evaluated.
- The 404/not-found cloak stays first at every site that has one: an unreadable private page must never learn it exists, or its realm, from the new copy.
- The edit page's read cloak (`canReadFrontmatter` → "Page not found") stays the FIRST branch. Only the write-denial branch moves, and only past the canonical-tenant redirect.
- The client gate stays a convenience gate: it may be narrower than the server's answer (a non-owner `ADMIN_HANDLES` admin is server-only knowledge) but must never be wider.
- `ArticleActions.tsx` stays a client island: no server-only module (`@/lib/authz`, `@/lib/commons`, `@/lib/wiki`) may enter its import graph.
- One owner per sentence, mirroring `src/lib/read-only.ts`: the realm copy lives in one module every call site imports.

**Block If:**
- Making the client gate match the server would require exposing `ADMIN_HANDLES` to the browser.

**Never:**
- Do not change what `canWritePage` decides — this pass changes who is *told* what, plus one branch ordering. The realm gate's inputs and outputs are unchanged.
- Do not add a metadata-only editing surface (that is a separate open ledger item).
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Owner of a public knowledge page | `ArticleActions` for `{visibility: public, type: undefined}`, viewer = page owner, not site owner | No Delete button rendered | No error expected |
| Owner of a public artifact | same, `type: "html"` (fails `belongsInCommons`) | Delete button rendered | No error expected |
| Owner of a private page | `visibility: "private"`, viewer = owner | Delete button rendered | No error expected |
| Site owner on a realm page | `visibility: public`, viewer = `NEXT_PUBLIC_OWNER_HANDLE` | Delete button rendered | No error expected |
| Signed-out viewer | any page | No Delete button | No error expected |
| DELETE realm deny | `DELETE /api/wiki/[slug]` on a readable commons-realm page, non-admin | 403 whose `error` carries the realm explanation, not the generic sentence | 403 |
| DELETE private deny | `DELETE /api/wiki/[slug]` on an unreadable private page | 404 `page not found: <slug>`, no realm wording anywhere | 404 |
| Metadata deny | `patchMetadata` denial branch (`writeKind` defaults to `metadata`, so `belongsInCommons` never gates it) | Generic sentence retained; `NOT_OWNER` code unchanged | thrown Error |
| Bulk delete deny | `DELETE /api/ingest/history` where one selected page is realm-denied | 403 with the realm explanation phrased for a selection | 403 |
| Bulk delete non-realm deny | same, deny on a page that is not `belongsInCommons` | Generic selection sentence | 403 |
| MCP reingest cloak | `mcp-http` `reingest` on a missing slug | Existing cloaked "Page not found or you don't have permission…" unchanged | thrown Error |
| Non-canonical edit URL, realm-denied | `/u/bob/transformers/edit` for alice's public knowledge page, non-admin viewer | 308 to `/u/alice/transformers/edit` (redirect wins) | No error expected |
| Canonical edit URL, realm-denied | `/u/alice/transformers/edit`, non-admin viewer | "Cannot edit" screen with the realm explanation and a back-link to `/u/alice/transformers` | No error expected |
| Non-canonical edit URL, unreadable private page | `/u/bob/secret/edit`, viewer cannot read | "Page not found" (read cloak still first, no 308 leak) | No error expected |

</intent-contract>

## Code Map

- `src/lib/authz.ts:183-215` -- `canWritePage`; its realm branch is `(writeKind === "body" || "delete") && belongsInCommons(meta)`. Extract that condition into an exported predicate the branch itself calls, so every other surface reads the same expression rather than a copy of it. `canWriteFrontmatter` (:220) is the frontmatter-coercing wrapper to mirror.
- `src/lib/commons.ts:46-55` -- `belongsInCommons(meta)`: `visibility !== "private" && !isAgentScopedType(type) && !isArtifactType(type)`. Server-only import graph (storage/lock/wiki) — must not reach a client bundle.
- `src/lib/read-only.ts` -- the precedent to mirror: one module owning every server refusal sentence, with a docblock stating what the boundary covers. `READ_ONLY_REFUSAL` is the shape for the new copy table.
- `src/components/ArticleActions.tsx:82` -- `const canDelete = isOwner || isSiteOwner;` (rendered at :137). Client island; `isSiteOwner` comes from `isOwnerHandle` (`src/lib/owner.ts`, `NEXT_PUBLIC_OWNER_HANDLE`, client-safe). Needs a new prop carrying the realm fact.
- `src/components/ArticleView.tsx:186` -- server component; already computes `isCuratable` from `isVaultEligible(...)` over the same coerced frontmatter, and hands `ArticleActions` its props at :485-494. This is where the realm fact is computed and threaded.
- `src/lib/__tests__/article-actions-gate.test.ts:22-26` -- the text pin that asserts the literal `const canDelete = isOwner || isSiteOwner;` string. Must be rewritten; its second suite (the read-only seam, DW-37/149/187) and its `readOnly=\{readOnly\}` count of 2 must survive untouched.
- Server deny sites, all nine: `src/mcp.ts:294` (body) and `:394` (delete); `src/app/api/wiki/[slug]/route.ts:59` (delete) and `:163` (body); `src/app/api/wiki/[slug]/revisions/route.ts:148` (revert); `src/app/api/ingest/reingest/route.ts:60`; `src/app/api/ingest/history/route.ts:212` (bulk delete, the ONLY one with no read cloak); `src/lib/mcp-http.ts:407` (deliberately merged not-found/denied cloak); `src/lib/patch-metadata.ts:108` (writeKind `metadata` — NOT a realm deny; see Design Notes).
- `src/app/u/[handle]/[slug]/edit/page.tsx` -- read cloak :24-42, write denial :56-77, canonical redirect :80-88. `pageTenant` is computed twice today (once inside the denial's `backHref`, once at :81).
- `src/app/u/[handle]/[slug]/edit/__tests__/edit-denial-copy.test.tsx` -- renders the real server component with `handle: "alice"` (canonical), so the reorder does not break it; extend it for the non-canonical case. `REALM_REASON` regex at :80 matches across whitespace.
- `src/lib/__tests__/mcp.test.ts:4319,4428` -- assert the two generic MCP sentences; update to the new copy.
- `src/lib/__tests__/workbench-preview.test.ts:2003-2020` -- uses the generic sentence only as an arbitrary relayed server string. Leave alone.
- `src/lib/page-types.ts` -- documented client-safe predicate module (`isAgentScopedType`, `isArtifactType`); read-only evidence that `belongsInCommons` itself cannot be imported client-side without moving it.
- `src/components/__tests__/page-write-read-only.test.tsx` and `owner-scoped-anchors.test.tsx:72` -- the mounted-test conventions: `vi.mock("@clerk/nextjs", …)`, `cleanup()` first in `afterEach`. DOM project collects `src/**/__tests__/**/*.test.tsx` only (`vitest.config.ts`).

## Tasks & Acceptance

**Execution:**
1. `src/lib/authz.ts` -- export a pure predicate for the realm branch (e.g. `isRealmRestrictedWrite(meta, writeKind)` plus a frontmatter wrapper) and make `canWritePage`'s branch call it -- so the client gate and the copy read the same expression the gate decides on, not a copy of it.
2. `src/lib/write-denial.ts` (new) -- own every commons-realm denial sentence in one table keyed by action (`edit`, `delete`, `revert`, `reingest`, `bulkDelete`), plus a resolver that returns the realm sentence when the realm predicate holds for that page/writeKind and the existing generic sentence otherwise -- mirroring `read-only.ts`'s "one owner per server sentence"; the resolver is what keeps a non-realm deny from claiming a realm.
3. `src/app/api/wiki/[slug]/route.ts` -- replace both literal 403 sentences (DELETE :59, PUT :163) with the resolver -- the two doors `WikiEditor` and `DeletePageButton` actually hit.
4. `src/app/api/wiki/[slug]/revisions/route.ts` -- same for the revert 403 at :148.
5. `src/app/api/ingest/reingest/route.ts` -- same for the re-ingest 403 at :60.
6. `src/app/api/ingest/history/route.ts` -- same for the bulk-delete 403 at :212, using the selection-phrased sentence; this site has no read cloak, so the resolver's realm check is what keeps it from describing an unreadable private page.
7. `src/mcp.ts` -- same for the two thrown sentences (:294 body, :394 delete).
8. `src/lib/mcp-http.ts` -- in the `reingest` tool (:405-409), keep the merged cloak for a missing/unreadable page and emit the realm explanation only when the page was read AND the realm predicate holds.
9. `src/lib/patch-metadata.ts` -- route the `NOT_OWNER` sentence through the same resolver with `writeKind` `metadata`, and record in the comment that the realm never gates a metadata patch, so this site keeps the generic sentence by construction rather than by omission.
10. `src/app/u/[handle]/[slug]/edit/page.tsx` -- move the write-denial branch to AFTER the canonical-tenant `permanentRedirect`, reuse the already-computed `pageTenant` for the back-link, source the paragraph from the shared copy table, and update the branch comment to state the new ordering guarantee (read cloak → canonical 308 → write denial).
11. `src/components/ArticleView.tsx` -- compute the realm fact server-side from the same coerced frontmatter `isCuratable` already uses, and pass it to `ArticleActions`.
12. `src/components/ArticleActions.tsx` -- replace `canDelete = isOwner || isSiteOwner` with a gate derived from the threaded realm fact, and rewrite the stale "the effective server outcome" comment to say what the client can and cannot know.
13. `src/components/__tests__/article-actions-delete-gate.test.tsx` (new) -- mount `ArticleActions` across the matrix rows above and assert the rendered Delete affordance agrees with `canWritePage(meta, principal, "delete")` evaluated directly -- the divergence the text pin could not see.
14. `src/lib/__tests__/article-actions-gate.test.ts` -- replace the literal-source assertions with a pin on the seam that carries the realm fact (`ArticleView` computes it, `ArticleActions` receives it, no server module imported into the island); leave the DW-37/149/187 suite and its two-`readOnly` count untouched.
15. `src/lib/__tests__/write-denial.test.ts` (new) -- unit-test the resolver over the I/O matrix: realm vs non-realm deny per action, and that no sentence claims a realm the predicate rejects.
16. `src/app/u/[handle]/[slug]/edit/__tests__/edit-denial-copy.test.tsx` -- add the non-canonical-handle cases (realm-denied → 308, unreadable private → "Page not found", writable → 308) and keep every existing assertion green.
17. `src/lib/__tests__/mcp.test.ts` -- update the two sentence assertions at :4319 and :4428 to the realm copy.

**Acceptance Criteria:**
- Given a public knowledge page and a signed-in non-admin page owner, when the article renders, then no Delete control appears, and the same `(meta, principal)` pair returns `false` from `canWritePage(…, "delete")`.
- Given any page/viewer pair covered by the mounted matrix, when the Delete affordance is present, then `canWritePage(meta, principal, "delete")` is `true` for that pair (the client gate is never wider than the server's answer).
- Given a readable commons-realm page and a non-admin caller, when any of the nine server denies fires, then the message names the page's realm and a way forward, and no two surfaces word the same realm deny differently.
- Given an unreadable private page, when a write is attempted at any of those surfaces, then the response is the existing not-found cloak with no realm wording.
- Given `/u/bob/transformers/edit` for alice's realm-denied public knowledge page, when a non-admin opens it, then the response is a 308 to `/u/alice/transformers/edit` rather than a rendered refusal.
- Given `/u/bob/secret/edit` for a private page the viewer cannot read, when it is opened, then "Page not found" renders and no redirect to the canonical handle occurs.
- Given the whole change, when `pnpm test` and `pnpm lint` run, then both pass with no pre-existing suite disabled or weakened.

## Design Notes

**Why the client gate is threaded, not computed.** `belongsInCommons` lives in `src/lib/commons.ts`, whose import graph reaches storage, locks and `wiki.ts`; `ArticleActions` is a `"use client"` island. So the *realm* half is evaluated on the server (`ArticleView`, beside the existing `isCuratable`) and handed down as one prop, while the *identity* half stays client-side because only the browser holds the Clerk session. The gate is therefore:

```
canDelete = isSiteOwner || (isOwner && !realmDeniesDelete)
```

`isSiteOwner` is the only admin the browser can know (`NEXT_PUBLIC_OWNER_HANDLE`); an `ADMIN_HANDLES` admin who is not the site owner is under-offered the button. That is the correct direction for a convenience gate — narrower than the server, never wider — and the mounted test asserts exactly that inequality rather than equality.

**Why the copy is resolved, not hardcoded.** Seven of the nine sites sit behind a read cloak, which is what makes "this page is public knowledge" provable there (readable + write-denied ⟹ the realm branch, since a readable private page is writable by everyone who can read it). Two do not: `ingest/history` has no cloak, and `patch-metadata` denies on `writeKind: "metadata"`, which the realm branch never gates at all — its `NOT_OWNER` sentence is reachable only if that invariant changes. A resolver keyed on the same predicate keeps both honest without either site re-deriving the argument.

**Ordering.** After task 10 the edit page reads: read cloak → canonical 308 → write denial → editor. The read cloak must stay first (moving it would make the 308 a private-page existence oracle); the write denial must stay after the 308 so the refusal it renders always belongs to the URL the viewer is on.

## Verification

**Commands:**
- `pnpm test` -- expected: both vitest projects green, including the new mounted gate suite and the updated `mcp.test.ts` sentences.
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit` -- expected: clean (new props and the extracted predicate typecheck).
- `grep -rn "You don't have permission" src --include=*.ts --include=*.tsx` -- expected: every remaining hit is inside `src/lib/write-denial.ts` or a test fixture; no route, MCP handler or page holds its own copy of the sentence.

## Spec Change Log

- 2026-08-19 -- Dev attempt 1 (`dw3-authz-realm-parity-and-copy-dev-1`) hit the 60-minute session timeout after planning; the orchestrator rolled the working tree back to `ffbebf4`, so this spec survived at `in-review` with no implementation on disk. Attempt 2 resumes the same plan at implementation: status reset to `in-progress`, `baseline_revision` unchanged (HEAD is still `ffbebf4`). No contract, task, or acceptance change.

## Review Triage Log

### 2026-08-19 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 5, low 3)
- defer: 3: (high 0, medium 2, low 1)
- reject: 3
- addressed_findings:
  - `[medium]` `[patch]` The edit screen's realm paragraph lost its "or deleted" clause versus `ffbebf4`, and since DW-120 now hides Delete, no surface told a non-admin owner deletion was refused. Restored the clause in `WRITE_DENIAL_REALM.edit` and pinned it.
  - `[medium]` `[patch]` `isRealmRestrictedWrite`/`isRealmRestrictedFrontmatterWrite` defaulted `writeKind` to `"metadata"`, so an omitted argument answered `false` and would silently widen the client Delete gate — the exact failure the required prop refuses. `writeKind` is now required on both.
  - `[medium]` `[patch]` AC-1 observes the rendered article, but the only article-surface pin was a regex over `ArticleView`'s source, so a wrong threaded boolean shipped green. Added a mounted `ArticleView` test (signed-in non-admin owner), mutation-verified against three wrong implementations.
  - `[medium]` `[patch]` The `ingest/history` leak guard ran against a page the caller owned and could read, reaching 403 only through a stubbed predicate. Rewritten onto the genuinely uncloaked `jobIds` path with the real `canWriteFrontmatter`.
  - `[medium]` `[patch]` The reingest "public ARTIFACT" test used a private fixture and asserted the cloak, so its stated justification was false. Renamed to what it pins, with a proof that the generic branch is unreachable through that door.
  - `[low]` `[patch]` `edit/page.tsx` and `mcp-http.ts` emitted `WRITE_DENIAL_REALM` entries directly, contradicting the module's own "only the resolver hands these out" rule. Both routed through `resolveWriteDenial`; the rule amended to say the resolver owns the words while a cloak site may consult the predicate to decide whether it may speak.
  - `[low]` `[patch]` The docblock's cloak accounting was wrong in four places ("the ONE site with no read cloak"; "seven of nine"). Corrected to eight of nine, with `ingest/history`'s `ingestIds`-vs-`jobIds` split and `patchMetadata`'s `writeKind` distinction stated, plus the reachability proof that explains the absent route-level generic-sentence tests.
  - `[low]` `[patch]` Three defects in the new pins: the island scan checked only direct imports while claiming the import graph (now covers the rendered subtree), a `[^>]*` regex made its `s` flag inert and would break on any prop containing `>` (replaced with an element-text slice), and a comment named a helper that did not exist.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

The commons-realm write deny now reads the same way everywhere it is reachable. One predicate decides it, one module owns every sentence about it, and the edit screen's refusal can no longer belong to a URL the viewer is not on.

- **DW-120** — `ArticleActions` derives its Delete gate from the realm fact `ArticleView` computes with the same predicate `canWritePage` decides on, instead of the hand-written `isOwner || isSiteOwner`. The gate is `isSiteOwner || (isOwner && !realmDeniesDelete)`: deliberately narrower than the server (an `ADMIN_HANDLES` admin who is not the site owner is under-offered the button, because closing that gap would mean exposing `ADMIN_HANDLES` to the browser) and never wider. The prop is required, not defaulted, so dropping the seam fails the typecheck rather than reopening the bug.
- **DW-122** — all nine server denies resolve their sentence from `src/lib/write-denial.ts`, which emits the realm explanation only where the realm predicate actually holds and the generic sentence otherwise. Every not-found cloak stays first.
- **DW-123** — the edit page now reads read cloak → canonical 308 → write denial → editor, so a non-canonical edit URL redirects before it can render a refusal whose back-link points at a different handle.

### Files changed

- `src/lib/write-denial.ts` (new) — the generic and realm sentence tables plus `resolveWriteDenial`; one owner per server sentence, mirroring `read-only.ts`.
- `src/lib/authz.ts` — extracted `isRealmRestrictedWrite` / `isRealmRestrictedFrontmatterWrite`; `canWritePage`'s realm branch calls the former. What `canWritePage` decides is unchanged.
- `src/app/api/wiki/[slug]/route.ts`, `.../revisions/route.ts`, `src/app/api/ingest/reingest/route.ts`, `src/app/api/ingest/history/route.ts`, `src/mcp.ts`, `src/lib/mcp-http.ts`, `src/lib/patch-metadata.ts` — the nine deny sites, all resolving their copy.
- `src/app/u/[handle]/[slug]/edit/page.tsx` — branch reordering, `pageTenant` computed once, paragraph sourced from the shared table.
- `src/components/ArticleView.tsx` / `ArticleActions.tsx` — the realm fact computed server-side and threaded into the client island; no server-only module enters the island's import graph.
- Tests — new `article-actions-delete-gate.test.tsx` (mounted matrix plus the `ArticleView` article-surface rows) and `write-denial.test.ts`; updated `article-actions-gate.test.ts`, `edit-denial-copy.test.tsx`, `mcp.test.ts`, `mcp-http.test.ts`, `wiki-routes.test.ts`, `ingest-routes.test.ts`, `ingest-history-delete-route.test.ts`, `patch-metadata.test.ts`.

### Review findings

- Patches applied: 8 (medium 5, low 3) — see the triage log above.
- Items deferred: 3 (medium 2, low 1) — the Re-ingest/Revert client gates still wider than the server, the unread-gated `jobIds` path of the bulk-delete route, and `commons.ts`'s import of two client-safe predicates through `wiki.ts`.
- Items rejected: 3 — a redundant whole-matrix sweep test, an unpinned `readOnly` × realm interaction already covered by the sibling suite, and a speculative mock-trimming concern contradicted by a green run.
- Follow-up review recommended: **true**. Patched counts: high 0, medium 5, low 3 → score `3 x 5 + 1 x 3 = 18`, which is at or above the threshold of 5.

### Verification

- `vitest run` — 246 files, 5090 tests, all passing (5077 at baseline).
- `tsc --noEmit` — exit 0.
- `eslint .` — exit 0; the three `jsx-ast-utils` notices are pre-existing and are not errors.
- `grep -rn "You don't have permission" src` — every remaining hit is inside `src/lib/write-denial.ts`, a test assertion, or docblock prose. No route, MCP handler, or page holds its own copy of a denial sentence.
- Matrix test audit — all fourteen I/O matrix rows have a covering test that ran and passed. The first audit found four rows asserting only status codes and no emitted sentence; those were closed before review.

### Residual risks

- The realm sentence is now asserted at nine surfaces from one table, so a future edit to `WRITE_DENIAL_REALM` changes user-visible copy in nine places at once. That is the point of the change, but it makes the table a high-blast-radius file.
- `resolveWriteDenial`'s generic branch is unreachable end-to-end at six of the nine route sites (a readable non-realm page is writable by its readers). That reachability argument is now documented and pinned at the resolver unit, not at those routes — if the realm rule ever widens, those sites will start emitting a sentence no route-level test covers.
- The deferred Re-ingest gate means the DW-120 shape is fixed for Delete only; on a public knowledge page with a `source_url`, the owner is still shown a button whose request the realm always refuses.
