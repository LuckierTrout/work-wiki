### DW-1: The CLI still exposes a publish-to-commons command after the REST route and the MCP tool were retired.
origin: spec-deferred 592955d7b1dc
location: src/cli.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/cli.ts` keeps `publish <slug> --agent <id>` calling `publishToCommons` (`src/lib/publish.ts`), and `src/lib/__tests__/cli.test.ts` still asserts the promotion end to end. The intent names routes and the MCP tool list, not the owner-local CLI, so it was left alone; it now writes into an index nothing reads.
status: open

### DW-2: slugPath() addresses every slug-only link through the default tenant, so the URL names the wrong handle until the owner route redirects it.
origin: spec-deferred fe2df3ceb0dd
location: src/lib/links.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: medium
reason: `slugPath()` hard-codes `DEFAULT_TENANT` and leans on the 308 in `src/app/u/[handle]/[slug]/page.tsx`. Call sites such as RecentIngests, VaultExplorer, ChatWorkspace, ActionInbox, BulkDocumentImport and KnowledgeStudio already hold (or can fetch) the real owner, so each of those links costs a redirect hop and shows a misleading handle in the address bar and in link previews.
status: open

### DW-3: Alias forwarding for merged or renamed slugs disappeared with the retired commons URL and was never rebuilt on the owner-scoped URL.
origin: spec-deferred 162f1930cc8c
location: src/lib/page-redirect.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: medium
reason: `commonsRedirectForMissing` resolved an absorbed slug to its survivor and 308'd to `/wiki/<canonical>`; it now returns null unconditionally. Its only caller was the retired page, so nothing regressed at that URL — but a wikilink to a merged-away slug now resolves through `slugPath()` to `/u/<tenant>/<old-slug>`, which 404s. `resolveAlias` has no routing caller.
status: open

### DW-4: The zh-CN translation catalog has stale keys and still spells the old brand.
origin: spec-deferred ee84aaa25ba2
location: src/lib/i18n.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: medium
reason: `src/lib/i18n.ts` keys on exact English source strings, so the renamed chrome labels ("The commons", "What is WorkWiki", "Browse all") no longer match and silently fall back to English; keys for deleted UI (Browse, Join waitlist, Contributors, Mobile navigation) are now unreachable; and line 43 still ships "WorkWiki" as rendered copy. The spec forbids i18n work in this story, and the recorded user preference is English-only, so the whole module is a later cut.
status: open

### DW-5: Reconcile-from-talk plumbing and the discussion lint checks outlive the talk surface they point at.
origin: spec-deferred af264a332ec0
location: src/lib/reconcile.ts, src/lib/lint-checks.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `/api/tasks/run` still dispatches `reconcile`/`maintain:reconcile` through `reconcileFromTalk`, the `reconcile_page` MCP tool remains, and `checkUnresolvedDiscussions` / `checkDisputedPages` still emit warnings whose remediation surface now 404s. Harmless while no surface can create a thread, but it is dead machinery.
status: open

### DW-6: ArticleActions still branches on the commons realm.
origin: spec-deferred 5bb7128d058f
location: src/components/ArticleActions.tsx
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/components/ArticleActions.tsx` keeps `isCommonsPage` gating for Delete and "Save to vault", and `ArticleView` computes and threads the flag purely to feed it. Changing delete authorization was out of this story's scope, so the realm model survives with no commons behind it.
status: open

### DW-7: canWritePage's commons-realm rule lost its escape hatch when talk was retired.
origin: spec-deferred 51476f69db15
location: src/lib/authz.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/lib/authz.ts` still denies `body` and `delete` writes on any public non-agent page to non-admin principals, justified in-comment by humans steering through metadata patches and talk threads. The edit page's copy is now a bare "You don't have write access to this page" with nowhere to go.
status: open

### DW-8: The contributor capability is retired at every page and REST surface but still ships as two MCP tools.
origin: spec-deferred b763192224b5
location: src/lib/mcp-http.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `/wiki/contributors`, `/api/contributors` and `/api/contributors/[handle]` all 404, and `/u/<handle>` is gone — but `list_contributors` and `get_contributor` remain registered in `src/lib/mcp-http.ts` and `mcp.json`, and `mcp-http.test.ts` was updated to keep them passing. They are read-only and bearer-gated, so nothing leaks in a single-owner deployment; whether the capability should survive at MCP after being cut everywhere else is a product call, not a defect.
status: open

### DW-9: Middleware still exempts the retired publish route as an in-route-auth path.
origin: spec-deferred 049dafc8e212
location: src/middleware.ts:73
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/middleware.ts` keeps `AGENT_PUBLISH_RE` and documents `/api/agents/<id>/publish` as "the agent's own per-agent token" in its header comment, though the handler is now `retiredRoute()` and inspects nothing. Harmless (the request 404s), but the exemption cannot be removed here: `middleware-write-gate.test.ts:39` pins it, and this story's constraints forbid changing that suite's behavior.
status: open

### DW-10: Maintainer-facing files still carry the old brand after the display rename.
origin: spec-deferred 4087d7d02acb
location: tools/workwiki-sync.mjs
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `tools/workwiki-sync.mjs`, `tools/WORKWIKI_SYNC.md`, `BACKLOG.md`, `docs/llm-wiki-functional-parity-roadmap.md` and `workers/sandbox-runner/README.md` still say "WorkWiki". None of it is rendered product copy — the intent's rename targets user-visible surfaces — and one of them is a filename, so renaming is a separate, wider cut.
status: open

### DW-11: Every owner-only page renders a second `<main>` landmark inside the one `SiteChrome` already provides.
origin: spec-deferred 87a650148e71
location: src/components/PrivateWorkspaceNotice.tsx
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `SiteChrome` wraps all children in `<main id="main-content">`, and the signed-out branch of nine pages returns `PrivateWorkspaceNotice`, whose root element is another `<main>`. The nesting predates this story — the baseline `chat/page.tsx` had the same `<main className="shell fade">` — so the refactor into one component inherited it rather than causing it. It is a duplicate-landmark violation in a component whose own docstring cites WCAG 2.2 AA, and the same pattern appears on `settings`, `query` and other signed-in pages, so the fix is a chrome-wide sweep, not a one-file edit.
status: open

### DW-12: The email-ingest worker's attachment-forwarding path has no test, so its byte-copy could silently forward empty files.
origin: spec-deferred 02eeaa536555
location: workers/email-ingest/index.ts:239
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `workers/email-ingest/index.ts:239` copies attachment bytes into a fresh `Uint8Array` before wrapping them in a `Blob` for the `attachments` FormData part. `email-ingest-worker.test.ts` is the only test that imports the worker, and its fixture is a plain-text message with no attachment; both cases assert only on `msg.reply`'s text. Zeroing the copy would still produce a correctly-sized buffer, a `{ ok: true, slug }` response and the same acknowledgement email, so every emailed PDF/DOCX would ingest empty with the suite green. The attachment path is pre-existing; this story only fixed a type error on that line.
status: open

### DW-13: Follow-up review still recommended for 1-1-sign-in-privately-and-retire-commons after the damping cap was spent
origin: review-budget-followup
location: n/a
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260814-210506-c3ab; this entry preserves the lingering recommendation for a deliberate later review.
status: open
