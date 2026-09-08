---
title: 'Owner identity: one fact on both sides of the wire — canonical tenant for id-owners, server-computed client owner gate'
type: 'bugfix'
created: '2026-09-05'
status: 'in-progress'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      Re-pointing an id-owner to the canonical silo strands whatever they
      already wrote under their drifted handle, with no migration, listing or
      warning.
    evidence: |-
      `ownerTenantHandle` changes WHERE a drifted-handle owner reads and writes,
      but nothing moves or even names the bytes already sitting under
      `tenantForOwner(principal.handle)`. On a deployment where the handle
      drifted BEFORE this change shipped, the owner's existing Wikis, artifacts
      and Workbench files stop being reachable from every converted door the
      moment it deploys — the registry they see becomes the (empty) canonical
      one. The direction is right and the decision chose it deliberately, but
      "the write lands where the reads look" says nothing about the writes that
      already landed elsewhere. Closing it needs its own decision: migrate the
      old tenant into the canonical one on first read, offer a one-shot import,
      or accept the loss and say so at the surface. Production is unaffected
      today — `wrangler.jsonc` sets both owner vars consistently, so no drift
      exists there.
    location: >-
      src/lib/owner.ts (ownerTenantHandle)
    severity: medium
baseline_revision: 'f94da1fba290490bb863c718c94c24312f6e1aa4'
---

<intent-contract>

## Intent

**Problem:** DW-486 made *who* the owner is one fact (the stable Clerk id), but left two halves reading a different one. (a) **Tenant (DW-612):** a drifted-handle owner passes `isOwnerPrincipal` at `src/app/api/wikis/route.ts:68` and `src/app/api/workbench/artifact/route.ts:168`, then addresses a silo derived from `principal.handle` (`:87`, `:216`, `:264`), while every canonical read — `readActiveWikiSchema` (`src/lib/wikis.ts:3650`), `maintenance.ts`, the backup scheduler, `lint-checks.ts` — resolves the tenant from `getOwnerHandle()`. Their 200-answered writes land where nothing reads. (b) **Client gate (DW-613):** `NavHeader.tsx:53`, `ArticleActions.tsx:123` and `RevisionHistory.tsx:132` re-derive owner-ness from `isOwnerHandle`, which cannot see the server-only id, so with an id configured the client answer is not merely narrower than the server's — it is wrong in both directions (a stale-handle impostor is shown owner affordances; the id-matching drifted owner is shown none). The one harness that compares the two, `src/components/__tests__/article-actions-delete-gate.test.tsx:211`, sets only `NEXT_PUBLIC_OWNER_HANDLE`, so both sides resolve from the same fact and agree by construction.

**Approach:** Per the recorded 2026-08-31 decisions. (a) Add `ownerTenantHandle(principal)` to `src/lib/owner.ts` — for a principal this deployment already calls the owner it answers the canonical `getOwnerHandle()`, for everyone else it answers `principal.handle` unchanged — and spend it at the workbench-artifact/wikis-registry doors so reads and writes address one silo; record the audit of the remaining handle-derived doors. (b) Compute owner-ness server-side (`isOwnerPrincipal`) and hand it to the three islands as an `isSiteOwner` prop, so the client gate *is* the server's answer; reparameterise the delete-gate harness over both owner configurations so an id/handle divergence is visible.

## Boundaries & Constraints

**Always:**
- `ownerTenantHandle(principal)` changes the tenant ONLY when `isOwnerPrincipal(principal)` is true AND `getOwnerHandle()` is non-null; otherwise it returns `principal?.handle ?? ""` byte-identically to today.
- The three islands receive owner-ness as a REQUIRED boolean prop (no default) and stop importing `@/lib/owner` entirely; `isOwnerHandle` keeps no caller outside `src/lib/owner.ts`.
- `ArticleView` (already holds `principal`) and `RootLayout` (must resolve one) are the two server sites that compute the flag, through `isOwnerPrincipal` — never a second re-derivation.
- The gate EXPRESSIONS in the islands stay byte-identical (`const canDelete = isSiteOwner || (isOwner && !realmDeniesDelete);`, `const canRevert = isSignedInViewer && (isSiteOwner || !realmDeniesRevert);`) — only where `isSiteOwner` comes FROM changes.
- Fail closed: no principal → `isSiteOwner: false`; `getPrincipal()` throwing/anonymous in the layout → `false`.
- `src/lib/owner.ts` stays import-light (one import, `./principal-id`).

**Block If:**
- Making `RootLayout` async breaks the Next build in a way that cannot be resolved inside `src/app/layout.tsx` and `src/app/__tests__/app-shell.test.tsx`.

**Never:**
- Do not add a `NEXT_PUBLIC_*` mirror of the owner user id, and do not read `YOPEDIA_OWNER_USER_ID` outside `getOwnerUserId()`.
- Do not substitute `getOwnerHandle()` for tenants derived from a URL segment or from page frontmatter (`/u/[handle]/...`, `api/admin/tenant/[handle]`, `api/vaults/[id]/pages/[slug]`) — those address content-derived tenants and the substitution would be wrong.
- Do not convert the doors outside the wikis-registry / workbench-artifact wire listed under **Audit** — record them, do not touch them.
- Do not loosen any gate, change any refusal status/message, or alter `isOwnerPrincipal`'s own semantics.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Drifted-handle owner writes | `YOPEDIA_OWNER_USER_ID=user_X`, `NEXT_PUBLIC_OWNER_HANDLE=alice`, principal `{id:"user_X", handle:"user_X"}` | `ownerTenantHandle` → `"alice"`; `createWiki`/`writeWikiArtifact`/`getWikiRegistry` address the same silo `readActiveWikiSchema()` reads | No error expected |
| Non-owner reaches an ungated read | id configured, principal `{id:"user_Y", handle:"mallory"}` at `GET /api/wikis` | `ownerTenantHandle` → `"mallory"` — unchanged from today | No error expected |
| No owner handle configured | `NEXT_PUBLIC_OWNER_HANDLE` unset, `YOPEDIA_OWNER_USER_ID=user_X`, principal `{id:"user_X", handle:"bob"}` | `ownerTenantHandle` → `"bob"` (never `""`/`DEFAULT_TENANT`) | No error expected |
| Service/agent principal | principal `{id:"service:svc", handle:"svc"}`, owner handle `alice` | `isOwnerPrincipal` false → `"svc"`, unchanged | No error expected |
| No principal | `ownerTenantHandle(null)` | `""` | Callers already refuse before reaching it |
| Impostor holding a stale owner handle | `YOPEDIA_OWNER_USER_ID=user_X`, `NEXT_PUBLIC_OWNER_HANDLE=alice`, viewer `{id:"user_Y", handle:"alice"}` | server `isOwnerPrincipal` false → `isSiteOwner={false}` → NO owner affordances offered | No error expected |
| Drifted-handle owner views a page | same config, viewer `{id:"user_X", handle:"user_X"}` | `isSiteOwner={true}` → Delete/Re-ingest/Revert/Settings offered, matching the server | No error expected |
| Signed-out / unresolved viewer | `getPrincipal()` → `null` | `isSiteOwner={false}`; the islands' `isLoaded`/`isSignedIn` terms are unchanged | Fails closed |

</intent-contract>

## Code Map

**DW-612 — tenant. The rule, not a file list.**

Every production (non-`__tests__`) site under `src/` that hands a SESSION principal's handle to a function taking a Wiki/Workbench storage tenant must resolve it through `ownerTenantHandle(principal)` instead. The tenant-taking functions are the closed set below; a source scan over the whole tree — not an enumerated file list — is what proves completeness, so a door added later is caught:

- registry: `getWikiRegistry`, `getCurrentWiki`, `setCurrentWiki`, `renameWiki`, `deleteWiki`, `wikiDirPath`, `requireAccessibleWikiId`
- wiki artifacts / profile: `readWikiArtifact`, `writeWikiArtifact`, `readEffectiveWikiArtifact`, `readWikiArtifactRevision`, `readWikiArtifactRevisionMeta`, `listWikiArtifactRevisionsPage`, `restoreWikiArtifactRevision`, `applyWikiTemplate`, `getWorkspaceProfile`, `writeWorkspaceProfile`
- workbench files: `listWorkbenchFilePaths`, `readWorkbenchFile`, `readWorkbenchFileBytes`, `workbenchFileExists`
- whole-tenant archive: `buildPortableArchive`, `inspectPortableArchive`, `importPortableArchive`

Known sites (verify by scan; this list is a map, not the authority):
- `src/lib/owner.ts:56` `getOwnerHandle()`, `:115` `isOwnerPrincipal()` -- ADD `ownerTenantHandle()` beneath them. `:32-50` is the now-false client-gate docblock DW-613 must rewrite.
- `src/app/api/wikis/route.ts:21,87`; `src/app/api/wikis/current/route.ts:40`; `src/app/api/wikis/[id]/route.ts:40,79`; `src/app/api/wikis/[id]/template/route.ts:40` -- the registry's create/list/activate/rename/delete/re-template set. These MUST move together with `POST`: a create that lands canonically while `setCurrentWiki` still addresses the drifted silo answers 404 "Wiki not found." on the very Wiki it just made.
- `src/app/page.tsx:74,103` -- the Workbench FIRST PAINT (registry + `listWorkbenchFilePaths`). Unconverted, the drifted owner is shown "No wiki yet" and an empty tree over a Wiki that exists.
- `src/app/api/workbench/files/route.ts:25,31`; `src/app/api/workbench/media/route.ts:75,87`; `src/app/api/workbench/source/route.ts:32` -- the tree, its bytes and its source pane. `src/lib/workbench-files.ts:1164` asserts the media door's reach is identical to the Preview's BY CONSTRUCTION; leaving media behind breaks that invariant.
- `src/app/api/workbench/artifact/route.ts:216,264`; `src/app/api/workbench/artifact/revisions/route.ts:139,144` (resolve once in `gate()`, which serves both verbs) and its restore write; `src/app/api/workbench/preview/route.ts:229,252,258,265` -- the editor wire.
- `src/app/api/lint/workbench-fix/route.ts:42` -- writes a Workbench artifact.
- `src/app/api/workspace-profile/route.ts:24,26` -- the workspace profile, which `src/lib/lint.ts:139` already reads canonically.
- `src/app/api/archive/export/route.ts:9`; `src/app/api/archive/import/route.ts:15,18` -- export/import address the whole tenant the doors above now write.
- `src/app/api/v1/projects/route.ts:28,47` and the `[wikiId]` family via `src/lib/v1-route.ts:66,73` -- the external mirror of the SAME registry.
- `src/lib/wikis.ts:3649` `readActiveWikiSchema()` -- the canonical READ all of this must agree with. READ-ONLY.
- `src/lib/wiki.ts:106` `tenantForOwner` → `ownerToTenant` (`src/lib/links.ts:139`) -- an EMPTY handle collapses to `DEFAULT_TENANT`, which is why the helper must never return `""` for a real principal.

**Attribution is NOT a tenant.** `owner:`/`author:`/`triggeredBy:` fields that record WHO acted (e.g. `src/app/api/workbench/activity/route.ts:191-193,219-221`) keep `principal.handle`. Convert a site only where the value selects a storage silo.

**Audit — recorded, deliberately NOT converted.** Namespaces with no `getOwnerHandle()`-keyed reader on the other side, so they stay internally self-consistent under drift: chats, todos, review-queue, research projects, monitors, vaults, agent surfaces, the ingest/activity pipeline, query/graph/sources. The sharpest residual is `src/app/api/system/backups/route.ts:21,25,27` (writes at `principal.handle`) versus `src/app/api/tasks/scan/route.ts:226` (schedules at `getOwnerHandle()`). Synthesized principals (`service:`/`agent:`/`agent-owner:`, `src/mcp.ts`'s `"system"`) carry a non-owner handle, so the helper is a no-op there by construction. URL- and frontmatter-derived tenants (`/u/[handle]/**`, `api/admin/tenant/[handle]`, `api/vaults/[id]/pages/[slug]`, `app/raw/[slug]`) address CONTENT, not the caller — converting them would be wrong.

**DW-613 — client gate**
- `src/components/NavHeader.tsx:6,12,51-53,196,203,312,329` -- take `isSiteOwner: boolean`; drop the `@/lib/owner` import. `useUser` may still be needed for non-gate uses (e.g. an avatar id) — keep it only if it gates nothing.
- `src/components/ArticleActions.tsx:6,98-109,123,146` and `src/components/RevisionHistory.tsx:5,29-43,103-107,132,145` -- `isSiteOwner` becomes a required prop; `handleLc` stays for the page-owner/contributor terms. The gate EXPRESSIONS stay byte-identical.
- `src/components/ArticleView.tsx:152-159,529,535` -- already holds `principal`; compute `isOwnerPrincipal(principal)` once, pass to both islands.
- `src/app/layout.tsx:77-96,98-119` -- `RootLayout` becomes `async`, resolves `getPrincipal()` inside a try/catch that calls `unstable_rethrow(err)` FIRST, and threads the boolean through a still-synchronous `AppProviders`.
- `src/lib/__tests__/owner-gate-parity.test.ts:292-295,321-357` -- `HANDLE_GATE_ALLOWED` shrinks to `["src/lib/owner.ts"]`; reword the failure message and the `:354` loop.
- `src/lib/__tests__/article-actions-gate.test.ts:198-220,279-301,306-310` -- invert the "islands import `@/lib/owner`" scans.
- `src/components/__tests__/article-actions-delete-gate.test.tsx:160-223` -- reparameterise over two owner configurations (Design Notes).
- `src/app/__tests__/app-shell.test.tsx:1-8,198,252-323,401,471-478,543-566,606-616` -- `mountLayout` must `await RootLayout(...)`; `mountNav` supplies the prop; mock `@/lib/auth`'s `getPrincipal` from the same hoisted session state.
- `src/components/__tests__/page-write-read-only.test.tsx:1024` -- supply the prop.
- `src/lib/owner.ts:27-50` -- rewrite the docblock. State only what the pins actually enforce.

## Tasks & Acceptance

**Execution:**
- `src/lib/owner.ts` -- add `ownerTenantHandle(principal)` per the matrix; rewrite the `:27-50` docblock -- one place decides both *who* the owner is and *which* silo they address.
- Every site the Code Map's tenant rule names -- resolve the tenant once per handler as `ownerTenantHandle(principal)` and spend that local; update the tenant-describing comments in the routes that carry one. Leave attribution fields on `principal.handle` -- a converted door whose sibling still addresses the drifted silo is worse than neither being converted, because it turns an inert write into a contradiction the owner can see.
- `src/components/NavHeader.tsx`, `src/components/ArticleActions.tsx`, `src/components/RevisionHistory.tsx` -- accept a required `isSiteOwner: boolean`; delete the `@/lib/owner` import -- the client gate stops being an independent re-derivation.
- `src/components/ArticleView.tsx`, `src/app/layout.tsx` -- compute `isOwnerPrincipal(principal)` server-side and pass it down -- one answer, produced where the stable id is readable. Document the per-request cost the layout's `getPrincipal()` adds, and share the resolution with the page render if `getPrincipal` can be memoized without changing any other caller's behavior.
- `src/lib/__tests__/owner-handle.test.ts` -- an `ownerTenantHandle` describe covering all five tenant rows of the matrix -- the matrix is the contract.
- `src/lib/__tests__/owner-gate-parity.test.ts` -- (a) shrink `HANDLE_GATE_ALLOWED`; (b) add an import-graph assertion that `src/lib/owner.ts` imports nothing but `./principal-id`, now that no island bundles it; (c) replace any fixed converted-file list with a SCAN over all non-test `src/**` for `<tenant fn>(principal.handle` / `(caller.principal.handle` and fail on any hit, naming the closed function set -- completeness must be mechanized, not enumerated; (d) pin that a drifted-handle owner's `ownerTenantHandle` equals the tenant `readActiveWikiSchema` resolves.
- `src/lib/__tests__/wikis-routes.test.ts` and the artifact, revisions and preview door suites -- one EXECUTING drifted-owner case per door (`YOPEDIA_OWNER_USER_ID` set, `NEXT_PUBLIC_OWNER_HANDLE` stale) asserting the tenant actually passed -- three of the four doors were previously pinned by source text alone, which a rename or a single reverted argument walks straight past.
- `src/components/__tests__/article-actions-delete-gate.test.tsx` -- reparameterise over both owner configurations, driving the prop from `isOwnerPrincipal(principalFor(viewer))` -- the two sides now resolve from different facts.
- `src/app/__tests__/app-shell.test.tsx` -- run the `NavHeader` describe over the SAME two owner configurations, and save/clear/restore `YOPEDIA_OWNER_USER_ID` around the suite; make the mocked `unstable_rethrow` re-throw its argument in the layout failure-path case; rename the shadowed local `auth` binding in that case -- the nav is one of the three gates DW-613 names, and it was the only one never exercised where the two facts disagree.
- `src/lib/__tests__/article-actions-gate.test.ts`, `src/components/__tests__/page-write-read-only.test.tsx`, `src/lib/__tests__/wiki-schema-edit.test.ts`, `src/lib/__tests__/workbench-preview.test.ts` -- update the source scans, mounts and now-stale explanatory comments for the new seams.

**Acceptance Criteria:**
- Given an owner admitted by stable id whose handle differs from `NEXT_PUBLIC_OWNER_HANDLE`, when they create a Wiki and then list, activate, rename, preview, save, revise, export or open it in the Workbench, then every one of those doors addresses the single tenant `getOwnerHandle()` names — no door answers 404 or an empty listing for a Wiki another door reports.
- Given the whole non-test tree, when the tenant scan runs, then no call to a registry/artifact/workbench-file/archive function receives a session principal's handle directly.
- Given a principal that is NOT the owner (or a deployment with no owner handle), when any converted door runs, then the tenant it addresses is byte-identical to the pre-change behavior.
- Given `YOPEDIA_OWNER_USER_ID` is configured with a stale `NEXT_PUBLIC_OWNER_HANDLE`, when the delete-gate and nav harnesses run both owner configurations, then no affordance is offered that the server would refuse, in either configuration.
- Given the repository source, when the scans run, then `isOwnerHandle(` has no caller outside `src/lib/owner.ts`, and none of the three islands imports `@/lib/owner`.
- Given the whole suite, when `npx tsc --noEmit`, `npx eslint src` and `npx vitest run` run, then typecheck and lint are clean and no test fails that was not already failing at the baseline revision.

## Spec Change Log

### 2026-09-05 — bad_spec repair (review pass 1)

- **Triggering finding:** converting only the four named doors left their siblings on `principal.handle`. For the drifted-handle owner — the only principal the change affects — `POST /api/wikis` created a Wiki in the canonical silo while `PUT /api/wikis/current`, `PATCH`/`DELETE /api/wikis/[id]`, `src/app/page.tsx`, `GET /api/workbench/files` and `GET /api/workbench/media` still addressed the drifted one: 404 on the Wiki just created, an empty tree, and a media door that 404s a file the Preview had just said exists (breaking the reach invariant asserted at `src/lib/workbench-files.ts:1164`). Before the change all of these agreed inertly; the partial conversion turned an invisible defect into a visible contradiction.
- **Root cause in the spec:** the previous **Code Map**/**Never** drew the boundary as a four-file list and forbade touching the rest, and the pin was a fixed `TENANT_CONVERTED` array — so nothing could detect a fifth door. That boundary is not the intent's: the recorded decision says id-owners "always address the canonical silo" and asks to "audit every write door … for the same substitution".
- **What was amended:** the Code Map now states a RULE over a closed set of tenant-taking functions plus an explicit attribution carve-out and an explicit non-converted audit list; the pin becomes a whole-tree scan rather than an enumerated list; per-door executing drifted-owner cases replace source-text-only coverage at three doors; the nav harness joins the two-configuration parameterisation.
- **Known-bad state avoided:** a green suite over a Workbench that contradicts itself for the exact user the story exists to fix.
- **KEEP (must survive re-derivation):**
  1. `ownerTenantHandle`'s shape: a no-op unless `isOwnerPrincipal(principal)` AND `getOwnerHandle()` is non-null; falls back to `principal?.handle ?? ""` so an id-only deployment never collapses to `DEFAULT_TENANT`. Its docblock explaining why that makes it safe at a door with no owner gate of its own.
  2. Resolving the tenant ONCE per handler into a local (`const tenant = ownerTenantHandle(principal)`) rather than repeating the call — and in `revisions/route.ts` doing it inside the shared `gate()` so GET and POST cannot drift.
  3. DW-613 exactly as implemented: required `isSiteOwner` prop on all three islands, computed in `ArticleView` and an `async RootLayout`, islands dropping `@/lib/owner`, gate expressions byte-identical, `unstable_rethrow` called first in the layout's catch, and `app-shell.test.tsx` mocking `getPrincipal` from the SAME hoisted session state `useUser` answers from.
  4. `article-actions-delete-gate.test.tsx`'s `OWNER_CONFIGS` parameterisation, the impostor rows at both doors, the non-vacuity case proving the two facts genuinely disagree, and driving the prop through the real `isOwnerPrincipal`.
  5. `HANDLE_GATE_ALLOWED` shrunk to `["src/lib/owner.ts"]` under a strict `toEqual`.
  6. Keeping `useUser` in `NavHeader` where it feeds a non-gate use (the avatar id), documented at the call site — the previous pass verified it is not dead.

## Review Triage Log

### 2026-09-05 — Review pass

- intent_gap: 0
- bad_spec: 6: (high 1, medium 3, low 2)
- patch: 0
- defer: 1: (high 0, medium 1, low 0)
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[high]` `[bad_spec]` Partial conversion: the four converted doors disagreed with their unconverted siblings (`wikis/current`, `wikis/[id]`, `wikis/[id]/template`, `page.tsx`, `workbench/files`, `workbench/media`, `workspace-profile`, `archive/*`, `v1/projects`) for the drifted-handle owner — create succeeded, then activate/rename/delete 404'd and the Workbench showed an empty tree. Spec amended from a four-file list to a rule over a closed set of tenant-taking functions, with a whole-tree scan as the pin; code reverted for re-derivation.
  - `[medium]` `[bad_spec]` The DW-612 pin was a fixed `TENANT_CONVERTED` array, so no test could see a fifth door. Amended to a scan.
  - `[medium]` `[bad_spec]` Three of the four doors (artifact, revisions, preview) were pinned by source text only; no executing test observed the tenant they address under drift. Amended to require a per-door executing drifted-owner case.
  - `[medium]` `[bad_spec]` `NavHeader` — one of the three gates DW-613 names — was exercised only where the id and handle answers coincide, so a revert to `isOwnerHandle` would pass the whole suite. Amended to parameterise the nav suite over both owner configurations.
  - `[low]` `[bad_spec]` `app-shell.test.tsx` never cleared an ambient `YOPEDIA_OWNER_USER_ID`; the mocked `unstable_rethrow` was a no-op so deleting the layout's guard failed nothing; a local `auth` binding shadowed the hoisted session state. All three folded into the amended tasks.
  - `[low]` `[bad_spec]` `owner.ts`'s docblock claimed stronger enforcement than the scan provides, and nothing replaced the client-bundling constraint that had kept the module import-light. Amended: state only what the pins enforce, and add an import-graph assertion.

## Design Notes

The tenant helper — a no-op for everyone the deployment does not already call the owner, which is what makes it safe to apply at a door with no owner gate of its own (the Preview):

```ts
export function ownerTenantHandle(
  principal: { id?: string | null; handle?: string | null } | null | undefined,
): string {
  const handle = principal?.handle ?? "";
  // Only an admitted owner is re-pointed, and only when a canonical handle
  // exists to re-point them AT: `tenantForOwner("")` is DEFAULT_TENANT, so an
  // id-only deployment must keep the caller's own handle.
  if (!isOwnerPrincipal(principal)) return handle;
  return getOwnerHandle() ?? handle;
}
```

The reparameterised harness. Today's `beforeEach` sets `NEXT_PUBLIC_OWNER_HANDLE = SITE_OWNER` and nothing else, so the client's `isOwnerHandle` and the server's `isAdmin` read one var and agree by construction. Run the whole matrix twice instead:

- `handle-only` — `NEXT_PUBLIC_OWNER_HANDLE = SITE_OWNER`, no id. Today's behavior, unchanged.
- `id-configured` — `YOPEDIA_OWNER_USER_ID = "user_" + SITE_OWNER` AND a STALE `NEXT_PUBLIC_OWNER_HANDLE` (e.g. `"old-owner"`), so the two facts genuinely disagree: `principalFor(SITE_OWNER)` is the owner by id but not by handle, and `principalFor("old-owner")` is the reverse.

`mount()` supplies `isSiteOwner={isOwnerPrincipal(principalFor(row.viewer))}` — the same call `ArticleView` makes — so the sweep "offers Delete to nobody the server would refuse" is now a real comparison in both configurations. An island that went back to `isOwnerHandle` fails the `id-configured` half.

The tenant rule is checked, not listed. Enumerating converted files in a test array is what let the first attempt convert four doors and leave nine siblings behind with nothing red. The pin scans every non-test file under `src/` and fails on any call of the form `<tenant fn>(principal.handle` / `(caller.principal.handle` over the closed function set in the Code Map, so completeness is a property of the tree rather than of a list someone remembered to extend. Attribution fields (`author:`, `triggeredBy:`, and `owner:` where it records who acted rather than which silo) are outside that set and stay on `principal.handle`.

`RootLayout` is called as a plain function by `app-shell.test.tsx` (`render(RootLayout({ children }))`), so making it `async` costs one `await` per mount rather than a new rendering strategy — provided `AppProviders` stays synchronous and receives the resolved boolean as a prop.

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: clean.
- `npx eslint src` -- expected: exit 0, stderr identical to baseline.
- `npx vitest run src/lib/__tests__/owner-handle.test.ts src/lib/__tests__/owner-gate-parity.test.ts src/lib/__tests__/owner-single-reader.test.ts src/lib/__tests__/wikis-routes.test.ts src/lib/__tests__/article-actions-gate.test.ts src/components/__tests__/article-actions-delete-gate.test.tsx src/app/__tests__/app-shell.test.tsx src/components/__tests__/page-write-read-only.test.tsx src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/wiki-artifact-revisions.test.ts src/lib/__tests__/workbench-epic2-routes.test.ts` -- expected: all green.
- `npx vitest run` -- expected: 0 failed (the full suite was green at the baseline revision `f94da1fb`; any new failure is this change's).
- `grep -rn "isOwnerHandle(" src --include=*.ts --include=*.tsx | grep -v __tests__` -- expected: `src/lib/owner.ts` only.
- `grep -rnE "(getWikiRegistry|getCurrentWiki|setCurrentWiki|renameWiki|deleteWiki|wikiDirPath|requireAccessibleWikiId|readWikiArtifact|writeWikiArtifact|readEffectiveWikiArtifact|listWorkbenchFilePaths|readWorkbenchFile|readWorkbenchFileBytes|workbenchFileExists|getWorkspaceProfile|applyWikiTemplate|buildPortableArchive|inspectPortableArchive|importPortableArchive)\(([a-zA-Z]+\.)?principal\.handle" src --include=*.ts --include=*.tsx | grep -v __tests__` -- expected: no output. This is the same property the parity-test scan mechanizes.
