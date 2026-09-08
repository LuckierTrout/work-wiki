---
title: 'DW-159 / DW-288 — gate Wiki creation on ownership and settle the sweep''s scope'
type: 'bugfix'
created: '2026-08-27'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
baseline_revision: '74e5892bf4aa664faac8cfeb84270fd0c6f9cb47'
deferred:
  - summary: >-
      The middleware admits the owner by stable Clerk id while every
      `isOwnerHandle` route gate refuses by handle, so the two owner identities
      can disagree and lock the real owner out.
    evidence: |-
      `handlePrivateRequest` (src/middleware.ts:248-259) admits on
      `YOPEDIA_OWNER_USER_ID`; `isOwnerHandle` (src/lib/owner.ts:22-25) compares
      against `NEXT_PUBLIC_OWNER_HANDLE`. `getPrincipal` falls back to the raw
      Clerk id as the handle when a user has no username and no linked X account
      (src/lib/auth.ts:135-147, a case it logs), and `NEXT_PUBLIC_*` is inlined
      at build time so a username change needs a redeploy. In both cases the
      owner passes the middleware and is then 403'd by the handle gate with a
      message saying they are not the owner, with no in-app recovery.
      Pre-existing at `PUT /api/workbench/artifact`; DW-159 widens it to Wiki
      creation.
    location: >-
      src/app/api/wikis/route.ts:65
    severity: medium
  - summary: >-
      `requireOwnerPrincipal` is fail-OPEN when no owner handle is configured
      while the direct `isOwnerHandle` gates are fail-CLOSED, and nothing records
      the divergence.
    evidence: |-
      `src/lib/owner-route.ts:8-14` reads "when no owner handle is configured
      (tests), any signed-in principal passes" and only refuses when
      `getOwnerHandle()` is truthy. The artifact route and now `POST /api/wikis`
      call `isOwnerHandle` directly, which answers false for everyone when the
      var is unset. A future Wiki route written through the helper would
      silently reopen creation on an unconfigured deployment. Pre-existing;
      surfaced by review of DW-159.
    location: >-
      src/lib/owner-route.ts:8
    severity: low
  - summary: >-
      Stale discard tombstones on pre-gate non-owner tenants are cleared by
      nothing, which is a second residual beyond the orphan directories the
      DW-288 scope note records.
    evidence: |-
      `clearStaleDiscardTombstones` (DW-291) runs only on the scheduled path, and
      the schedule resolves a single owner via `getOwnerHandle()`. `deleteWiki`'s
      inline sweep runs with `scheduled` unset, so for a tenant created before
      the DW-159 gate landed the tombstones have no clearer at all — unlike the
      orphan directories, which `deleteWiki` at least reclaims inline. The new
      SCOPE note in `maintenance.ts` accounts only for the directories.
    location: >-
      src/lib/maintenance.ts (sweepOrphanWikiDirs)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `POST /api/wikis` (`src/app/api/wikis/route.ts:35-59`) gates on sign-in and read-only only, then calls `createWiki(principal.handle, …)`, so any signed-in non-owner can create a Wiki that no downstream surface honours — `readActiveWikiSchema()` resolves the Schema from `getOwnerHandle()`, and `PUT /api/workbench/artifact` 403s that Wiki's Schema edits. The same open door is what makes `sweepOrphanWikiDirs` (`src/lib/maintenance.ts:318-327`) look narrow: it sweeps exactly the configured owner's tenant (DW-288).

**Approach:** Add an `isOwnerHandle(principal.handle)` gate to `POST /api/wikis`, answering the same 403 shape `src/app/api/workbench/artifact/route.ts:107-108` already uses, and pin it with a route test beside the existing sign-in and read-only cases. Then record the consequence where it is claimed: the sweep's owner-only scope is correct by construction once no new non-owner tenant can appear, and the two stale prose blocks that assert the opposite (`src/lib/wikis.ts` MIGRATION note, `src/lib/maintenance.ts` sweep doc) are corrected to say so.

## Boundaries & Constraints

**Always:** The server gate is the boundary — `owner.ts` states client gating is UX only. The refusal is 403 with an `{ error }` body, matching the artifact route's wording shape. The gate sits after the 401 sign-in check and before the read-only check, mirroring `src/app/api/workbench/artifact/route.ts` exactly, so the two owner-gated write doors order their refusals identically. Every existing status in `wikis-routes.test.ts` keeps its current value.

**Block If:** The intent asks to gate a route other than `POST /api/wikis`, or the decision to gate rather than accept inert non-owner Wikis appears contradicted elsewhere in the repo.

**Never:** Do not gate `GET /api/wikis`, `PUT /api/wikis/current`, `PATCH`/`DELETE /api/wikis/<id>`, or `POST /api/wikis/<id>/template` — the recorded decision is about the creation door only, and each of those addresses the caller's own already-existing registry. Do not add owner gating to the client surfaces (`WikiWorkbench.tsx`, `WikiSwitcher.tsx`) — they already surface the response's `error` string through `writeFailure`, so the refusal reads correctly without a UI change. Do not build a Wiki-tenant enumeration index or widen the sweep to other tenants. Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Owner creates | signed in, `isOwnerHandle` true, not read-only, valid body | 201 `{ wiki }`; `createWiki` called once | No error expected |
| Signed out | `getPrincipal()` → null | 401 `{ error: "Sign in required." }`; `createWiki` not called | 401 precedes the owner check |
| Non-owner creates | signed in, `isOwnerHandle` false, not read-only, valid body | 403 with the owner-refusal copy; `createWiki` NOT called | 403, no bytes written |
| Non-owner, read-only | signed in, `isOwnerHandle` false, `isReadOnly()` true | 403 with the owner-refusal copy (owner check first, as in the artifact route) | 403 either way |
| Owner, read-only | signed in, `isOwnerHandle` true, `isReadOnly()` true | 403 with the existing read-only copy, unchanged | 403 |
| Non-owner, bad body | signed in, `isOwnerHandle` false, unparseable JSON | 403 owner refusal, not 400 — the gate precedes body parsing | 403 |
| Owner unset | `NEXT_PUBLIC_OWNER_HANDLE` unset → `isOwnerHandle` false for everyone | 403 for every caller; nobody creates | 403 |

</intent-contract>

## Code Map

- `src/app/api/wikis/route.ts` -- `POST` at line 35; sign-in check lines 36-39, read-only check lines 40-45, `createWiki` call line 53. The one edit site for the gate.
- `src/app/api/workbench/artifact/route.ts:99-109` -- the precedent to mirror: 401 → `if (!isOwnerHandle(principal.handle)) return json({ error: "Only the workspace owner can edit the Schema." }, 403)` → read-only. Its comment already reasons about the inertness DW-159 names. Read-only reference; do not edit.
- `src/lib/owner.ts` -- `getOwnerHandle()` / `isOwnerHandle()`; documents the single-owner stance and "the client gate is UX only". Read-only reference; do not edit.
- `src/lib/__tests__/wikis-routes.test.ts` -- the route contract suite. `vi.mock` block lines 12-22, imports 24-38, `beforeEach` lines 82-92 (principal `alice`, `isReadOnly` false), `describe("wiki API auth")` lines 95-135 with the sign-in and read-only cases to sit beside, `describe("POST /api/wikis")` lines 200-225. `@/lib/owner` is NOT currently mocked here — it must be, or the real `isOwnerHandle` reads an unset env var and 403s every existing POST case.
- `src/lib/__tests__/settings-route.test.ts:4,40,63` -- the established owner-mock recipe: `vi.mock("@/lib/owner", () => ({ isOwnerHandle: vi.fn() }))`, then `const mockedIsOwner = vi.mocked(isOwnerHandle)`. Copy this shape.
- `src/lib/wikis.ts` -- MIGRATION prose block around lines 2090-2098 asserts "`POST /api/wikis` gates on `getPrincipal()`, not `isOwnerHandle`, so any signed-in non-owner can create one." That sentence becomes false with this change and must be corrected. `sweepOrphanWikiDirectories(owner)` at line 1943 with its doc at 1927-1941 — signature and behaviour unchanged.
- `src/lib/maintenance.ts:302-327` -- `sweepOrphanWikiDirs` doc and body; resolves one handle via `getOwnerHandle()`. Body unchanged; the doc is where DW-288's answer is recorded.
- `src/lib/__tests__/maintenance.test.ts:385-430` -- existing `sweepOrphanWikiDirs` suite; behaviour must stay green unchanged.
- `src/lib/__tests__/owner-handle.test.ts` -- ADDED during implementation. Nothing in the repo asserted what the REAL `isOwnerHandle` answers (every owner-gated route suite mocks it), so the matrix's "owner unset" row had no covering test. Pins unset/blank → false for every handle, plus case-insensitive matching.
- `src/components/workbench/WikiSwitcher.tsx:215-240` and `src/components/WikiWorkbench.tsx:171-190` -- the two client create surfaces. Both route the response's `error` through `writeFailure` into visible copy, so the new refusal already displays. Read-only evidence; do not edit.

## Tasks & Acceptance

**Execution:**
- `src/app/api/wikis/route.ts` -- import `isOwnerHandle` from `@/lib/owner` and add the gate to `POST` between the 401 sign-in check and the `isReadOnly()` check: `if (!isOwnerHandle(principal.handle)) return NextResponse.json({ error: "Only the workspace owner can create Wikis." }, { status: 403 })`. Add a short comment saying WHY it is a refusal and not a permission model (a non-owner's Wiki is inert: `readActiveWikiSchema()` resolves from `getOwnerHandle()` and the artifact route 403s its Schema edits), and update the `POST` JSDoc so its contract sentence names the owner gate. -- Closes the one open creation door DW-159 identifies.
- `src/lib/__tests__/wikis-routes.test.ts` -- add `vi.mock("@/lib/owner", () => ({ isOwnerHandle: vi.fn() }))` beside the existing mocks, import and `vi.mocked` it, default it to `true` in `beforeEach` so every existing case keeps its current status, and add a non-owner case in `describe("wiki API auth")` asserting `POST` answers 403 and `createWiki` was never called. Cover the matrix rows the gate introduces: non-owner while read-only still answers the owner copy, and a non-owner with an unparseable body 403s rather than 400s. -- Pins the gate and its ordering; without the default-true mock the existing 401/400/201 cases would silently start passing for the wrong reason.
- `src/lib/wikis.ts` -- correct the MIGRATION prose block (~lines 2090-2098) so it no longer claims a non-owner can create a Wiki. State instead that `POST /api/wikis` is owner-gated (DW-159), that the only reachable non-owner tenants are ones created before the gate landed, and keep the rest of the migration trigger unchanged ("a non-owner's Wiki must actually serve that non-owner"). -- The block is the repo's own map of the single-owner assumption; leaving it stale would misdirect the next reader.
- `src/lib/maintenance.ts` -- extend the `sweepOrphanWikiDirs` doc comment to record DW-288's answer: the owner-only scope is total by construction now that creation is owner-gated, so no NEW unswept tenant can appear; name the one residual honestly — tenants created before the gate landed are still reclaimed only by `deleteWiki` — and note that a Wiki-tenant enumeration index remains deliberately absent. Do not change the function body or signature. -- Records where the scope claim is made, so the next reader does not re-open DW-288 as a leak.

**Acceptance Criteria:**
- Given a signed-in principal whose handle is not the configured owner, when they `POST /api/wikis` with a valid body on a writable deployment, then the response is 403 and `createWiki` is never called.
- Given the configured owner is signed in on a writable deployment, when they `POST /api/wikis` with a valid body, then the response is still 201 with `{ wiki }` and every other status in `wikis-routes.test.ts` is unchanged.
- Given `NEXT_PUBLIC_OWNER_HANDLE` is unset, when any signed-in principal posts to `/api/wikis`, then the response is 403 — `isOwnerHandle` answers false when no owner is configured.
- Given a reader opens `src/lib/wikis.ts`'s MIGRATION block or `sweepOrphanWikiDirs`'s doc, when they look for whether a non-owner tenant can still be created, then both say it cannot and name the pre-gate residual, with no sentence left claiming the opposite.
- Given the full suite is run, when `pnpm test` and `pnpm lint` complete, then both pass with no new failures.

## Spec Change Log

_No bad_spec loopback occurred; this section is empty by design._

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 3: (high 0, medium 1, low 2)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The new SCOPE note in `maintenance.ts` and the amended MIGRATION note in `wikis.ts` credited the route gate as the reason no new non-owner tenant can appear, but `handlePrivateRequest` (`src/middleware.ts`) already 403s every non-owner `/api/*` request and `createWiki` itself is un-asserted. Both blocks rewritten to state the guarantee as a stack of doors — middleware outer gate, route gate as defense-in-depth, kernel deliberately un-asserted with the route as its only caller.
  - `[medium]` `[patch]` The non-owner route test claimed to pin that the sibling Wiki routes stay ungated but asserted only `PUT /current` and `PATCH /[id]`; mutations gating `GET /api/wikis` and `DELETE /api/wikis/[id]` both left the suite green. Extended to assert all five siblings under `isOwnerHandle` false, including `DELETE` (the reclamation path the DW-288 residual argument rests on) and `POST /[id]/template`.
  - `[low]` `[patch]` The signed-out test did not pin that 401 precedes the owner check; added `expect(mockedIsOwner).not.toHaveBeenCalled()`.
  - `[low]` `[patch]` `owner-handle.test.ts` asserted the unset and the configured-but-blank states under one test name; split into two named cases, each looping the full handle set.
  - `[low]` `[patch]` The gate comment omitted the operator-facing consequence that an unset or blank `NEXT_PUBLIC_OWNER_HANDLE` closes creation to every caller including the deployer; added a FAILS CLOSED paragraph naming it as deliberate and pointing at the env var.

## Design Notes

Gate placement mirrors `src/app/api/workbench/artifact/route.ts` exactly — 401, then owner, then read-only — so a non-owner on a read-only deployment gets the owner refusal from both write doors rather than one answer from each. That ordering is what makes the copy predictable enough to assert.

The DW-288 half is deliberately doc-only. Widening the sweep would need a Wiki-tenant enumeration index the repo does not have (`listSourceMonitorOwners` is the precedent for source monitors, not Wikis), and building one to sweep a set that the creation gate now keeps empty is work with no live input. The honest residual — tenants created before this gate landed — is recorded rather than swept, because nothing in the repo can enumerate them either.

```ts
// src/app/api/wikis/route.ts — the gate
if (!isOwnerHandle(principal.handle)) {
  return NextResponse.json(
    { error: "Only the workspace owner can create Wikis." },
    { status: 403 },
  );
}
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wikis-routes.test.ts` -- expected: all cases pass, including the new non-owner 403 cases.
- `pnpm vitest run src/lib/__tests__/maintenance.test.ts` -- expected: the existing `sweepOrphanWikiDirs` suite passes unchanged.
- `pnpm test` -- expected: full suite green, no new failures.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** `POST /api/wikis` is now gated on `isOwnerHandle(principal.handle)` — 403 `{ error: "Only the workspace owner can create Wikis." }` — placed between the 401 sign-in check and the `isReadOnly()` check, mirroring `PUT /api/workbench/artifact` exactly (DW-159). DW-288 is settled as documentation: the sweep's owner-only scope is recorded as correct, stated at the surface it actually holds at (middleware outer gate, route gate as defense-in-depth, kernel deliberately un-asserted), with the pre-gate residual named honestly. No sweep behaviour changed and no Wiki-tenant enumeration index was built.

**Files changed.**
- `src/app/api/wikis/route.ts` -- the `isOwnerHandle` gate on `POST`, with the inertness rationale, the ordering rationale, and a FAILS CLOSED paragraph for the unset-owner case; `POST` JSDoc names the gate.
- `src/lib/__tests__/wikis-routes.test.ts` -- `@/lib/owner` mocked (defaulted true in `beforeEach` so every pre-existing status is unchanged); three new cases covering the non-owner 403 with all five sibling routes pinned ungated, the owner-before-read-only-before-parse ordering, and the owner's unchanged read-only refusal; the signed-out case now pins that 401 precedes the owner check.
- `src/lib/__tests__/owner-handle.test.ts` -- NEW. Pins the real `getOwnerHandle`/`isOwnerHandle` semantics that every owner-gated route suite mocks away: unset and blank both mean nobody is the owner, and matching is case-insensitive.
- `src/lib/wikis.ts` -- the `readActiveWikiSchema` MIGRATION block no longer claims a non-owner can create a Wiki; it now describes the door stack and names `createWiki` as deliberately un-asserted with the route as its only caller. Comment-only.
- `src/lib/maintenance.ts` -- `sweepOrphanWikiDirs` gained a `SCOPE (DW-288, settled)` block recording the same door stack, the pre-gate residual, and why the enumeration index stays absent. Comment-only.

**Review findings breakdown.** 5 patches applied (2 medium, 3 low), 3 items deferred (1 medium, 2 low), 10 items rejected. No intent gaps and no spec-level defects; no repair loopback was needed.

**Follow-up review recommendation: true.** Patched this pass: high 0, medium 2, low 3. Score = 3x2 + 1x3 = 9, which is at or above the threshold of 5.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/wikis-routes.test.ts src/lib/__tests__/owner-handle.test.ts src/lib/__tests__/maintenance.test.ts` -- 3 files, 52 tests passed.
- `pnpm test` -- 328 files, 7527 passed / 1 skipped. Baseline before this change was 327 files / 7523 passed; the deltas are the new test file and the four added cases.
- `pnpm lint` -- exit 0; only the pre-existing `jsx-ast-utils` TSNonNullExpression notices, which are present on the baseline and unrelated to these files.
- Matrix audit: every I/O row has a covering test that ran and passed. The "owner unset" row is covered compositionally — `owner-handle.test.ts` pins that the real predicate answers false when the var is unset or blank, and the route suite pins that a false predicate yields 403 with no write.
- Mutation evidence for the review patch: gating `GET /api/wikis` and, separately, `DELETE /api/wikis/[id]` each left the suite green before the fix and each fails it after.

**Residual risks.**
- The route suite mocks `@/lib/owner` wholesale with only `isOwnerHandle`. The real `wikis.ts` loaded beside it calls `getOwnerHandle` solely from `readActiveWikiSchema`, which no route under test reaches; a future test in that file exercising that function must add `getOwnerHandle` to the mock. Noted in a comment above the mock.
- The DW-288 half changed no behaviour, so its claim is prose in a module whose behaviour is otherwise pinned by execution. It rests on `createWiki` having exactly one caller, which was verified in this run and is called out in the comment as the line to re-check.
- The repo has no `typecheck` script; type correctness is covered by eslint's TS parse and the vitest run.
- Three deferred items are recorded in this spec's frontmatter for the orchestrator to harvest; the most consequential is the middleware/route owner-identity mismatch, which is pre-existing at the artifact route and now also reachable through Wiki creation.
