---
title: 'Owner identity: resolve owner-ness through the stable Clerk id, handle only as fallback'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      A drifted-handle owner now passes the gate but still addresses a
      handle-keyed silo, so their writes land in a tenant nothing reads.
    evidence: |-
      `isOwnerPrincipal` resolves WHO the owner is by the stable Clerk id, but
      WHICH tenant they address is still derived from `principal.handle`:
      `POST /api/wikis` calls `createWiki(principal.handle, ...)`
      (src/app/api/wikis/route.ts) while the Schema that executes is read from
      `getOwnerHandle()` (`readActiveWikiSchema`, src/lib/wikis.ts:2149), and
      `PUT /api/workbench/artifact` writes to the caller's tenant. Before this
      change the owner-by-id whose handle had drifted got a loud 403; now they
      get a 200 whose bytes land in a silo (named after the raw Clerk id, in
      the no-username case) that no prompt or reader ever opens. Both routes'
      own comments describe exactly that "silently inert save" as the thing
      their gate existed to prevent. DW-486's recorded decision covered
      owner-ness only; which silo the admitted owner addresses is a separate
      fact needing its own decision, and the fix has more than one defensible
      shape (route the owner's tenant through `getOwnerHandle()`; refuse when
      the id-owner's handle differs from the configured handle; leave as is).
      Production is unaffected today: `wrangler.jsonc` sets both owner vars
      consistently, so no drift exists there.
    location: >-
      src/app/api/wikis/route.ts:85
    severity: medium
  - summary: >-
      The three client owner gates cannot see the stable id, so client and
      server owner-ness can now disagree in BOTH directions, and the harness
      written to catch that never runs with an owner id configured.
    evidence: |-
      `NavHeader.tsx:53`, `ArticleActions.tsx:118` and `RevisionHistory.tsx:132`
      stay on `isOwnerHandle` because `YOPEDIA_OWNER_USER_ID` is server-only and
      is never inlined into the bundle. With an id configured the client answer
      is no longer merely NARROWER than the server's: an impostor holding a
      stale `NEXT_PUBLIC_OWNER_HANDLE` is refused by every server gate yet is
      still shown the owner affordances, and the id-matching owner whose handle
      drifted is shown none. `src/components/__tests__/article-actions-delete-gate.test.tsx`
      is the one harness that compares the client gate against the real
      `canWritePage`, and it sets only `NEXT_PUBLIC_OWNER_HANDLE` in its
      `beforeEach` (:211) so both sides resolve from the same fact and agree by
      construction; running it with `YOPEDIA_OWNER_USER_ID=user_2stable`
      produces 4 failures, including "offers Delete to nobody the server would
      refuse". Closing this needs a decision: hand the islands a
      server-computed `isOwner` prop, or accept the divergence and parameterise
      that harness over both owner configurations so it states which side is
      narrower.
    location: >-
      src/components/__tests__/article-actions-delete-gate.test.tsx:211
    severity: medium
  - summary: >-
      `src/mcp.ts` mints `service:mcp` principal ids from a raw string literal
      rather than the shared `SERVICE_PRINCIPAL_ID_PREFIX`.
    evidence: |-
      Three sites (src/mcp.ts:296, :374, :398) write `{ id: "service:mcp", ... }`
      inline. `src/lib/principal-id.ts` was added precisely to give that prefix
      one definition shared by the module that mints it and the module that
      reads it; these mints predate the change and were outside its scope.
      Behaviour is correct today — `isSynthesizedPrincipalId` matches on the
      colon, not the prefix — so this is drift risk, not a live defect.
    location: >-
      src/mcp.ts:296
    severity: low
  - summary: >-
      Pre-existing: 13 workbench DOM test files fail on this branch because
      `window.localStorage` is undefined under jsdom.
    evidence: |-
      `npx vitest run` reports 233 failing tests across 13
      `src/components/workbench/__tests__/*.tsx` files, every one of them the
      same `TypeError: Cannot read properties of undefined (reading 'clear')`
      raised from a `beforeEach` calling `window.localStorage.clear()`. Confirmed
      pre-existing: with every `src/` change from this story stashed, the same
      file fails 29/29 at baseline revision 249fc694. The failure count is
      identical before and after this story, so nothing here caused or worsened
      it — but the suite is red on this branch and any spec asserting
      "`pnpm test` passes" cannot be met until it is fixed.
    location: >-
      src/components/workbench/__tests__/workbench-split-wiring.test.tsx:97
    severity: medium
baseline_revision: '249fc69455a9556f0c11d8ffc2477add23d7663c'
---

<intent-contract>

## Intent

**Problem:** The deployment gate and the route gates answer "is this the owner?" from two different facts that can disagree. `handlePrivateRequest` (`src/middleware.ts:248-259`) admits on the stable Clerk id `YOPEDIA_OWNER_USER_ID`, while every route/page gate calls `isOwnerHandle` (`src/lib/owner.ts:22-25`), which compares a handle against the build-inlined `NEXT_PUBLIC_OWNER_HANDLE`. `getPrincipal` falls back to the raw Clerk id as the handle when a user has no username and no linked X account (`src/lib/auth.ts:135-147`), and a username change also drifts the handle — in both cases the real owner passes middleware and is then 403'd/404'd by a route gate saying they are not the owner, with no in-app recovery (`NEXT_PUBLIC_*` is inlined at build time, so recovery needs a redeploy).

**Approach:** Make owner-ness one fact. Add `getOwnerUserId()` and `isOwnerPrincipal(principal)` to `src/lib/owner.ts`: the stable Clerk id decides when the principal carries one, and the handle comparison survives only as the fallback for principals with no Clerk id (bearer service principals, and any deployment with no `YOPEDIA_OWNER_USER_ID` configured). Route every server-side owner gate through `isOwnerPrincipal`, make `getOwnerUserId()` the single production reader of `YOPEDIA_OWNER_USER_ID`, and pin — behaviorally and by source scan — that a principal the middleware admitted is never refused by a route gate.

## Boundaries & Constraints

**Always:**
- `getOwnerUserId()` in `src/lib/owner.ts` is the ONLY production reader of `YOPEDIA_OWNER_USER_ID` (mirrors the DW-157 rule for `getOwnerHandle()`), and it reads exactly as middleware did: `?.trim()`, blank/whitespace → `null`.
- `isOwnerPrincipal` decides by id ONLY when an owner id is configured AND the principal carries a real Clerk id; otherwise it falls back to `isOwnerHandle(principal.handle)`.
- A bearer service principal (id `service:<handle>`, minted in `src/lib/auth.ts`) is NOT a Clerk id — it keeps the handle path, or `requireOwnerOrServicePrincipal` and the admin routes lose the sidecar/automation token.
- Fail closed: `null`/undefined principal → `false`; neither env var configured → `false` for everyone.
- `src/lib/owner.ts` stays import-free (it is bundled into client components) — no import of `@/lib/auth` from it.
- Owner-gate refusal semantics per route are unchanged (404 vs 403 vs `null`); only the predicate changes.

**Block If:**
- A server owner gate is reached with a bare handle and no principal object in scope, so `isOwnerPrincipal` cannot be applied without changing that call's signature chain beyond its own file.

**Never:**
- Do not add a `NEXT_PUBLIC_*` mirror of the owner user id, and do not read `YOPEDIA_OWNER_USER_ID` from a client component — the three client gates (`NavHeader`, `ArticleActions`, `RevisionHistory`) stay on `isOwnerHandle` by design: they are UX-only and documented as permitted to be NARROWER than the server's answer.
- Do not touch the tenant-name uses of `getOwnerHandle()` (`src/lib/wikis.ts:2149`, `src/lib/maintenance.ts:344,380`, `src/app/api/tasks/scan/route.ts:188`, `e2eOwnerHandle()`) — those resolve a storage tenant, not a gate.
- Do not loosen any gate toward "any signed-in user", and do not change `requireOwnerPrincipal`'s unconfigured-deployment permissiveness beyond adding the id term.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Owner whose handle drifted | `YOPEDIA_OWNER_USER_ID=user_X`, `NEXT_PUBLIC_OWNER_HANDLE=alice`, principal `{id:"user_X", handle:"user_X"}` (or `"alice2"`) | `isOwnerPrincipal` → `true`; every owner-gated route admits | No error expected |
| Impostor holding the owner handle | `YOPEDIA_OWNER_USER_ID=user_X` set, principal `{id:"user_Y", handle:"alice"}` | `isOwnerPrincipal` → `false` | Route gate refuses as it does today |
| No owner id configured | `YOPEDIA_OWNER_USER_ID` unset, `NEXT_PUBLIC_OWNER_HANDLE=alice`, principal `{id:"user_Y", handle:"Alice"}` | Handle fallback → `true` (case-insensitive) | No error expected |
| Bearer service principal | `YOPEDIA_OWNER_USER_ID=user_X` set, principal `{id:"service:alice", handle:"alice"}`, owner handle `alice` | Handle fallback → `true`; sidecar/automation keeps access | No error expected |
| Nothing configured | Both env vars unset/blank, any principal | `false` | Fails closed for everyone, incl. the deployer |
| No principal | `isOwnerPrincipal(null)` / `(undefined)` | `false` | Fails closed |
| Client gate | Browser bundle, `YOPEDIA_OWNER_USER_ID` not inlined | `getOwnerUserId()` → `null`; client gates unchanged (handle-based) | Server env value never reaches the bundle |

</intent-contract>

## Code Map

- `src/lib/owner.ts:16-25` -- the two current exports; ADD `getOwnerUserId()` and `isOwnerPrincipal()` here. No imports today except the new `./principal-id`; keep it client-safe.
- `src/lib/principal-id.ts` -- NEW. `SERVICE_PRINCIPAL_ID_PREFIX = "service:"` + `isServicePrincipalId(id)`. Import-free so both `owner.ts` (client-bundled) and `auth.ts` (server) can use it without pulling Clerk into the browser.
- `src/lib/auth.ts:200` -- `return { id: \`service:${handle}\`, handle }` — mint via `SERVICE_PRINCIPAL_ID_PREFIX`. `src/lib/auth.ts:135-147` is the handle→userId fallback that motivates the whole change.
- `src/middleware.ts:217,248` -- two raw `process.env.YOPEDIA_OWNER_USER_ID?.trim()` reads (e2e branch + Clerk branch) → `getOwnerUserId()`. This is the gate whose answer route gates must never contradict.
- `src/lib/e2e-identity.ts:40-43` -- `e2eOwnerUserId()` third raw read → `getOwnerUserId()` then keep its `OWNER_ID_RE` validation. Already imports `./owner` (precedent comment at :46-49).
- Server owner gates to convert (`isOwnerHandle(x?.handle)` → `isOwnerPrincipal(x)`), all have a `Principal` in scope: `src/app/settings/layout.tsx:18`, `src/app/lint/page.tsx:13`, `src/app/api/settings/route.ts:51`, `src/app/api/settings/test/route.ts:10`, `src/app/api/settings/rebuild-embeddings/route.ts:11`, `src/app/api/lint/route.ts:16`, `src/app/api/lint/fix/route.ts:96`, `src/app/api/wikis/route.ts:61`, `src/app/api/admin/tenant/[handle]/route.ts:37`, `src/app/api/admin/migrate/route.ts:21`, `src/app/api/workbench/artifact/route.ts:107`, `src/app/api/workbench/artifact/revisions/route.ts:117`, `src/app/api/workbench/preview/route.ts:370`, `src/app/api/email/settings/route.ts:20`, `src/lib/authz.ts:61` (`isAdmin`, takes `{id?, handle?}` — a natural fit), `src/lib/owner-route.ts:12,42`.
- `src/lib/owner-route.ts:8-14` -- `requireOwnerPrincipal` currently returns any signed-in principal when NO owner handle is configured (tests rely on this). Preserve: unconfigured means BOTH `getOwnerUserId()` and `getOwnerHandle()` are null.
- `src/app/api/lint/fix/route.ts:161` -- `principal!` non-null assertion justified by "`isOwnerHandle` is false for a null handle"; `isOwnerPrincipal(null) === false` keeps it sound — update the comment.
- READ-ONLY, do not convert: `src/components/NavHeader.tsx:53`, `src/components/ArticleActions.tsx:118`, `src/components/RevisionHistory.tsx:132` (client, UX-only, deliberately narrower).
- Tests that break and must be updated: `vi.mock("@/lib/owner", () => ({ isOwnerHandle: vi.fn() }))` in `src/lib/__tests__/wikis-routes.test.ts:21`, `settings-route.test.ts:4`, `email-settings-route.test.ts:4`, `lint-fix-route.test.ts:7` (each also has a `vi.mocked(isOwnerHandle)` alias — `wikis-routes.test.ts:39,60`, `settings-route.test.ts:40,64`, `email-settings-route.test.ts:21,31`, `lint-fix-route.test.ts:24,32`); and the source-scan regex at `src/lib/__tests__/wiki-schema-edit.test.ts:1206`.
- `src/lib/__tests__/owner-single-reader.test.ts` -- the DW-157 single-reader pin; the template to copy for `YOPEDIA_OWNER_USER_ID`. `src/lib/__tests__/owner-handle.test.ts` -- unit home for the new predicate.
- Evidence the env is live in production: `wrangler.jsonc:108,113` set both `NEXT_PUBLIC_OWNER_HANDLE` and `YOPEDIA_OWNER_USER_ID`. `YOPEDIA_OWNER_USER_ID` is NOT set globally in vitest (only per-test), so every existing suite keeps the handle-fallback behavior it has today.

## Tasks & Acceptance

**Execution:**
- `src/lib/principal-id.ts` -- NEW: export `SERVICE_PRINCIPAL_ID_PREFIX` and `isServicePrincipalId(id)`; no imports -- one definition of "this id is synthesized, not a Clerk id", shared by a client-bundled and a server module.
- `src/lib/auth.ts` -- mint the service principal id from `SERVICE_PRINCIPAL_ID_PREFIX` -- prevents the prefix drifting from the predicate that reads it.
- `src/lib/owner.ts` -- add `getOwnerUserId()` and `isOwnerPrincipal(principal)` per the matrix; document why the handle path survives and why the module stays import-light -- the one place owner-ness is decided.
- `src/middleware.ts` -- both raw reads → `getOwnerUserId()` -- the gate and the route predicate must read one value.
- `src/lib/e2e-identity.ts` -- `e2eOwnerUserId()` reads through `getOwnerUserId()`, keeping `OWNER_ID_RE` -- same single-reader rule.
- `src/lib/owner-route.ts` -- both gates → `isOwnerPrincipal`, with the unconfigured-deployment escape now keyed on both env vars being absent -- kernel/sidecar routes follow the same fact.
- `src/lib/authz.ts` -- `isAdmin` → `isOwnerPrincipal(principal)` -- the owner⇒admin grant must not hinge on a drifted handle.
- The 14 route/page gates listed in the Code Map -- swap the predicate, update the `isOwnerHandle`-naming comments in `wikis/route.ts`, `workbench/preview/route.ts`, `lint/fix/route.ts` and `workbench/artifact/route.ts` to describe the new rule -- these are the surfaces that 403'd the admitted owner.
- `src/lib/__tests__/owner-handle.test.ts` -- add `getOwnerUserId` + `isOwnerPrincipal` describes covering every I/O matrix row -- the matrix is the contract.
- `src/lib/__tests__/owner-single-reader.test.ts` -- add a second pin: `YOPEDIA_OWNER_USER_ID` is read only by `src/lib/owner.ts` -- keeps the grep property the DW-157 pin established.
- `src/lib/__tests__/owner-gate-parity.test.ts` -- NEW: (a) behavioral — with an owner id configured, a principal whose id matches is owner-true for every handle including the raw-id fallback and a stale username; (b) source scan — `isOwnerHandle(` appears in `src/` non-test source only in `src/lib/owner.ts`, `src/components/NavHeader.tsx`, `src/components/ArticleActions.tsx`, `src/components/RevisionHistory.tsx` -- this is the "middleware-admitted principal is never refused by a route gate" pin.
- `src/lib/__tests__/wikis-routes.test.ts`, `settings-route.test.ts`, `email-settings-route.test.ts`, `lint-fix-route.test.ts` -- retarget the `@/lib/owner` mock and its `vi.mocked` alias to `isOwnerPrincipal` -- the modules under test no longer import `isOwnerHandle`.
- `src/lib/__tests__/wiki-schema-edit.test.ts` -- update the `editable:` source regex to the new expression -- the pin is about one expression, not one predicate name.

**Acceptance Criteria:**
- Given `YOPEDIA_OWNER_USER_ID` is configured and a signed-in principal whose Clerk id equals it but whose handle differs from `NEXT_PUBLIC_OWNER_HANDLE`, when that principal reaches any converted server owner gate, then it is admitted (no 403/404/`null`).
- Given a signed-in principal whose Clerk id differs from a configured `YOPEDIA_OWNER_USER_ID`, when it reaches a converted gate, then it is refused with that gate's existing status and message even if its handle equals `NEXT_PUBLIC_OWNER_HANDLE`.
- Given `YOPEDIA_OWNER_USER_ID` is unset, when any converted gate runs, then its admit/refuse answer is byte-identical to the pre-change handle behavior.
- Given the repository source, when the new source-scan pins run, then `YOPEDIA_OWNER_USER_ID` has exactly one production reader and `isOwnerHandle` has no server-side caller outside `src/lib/owner.ts`.
- Given the whole suite, when `pnpm test` and `pnpm lint` run, then both pass with no skipped or newly-failing tests.

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 1, medium 3, low 5)
- defer: 4: (high 0, medium 3, low 1)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[high]` `[patch]` `isOwnerPrincipal` excluded only `service:` ids from the stable-id path, so the other synthesized principal ids minted in production (`agent:` in `src/app/api/mcp/route.ts:78`, `agent-owner:` in `src/lib/agent-runtime.ts:144`, plus `knowledge-compiler:` and `eval:`) took the id path, could never match the owner's Clerk id, and silently lost the owner⇒admin grant on the deployed config. Generalized the carve-out to `isSynthesizedPrincipalId` (a Clerk id never contains `:`) and pinned `isOwnerPrincipal`/`isAdmin`/`canWritePage` for every synthesized shape carrying the owner handle.
  - `[medium]` `[patch]` `requireOwnerOrServicePrincipal` refused the bearer sidecar/automation token on a deployment naming the owner by id alone. Restored the service branch's original handle-keyed condition and pinned the id-only configuration.
  - `[medium]` `[patch]` The parity pin asserted the route-gate half but only assumed the middleware half. `owner-gate-parity.test.ts` now drives `handlePrivateRequest` for each drifted handle and asserts the identical principal passes `isOwnerPrincipal`/`requireOwnerPrincipal`.
  - `[medium]` `[patch]` `.env.example` still called `NEXT_PUBLIC_OWNER_HANDLE` the owner fact and never mentioned `YOPEDIA_OWNER_USER_ID`; the `wrangler.jsonc` comment still scoped the id to middleware. Both updated.
  - `[low]` `[patch]` `src/lib/authz.ts` still hardcoded `startsWith("service:")` — routed through `isServicePrincipalId`.
  - `[low]` `[patch]` The `owner.ts` docblock claimed the client answer is only ever narrower than the server's; with an id configured it can also be wider. Corrected there and in the parity test's allowlist rationale.
  - `[low]` `[patch]` `isOwnerConfigured()` was a private copy in `owner-route.ts`; exported from `owner.ts` so the "named by either fact" rule has one implementation.
  - `[low]` `[patch]` The `HANDLE_GATE_ALLOWED` failure message gave the wrong advice for its most likely legitimate offender (a new client island); it now names the allowlist as the correct resolution.
  - `[low]` `[patch]` The four route suites replaced the whole `@/lib/owner` module, leaving `getOwnerHandle`/`getOwnerUserId` undefined for `owner-route.ts`; switched to the `importOriginal` spread form.

## Design Notes

The predicate, and why the service branch is explicit rather than "any id":

```ts
export function isOwnerPrincipal(
  principal: { id?: string | null; handle?: string | null } | null | undefined,
): boolean {
  if (!principal) return false;
  const ownerId = getOwnerUserId();
  // The stable id decides — but ONLY for a real Clerk id. A bearer service
  // principal's id is synthesized (`service:<handle>`), so it can never equal
  // the owner's Clerk id; gating it on the id would revoke the sidecar's token.
  if (ownerId && principal.id && !isServicePrincipalId(principal.id)) {
    return principal.id === ownerId;
  }
  return isOwnerHandle(principal.handle);
}
```

Client gates stay handle-based on purpose: `YOPEDIA_OWNER_USER_ID` is a server var, and the three client islands already document that their gate may be narrower than the server's — an unoffered button is recoverable, a 403 on a write the middleware admitted is not. The residual gap (a drifted-handle owner sees fewer client affordances) is UX, not a lockout, and closing it would require a build-inlined public mirror of the id, which the Never list forbids.

## Verification

**Commands:**
- `pnpm lint` -- expected: exit 0, no new warnings.
- `pnpm test` -- expected: exit 0; `owner-handle`, `owner-single-reader`, `owner-gate-parity`, `wikis-routes`, `settings-route`, `email-settings-route`, `lint-fix-route`, `wiki-schema-edit`, `middleware-write-gate`, `auth`, `e2e-identity` suites all green.
- `grep -rn "process.env.YOPEDIA_OWNER_USER_ID" src/ --include=*.ts --include=*.tsx` -- expected: only `src/lib/owner.ts` outside `__tests__`.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Owner-ness is now one fact. `src/lib/owner.ts` gained `getOwnerUserId()` — the single production reader of `YOPEDIA_OWNER_USER_ID` — and `isOwnerPrincipal(principal)`, which decides on the stable Clerk id whenever one is configured and the principal carries a real (non-synthesized) id, and falls back to the handle comparison otherwise. Every server-side owner gate (14 routes/pages, `authz.isAdmin`, both `owner-route` gates) now spends that predicate, `middleware.ts` and `e2e-identity.ts` read the id through the same helper, and two source scans plus an executed middleware-to-predicate test pin that a principal the deployment gate admitted is never refused by a route gate. The three client islands stay on `isOwnerHandle` deliberately: the id is server-only, and their gate is UX.

**Files changed.**
- `src/lib/principal-id.ts` (new) -- one definition of "this id is synthesized, not Clerk's": the `service:` prefix plus `isSynthesizedPrincipalId` (the `:` rule).
- `src/lib/owner.ts` -- `getOwnerUserId`, `isOwnerPrincipal`, `isOwnerConfigured`; docblock explaining the two facts and both directions in which the client answer may diverge.
- `src/lib/auth.ts` -- mints the service principal id from the shared prefix.
- `src/middleware.ts`, `src/lib/e2e-identity.ts` -- read the owner id through `getOwnerUserId()`.
- `src/lib/owner-route.ts` -- session branch on `isOwnerPrincipal`; service branch keeps its handle-keyed condition.
- `src/lib/authz.ts` -- owner⇒admin grant on `isOwnerPrincipal`; service bypass on `isServicePrincipalId`.
- 14 route/page gates under `src/app/**` -- predicate swap plus comment updates.
- `src/lib/wikis.ts`, `src/lib/maintenance.ts`, `src/lib/lint-checks.ts` -- stale `isOwnerHandle` references in prose updated.
- `.env.example`, `wrangler.jsonc` -- document that the stable id decides owner-ness.
- `src/lib/__tests__/owner-gate-parity.test.ts` (new) -- executed middleware+predicate parity, synthesized-id coverage, and two source scans.
- `src/lib/__tests__/owner-handle.test.ts`, `owner-single-reader.test.ts`, `wikis-routes.test.ts`, `settings-route.test.ts`, `email-settings-route.test.ts`, `lint-fix-route.test.ts`, `wiki-schema-edit.test.ts` -- matrix coverage, the second single-reader pin, mock retargeting, source-regex update.

**Review findings.** 9 patches applied (1 high, 3 medium, 5 low); 4 items deferred (3 medium, 1 low); 6 rejected as noise (a pre-existing middleware property restated as new, a type-tightening that would break `isAdmin`'s signature, duplicated test-scan helpers, the known aliasing hole the DW-157 pin already documents, comment re-wrapping, and an id-less-principal case the matrix pins by design).

**Follow-up review recommendation.** true. Patched severities: high 1, medium 3, low 5; the rule fires on the high patch (score `3 x 3 + 1 x 5 = 14`, also over the threshold).

**Verification.**
- `npx eslint` -- exit 0; stderr identical to baseline (only the pre-existing `jsx-ast-utils` notices).
- `npx tsc --noEmit` -- clean.
- Targeted run of the 13 owner/auth/authz/mcp/route suites -- 432 passed, 0 failed.
- `npx vitest run` (full) -- 7828 passed, 1 skipped, 233 failed. All 233 are the 13 pre-existing `src/components/workbench/__tests__/*.tsx` files failing on `window.localStorage` being undefined under jsdom; confirmed at baseline `249fc694` by stashing every `src/` change and reproducing 29/29 failures in `workbench-split-wiring.test.tsx`. The failure count is identical before and after this story.
- `grep -rn "process.env.YOPEDIA_OWNER_USER_ID" src/` -- only `src/lib/owner.ts` outside `__tests__`.
- Matrix audit: all seven I/O rows are covered by tests that ran and passed (`owner-handle.test.ts` for each row, `owner-gate-parity.test.ts` for the drifted-handle, impostor, service-principal, unconfigured and client-island rows).
- Mutation checks: reverting one gate to `isOwnerHandle` trips the source-scan pin; flipping the middleware mock's `userId` trips the executed parity rows.

**Residual risks.**
- The repository's test suite is RED on this branch for unrelated reasons (the 13 workbench DOM files). The spec's "`pnpm test` passes" criterion was already unmet at `249fc694`; this story neither caused nor fixed it, and it is recorded as a deferred item.
- A drifted-handle owner is now admitted by every gate but still addresses a handle-keyed silo, so their writes can land where nothing reads them — deferred, because which silo the owner addresses is a separate fact from who the owner is and the fix has more than one defensible shape.
- Client owner gates can now disagree with the server in both directions; the harness that compares them never runs with an owner id configured. Deferred.
- The `:` rule for "synthesized id" is a heuristic over the shapes this repo mints today. A future principal minted with a colon-free synthetic id would take the stable-id path and be refused; the fail-closed direction, but worth knowing.
