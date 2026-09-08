---
title: 'Owner-scoped link and not-found hardening (DW-83/84/85/87/89)'
type: 'bugfix'
created: '2026-08-19'
status: 'done'
baseline_revision: 'ed2a9256f80de5a59586b846e02d2e4abec59d04'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      The edit route answers a dead slug with a rendered "Page not found — nothing to edit"
      body at HTTP 200, the same defect DW-85 fixed on the page view, and this story's tests
      now pin that 200 in place.
    evidence: |-
      src/app/u/[handle]/[slug]/edit/page.tsx returns JSX from its miss branch rather than
      calling notFound(). DW-85's intent text scopes the 200->404 conversion to the page-view
      route only, so this story deliberately left it; DW-84's own ledger text is inaccurate
      here, asserting both non-page routes "keep their pre-existing hard-404 miss behavior"
      when only /raw/ does. The edit/ segment also has no not-found.tsx of its own, so an
      honest 404 there needs one carrying the surface-specific copy (the sibling [slug]/ and
      raw/[slug]/ segments each have one). Pre-existing; surfaced by this change's review.
    location: >-
      src/app/u/[handle]/[slug]/edit/page.tsx:24
    severity: low
  - summary: >-
      tenantForSlug still resolves a slug through inherited-prototype indexing, the exact
      defect DW-89 fixed in resolveSlugPath, one file over.
    evidence: |-
      src/lib/wiki.ts:130 does `pageIdx[slug]` and :136 does `map[slug] ?? tenantForOwner(undefined)`,
      both over plain object literals — so a page titled "Constructor" would short-circuit the
      fast path on Object.prototype.constructor, or return that function as a tenant. Currently
      inert: the function's only callers are in tenant-paths.test.ts, no production path. The
      structural fix is to build these maps with a null prototype at their construction sites
      (buildSlugTenantMap, /api/wiki/routes, the log page's literal) rather than guarding each
      lookup. Byte-identical to the pre-story idiom; this story hardened only the link path.
    location: >-
      src/lib/wiki.ts:126
    severity: low
  - summary: >-
      The machine surfaces GET /api/wiki/[slug] and /api/raw/[slug] still hard-404 a
      merged-away slug, so agents and MCP clients now get a different answer than the UI for
      the same bookmark.
    evidence: |-
      This story wired aliasTargetForMissing into all three /u/ routes, so the page, edit and
      raw views forward. The JSON routes were never in scope — the intent names only the edit
      and raw owner-scoped routes — and were already hard-404 before it. The asymmetry is new
      even though neither side changed: forwarding the HTML surfaces is what made the API's
      behavior a divergence rather than the uniform rule. Either forward there too, or return
      the canonical slug in the 404 envelope so a client can follow it.
    location: >-
      src/app/api/wiki/[slug]/route.ts
    severity: low
  - summary: >-
      A component mounted while /api/wiki/routes was failing keeps DEFAULT_TENANT hrefs for
      its whole lifetime, because useSlugTenants has no refresh path after its mount effect.
    evidence: |-
      src/hooks/useSlugTenants.ts's effect has an empty dependency array, so it loads once per
      mount. DW-87's fix makes the SESSION recover — the next cold caller re-fetches and caches
      a good map — but a component already mounted during the outage never re-reads it. Links
      still work through the 308 fallback, so the consequence is a stale wrong-handle hop on
      one component until it remounts, not breakage. The empty-dep mount effect pre-dates this
      story; DW-87 only changed what the cache holds.
    location: >-
      src/hooks/useSlugTenants.ts:56
    severity: low
---

<intent-contract>

## Intent

**Problem:** Five edges the owner-scoped-linking conversion missed. (DW-83) Five `MarkdownRenderer` call sites still render without `slugTenants`, so in-content `[x](slug.md)` links emit `DEFAULT_TENANT` hrefs and take a wrong-handle 308 hop — `QueryResultPanel.tsx:182` even holds `useSlugTenants()` at :43 already. (DW-84) `aliasRedirectForMissing` is wired only into the page-view route, so an old `/u/<handle>/<slug>/edit` or `/u/<handle>/raw/<slug>` bookmark for a merged-away slug hard-404s where the page URL forwards. (DW-85) The page-view miss branch returns JSX instead of calling `notFound()`, so dead slugs are indexable HTTP 200 pages. (DW-87) `loadSlugTenants` caches a non-OK response's empty map for the whole session while retrying a rejected fetch, so one transient 401/429/500 pins `DEFAULT_TENANT` links until reload. (DW-89) `resolveSlugPath` indexes the map with inherited-prototype lookup, so a page titled "Constructor" resolves to `Object.prototype.constructor` and `tenantSegment` throws a TypeError during render.

**Approach:** Plumb the already-existing slug→tenant map into each unconverted renderer — via `useSlugTenants()` in the client components, and via a readability-gated server-built map on the one server page. Factor the survivor lookup out of `aliasRedirectForMissing` into a shared `aliasTargetForMissing` returning `{tenant, canonical}` so the edit and raw routes forward to their OWN URL shape. Signal the page-view miss with `notFound()`. Stop caching the non-OK `{}`. Make the map lookup own-property-only and string-typed.

## Boundaries & Constraints

**Always:**
- The map handed to any client renderer must be readability-gated exactly as `/api/wiki/routes` is: never build a client-visible map from unfiltered `listWikiPages()`.
- Alias forwarding stays principal-aware and fail-closed everywhere it is added: forward only when the survivor exists AND `canReadFrontmatter(survivor, principal)` passes AND `canonical !== slug`; otherwise the route's existing miss behavior is unchanged.
- Each route forwards to its own surface: page → `pagePath`, edit → `editPath`, raw → `rawPath`. Never cross-forward a viewer from `/edit` to the read view.
- Forwarding must run before a route's handle-canonicalization redirect, so a miss lands on the survivor in ONE hop rather than bouncing through `DEFAULT_TENANT` first.
- `aliasRedirectForMissing`'s existing signature and behavior stay intact — the page route and `merge.test.ts` both depend on it.
- Fall back, never throw: a map value that is missing or not a string resolves through `fallbackTenant`.

**Block If:** Making any of these link surfaces canonical would require exposing slug→owner data beyond what readability-gated `/api/wiki/routes` (or its server-side equivalent over the same gate) already returns.

**Never:**
- Reintroduce any `/wiki/<slug>` surface or redirect target (AD-21 retirement stands).
- Change `resolveAlias` / alias-index semantics or its caching (that is a separate open ledger entry).
- Change `slugPath()`; it remains the documented no-resolver fallback.
- Convert the edit route's "nothing to edit" miss UI to `notFound()` — DW-85 scopes the 200→404 change to the page-view route, and the edit copy is surface-specific.
- Thread `owner` through ingest/import/action API payloads.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Query answer cites `[T](slug.md)`, map loaded | `QueryResultPanel` with `slugTenants = {slug: "alice"}` | anchor href is `/u/alice/slug` | No error expected |
| Same, map empty / unknown slug | `slugTenants = {}` | href is `/u/yopedia/slug`; the 308 lands it | No error expected |
| Log page rendered for a viewer | server map built from pages passing `canReadEntry` | in-content links use readable owners only; hidden slugs absent from the map | No error expected |
| Merged-away slug's edit bookmark | `/u/old/<alias>/edit`, alias → readable survivor of `alice` | 308 to `/u/alice/<canonical>/edit` | No error expected |
| Merged-away slug's raw bookmark | `/u/old/raw/<alias>`, same | 308 to `/u/alice/raw/<canonical>` | No error expected |
| Alias to a private survivor, anonymous | viewer cannot read survivor | unchanged miss behavior on every route (no redirect) | No redirect emitted |
| Existing-but-unreadable slug | `resolveAlias` returns the slug itself | unchanged miss behavior (self-redirect guarded) | No redirect emitted |
| Dead slug at the page URL | no page, no alias | `notFound()` → the sibling `not-found.tsx` at HTTP 404 | No error expected |
| `/api/wiki/routes` returns 500 once | first `loadSlugTenants()` sees `ok: false` | resolves `{}` WITHOUT caching; the next call re-fetches and caches a good map | Degrades to fallback hrefs meanwhile |
| Page titled "Constructor" | `slugTenants` lacks own key `constructor` | href is `/u/<fallbackTenant>/constructor` | No TypeError |

</intent-contract>

## Code Map

- `src/lib/links.ts:152-159` -- `resolveSlugPath(slug, slugTenants, fallbackTenant)`; the DW-89 defect is `slugTenants?.[slug] ?? fallbackTenant`. `tenantSegment` (:107) calls `.trim()`, which is what throws on an inherited function. `pagePath` :98, `editPath` :125, `rawPath` :134, `ownerToTenant` :80, `SlugTenantMap` :146.
- `src/hooks/useSlugTenants.ts:21-34` -- `loadSlugTenants`: the DW-87 asymmetry is `.then((r) => (r.ok ? r.json() : {}))` feeding the cache-assigning `.then`. Docstring at :10-20 already documents the asymmetry and must be rewritten. `hrefFromMap` :44, `useSlugTenants` :56 (returns `{hrefForSlug, slugTenants}`).
- `src/lib/page-redirect.ts:37-65` -- `aliasRedirectForMissing`; body is `resolveAlias` → `canonical !== slug` guard → survivor read → `canReadFrontmatter` → `pagePath(tenantForOwner(owner), canonical)`, all inside a fail-closed try/catch that `logger.warn`s. Split the `{tenant, canonical}` half out; keep this export as a wrapper.
- `src/app/u/[handle]/[slug]/page.tsx:76-90` -- miss branch: alias forward already wired at :80; the JSX return at :82-89 is the DW-85 defect. `notFound` is NOT yet imported (only `permanentRedirect`, :2). `not-found.tsx` sits beside it and renders the equivalent copy.
- `src/app/u/[handle]/[slug]/edit/page.tsx:23-32` -- miss branch returning the "nothing to edit" JSX; `principal` is in scope at :20; `editPath` already imported (:5). Handle-canonicalization 308 at :75-77.
- `src/app/u/[handle]/raw/[slug]/page.tsx:24-38` -- `canReadSlug` gate (:24), then `ownerPage` read (:30), then the handle 308 (:36). Alias forwarding must go between :30 and :36, keyed on `!ownerPage`, and must fall through to today's behavior when there is no target — a raw blob can outlive its page and `ownerPage` is `?.`-tolerant everywhere below. `notFound`/`permanentRedirect`/`rawPath` all already imported.
- `src/components/QueryResultPanel.tsx:43,182` -- already calls `useSlugTenants()` (only `hrefForSlug` destructured); :182 is the bare `MarkdownRenderer`. Also renders `SlidePreview` at :180.
- `src/components/SlidePreview.tsx:61,77` -- `"use client"`, two bare `MarkdownRenderer` calls. Rendered by `QueryResultPanel:180` and `ArticleView:417` (ArticleView already computes `slugTenants` via `buildSlugTenantMap`, server-side, and passes it to its own renderer at :420-425).
- `src/components/RawSourceBrowser.tsx:88-93` -- `"use client"`; module-level `RawContent({text})` helper holds the bare call.
- `src/components/AgentApiContent.tsx:45` -- `"use client"`, bare call.
- `src/app/wiki/log/page.tsx:13-47,66` -- server component; already awaits `getPrincipal()` and `listWikiPages()` INSIDE `if (raw)` and filters with `canReadEntry` to build `hidden`. Build the map from the complement of that same partition (one listing, one `canReadEntry` pass) and pass it to :66. `ownerToTenant` from `@/lib/links` is the client-safe tenant derivation (`src/app/api/wiki/routes/route.ts:17` uses exactly this pairing).
- `src/components/MarkdownRenderer.tsx:194-201` -- consumer: `tenant || slugTenants ? resolveSlugPath(slug, slugTenants, tenant ?? "") : slugPath(slug)`. Read-only.
- `vitest.config.ts` -- two projects: `node` (`src/**/__tests__/**/*.test.ts`) and `dom` (jsdom + `@testing-library/react`, `src/**/__tests__/**/*.test.tsx`). Mounted component tests ARE available now; `src/components/__tests__/lint-check-parity.test.tsx` is a representative example.
- Tests to extend: `src/lib/__tests__/links.test.ts:162-193` (`resolveSlugPath`), `src/hooks/__tests__/useSlugTenants.test.ts:30-87` (`loadSlugTenants` caching), `src/lib/__tests__/owner-page-route.test.ts` (route harness; `next/navigation` mock at :24-31 already stubs `notFound` to throw `"NOT_FOUND"`, and three tests currently assert the weaker `rejects.not.toThrow(/^REDIRECT:/)` because the miss branch used to render JSX), `src/lib/__tests__/merge.test.ts:300-393` (`aliasRedirectForMissing` cases).

## Tasks & Acceptance

**Execution:**
- `src/lib/links.ts` -- make `resolveSlugPath` read the map with `Object.prototype.hasOwnProperty.call` and accept the value only when `typeof === "string"`, else `fallbackTenant`; note in the docstring that the map is parsed response JSON so inherited members are not entries.
- `src/hooks/useSlugTenants.ts` -- throw on a non-OK response inside the fetch chain so it joins the existing `.catch` path: `{}` is returned but NOT cached, and the next caller retries. Rewrite the docstring — the two failure modes are now symmetric.
- `src/lib/page-redirect.ts` -- extract `aliasTargetForMissing(slug, principal): Promise<{tenant, canonical} | null>` carrying the whole gate (alias resolve, `canonical !== slug`, survivor exists, `canReadFrontmatter`, fail-closed try/catch + `logger.warn`); reduce `aliasRedirectForMissing` to `pagePath(target.tenant, target.canonical)` over it. Update the module header: three routes share the gate now.
- `src/app/u/[handle]/[slug]/page.tsx` -- import `notFound` from `next/navigation` and replace the miss branch's JSX return with `notFound()`; comment why (dead slugs must be 404, and `not-found.tsx` beside this file carries the copy).
- `src/app/u/[handle]/[slug]/edit/page.tsx` -- in the miss branch, `await aliasTargetForMissing(slug, principal)` and `permanentRedirect(editPath(target.tenant, target.canonical))` when non-null; otherwise the existing "nothing to edit" UI, unchanged.
- `src/app/u/[handle]/raw/[slug]/page.tsx` -- after the `ownerPage` read and BEFORE the handle-canonicalization 308, when `!ownerPage`, `await aliasTargetForMissing(slug, await-ed principal)` and `permanentRedirect(rawPath(target.tenant, target.canonical))` when non-null; fall through unchanged otherwise. Hoist the single `getPrincipal()` result so it is fetched once.
- `src/components/QueryResultPanel.tsx` -- destructure `slugTenants` from the existing `useSlugTenants()` and pass it to the `MarkdownRenderer` at :182 and to `SlidePreview`.
- `src/components/SlidePreview.tsx` -- accept an optional `slugTenants?: SlugTenantMap` prop and forward it to both `MarkdownRenderer` calls; `ArticleView` passes the server map it already holds, `QueryResultPanel` the hook's.
- `src/components/ArticleView.tsx` -- pass the `slugTenants` it already computes to its `SlidePreview` at :417.
- `src/components/RawSourceBrowser.tsx` -- call `useSlugTenants()` in the component and thread the map into `RawContent`, which forwards it to `MarkdownRenderer`.
- `src/components/AgentApiContent.tsx` -- call `useSlugTenants()` and pass `slugTenants` to its `MarkdownRenderer`.
- `src/app/wiki/log/page.tsx` -- partition the single `listWikiPages()` result once into readable/hidden with `canReadEntry`; build `slugTenants` from the readable half via `ownerToTenant` and pass it to the `MarkdownRenderer`; keep the existing redaction driven by the hidden half. Comment that the readability gate is what keeps a private slug→owner pairing off the client.
- `src/lib/__tests__/links.test.ts` -- add `resolveSlugPath` cases for every `Object.prototype` collision that matters (`constructor`, `toString`, `hasOwnProperty`) plus a non-string own value, asserting the fallback href and no throw.
- `src/hooks/__tests__/useSlugTenants.test.ts` -- add a case where the first fetch is non-OK and the second is OK: first call resolves `{}`, second resolves the real map, `fetch` called twice (pins that the empty map is no longer cached).
- `src/lib/__tests__/owner-page-route.test.ts` -- strengthen the three miss-path tests to assert `NOT_FOUND` explicitly instead of only "not a REDIRECT".
- `src/lib/__tests__/edit-raw-alias-forwarding.test.ts` -- new route-level suite modeled on `owner-page-route.test.ts` (same `next/navigation` + `@/lib/auth` mocks, same tmpdir seeding, `resetAliasIndex()` per test): merged-away slug 308s to `/u/<survivor-tenant>/<canonical>/edit` and to `/u/<survivor-tenant>/raw/<canonical>`; a private survivor forwards for its owner but not for an anonymous viewer on both routes; a missing slug with no alias keeps each route's pre-existing miss behavior.
- `src/components/__tests__/renderer-slug-tenant-adoption.test.tsx` -- new mounted (dom project) suite pinning the DW-83 adoption: with `/api/wiki/routes` stubbed to `{target: "alice"}`, `QueryResultPanel`, `SlidePreview`, `RawSourceBrowser` and `AgentApiContent` each render content containing `[T](target.md)` and produce an `/u/alice/target` anchor — so reverting any one call site fails.

**Acceptance Criteria:**
- Given the session map resolves `target → alice`, when any of the five previously-unconverted renderers renders `[T](target.md)`, then the anchor href is `/u/alice/target` and no `DEFAULT_TENANT` hop is emitted.
- Given a viewer who cannot read a private page, when the activity log renders, then that page's slug appears in neither the rendered log text nor the `slugTenants` map handed to the renderer.
- Given a slug merged into a survivor the viewer may read, when that slug is requested at the page, edit, or raw URL under any handle, then the browser lands on the survivor's equivalent URL after exactly one 308.
- Given a slug with no page and no readable alias, when the page URL is requested, then the response is an HTTP 404 rather than a 200 rendering "Page not found".
- Given any change in this spec, no surface emits or forwards to `/wiki/<slug>`.

## Spec Change Log

## Review Triage Log

### 2026-08-19 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 1, medium 1, low 4)
- defer: 4: (high 0, medium 0, low 4)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[high]` `[patch]` The `slugTenants` prop this change added to `SlidePreview` leaked private data: `ArticleView` is an async SERVER component holding the UNGATED `buildSlugTenantMap()` output, and `SlidePreview` is `"use client"`, so the prop serialized every private page's slug→owner pairing into the RSC payload of any legacy Marp-deck page — the exact leak this spec's own "Always" rule forbids. The prop is removed entirely; `SlidePreview` now calls `useSlugTenants()` itself (readability-gated, session-cached), `ArticleView` is back to unmodified, and a new test plus a `@ts-expect-error` pin that the component sources its own map and accepts none from a parent.
  - `[medium]` `[patch]` The raw route's new forwarding hid a still-present archive: a merge hard-deletes the absorbed page while `deleteWikiPage` deliberately keeps its `raw/` blob, so forwarding on `!ownerPage` alone put a 308 in front of the very file the route existed to serve. The forward is now gated on the blob being genuinely absent, read once and reused by the legacy branch below; a new test seeds a blob at the aliased slug and pins that the archive is served.
  - `[low]` `[patch]` `src/hooks/useSlugTenants.ts` cast the parsed body to `SlugTenantMap` unchecked — a JSON `null` cached falsy and re-fetched forever, an array or scalar was cached and handed to every renderer. The parsed value is now rejected unless it is a non-null, non-array object, joining the same uncached `.catch` as the other failure modes, with a covering `it.each`.
  - `[low]` `[patch]` The log page's gate comment claimed the map "reaches the client"; `MarkdownRenderer` carries no `"use client"` directive, so on that server-rendered path it does not. The gate is right and stays — the comment (and the matching test header and name) now give the reasons that actually hold.
  - `[low]` `[patch]` The DW-85 comment argued dead slugs "stayed indexable" and named crawlers, but `src/middleware.ts:140-145` stamps `X-Robots-Tag: noindex, nofollow, noarchive` on every response. Rewritten around what does hold: a 200 makes the status contradict the body, so link checkers, `fetch`/API clients and caches cannot tell a miss from a hit.
  - `[low]` `[patch]` Test hygiene in `renderer-slug-tenant-adoption.test.tsx`: a raw DOM `.click()` outside React's event system became `fireEvent.click`, and a `waitFor` wrapped around an already-waiting `findByRole` (stacking two timeouts on a real failure) was unwrapped.

## Design Notes

- `aliasTargetForMissing` returns the survivor's parts rather than a URL because the three routes need three different URL shapes; returning a page URL and rewriting it per route would put URL-shape knowledge in three places and risk cross-forwarding `/edit` to the read view.
- The raw route's forwarding sits before the handle 308 on purpose: a missing slug there resolves `pageTenant` to `DEFAULT_TENANT`, so a non-default handle would otherwise burn a hop redirecting to a URL that also 404s.
- The log page builds its map server-side from the readable half of a listing it already performs. Calling `buildSlugTenantMap()` would be shorter and wrong — it is ungated, and shipping it to the client would hand every viewer the private slug→owner pairs the redaction just removed.
- DW-87's fix deliberately reuses the existing `.catch` rather than adding a cooldown or retry counter: the goal is to make the two failure modes symmetric, not to introduce a retry policy the rejection path never had.

## Verification

**Commands:**
- `npm test` -- expected: all suites pass, both `node` and `dom` projects, including the two new suites.
- `npm run lint` -- expected: exit 0, no unused imports (pre-existing `jsx-ast-utils` warnings only).
- `npx tsc --noEmit` -- expected: no type errors.

## Auto Run Result

**Summary:** Closed the five deferred-work entries left by the owner-scoped-linking conversion. Every `MarkdownRenderer` call site in `src/` now receives a slug→tenant map, so in-content `[x](slug.md)` links emit the target's real owner instead of taking a `DEFAULT_TENANT` 308 hop (DW-83). The alias gate was factored into `aliasTargetForMissing`, returning the survivor's `{tenant, canonical}` parts so the page, edit and raw routes each forward a merged-away bookmark to their OWN surface (DW-84). The page-view miss now signals `notFound()` instead of rendering a 200 body (DW-85). `loadSlugTenants` no longer caches a failed response's empty map (DW-87), and `resolveSlugPath` reads the map own-property-only and string-typed, so a page titled "Constructor" cannot resolve through `Object.prototype` (DW-89).

**Files changed:**
- `src/lib/links.ts` — `resolveSlugPath` uses `hasOwnProperty.call` + a `typeof === "string"` check; falls back rather than throwing.
- `src/hooks/useSlugTenants.ts` — a non-OK response and a malformed body both throw into the shared `.catch`, so no failure caches; all three failure modes symmetric.
- `src/lib/page-redirect.ts` — new `aliasTargetForMissing` carrying the whole principal-aware, fail-closed gate; `aliasRedirectForMissing` reduced to its page-shaped wrapper (signature unchanged).
- `src/app/u/[handle]/[slug]/page.tsx` — miss branch calls `notFound()`; the sibling `not-found.tsx` renders the body.
- `src/app/u/[handle]/[slug]/edit/page.tsx` — miss branch forwards to `editPath(...)` before falling back to its unchanged "nothing to edit" copy.
- `src/app/u/[handle]/raw/[slug]/page.tsx` — forwards to `rawPath(...)` before the handle 308, but only when no raw blob survives at the old slug; the blob is read once and shared with the legacy branch.
- `src/app/wiki/log/page.tsx` — builds a `canReadEntry`-gated map from the readable half of the listing the redaction already partitions.
- `src/components/QueryResultPanel.tsx`, `SlidePreview.tsx`, `RawSourceBrowser.tsx`, `AgentApiContent.tsx` — each hands its `MarkdownRenderer` a gated map; `SlidePreview` sources its own via the hook and deliberately exposes no prop.
- `src/lib/__tests__/links.test.ts`, `src/hooks/__tests__/useSlugTenants.test.ts`, `src/lib/__tests__/owner-page-route.test.ts` — extended; the three page-route miss tests now assert `NOT_FOUND` by name instead of "not a REDIRECT", which the old 200 also satisfied.
- `src/lib/__tests__/edit-raw-alias-forwarding.test.ts` (new) — route-level forwarding on both surfaces, private-survivor owner vs. anonymous, self-alias guards, and the surviving-blob case.
- `src/components/__tests__/renderer-slug-tenant-adoption.test.tsx` (new) — mounted, asserting rendered hrefs for every converted renderer plus the empty-map fallback.
- `src/app/wiki/log/__tests__/log-slug-tenant-gate.test.tsx` (new) — the log page's map carries only readable pages (asserted on the map, not the markup, since a hidden slug's absence from the DOM only proves the redaction worked).

**Review findings breakdown:** patch 6 (1 high, 1 medium, 4 low — all fixed), defer 4 (all low, all pre-existing or out of the intent's scope: the edit route's 200 miss, `tenantForSlug`'s prototype indexing, the JSON API surfaces' lack of forwarding, and the hook's absent post-mount refresh), reject 12 (noise: design-taste items, pre-existing costs the change did not add, the orchestrator-owned ledger, and readings the intent already settled).

**Follow-up review recommendation:** patched this pass: 1 high + 1 medium + 4 low → a `high` was patched → `followup_review_recommended: true`.

**Verification:** `npm test` — 234 files, 4871 tests, all pass (node + dom projects). `npx tsc --noEmit` — clean. `npm run lint` — exit 0 (pre-existing `jsx-ast-utils` `TSNonNullExpression` warnings only). Matrix audit: all ten I/O rows have a covering test that ran and passed; two rows (the empty-map renderer fallback and the log page's gated map) had no coverage after the first implementation pass and were closed with new tests, the log one mutation-checked by removing the gate.

**Residual risks:**
- `SlidePreview`'s "takes no map from its parent" pin is a `@ts-expect-error`, so it holds only while `npx tsc --noEmit` covers test files. A runtime assertion cannot see a prop that silently starts working again.
- `ArticleView` still hands its ungated `buildSlugTenantMap()` output to a server-rendered `MarkdownRenderer`. That is safe today precisely because `MarkdownRenderer` has no `"use client"` directive — adding one would turn it into the leak this pass removed, and nothing enforces that.
- With `/api/wiki/routes` failing persistently, the removed failure cache means one request per cold caller instead of one per session. Bounded (mount-time only, links still work through the 308) and the direct consequence of the retry direction DW-87 asked for.
