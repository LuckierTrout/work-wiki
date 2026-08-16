---
title: 'Owner-scoped linking: emit real-owner URLs and restore alias forwarding'
type: 'bugfix'
created: '2026-08-16'
status: 'done'
baseline_revision: '771cf33ef0b99ae394d2d50ee208243635ed9bc3'
review_loop_iteration: 0
followup_review_recommended: true # patched this pass: 1 medium + 3 low → 3×1 + 1×3 = 6 ≥ 5
context: []
warnings: [multiple-goals, oversized] # DW-2 + DW-3 bundled by the orchestrator as one owner-scoped-linking intent; Code Map spans both
deferred:
  - summary: >-
      MarkdownRenderer call sites outside the intent's component list still emit DEFAULT_TENANT
      wikilinks for in-content [x](slug.md) targets, taking the wrong-handle 308 hop the named
      components were just cured of.
    evidence: |-
      QueryResultPanel.tsx:182 renders query answers (which cite [Title](slug.md) per
      src/lib/query.ts:62) without passing slugTenants even though the component already calls
      useSlugTenants for its source chips — a one-line adoption; RawSourceBrowser.tsx:90,
      SlidePreview.tsx:61,77, AgentApiContent.tsx:45 and src/app/wiki/log/page.tsx:66 render with
      no map either. All pre-date this change; the intent's component list (union of DW-2 and the
      bundle intent) does not include them.
    location: >-
      src/components/QueryResultPanel.tsx:182
    severity: medium
  - summary: >-
      The edit and raw owner-scoped routes do not alias-forward merged-away slugs, so an old
      /u/<handle>/<slug>/edit bookmark 404s where the page-view URL now forwards.
    evidence: |-
      aliasRedirectForMissing is wired only into src/app/u/[handle]/[slug]/page.tsx; the edit and
      raw routes keep their pre-existing hard-404 miss behavior. Pre-existing asymmetry surfaced
      by this change; the intent names only the owner route's page-view miss path.
    location: >-
      src/app/u/[handle]/[slug]/edit/page.tsx
    severity: low
  - summary: >-
      The owner route's "Page not found" UI is rendered as a normal HTTP 200 response instead of
      signalling notFound(), so dead slugs (including alias candidates that fail the forwarding
      guard) are indexable 200 pages to crawlers.
    evidence: |-
      The miss branch of src/app/u/[handle]/[slug]/page.tsx returns JSX directly rather than
      calling next/navigation notFound(); pre-existing behavior that this change extends but did
      not introduce.
    location: >-
      src/app/u/[handle]/[slug]/page.tsx:75
    severity: low
  - summary: >-
      Converted components' rendered anchors have no executable coverage: reverting any one call
      site to slugPath (or dropping a slugTenants renderer prop) passes the whole suite, so the
      story's component-surface acceptance criterion has no executable check.
    evidence: |-
      vitest.config.ts runs node-only with include src/**/__tests__/**/*.test.ts (no .tsx), and
      package.json carries no jsdom or @testing-library dependency, so no test can render the six
      converted "use client" components; ChatWorkspace's saved-banner url fallback and
      VaultExplorer's owner-direct link are likewise unasserted. The hook's render contract is now
      pinned via react-dom/server, but per-component adoption above it is not. Surfaced by this
      story's review; the missing client-component harness pre-dates the story and adopting one is
      a project-level decision.
    location: >-
      vitest.config.ts
    severity: medium
  - summary: >-
      loadSlugTenants caches a non-OK response's empty map for the whole session (no retry) while
      a rejected fetch is retried, so one transient 401/429/500 from /api/wiki/routes pins
      DEFAULT_TENANT fallback links until reload.
    evidence: |-
      In src/hooks/useSlugTenants.ts the non-OK branch's {} flows into the .then that assigns
      cache, so cache = {} permanently; the .catch path returns {} without assigning cache, so the
      next caller re-fetches. Byte-identical logic pre-dates this story (only renamed/exported
      here). Links still work via the 308 fallback, so the consequence is a session of
      wrong-handle hrefs, not breakage.
    location: >-
      src/hooks/useSlugTenants.ts
    severity: low
  - summary: >-
      getAliasIndex caches only successful builds, so while any page file has malformed
      frontmatter every missing-slug request re-runs the full wiki scan behind
      aliasRedirectForMissing before failing closed.
    evidence: |-
      buildAliasIndex sets cachedIndex only after a complete scan (src/lib/alias-index.ts:100)
      and getAliasIndex re-invokes it whenever cachedIndex is null, so a mid-loop parse throw
      leaves nothing cached and the next miss-path request re-scans. The cache-only-on-success
      behavior pre-dates this story; the owner route's miss path is merely its first routing
      caller, and the proper fix (failure caching or a cooldown) lives in alias-index.ts, which
      the intent walls off ("Never: Change resolveAlias / alias-index semantics"). Consequence
      is bounded: the scan is one readdir plus frontmatter parses, aborts at the corrupt file,
      and each failure is now logger.warn-visible.
    location: >-
      src/lib/alias-index.ts:107
    severity: low
  - summary: >-
      SlugTenantMap lookups use plain inherited-prototype indexing, so a slug naming an
      Object.prototype member (a page titled "Constructor" slugifies to "constructor") resolves
      to the inherited function and tenantSegment throws during render.
    evidence: |-
      resolveSlugPath does slugTenants?.[slug] ?? fallbackTenant (src/lib/links.ts:157) and the
      map is parsed response JSON, whose objects inherit Object.prototype — map["constructor"]
      is a function, which ?? does not filter, so pagePath receives it and tenantSegment calls
      .trim() on a function (TypeError) wherever such a slug renders as a link. The lookup idiom
      is byte-identical to the pre-story hook and MarkdownRenderer paths; this story only spread
      the same map to more call sites. Requires a page slug colliding with an Object.prototype
      member, hence low.
    location: >-
      src/lib/links.ts:157
    severity: low
---

<intent-contract>

## Intent

**Problem:** (DW-2) Six client components build slug-only links via `slugPath()`, which hard-codes `DEFAULT_TENANT` — every link shows the wrong handle in the address bar and link previews and costs a 308 hop. (DW-3) Alias forwarding for merged/renamed slugs died with the retired commons URL: `commonsRedirectForMissing` returns null unconditionally and `resolveAlias` has no routing caller, so a wikilink to a merged-away slug 404s at `/u/<tenant>/<old-slug>`.

**Approach:** Point the components at the existing readability-gated slug→tenant mechanism (`useSlugTenants` / `/api/wiki/routes`) so they emit `/u/<handle>/<slug>` directly, keeping the `DEFAULT_TENANT` fallback only where no owner is resolvable. Replace `commonsRedirectForMissing` with a principal-aware alias resolver wired into the owner route's miss path, 308ing a merged-away slug to its survivor's canonical URL.

## Boundaries & Constraints

**Always:**
- Keep `slugPath()` itself unchanged; it remains the documented fallback (map still loading, unknown/new slug, no resolver) and the 308 keeps such links working.
- Alias forwarding must not become a private-page existence oracle: forward only when the survivor exists AND `canReadFrontmatter(survivor, principal)` passes; otherwise render the identical 404 UI.
- Guard `canonical !== slug` before redirecting — the alias index maps every live slug to itself, so an existing-but-unreadable page would otherwise self-redirect-loop.
- Redirect in one hop to `pagePath(tenantForOwner(survivorOwner), canonical)` via `permanentRedirect` (308), never through `DEFAULT_TENANT`.

**Block If:** Making any affected link canonical would require exposing another user's private slug→owner data beyond what readability-gated `/api/wiki/routes` already returns.

**Never:**
- Reintroduce any `/wiki/<slug>` surface or redirect target (AD-21 retirement stands).
- Extend ingest/import/action API payloads with owner fields — the session map plus 308 fallback covers fresh pages.
- Touch the Cloudflare workers that hand-inline the `DEFAULT_TENANT` URL shape.
- Change `resolveAlias` / alias-index semantics.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Merged-away slug visited | `/u/<any>/<old-slug>`; alias → readable survivor | 308 to `/u/<survivor-tenant>/<canonical>` | No error expected |
| Alias to private survivor, anonymous | `resolveAlias` hits; viewer can't read survivor | 404 UI, indistinguishable from missing | No redirect emitted |
| Alias to private survivor, its owner | Same slug, principal owns survivor | 308 to canonical | No error expected |
| No alias for missing slug | `resolveAlias` returns null | 404 UI | No error expected |
| Existing-but-unreadable page slug | `resolveAlias` returns the slug itself | 404 UI (self-redirect guarded) | No error expected |
| Component link, slug in map | map has `slug → tenant` | href is `/u/<tenant>/<slug>` directly | No error expected |
| Component link, map loading / unknown slug | no map entry | href falls back to `/u/yopedia/<slug>`; 308 lands it | No error expected |
| Chat answer saved | `/api/query/save` returns `{slug, url}` | banner links via returned canonical `url` (fresh slug is not in the session map) | Existing error alert unchanged |

</intent-contract>

## Code Map

- `src/lib/links.ts:118-120` -- `slugPath()` (unchanged fallback); `pagePath`, `resolveSlugPath`, `SlugTenantMap`, and the client-safe `ownerToTenant` (which server-side `tenantForOwner` in `wiki.ts` wraps) also here.
- `src/hooks/useSlugTenants.ts` -- session-cached `/api/wiki/routes` map; `hrefForSlug(slug)` already does map-or-fallback. Extend its return to also expose the raw map (`slugTenants`) for MarkdownRenderer props.
- `src/app/api/wiki/routes/route.ts` -- readability-gated slug→tenant source. No change.
- `src/lib/page-redirect.ts:15-19` -- `commonsRedirectForMissing`, unconditionally null; replace with `aliasRedirectForMissing(slug, principal)`.
- `src/lib/alias-index.ts:126` -- `resolveAlias`; `bySlug` maps every live slug to itself (hence the `canonical !== slug` guard).
- `src/app/u/[handle]/[slug]/page.tsx:74-83` -- miss branch (missing OR unreadable → 404 UI) to wire forwarding into; `permanentRedirect` idiom at :94-96.
- `src/lib/wiki.ts:105` -- `tenantForOwner`; `src/lib/authz.ts:120` -- `canReadFrontmatter(fm, principal)`; both accept the route's `getPrincipal()` result.
- Call sites to convert (all `"use client"`): `src/components/RecentIngests.tsx:486,567`; `VaultExplorer.tsx:545` (+ MarkdownRenderer :637); `ChatWorkspace.tsx:259,346` (+ renderer :342; `saveAnswer` :214-232 currently discards the response `url`); `ActionInbox.tsx:386`; `BulkDocumentImport.tsx:531`; `KnowledgeStudio.tsx:399` (+ renderer :779).
- `src/components/MarkdownRenderer.tsx:194-199` -- already accepts `tenant`/`slugTenants`; `slugPath` fallback fires only when neither is passed. Keep that fallback; feed it the map from client callers.
- `src/app/api/query/save/route.ts:83-85` -- server already returns canonical `url` when owner is known; `slugPath` fallback there is the legitimate no-owner case. No change.
- Tests: `src/lib/__tests__/merge.test.ts:148-152,297-330` -- asserts `commonsRedirectForMissing` is null; rewrite for the new resolver. `src/lib/__tests__/owner-page-route.test.ts` -- route-level harness (mocks `permanentRedirect` to throw `REDIRECT:<url>`) to extend.

## Tasks & Acceptance

**Execution:**
- `src/hooks/useSlugTenants.ts` -- return the raw map (e.g. `slugTenants`) alongside `hrefForSlug` -- MarkdownRenderer call sites need it as a prop.
- `src/lib/page-redirect.ts` -- replace `commonsRedirectForMissing` with `aliasRedirectForMissing(slug, principal)`: `resolveAlias(slug)`; null unless hit && hit !== slug; read survivor frontmatter; null unless `canReadFrontmatter` passes; else `pagePath(tenantForOwner(owner), hit)`. Rewrite module header -- forwarding now targets the owner-scoped URL.
- `src/app/u/[handle]/[slug]/page.tsx` -- in the miss branch, `await aliasRedirectForMissing(slug, principal)`; `permanentRedirect(target)` when non-null, else the existing 404 UI.
- `src/components/RecentIngests.tsx`, `src/components/ActionInbox.tsx`, `src/components/BulkDocumentImport.tsx` -- swap `slugPath(x)` → `hrefForSlug(x)` via `useSlugTenants`; drop unused `slugPath` imports.
- `src/components/VaultExplorer.tsx`, `src/components/KnowledgeStudio.tsx` -- same swap; also pass `slugTenants` to their MarkdownRenderer usages so in-content wikilinks resolve canonically.
- `src/components/ChatWorkspace.tsx` -- source chips via `hrefForSlug`; `saveAnswer` keeps the response `url` and the saved banner links with it (fallback `hrefForSlug(slug)` if absent); pass `slugTenants` to the assistant-message MarkdownRenderer.
- `src/lib/__tests__/merge.test.ts` -- rewrite the three null-assertions for `aliasRedirectForMissing`: merged slug forwards to survivor canonical; private survivor stays null for anonymous but forwards for its owner; no-alias stays null.
- `src/lib/__tests__/owner-page-route.test.ts` -- add route-level cases: merged-away slug 308s once to the survivor's canonical URL; a missing slug with no alias still renders the 404 UI. Cover the I/O matrix rows not exercised elsewhere.

**Acceptance Criteria:**
- Given a readable page owned by `alice` listed in any converted component, when the session map has loaded, then its anchor href is `/u/alice/<slug>` and navigation performs no redirect.
- Given the map has not loaded or the slug is unknown, when the link renders, then the href is the `DEFAULT_TENANT` form and navigating it still lands on the canonical page via the existing 308.
- Given a page merged into a survivor, when any surface follows a link to the old slug, then the browser lands on the survivor's canonical URL after exactly one 308.
- Given any change in this spec, no surface emits or forwards to `/wiki/<slug>`.

## Spec Change Log

## Review Triage Log

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 3: (high 0, medium 1, low 2)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` `aliasRedirectForMissing` could 500 every missing-page request when any page file has malformed frontmatter (parseFrontmatter throws inside buildAliasIndex) — body now wrapped in try/catch returning null so a broken alias index degrades to the 404 UI.
  - `[medium]` `[patch]` DW-2's map wiring had no executable coverage (dropping the map lookup passed the whole suite) — `useSlugTenants` restructured into exported testable seams `loadSlugTenants()` and pure `hrefFromMap(map, slug)`, pinned by new `src/hooks/__tests__/useSlugTenants.test.ts` (fetch-once caching, failure → {}, map-hit → /u/alice/a, fallback → /u/yopedia/x).
  - `[low]` `[patch]` VaultExplorer holds `entry.owner` but waited on the session map — "Open full page" now builds `pagePath(ownerToTenant(selectedEntry.owner), slug)` directly and the preview MarkdownRenderer additionally gets `tenant={ownerToTenant(selectedEntry.owner)}`.
  - `[low]` `[patch]` Hook's private `SlugTenants` type replaced with the exported `SlugTenantMap` from `@/lib/links` so the MarkdownRenderer prop contract is nominal, not structural coincidence.
  - `[low]` `[patch]` `page-redirect.ts` docstring understated forwarding scope — now notes that resolveAlias also forwards a missing slug matching an existing page's slugified title, not only recorded aliases.
  - `[low]` `[patch]` Anonymous half of the private-survivor route test could not assert the redirect mock was uncalled — mock calls now cleared between halves and the not-called assertion added.
  - `[low]` `[patch]` Ownerless-survivor branch (`tenantForOwner(undefined)` → /u/yopedia/<canonical>) was untested — new merge.test.ts case pins it.

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 2: (high 0, medium 1, low 1)
- reject: 14: (high 0, medium 0, low 14)
- addressed_findings:
  - `[medium]` `[patch]` The review-added fail-closed try/catch in `aliasRedirectForMissing` had no test (deleting it kept the suite green) — new merge.test.ts case corrupts a seeded page's frontmatter on disk, proves `resolveAlias` then rejects, and pins that the resolver still resolves null.
  - `[low]` `[patch]` `useSlugTenants` itself never executed in any test (only its extracted seams were pinned) — new react-dom/server render tests pin the hook's render contract: warmed cache → `/u/alice/a` anchor plus exposed `slugTenants`; cold module → DEFAULT_TENANT fallback href.
  - `[low]` `[patch]` The merged-away 308 route test exercised only the default handle, leaving the I/O matrix's `/u/<any>/<old-slug>` claim unpinned — the test now visits the alias under a non-default handle.
  - `[low]` `[patch]` Code Map omitted `ownerToTenant` (links.ts) even though the implementation and the prior triage log reference it — the links.ts entry now names it and its `tenantForOwner` wrapper.

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 2: (high 0, medium 0, low 2)
- reject: 13: (high 0, medium 0, low 13)
- addressed_findings:
  - `[medium]` `[patch]` The fail-closed catch in `aliasRedirectForMissing` swallowed every error invisibly, so a broken alias index (all forwarding down) left no operator trace — the catch now emits `logger.warn("page-redirect", ...)` with the slug and error, matching the repo's logger idiom (suppressed at the test-mode log level).
  - `[low]` `[patch]` ChatWorkspace's saved banner regressed for a malformed-but-OK save response: the old falsy string suppressed the banner, but the new object form rendered "Saved as ." linking /u/yopedia/undefined — `setSavedMessage` now guards on `result.slug` and keeps the banner hidden when absent.
  - `[low]` `[patch]` `loadSlugTenants`' docstring overclaimed "at most once per session" (false when the fetch rejects — that path retries) and presented the two failure modes as equivalent despite DW-87's caching asymmetry — the docstring now states the asymmetry explicitly.
  - `[low]` `[patch]` The docstring's concurrent-caller sharing contract had no test (the "exactly once" test awaits the first call, exercising only the warm cache) — a new test issues two calls while the fetch is unresolved and pins one fetch with both callers resolving to the same map.

## Design Notes

- The hook, not payload owner fields: `/api/wiki/routes` is already readability-gated and session-cached; threading `owner` through ingest/import/action payloads would widen APIs for no canonical-URL gain the map doesn't provide.
- `savedMessage` uses the server-returned `url` because a just-created slug cannot be in the session-cached map — `hrefForSlug` would bounce it through the 308 the DW exists to remove.
- Forwarding is principal-aware where the commons version was not: the old surface was public-only, the owner route is not, so the owner must reach their own private survivor while anonymous viewers still see the neutral 404.

## Verification

**Commands:**
- `npm test` -- expected: all suites pass, including rewritten `merge.test.ts` and extended `owner-page-route.test.ts`.
- `npm run lint` -- expected: clean, no unused `slugPath` imports.
- `npx tsc --noEmit` -- expected: no type errors.

## Auto Run Result

**Summary:** Follow-up review pass (dispatched on the `done` spec per its standing `followup_review_recommended`) over the full DW-2/DW-3 diff since `771cf33`. Four parallel review layers (blind hunter, edge-case hunter, verification-gap, intent-alignment) produced 19 distinct findings; no intent gaps or spec defects. Four patches were applied in this pass: operator-visible logging in `aliasRedirectForMissing`'s fail-closed catch, a guard so ChatWorkspace's saved banner stays hidden on a malformed-but-OK save response instead of rendering "Saved as undefined", an accuracy fix to `loadSlugTenants`' caching docstring, and a test pinning the hook loader's concurrent in-flight sharing.

**Files changed this pass:**
- `src/lib/page-redirect.ts` — catch now logs `logger.warn("page-redirect", ...)` before degrading to the 404 UI.
- `src/components/ChatWorkspace.tsx` — `setSavedMessage` guards on `result.slug`; missing slug keeps the banner hidden (pre-change behavior).
- `src/hooks/useSlugTenants.ts` — docstring corrected: non-OK caches `{}` for the session, rejected fetch retries.
- `src/hooks/__tests__/useSlugTenants.test.ts` — new "shares one in-flight request between concurrent callers" test.

**Review findings breakdown:** patch 4 (1 medium, 3 low — all fixed), defer 2 (both low, pre-existing: alias-index rebuild-on-failure cost, walled off by the intent's "never change alias-index semantics"; prototype-unsafe `SlugTenantMap` indexing), reject 13 (noise: duplicates of already-deferred DW-83/DW-86, orchestrator-owned ledger formatting/sequencing, workflow-convention misreadings, test-idiom and design-taste complaints, spec-prescribed defensive fallback).

**Follow-up review recommendation:** patched this pass: 1 medium + 3 low → score 3×1 + 1×3 = 6 ≥ 5 → `followup_review_recommended: true`.

**Verification:** `npm test` — 206 files, 4297 tests, all pass. `npm run lint` — exit 0 (pre-existing `jsx-ast-utils` TSNonNullExpression warnings only). `npx tsc --noEmit` — clean.

**Residual risks:** The converted components' anchors remain unpinned by executable tests (deferred DW-86; project-level harness decision). Alias forwarding on `/edit`/`/raw` routes and the 404-as-200 behavior remain deferred (DW-84/DW-85). A corrupt page file still costs a bounded re-scan per missing-slug request until fixed (new defer), now at least logged.

