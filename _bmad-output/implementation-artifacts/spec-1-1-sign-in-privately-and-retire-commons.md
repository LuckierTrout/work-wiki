---
title: 'Story 1.1: Sign in privately and retire commons'
type: 'feature'
created: '2026-08-14'
status: 'done'
baseline_revision: '893d23e145c29bbe551ecbae61443694884205fc'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      The CLI still exposes a publish-to-commons command after the REST route and
      the MCP tool were retired.
    evidence: |-
      `src/cli.ts` keeps `publish <slug> --agent <id>` calling `publishToCommons`
      (`src/lib/publish.ts`), and `src/lib/__tests__/cli.test.ts` still asserts the
      promotion end to end. The intent names routes and the MCP tool list, not the
      owner-local CLI, so it was left alone; it now writes into an index nothing
      reads.
    location: >-
      src/cli.ts
    severity: low
  - summary: >-
      slugPath() addresses every slug-only link through the default tenant, so the
      URL names the wrong handle until the owner route redirects it.
    evidence: |-
      `slugPath()` hard-codes `DEFAULT_TENANT` and leans on the 308 in
      `src/app/u/[handle]/[slug]/page.tsx`. Call sites such as RecentIngests,
      VaultExplorer, ChatWorkspace, ActionInbox, BulkDocumentImport and
      KnowledgeStudio already hold (or can fetch) the real owner, so each of those
      links costs a redirect hop and shows a misleading handle in the address bar
      and in link previews.
    location: >-
      src/lib/links.ts
    severity: medium
  - summary: >-
      Alias forwarding for merged or renamed slugs disappeared with the retired
      commons URL and was never rebuilt on the owner-scoped URL.
    evidence: |-
      `commonsRedirectForMissing` resolved an absorbed slug to its survivor and
      308'd to `/wiki/<canonical>`; it now returns null unconditionally. Its only
      caller was the retired page, so nothing regressed at that URL — but a
      wikilink to a merged-away slug now resolves through `slugPath()` to
      `/u/<tenant>/<old-slug>`, which 404s. `resolveAlias` has no routing caller.
    location: >-
      src/lib/page-redirect.ts
    severity: medium
  - summary: >-
      The zh-CN translation catalog has stale keys and still spells the old brand.
    evidence: |-
      `src/lib/i18n.ts` keys on exact English source strings, so the renamed chrome
      labels ("The commons", "What is WorkWiki", "Browse all") no longer match and
      silently fall back to English; keys for deleted UI (Browse, Join waitlist,
      Contributors, Mobile navigation) are now unreachable; and line 43 still ships
      "WorkWiki" as rendered copy. The spec forbids i18n work in this story, and the
      recorded user preference is English-only, so the whole module is a later cut.
    location: >-
      src/lib/i18n.ts
    severity: medium
  - summary: >-
      Reconcile-from-talk plumbing and the discussion lint checks outlive the talk
      surface they point at.
    evidence: |-
      `/api/tasks/run` still dispatches `reconcile`/`maintain:reconcile` through
      `reconcileFromTalk`, the `reconcile_page` MCP tool remains, and
      `checkUnresolvedDiscussions` / `checkDisputedPages` still emit warnings whose
      remediation surface now 404s. Harmless while no surface can create a thread,
      but it is dead machinery.
    location: >-
      src/lib/reconcile.ts, src/lib/lint-checks.ts
    severity: low
  - summary: >-
      ArticleActions still branches on the commons realm.
    evidence: |-
      `src/components/ArticleActions.tsx` keeps `isCommonsPage` gating for Delete and
      "Save to vault", and `ArticleView` computes and threads the flag purely to feed
      it. Changing delete authorization was out of this story's scope, so the realm
      model survives with no commons behind it.
    location: >-
      src/components/ArticleActions.tsx
    severity: low
  - summary: >-
      canWritePage's commons-realm rule lost its escape hatch when talk was retired.
    evidence: |-
      `src/lib/authz.ts` still denies `body` and `delete` writes on any public
      non-agent page to non-admin principals, justified in-comment by humans steering
      through metadata patches and talk threads. The edit page's copy is now a bare
      "You don't have write access to this page" with nowhere to go.
    location: >-
      src/lib/authz.ts
    severity: low
  - summary: >-
      The contributor capability is retired at every page and REST surface but
      still ships as two MCP tools.
    evidence: |-
      `/wiki/contributors`, `/api/contributors` and `/api/contributors/[handle]`
      all 404, and `/u/<handle>` is gone — but `list_contributors` and
      `get_contributor` remain registered in `src/lib/mcp-http.ts` and `mcp.json`,
      and `mcp-http.test.ts` was updated to keep them passing. They are read-only
      and bearer-gated, so nothing leaks in a single-owner deployment; whether the
      capability should survive at MCP after being cut everywhere else is a
      product call, not a defect.
    location: >-
      src/lib/mcp-http.ts
    severity: low
  - summary: >-
      Middleware still exempts the retired publish route as an in-route-auth path.
    evidence: |-
      `src/middleware.ts` keeps `AGENT_PUBLISH_RE` and documents
      `/api/agents/<id>/publish` as "the agent's own per-agent token" in its header
      comment, though the handler is now `retiredRoute()` and inspects nothing.
      Harmless (the request 404s), but the exemption cannot be removed here:
      `middleware-write-gate.test.ts:39` pins it, and this story's constraints
      forbid changing that suite's behavior.
    location: >-
      src/middleware.ts:73
    severity: low
  - summary: >-
      Maintainer-facing files still carry the old brand after the display rename.
    evidence: |-
      `tools/workwiki-sync.mjs`, `tools/WORKWIKI_SYNC.md`, `BACKLOG.md`,
      `docs/llm-wiki-functional-parity-roadmap.md` and
      `workers/sandbox-runner/README.md` still say "WorkWiki". None of it is
      rendered product copy — the intent's rename targets user-visible surfaces —
      and one of them is a filename, so renaming is a separate, wider cut.
    location: >-
      tools/workwiki-sync.mjs
    severity: low
  - summary: >-
      Every owner-only page renders a second `<main>` landmark inside the one
      `SiteChrome` already provides.
    evidence: |-
      `SiteChrome` wraps all children in `<main id="main-content">`, and the
      signed-out branch of nine pages returns `PrivateWorkspaceNotice`, whose
      root element is another `<main>`. The nesting predates this story — the
      baseline `chat/page.tsx` had the same `<main className="shell fade">` — so
      the refactor into one component inherited it rather than causing it. It is
      a duplicate-landmark violation in a component whose own docstring cites
      WCAG 2.2 AA, and the same pattern appears on `settings`, `query` and other
      signed-in pages, so the fix is a chrome-wide sweep, not a one-file edit.
    location: >-
      src/components/PrivateWorkspaceNotice.tsx
    severity: low
  - summary: >-
      The email-ingest worker's attachment-forwarding path has no test, so its
      byte-copy could silently forward empty files.
    evidence: |-
      `workers/email-ingest/index.ts:239` copies attachment bytes into a fresh
      `Uint8Array` before wrapping them in a `Blob` for the `attachments`
      FormData part. `email-ingest-worker.test.ts` is the only test that imports
      the worker, and its fixture is a plain-text message with no attachment;
      both cases assert only on `msg.reply`'s text. Zeroing the copy would still
      produce a correctly-sized buffer, a `{ ok: true, slug }` response and the
      same acknowledgement email, so every emailed PDF/DOCX would ingest empty
      with the suite green. The attachment path is pre-existing; this story only
      fixed a type error on that line.
    location: >-
      workers/email-ingest/index.ts:239
    severity: low
---

<intent-contract>

## Intent

**Problem:** The app is a fork of the public "yopedia" commons product. Edge auth is already owner-only, but the commons product surface (public browse, commons page URLs, public profiles/share, waitlist, talk, publish-to-commons, a paid-plan gate on private pages) is still live behind that gate, `syncCommonsForPage` still writes a commons index, MCP dispatch gates only writes, and user-visible copy still says "WorkWiki"/"Yopedia".

**Approach:** Retire the commons product surface — every route FR-1 names returns 404, `syncCommonsForPage` becomes a no-op, publish-to-commons leaves the MCP tool list, and the paid-plan gate on private pages is removed. Harden MCP dispatch so reads also require a principal. Rename user-visible copy to `work-wiki` while leaving every runtime identifier on `yopedia`. Remove nav/CTA links and the alternate mobile IA that point at retired routes.

## Boundaries & Constraints

**Always:**
- Runtime identifiers stay `yopedia` (AD-7): `DEFAULT_TENANT`, `BASE_AGENT_OWNER`, `AUTOMATION_ACTORS`, MCP `serverInfo.name`, `localStorage` keys, `X-Yopedia-*` headers, `YOPEDIA_*` env/secret names, every resource name in all `wrangler.jsonc` files, and the `yopedia--yoyo` agent-id examples in `public/agent-api.md`.
- Retire by making the route return 404 — do not delete the underlying `src/lib/` modules. Module files may remain with zero reachable callers (AD-21).
- Route every retired page/handler through one shared helper so the retired list is a single enumerable source of truth.
- Every retired route loses its inbound links (nav, footer, mobile dock, signed-out CTAs, article badges) in the same change — no link may point at a 404.
- Preserve `src/lib/__tests__/middleware-write-gate.test.ts` and `read-isolation.test.ts` behavior: the edge gate must keep working exactly as it does.

**Block If:**
- Removing a commons surface would also remove the owner's own page-view path (`/u/[handle]/[slug]`, `/u/[handle]/raw/[slug]`) — those stay reachable.

**Never:**
- Do not build `/api/v1`, the sidecar 503 `sidecar_required` contract, the icon rail, or sidecar-down Chat copy — those are Stories 1.3 and 3.1.
- Do not touch `llm-wiki.md`, `.github/`, or `.yoyo/yoyo.toml`.
- Do not rename `/api/query`, `/api/chat/*`, or Worker chat internals — Story 3.1 owns that cut.
- Do not add i18n/locale work; English-only stands.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unauthenticated page | `GET /knowledge`, no Clerk session | 307 redirect to `/sign-in` (unchanged) | No error expected |
| Unauthenticated API | `GET /api/knowledge`, no session | 401 JSON (unchanged) | No error expected |
| Unauthenticated MCP read | `tools/call` `read_page`, `principal = null` | Tool result `isError: true`, "Authentication required" — read is not served | Never returns page content |
| Owner hits retired page | Signed-in owner `GET /wiki`, `/wiki/spec`, `/wiki/contributors`, `/waitlist`, `/share/h/s`, `/u/h`, `/u/h/a/bot` | 404 | No error expected |
| Owner hits retired API | Signed-in owner `GET /api/wiki/browse`, `/api/contributors`, `/api/query/demo`, `POST /api/agents/x/publish`, any `/api/wiki/:slug/discuss/**` | 404 with no body side effects | No error expected |
| Commons sync after write | `syncCommonsForPage("x", { visibility: "public", ... })` | Resolves; commons index unread and unwritten | Never throws |
| Owner sets page private | `patchPageMetadata` with `visibility: "private"`, owner principal, no Clerk `plan` | Succeeds — no `PLAN_REQUIRED` | Non-owner still `NOT_OWNER` |
| Brand copy | Root layout metadata, manifest, worker email bodies | Renders `work-wiki` | No "Yopedia"/"WorkWiki" in user-visible copy |

</intent-contract>

## Code Map

**Edge gate (read-only reference — do not regress):**
- `src/middleware.ts:154-197` -- `clerkMiddleware`; anon API 401 / page redirect (:173,:178), non-owner 403/404 (:190-194), `YOPEDIA_OWNER_USER_ID` missing → 503 (:183). `SIGN_IN_RE` :114 is the only public path set. Already satisfies AC1's page/API halves.
- `src/lib/__tests__/middleware-write-gate.test.ts`, `src/lib/__tests__/read-isolation.test.ts` -- existing proof; keep green.

**MCP read gate:**
- `src/lib/mcp-http.ts:1105` `dispatchMcp`, gate at `:1150-1157` -- gates `tool.write` only; reads served with a null principal. Add the read gate here.
- `src/lib/mcp-http.ts:435-455` -- `publish_to_commons` tool entry; remove from `MCP_TOOLS`.
- `src/app/api/mcp/route.ts:55-95` -- bearer-only `resolvePrincipal`, 401 when absent (outer gate, unchanged).
- `src/mcp.ts` -- stdio server with its own tool impls; does **not** call `dispatchMcp`. Only edit: drop its `publish_to_commons` wiring at `:103,:1004`.

**Commons surface to retire:**
- Pages: `src/app/wiki/page.tsx:6`, `src/app/wiki/[slug]/page.tsx:39`, `src/app/wiki/contributors/page.tsx:18`, `src/app/waitlist/[[...waitlist]]/page.tsx:22`, `src/app/share/[handle]/[slug]/page.tsx` (+ its `opengraph-image.tsx`), `src/app/u/[handle]/page.tsx`, `src/app/u/[handle]/a/[agent]/page.tsx`.
- Handlers: `src/app/api/wiki/browse/route.ts:22`, `src/app/api/contributors/route.ts:15`, `src/app/api/contributors/[handle]/route.ts:16`, `src/app/api/query/demo/route.ts:19-23` (explicitly no-auth today), `src/app/api/agents/[id]/publish/route.ts:23`, and the four talk handlers under `src/app/api/wiki/[slug]/discuss/` (`route.ts`, `[threadIndex]/route.ts`, `[threadIndex]/comments/route.ts`, `[threadIndex]/ask-yoyo/route.ts`).
- KEEP reachable: `src/app/u/[handle]/[slug]/page.tsx` (owner page view — but drop its 308 → `/wiki/<slug>` at `:12`), `src/app/u/[handle]/raw/[slug]/page.tsx`, `src/app/wiki/log`, `src/app/wiki/graph`, `src/app/wiki/new`, `/studio`, `/agents`, `/about`.

**Commons machinery:**
- `src/lib/commons.ts:180-209` `syncCommonsForPage` -- sole production caller `src/lib/lifecycle.ts:404` (import `:29`, try/catch `:418-420`). Make the function body a no-op; leave the call site.
- `src/lib/authz.ts:236` `hasPaidPlan`, `:250` `canSetPrivate` -- billing gate; `canSetPrivate` must return true for any non-null principal.
- `src/lib/patch-metadata.ts:108-123` -- `PLAN_REQUIRED` throw driven by `canSetPrivate`.
- `src/lib/page-redirect.ts:33-37` `commonsRedirectForMissing` -- stops forwarding to a retired URL.
- `src/lib/share-url.ts:17-21`, `src/lib/links.ts:97` `commonsPath`, `:121` `sharePath` -- URL builders that must stop emitting retired paths.

**Inbound links to remove:**
- `src/components/NavHeader.tsx:19,28,30,152,178,188,374`; `src/components/Footer.tsx:12,21,28`; `src/components/MobileNavigationDock.tsx:8` (the alternate mobile IA); `src/components/SharePageButton.tsx:8`; `src/components/ArticleView.tsx:165,315-320` (commons badge / profile link, `DiscussionPanel` mount); `src/components/ArticleActions.tsx:20-43`.
- Signed-out waitlist CTA branches: `src/app/chat/page.tsx:20`, `src/app/knowledge/page.tsx:20`, `src/app/monitors/page.tsx:20`, `src/app/integrations/page.tsx:20`, `src/app/review/page.tsx:30`, `src/app/system/page.tsx:20`, `src/app/tasks/page.tsx:18`, `src/app/vault/page.tsx:49`, `src/app/agents/page.tsx:50`, `src/components/HomeAsk.tsx:256,287`.

**Brand copy (display only):**
- `src/lib/brand.ts:1` `APP_NAME` -- single source of truth; consumed by `src/app/layout.tsx:38-55`, `src/app/manifest.ts:17-19`, `src/app/opengraph-image.tsx:8,38`, `src/components/Logo.tsx:87`.
- Hardcoded `"WorkWiki"` in per-route metadata: `src/app/about/page.tsx:6,8`, `src/app/save/page.tsx:7,8`, `src/app/studio/page.tsx:7`, `src/app/agent-api/page.tsx:8,10`, `src/app/robots.ts:3`.
- "Yopedia" in user-facing worker email copy: `workers/email-ingest/index.ts:113,117,126,136,140,151,162,175,189,201,202,275,279`; `workers/task-consumer/index.ts:83,111,125,177,194`.
- `src/components/Logo 2.tsx` -- dead file rendering a `yopedia` wordmark; zero importers. Delete.
- Do **not** touch: `src/lib/links.ts:64`, `src/lib/agents.ts:96`, `src/lib/agent-handle.ts:33`, `src/lib/mcp-http.ts:87`, `src/mcp.ts:1646`, `mcp.json:2`, `src/lib/recent-ingests.ts:8`, `src/components/HomeAsk.tsx:26`, `src/components/IntegrationDesk.tsx:117`, any `YOPEDIA_*` env read, any `wrangler.jsonc`, worker `Env` interfaces, `X-Yopedia-*` headers, worker health-check bodies.

**Tests that encode retired behavior and must be updated, not deleted:**
- `src/lib/__tests__/commons.test.ts` (sync transitions), `publish.test.ts`, `agent-publish-route.test.ts`, `browse.test.ts`, `browse-route.test.ts`, `browse-explorer-view.test.ts`, `talk.test.ts`, `discuss-route.test.ts`, `discuss-stats-index.test.ts`, `ask-yoyo-route.test.ts`, `contributors.test.ts`, `contributor-index.test.ts`, `share-url.test.ts`, `query-demo.test.ts`, `links.test.ts`, `wiki-routes.test.ts`, `lifecycle.test.ts`, `mcp-http.test.ts`, `mcp.test.ts`, `cli.test.ts:1220-1239`.
- Identifier-pinning tests that must stay green unchanged: `links.test.ts:118-131,185-186`, `agent-handle.test.ts:10,13,23`, `agents.test.ts:1085+`, `tasks-route.test.ts:161-195`, `sandbox-service.test.ts:48`, `task-consumer.test.ts:12,29`.

## Tasks & Acceptance

**Execution:**
- `src/lib/retired.ts` -- new: export `RETIRED_SURFACES` (the enumerated path list) plus `retiredPage()` (calls `notFound()`) and `retiredRoute()` (returns `new Response(null, { status: 404 })`) -- one enumerable source of truth so a test can assert the whole cut list.
- `src/app/wiki/page.tsx`, `src/app/wiki/[slug]/page.tsx`, `src/app/wiki/contributors/page.tsx`, `src/app/waitlist/[[...waitlist]]/page.tsx`, `src/app/share/[handle]/[slug]/page.tsx` (+ `opengraph-image.tsx`), `src/app/u/[handle]/page.tsx`, `src/app/u/[handle]/a/[agent]/page.tsx` -- replace each body with `retiredPage()` -- FR-1 says these 404.
- `src/app/api/wiki/browse/route.ts`, `src/app/api/contributors/route.ts`, `src/app/api/contributors/[handle]/route.ts`, `src/app/api/query/demo/route.ts`, `src/app/api/agents/[id]/publish/route.ts`, `src/app/api/wiki/[slug]/discuss/**/route.ts` -- replace each exported method with `retiredRoute()` -- retires public browse, contributors, the no-auth demo, publish-to-commons, and talk.
- `src/app/u/[handle]/[slug]/page.tsx` -- drop the 308 redirect to `/wiki/<slug>` -- the target now 404s; the owner must still read the page here.
- `src/lib/page-redirect.ts` -- stop returning commons redirects -- same reason.
- `src/lib/commons.ts` -- make `syncCommonsForPage` an awaited no-op that keeps its signature and never throws -- AD-21; `src/lib/lifecycle.ts:404` keeps calling it.
- `src/lib/authz.ts` -- `canSetPrivate` returns true for any non-null principal; delete `hasPaidPlan` and its only consumer path -- billing is retired, and private must not need a plan.
- `src/lib/patch-metadata.ts` -- remove the `PLAN_REQUIRED` branch, keep the `NOT_OWNER` check -- private stays owner-only, just not paid.
- `src/lib/mcp-http.ts` -- gate every `tools/call` on a non-null principal (reads included) and drop `publish_to_commons` from `MCP_TOOLS` -- AD-8 unauthenticated-read leftover; AD-21 tool-list cut.
- `src/mcp.ts` -- remove the `publish_to_commons` tool wiring only -- stdio server keeps `serverInfo.name: "yopedia"`.
- `src/lib/links.ts`, `src/lib/share-url.ts` -- stop emitting `/wiki/<slug>` and `/share/...`; resolve to the owner-scoped `/u/<tenant>/<slug>` path -- no link may target a 404.
- `src/components/NavHeader.tsx`, `src/components/Footer.tsx`, `src/components/MobileNavigationDock.tsx`, `src/components/SharePageButton.tsx`, `src/components/ArticleView.tsx`, `src/components/ArticleActions.tsx` -- remove links/badges/panels targeting retired routes; remove the mobile dock as an alternate IA -- AC2 and AC3.
- `src/app/{chat,knowledge,monitors,integrations,review,system,tasks,vault,agents}/page.tsx`, `src/components/HomeAsk.tsx` -- remove signed-out marketing/waitlist branches -- middleware makes them unreachable and they link to a retired route.
- `src/lib/brand.ts` -- `APP_NAME = "work-wiki"`; keep `APP_TAGLINE` -- AC2 and AD-7 both name `work-wiki` as the display form.
- `src/app/about/page.tsx`, `src/app/save/page.tsx`, `src/app/studio/page.tsx`, `src/app/agent-api/page.tsx`, `src/app/robots.ts` -- replace hardcoded `"WorkWiki"` with `APP_NAME` -- one display name, one source.
- `workers/email-ingest/index.ts`, `workers/task-consumer/index.ts` -- replace user-facing "Yopedia" in bounce/status email copy with `work-wiki`; leave `Env` bindings, `X-Yopedia-*` headers, and health-check bodies untouched -- display-only rename.
- `src/components/Logo 2.tsx` -- delete -- dead file, zero importers, hardcoded `yopedia` wordmark.
- `src/lib/__tests__/retired-surfaces.test.ts` -- new: assert every entry in `RETIRED_SURFACES` resolves to a 404 handler/page, that `syncCommonsForPage` performs no storage I/O, that `canSetPrivate` no longer consults a plan, and that `dispatchMcp` refuses a read tool with a null principal -- covers the I/O matrix rows.
- `src/lib/__tests__/brand-copy.test.ts` -- new: assert `APP_NAME === "work-wiki"`, that the manifest and root-layout metadata interpolate it rather than hardcoding a second string, that no file under `src/app` or `src/components` says "WorkWiki", and that every remaining `yopedia` under `src/` matches a runtime-identifier pattern -- covers the brand-copy matrix row.
- Existing test files listed in the Code Map -- rewrite the commons/talk/browse/publish/demo expectations to the retired behavior; delete only assertions whose subject no longer exists -- keep identifier-pinning tests untouched.

**Acceptance Criteria:**
- Given a signed-in owner on a phone or a second Clerk browser, when they load the app, then tree, Preview, and search surfaces are reachable and no device-specific alternate navigation exists (AC3's in-scope half; the sidecar 503 contract is Story 3.1's).
- Given the full test suite, when it runs, then no test asserts that a runtime `yopedia` identifier changed, and `pnpm test` passes.
- Given a grep of user-visible copy, when it runs, then no rendered string says "Yopedia" or "WorkWiki".

## Review Triage Log

### 2026-08-14 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 15: (high 3, medium 8, low 4)
- defer: 7: (high 0, medium 3, low 4)
- reject: 7
- addressed_findings:
  - `[high]` `[patch]` `workers/task-consumer/index.ts` renamed the wire header to `X-work-wiki-Queue-Attempt` while `/api/tasks/run` still read `X-Yopedia-Queue-Attempt`, silently defaulting every retry to attempt 1 and disabling the terminal-failure branch — a direct violation of the spec's "never rename `X-Yopedia-*`" rule. Restored the header and pinned both sides in `brand-copy.test.ts`.
  - `[high]` `[patch]` Both worker receipt emails still linked the retired `/wiki/<slug>`, handing every email-ingest user a 404; `task-consumer.test.ts` pinned that URL so it passed. Switched to the owner-scoped form and updated the assertion.
  - `[high]` `[patch]` `listCommonsPages()` preferred the stored commons index, which the no-op `syncCommonsForPage` can no longer refresh while deletes still shrink it — freezing `/wiki/graph`, `/wiki/log`, unscoped MCP `wiki_graph`, and search on a stale page set. It now always derives from the live wiki index.
  - `[medium]` `[patch]` `HomeAsk` still fetched the retired `/api/query/demo`; the bodiless 404 made `res.json()` throw before the error branch. Demo path removed.
  - `[medium]` `[patch]` `AuthorBadges` and `ContributorBadge` still fetched the retired `/api/contributors*`. Fetches removed; the orphaned badge component deleted.
  - `[medium]` `[patch]` `/wiki/[slug]/edit` still served a live 308 inside the retired namespace. Retired and added to `RETIRED_SURFACES`.
  - `[medium]` `[patch]` Talk was retired at REST and UI but its five MCP tools survived, letting agents create threads no surface can display. Removed from `mcp-http.ts`, `src/mcp.ts`, and `mcp.json`, with the affected suites updated.
  - `[medium]` `[patch]` `brand-copy.test.ts` scanned only `src/app` and `src/components` — the exact blind spot the header rename slipped through. Extended to `workers/`, `src/mcp.ts`, and `src/middleware.ts`, with `src/lib/i18n.ts` exempted by path rather than by widening the allowlist.
  - `[medium]` `[patch]` `retired-surfaces.test.ts` checked `RETIRED_SURFACES` against a second hand-written list in the same file. It now derives the expected set by walking `src/app` for modules importing `@/lib/retired`.
  - `[medium]` `[patch]` Thirteen user-visible strings still promised a live public commons (Save capture/guide, query placeholder and explainer, ingest, about, vault, onboarding, vault picker, graph aria-label). Reworded to the private wiki; the `disputed` banner no longer points at the deleted discussion surface.
  - `[medium]` `[patch]` AC3 had no test. Added `single-ia.test.ts`: no device-specific navigation, no mobile-only CSS hooks, no user-agent layout branch, non-sidecar surfaces on the shared route tree.
  - `[low]` `[patch]` Stale comments describing the removed `waitlistUrl` prop and a `/wiki/<slug>` 308 fallback.
  - `[low]` `[patch]` Nine signed-out branches were verbatim copies of a headingless `<p>`. Factored into `PrivateWorkspaceNotice` with a real `<h1>`.
  - `[low]` `[patch]` Removed ~960 lines of dead `.browse-explorer-*` / `.browse-lineage-*` CSS and the components orphaned by the deleted `DiscussionPanel` (`ThreadForm`, `ThreadView`, `CommentNode`, `RemoveFromVaultButton`).
  - `[low]` `[patch]` `pagePath`/`resolveSlugPath` could emit `/u//<slug>` when a caller lost its tenant. Both now fall back to `DEFAULT_TENANT`, with a test.

Rejected as noise: gating `initialize`/`tools/list` on a principal (the HTTP route 401s first); the now-callerless `canSetPrivate` export; service principals gaining a private-visibility entitlement in a single-owner deployment; three tautological spy assertions in the retired-route tests; the orphaned `/api/wiki/[slug]/lineage` route; a slug double-encoding nit in `KnowledgeStudio`; and the claim that dropping `commonsRedirectForMissing` regressed owner navigation (its only caller was the retired page — the real residue is deferred instead).

Note on routing: three findings (the frozen commons index, the surviving MCP talk tools, the un-enumerated commons copy) trace to gaps in this spec's own Code Map rather than to the implementation. They were routed to `patch` rather than `bad_spec` because each has a bounded, unambiguous correct form; a `bad_spec` loopback would have reverted 142 correct files to re-derive them.

### 2026-08-14 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 4, low 6)
- defer: 3: (high 0, medium 0, low 3)
- reject: 20
- addressed_findings:
  - `[medium]` `[patch]` `public/agent-api.md` §4 was rewritten to say reads now require a token ("Send the token on every request"), but its three read examples and the §6 `initialize` handshake still omit `-H "Authorization: Bearer $YOYO_TOKEN"` — every one of them 401s if copy-pasted, and the page is served to users at `/agent-api`. Header added to all four.
  - `[medium]` `[patch]` The browser clipper — shipped extension UI outside the Next tree — still rendered "WorkWiki" in its popup title/heading/help text, extension name, description, toolbar tooltip and context-menu item. Renamed to `work-wiki`, leaving the `workwiki.app` host, the `save-to-workwiki` menu id and the `workwikiDefaultTags` storage key as identifiers; `brand-copy.test.ts` now scans `integrations/` so the blind spot closes.
  - `[medium]` `[patch]` The `/u/<handle>/<slug>` "handle ≠ page tenant → 308" branch became load-bearing in this cut — `slugPath()` addresses every slug-only link through `DEFAULT_TENANT` and both workers inline the same shape — yet every test asserted only the string those callers build, never the route that makes it resolve. Added `owner-page-route.test.ts` covering the default-tenant and agent-owned redirects plus the no-redirect path.
  - `[medium]` `[patch]` The email-ingest acknowledgement's page link (moved off the retired `/wiki/<slug>` in this story) had no test at all, while the identical task-consumer link is pinned twice; a regression would ship green. Added `email-ingest-worker.test.ts` (mutation-checked: restoring `/wiki/<slug>` fails it). Importing the worker pulled it into the `tsc` graph for the first time and surfaced a pre-existing `Blob`/`Uint8Array` type error at `workers/email-ingest/index.ts:239`, fixed so `tsc --noEmit` stays clean.
  - `[low]` `[patch]` Six tools were removed (49 → 43) but the count stayed hand-written and stale in `src/lib/mcp-http.ts` and `public/agent-api.md` ("48 tools"). Both corrected and pinned in `mcp-annotations.test.ts` against the real registration count rather than another literal.
  - `[low]` `[patch]` `SERVER_INSTRUCTIONS` still told every agent "Contradictions are tracked and resolved through talk pages" after talk was retired. Reworded to the `disputed` flag and `lint_wiki`.
  - `[low]` `[patch]` `src/lib/commons.ts`'s module doc still claimed the index is "maintained on the write/delete path" — the exact opposite of what the no-op `syncCommonsForPage` made true. Rewritten to describe the retired state.
  - `[low]` `[patch]` `src/components/UserLink.tsx` kept `void isAgentHandle(handle);` purely to justify an import. Call and import removed.
  - `[low]` `[patch]` Seven components were orphaned when `/wiki` and `/u/<handle>` were retired (`Trail`, `FeaturedArtifacts`, `ProfileBlogIndex`, the `WikiIndexClient`/`WikiIndexToolbar`/`WikiPageCard` cluster, `AuthorBadges`) — some of them edited rather than deleted — plus `src/app/wiki/contributors/error.tsx`, a boundary for a page that can only `notFound()`. All deleted, matching how the previous pass handled the talk orphans.
  - `[low]` `[patch]` `editPath`/`rawPath` never got the empty-tenant floor that `pagePath`/`resolveSlugPath` gained last pass, so they could still emit `/u//<slug>/edit`. Both now fall back to `DEFAULT_TENANT`, with assertions in `links.test.ts`.

Deferred: the contributor MCP tools surviving a retirement that cut every other contributor surface; the middleware exemption for the retired publish route (removable only by editing `middleware-write-gate.test.ts`, which this spec protects); and the old brand in maintainer-facing files (`tools/`, `BACKLOG.md`, `docs/`, a worker README) that are not rendered product copy.

Rejected as noise or out of scope: gating `initialize`/`tools/list` and reordering the auth check ahead of tool-name resolution (the HTTP route 401s first — a repeat of last pass's rejection); the callerless `canSetPrivate` export and the other zero-caller commons helpers (AD-21 permits them); the tautological spy assertions in the retired-route tests; 405-instead-of-404 on methods a retired route never exported; deleting the retired share OG image rather than 404ing it; a purge/migration for the now-inert commons index; slug encoding in `KnowledgeStudio`; the sign-in flash while Clerk loads in `HomeAsk`; accent-colored `<span>`s where links used to be; the dead `TrailEvent.commons` field; restoring a removed OpenNext canonical note that described commons-only SEO handling; adding redirects from retired URLs (FR-1 says they 404); and signposting the half-retired `/wiki` namespace. Seven further findings restated entries already on the deferred list (the CLI publish command, the `slugPath` default-tenant hop, alias forwarding, the zh-CN catalog, and the reconcile/lint talk plumbing) and were dropped rather than re-raised.

### 2026-08-14 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 6, low 4)
- defer: 2: (high 0, medium 0, low 2)
- reject: 27
- addressed_findings:
  - `[medium]` `[patch]` The `integrations/` brand scan added last pass never read a single file: `walk()` filters `/\.tsx?$/` and `integrations/browser-clipper/` contains only `.html`, `.js`, `.json`, `.css`, `.md`. The comment claimed the clipper was covered while the four files that pass hand-edited were unpinned. `walk()` now takes an extension predicate, the clipper tree is scanned with its own, and a new assertion names `popup.html`, `manifest.json` and `service-worker.js` so the scan fails instead of going vacuous again — mutation-checked by restoring the old filter.
  - `[medium]` `[patch]` `.dashboard-topics a` carries all of the topic pill's styling (inline-flex, gap, padding, border, radius), but the pills became `<span>`s when `/wiki?tag=` was retired, so the home dashboard rendered bare label-and-count text runs. The selector now matches both elements.
  - `[medium]` `[patch]` The `disputed` banner still told readers "A reconciliation is open" — computed by `hasOpenThread()` in `/u/[handle]/[slug]/page.tsx` — after every surface that could display, open or close a thread was retired. The claim, the prop, and the `@/lib/talk` import are removed; the banner keeps the `disputed` warning it can still substantiate.
  - `[medium]` `[patch]` `/wiki/new` stayed live but lost its only inbound link when `WikiIndexToolbar` was deleted, leaving manual page creation reachable only by typing the URL — while `single-ia.test.ts` asserts the route still exists. Added to the footer's "Your wiki" column.
  - `[medium]` `[patch]` The Obsidian vault export (`GET /api/wiki/export`, still middleware-listed) lost its only caller with `WikiIndexClient`. The endpoint was never part of the commons cut, so the capability is re-homed as a "Your data" section on `/settings` via a new `VaultExportButton`.
  - `[medium]` `[patch]` `DataviewPanel` (and `DataviewResultsTable`, edited in an earlier pass) had zero mount points for the same reason, while `/api/wiki/dataview` stayed live. Re-homed as a collapsible panel on `/query`, beside the natural-language ask.
  - `[low]` `[patch]` Six `error.tsx` boundaries were repointed to `backHref="/"` but kept `backLabel="← Back to wiki"` / `"← Wiki"`, naming a destination that no longer exists. All now read "← Home", matching `src/app/wiki/error.tsx`.
  - `[low]` `[patch]` `src/lib/merge.ts` still documented, in its module header and at the alias write, that `/wiki/<from>` redirects to the survivor — the exact opposite of what retiring the route made true. Rewritten to say aliases steer ingest, not routing.
  - `[low]` `[patch]` `public/agent-api.md` told integrators an unauthenticated MCP read returns an "Authentication required" tool error; the HTTP endpoint answers `401` before `dispatchMcp` runs, so the doc described the library seam rather than the surface it is shipped to describe.
  - `[low]` `[patch]` `pagePath`/`rawPath` tested the *trimmed* tenant but emitted the raw one, so `pagePath("  alice  ", s)` yielded `/u/  alice  /s`. Both now share one `tenantSegment()` helper that emits what it validated.

Deferred: the duplicate `<main>` landmark that `PrivateWorkspaceNotice` inherited verbatim from the nine signed-out branches it replaced (pre-existing, and chrome-wide); and the email-ingest worker's untested attachment-forwarding path.

Rejected as noise, already-recorded, or out of scope: eight findings restating entries already on the deferred list (alias forwarding, the talk lint suggestions and `reconcile_page`, the middleware publish exemption, the contributor MCP tools, the maintainer-facing brand, the zh-CN catalog, `slugPath`'s default-tenant hop); a claim that `mcp.json`'s tool inventory is unpinned — `mcp.test.ts:4185` already diffs it against the live registry; and repeats of prior passes' rejections (gating `initialize`/`tools/list`, the callerless `canSetPrivate`, the tautological retired-route spies, 405-instead-of-404, the `lineage` route, `KnowledgeStudio` slug encoding, the HomeAsk hydration flash, `TrailEvent.commons`, the share OG stub, and the zero-caller commons/browse/page-type helpers AD-21 permits). Also rejected: the loss of tag filtering (FR-1 retires the browse index that hosted it), `INTERFACE_LOCALE_COOKIE` (a runtime identifier in the i18n module this story may not touch), a Clerk waitlist-mode sign-up fallback (deployment configuration, not code), and the descriptive observations that `RETIRED_SURFACES` and `single-ia.test.ts` are pinned at the source surface rather than the HTTP one.

Note on routing: the three orphaned owner capabilities (`/wiki/new`, vault export, Dataview) share one root cause — the wiki index carried non-commons payload that the spec's Code Map never enumerated. They were routed to `patch` rather than `bad_spec` for the same reason the first pass gave: each has a bounded correct form, and a loopback would revert ~170 correct files to re-derive them. Placement was chosen to match each capability's nearest surviving surface rather than to introduce a new route.

## Design Notes

`retiredPage()`/`retiredRoute()` exist so "what got cut" is one list rather than 20 independent edits — `RETIRED_SURFACES` is what the new test iterates, and what Story 1.3 can consult when it builds the rail.

Retire, don't delete: `src/lib/commons.ts`, `browse.ts`, `talk.ts`, `contributors.ts`, and `publish.ts` stay on disk with no reachable callers (AD-21 permits this). Deleting them would cascade into `trail.ts`, `graph-build.ts`, `search.ts`, `merge.ts`, `vault.ts`, and `maintenance.ts`, all of which import `belongsInCommons`/`listCommonsPages` and are needed by later epics.

`syncCommonsForPage` keeps its signature and its `lifecycle.ts` call site so the write path's shape is unchanged for Epic 2:

```ts
export async function syncCommonsForPage(
  _slug: string,
  _meta: { /* unchanged shape */ },
): Promise<void> {
  // AD-21: commons is retired. Intentionally does nothing.
}
```

The MCP read gate is defense-in-depth: `src/app/api/mcp/route.ts` already 401s a missing bearer, so `dispatchMcp` never sees a null principal in production today. AD-8 names the ungated read path as the leftover to close, and `src/mcp.ts` (stdio) is unaffected because it does not call `dispatchMcp`.

## Verification

**Commands:**
- `pnpm test` -- expected: full Vitest suite green, including the rewritten commons/talk/browse/publish/demo tests and the new `retired-surfaces.test.ts`.
- `pnpm lint` -- expected: clean, with no unused-import errors left by removed branches.
- `pnpm exec tsc --noEmit` -- expected: no type errors from removed exports (`hasPaidPlan`, `publish_to_commons`).
- `grep -rn -i 'yopedia' src/ workers/ --include='*.ts' --include='*.tsx'` -- expected: every remaining hit is a runtime identifier, env name, header, `Env` binding, or health-check body — no user-facing copy.
- `grep -rn 'WorkWiki' src/ --include='*.ts' --include='*.tsx'` -- expected: only `src/lib/i18n.ts` translation-map keys (English-only cleanup is out of scope).

**Manual checks (if no CLI):**
- Confirm no `href`/`Link` in `src/components/` or `src/app/` targets `/wiki`, `/wiki/<slug>`, `/waitlist`, `/share/`, or a bare `/u/<handle>` profile.

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** A second follow-up review pass over the already-implemented Story
1.1 change (the spec arrived at `status: done` with
`followup_review_recommended: true`). Four review layers — blind hunter,
edge-case hunter, verification-gap and intent-alignment — read the full
14,151-line diff since `893d23e145c29bbe551ecbae61443694884205fc`. No
`intent_gap` and no `bad_spec` findings. Ten findings were patched, two
deferred, twenty-seven rejected. The dominant theme this pass was collateral
damage rather than the retirement itself: three owner capabilities that happened
to live on the deleted wiki-index UI, and a brand-scan guard that was reading
zero files.

**Files changed in this pass**

- `src/lib/__tests__/brand-copy.test.ts` — `walk()` takes an extension filter;
  the browser-clipper tree is scanned with its own; a new assertion pins the
  three clipper files by name so the scan cannot go vacuous again.
- `src/components/ArticleView.tsx`, `src/app/u/[handle]/[slug]/page.tsx` — the
  `disputed` banner no longer claims an open reconciliation; the
  `hasOpenReconciliation` prop and the `@/lib/talk` import are gone.
- `src/app/globals.css` — `.dashboard-topics` pill styling matches `<span>` as
  well as `a`.
- `src/components/Footer.tsx` — "New page" link restores an entry point to the
  still-live `/wiki/new`.
- `src/components/VaultExportButton.tsx` (new), `src/app/settings/page.tsx` —
  the Obsidian vault export gets a "Your data" home.
- `src/app/query/page.tsx` — `DataviewPanel` re-homed as a collapsible
  structured-query panel.
- Six `error.tsx` boundaries — "← Back to wiki" / "← Wiki" → "← Home".
- `src/lib/merge.ts` — module doc and alias comment no longer promise a
  `/wiki/<from>` redirect.
- `public/agent-api.md` — unauthenticated MCP reads answer `401`, not a tool
  error.
- `src/lib/links.ts` — `pagePath`/`rawPath` emit the trimmed tenant through one
  shared `tenantSegment()` helper.

**Review findings breakdown.** Patches applied: 10 (high 0, medium 6, low 4).
Items deferred: 2 (both low). Items rejected: 27.

**Follow-up review recommendation:** `true` — patched severities were 0 high,
6 medium, 4 low, so the score is `3 × 6 + 1 × 4 = 22`, at or above the threshold
of 5. No high-severity patch was needed, and the medium findings were
collateral-damage cleanups rather than defects in the retirement itself.

**Verification performed**

- `npx vitest run` — 191 files, 3720 tests, all passing (3719 before this pass;
  the new brand-scan guard is the one addition).
- `npx tsc --noEmit` — clean (exit 0).
- `npx next lint` — no ESLint warnings or errors.
- Mutation check on the new guard: restoring the old `/\.tsx?$/` filter over
  `integrations/` fails `"actually reads the browser clipper's shipped copy"`,
  confirming it is not vacuous.
- `grep -rn -i 'yopedia' src/ workers/` — every remaining hit is a runtime
  identifier, env name, header, `Env` binding, or health-check body.
- `grep -rn 'WorkWiki' src/` — only `src/lib/i18n.ts` translation keys (deferred),
  `names-terms.test.ts` fixture data, and `brand-copy.test.ts`'s own literal.
- Manual: no `href` under `src/app` or `src/components` targets `/wiki`,
  `/wiki/<slug>`, `/waitlist`, `/share/`, or a bare `/u/<handle>`.

**Residual risks**

- Placement of the three re-homed capabilities (`/wiki/new` in the footer, vault
  export on `/settings`, Dataview on `/query`) is a judgment call the intent does
  not speak to. Each is reachable and tested by the existing suites, but an owner
  may expect them elsewhere.
- Twelve entries now sit on the spec's `deferred` list. Two of them — the
  `slugPath` default-tenant redirect hop and the missing alias forwarding for
  merged slugs — are the load-bearing residue of retiring the commons URL space,
  and both remain medium.
- The retirement is still verified at the module surface (exported page/handler
  functions), not through the router or middleware; no request-level test exists
  for the 404 contract.


