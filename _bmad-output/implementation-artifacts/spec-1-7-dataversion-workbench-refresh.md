---
title: 'Story 1.7: dataVersion Workbench refresh'
type: 'feature'
created: '2026-08-16'
status: 'done'
baseline_revision: '8fde226552a42eea61c0ede6e9425ea4b99f38f3'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-6-drag-resize-and-durable-layout.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A refresh whose server re-render still reads the OLD version strands that
      version: `refreshedFor` has already advanced, so it is never retried.
    evidence: |-
      `DataVersionWatcher` sets `refreshedForRef.current = result.version` before
      `router.refresh()` and never checks that the new render's `dataVersion`
      caught up. Both reads go through the same Worker, so the window is narrow —
      but if the RSC read answers the pre-bump integer, `served` stays behind
      while `refreshedFor` is ahead, and `shouldRefreshForDataVersion` returns
      `false` for that version forever; the trees then wait for the NEXT write.
      The obvious fix is not obviously right: dropping the guard restores the
      unbounded re-render loop it exists to prevent (a degraded `page.tsx` read
      stuck at 0 against a route answering 7 would refresh every tick, forever),
      so closing this needs a bounded retry policy — how many attempts, how long
      to wait for the baseline to move — which is a refresh-policy decision for
      whichever story next revisits the signal (Epic 2's Ingest is its first real
      consumer).
    location: >-
      src/components/workbench/DataVersionWatcher.tsx (run), src/lib/workbench-data-version.ts (shouldRefreshForDataVersion)
    severity: low
  - summary: >-
      Writes that bypass `runPageLifecycleOp` — template seeding of `purpose.md`
      and `schema.md`, raw source files — never move the signal.
    evidence: |-
      The bump is at the kernel pipeline's tail, which is what the story's `When`
      clause names, and `seedWikiArtifacts` (`wikis.ts:280`) writes through
      `storage.writeFile` instead. Creating a Wiki is covered because
      `WikiSwitcher` still calls `router.refresh()` itself, but a confirm-gated
      template RE-APPLY, and any later writer that lands bytes the Files tab
      renders, would leave a second open tab stale. Story 1.8 routes Schema edits
      through the kernel write path, at which point that half needs nothing; the
      open question is only whether seeding and template re-apply should bump too,
      and that belongs with whichever story owns those flows.
    location: >-
      src/lib/wikis.ts (seedWikiArtifacts), src/lib/lifecycle.ts (runPageLifecycleOp)
    severity: low
  - summary: >-
      A silent same-row refresh swaps the Preview's body with no announcement, so
      a screen-reader user reading it is not told the content changed.
    evidence: |-
      Before this story the body changed only when the owner picked a row, which
      is their own action. A bump from another actor now replaces it underneath
      them, and `PreviewColumn` has no live region. The epic's accessibility floor
      already says mode changes announce the surface name, so the same argument
      applies here — but any announcement is a new authored sentence, and the
      epic's Copy table is the only place a Workbench sentence may be born. That
      makes it a copy decision rather than a wiring fix, and it belongs with
      whichever story next opens that table for the Preview column.
    location: >-
      src/components/workbench/PreviewColumn.tsx (the fetch effect's response handler)
    severity: low
  - summary: >-
      `PUT /api/wiki/[slug]` carries no `If-Match` precondition, so the Preview
      editor silently clobbers a write another actor made while it was open.
    evidence: |-
      Pre-existing — the write path has never had one — but this story makes the
      race visible for the first time by teaching the shell to notice other
      actors' writes, and it deliberately does NOT disturb an open editor, so the
      draft can now be knowingly stale. The read side already supports the
      primitive (`readFileWithEtag` / `writeFileIfMatch` in `storage/types.ts`);
      what is missing is a version on the preview payload, a precondition on the
      route, and a decision about what the column shows when it fails. That is a
      whole conflict-handling design, not a patch.
    location: >-
      src/app/api/wiki/[slug]/route.ts (PUT), src/lib/workbench-preview.ts (savePreviewBody)
    severity: medium
  - summary: >-
      The watcher's effect lifecycle — poll cadence, visibility gating, abort,
      teardown — is verified only by matching strings in its own source.
    evidence: |-
      `vitest.config.ts` is `environment: "node"` and the repo has no jsdom,
      happy-dom, Testing Library or React test plugin, so no suite renders a
      component, mounts an effect, advances a timer or dispatches a
      `visibilitychange`. The story's decisions were extracted into pure
      functions precisely to work around this, and that half IS executed — but
      "a backgrounded tab does not poll", "becoming visible checks
      immediately", "one AbortController per run" and "full teardown in the
      cleanup" are runtime claims pinned by `expect(source).toContain(
      "clearInterval(timer)")` and friends. Those assertions survive a broken
      rewrite and break on a reflow. This pass patched the two places where a
      one-character inversion stayed green (the refresh guard's `!` and the two
      `setFailed` branches), but the remedy for the class is a DOM test
      environment, which is a project-level dependency and CI decision rather
      than something one story should take unilaterally.
    location: >-
      vitest.config.ts, src/components/workbench/DataVersionWatcher.tsx, src/lib/__tests__/workbench-data-version.test.ts
    severity: medium
  - summary: >-
      A page another actor deletes now disappears from the trees mid-session
      while the docked selection survives, leaving no row marked current.
    evidence: |-
      Before this story the trees only changed under a `WikiSwitcher` refresh,
      which also changes `currentWikiId` and so re-runs the selection reset at
      `Workbench.tsx:194-203`; `restorableSelection` / `selectionExists` are
      reached only from the `[]` mount effect (`:173`). A watcher-driven
      refresh changes neither, so the selection outlives the row: the Preview
      stays docked showing `PREVIEW_FAILED_COPY` (truthful) while no tree row
      carries `aria-current` — the state Story 1.6's `selectionExists` docblock
      names as "a shell that looks broken rather than one that forgot".
      Reconciling a live selection against a refreshed tree is a design
      decision (does the shell silently undock, fall back to the sibling row,
      or say something?) and the last of those needs a sentence from the epic's
      Copy table, so it belongs with whichever story next opens it.
    location: >-
      src/components/workbench/Workbench.tsx (the selection reset effect), src/lib/workbench-tree.ts (selectionExists)
    severity: low
  - summary: >-
      A silent refresh cannot tell "another actor deleted this page" from "the
      network blipped", so a transient failure replaces the page the owner is
      reading with the failure copy and does not heal itself.
    evidence: |-
      `fetchPreview` (`workbench-preview.ts:344-364`) collapses 404, 500, a
      malformed body, the `REQUEST_TIMEOUT_MS` deadline and a bare transport
      failure into one `{ status: "failed" }`, and `previewBodyState`
      (`workbench-preview.ts:152-155`) puts `failed` AHEAD of a payload that is
      still held. Before this story the flag could only be set right after an
      explicit pick, behind a `Loading…` the owner had just caused. A silent
      same-row refresh sets it with `plan.reset === false`, so a page jumps
      straight from rendered bytes to `PREVIEW_FAILED_COPY` for a reason the
      owner did not initiate — and because the effect re-runs only on
      `[selection, dataVersion, editing]`, it stays that way until the next bump
      or until they click elsewhere and back. The spec's rule ("a failed silent
      refresh still tells the truth, because a page another actor just deleted
      must not keep rendering as if it were there") is right about deletion and
      is what makes the conflation visible; separating "gone" from "could not
      reach" means a new `fetchPreview` outcome and a decision about what the
      column shows for each, which is a conflict/error-surface design rather
      than a patch — and the "could not reach" branch may need a sentence from
      the epic's Copy table.
    location: >-
      src/lib/workbench-preview.ts (fetchPreview, previewBodyState), src/components/workbench/PreviewColumn.tsx (the fetch effect's response handler)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Nothing in the app writes or reads a `dataVersion`; the string appears only in two hand-off comments (`WorkbenchData.tsx:14`, `PreviewColumn.tsx:234-236`). A kernel write therefore reaches the Workbench only when the one client that happens to know about it calls `router.refresh()` — `PreviewColumn`'s own save does, and nothing else does. A page written by the CLI, by MCP, by an agent, or (from Epic 2) by Ingest leaves the trees and the Preview showing yesterday's bytes until the owner reloads the window. Every later epic is specified against this signal, so it has to be right here.

**Approach:** Bump one monotonic integer in the config store at the single choke point every kernel write and delete already passes through, serve it from a gated route, and give the Workbench one watcher that compares the served integer to the polled one and, when it has moved forward, re-runs the server render (`router.refresh()`) for the trees and re-fetches the Preview's bytes for the docked row — no full page reload, no second refresh mechanism.

## Boundaries & Constraints

**Always:**
- The bump lives at exactly one site: `lifecycle.ts:648`, between `await appendToLog(...)` (`:647`) and the `return` (`:649`) inside `runPageLifecycleOp`. Both `writeWikiPageWithSideEffects` (`:708`) and `deleteWikiPage` (`:664`) are thin wrappers over that pipeline, and every one of the ~40 callers (routes, `mcp.ts`, `cli.ts`, `ingest.ts`, `lint-fix.ts`, …) funnels through it, so no call site is edited. A throw before that line means the op failed and nothing bumps.
- The bump is **fail-soft**, in the shape every other side effect in that pipeline uses: `try { … } catch (err) { logger.warn("data-version", …); }`. A KV hiccup must not fail a write that already landed — a stale tree is recoverable, a rejected save is not.
- The counter is read and written through the storage provider's index API (`getIndex` / `putIndex`, `storage/types.ts:218,225`), under the logical key `"data-version"` — so it is KV `_idx:data-version` in `YOPEDIA_CONFIG` on Cloudflare (`storage/r2.ts:53,209,214`) and `<DATA_DIR>/.indexes/data-version.json` in local dev (`storage/filesystem.ts:195-217`), with no provider branch in the caller. The read-modify-write is wrapped in `withFileLock("data-version", …)` (`lock.ts:37`), the same serializer every other derived index uses.
- Monotonic means monotonic: the writer stores `previous + 1`, never a timestamp, never a random token, and a stored value that is absent, non-numeric, non-integer, negative or non-finite reads as `0` rather than propagating. The consumer treats only a FORWARD move as a reason to refresh.
- Runtime identifiers stay `yopedia` (AD-7): the KV binding is `YOPEDIA_CONFIG`, the key prefix is the provider's own `_idx:`, and no new `localStorage` key is added at all.
- The route is `GET /api/workbench/version`, gated by `getPrincipal()` with `401 { error: "Sign in required." }`, answering `{ dataVersion: <integer> }` under `Cache-Control: private, no-store`, wrapped in the try/catch → `500 { error }` shape — the same six rules `api/workbench/preview/route.ts:47-92` follows, because the column already parses that shape.
- Every refresh DECISION is a pure exported function the node suite executes (there is no DOM test environment — `vitest.config.ts` is `environment: "node"`, include `src/**/__tests__/**/*.test.ts`): whether a polled version warrants a refresh, and whether a re-run of the Preview effect is a fresh row or a silent refresh. The watcher component and `PreviewColumn` hold state, refs and effects; they spell no comparison of their own.
- The trees refresh by `router.refresh()` and only from a component that already owns a router: the watcher mounted by `page.tsx`. `Workbench.tsx` must not gain `useRouter` (`workbench-chrome.test.ts:130-134`, `workbench-left-column.test.ts:101,446` all assert its absence), and `page.tsx` must contain no `fetch(` (`workbench-left-column.test.ts:492`) — its `dataVersion` is a server lib call.
- The polling loop is the `useSidecarStatus.ts:27-73` idiom verbatim in structure: `setInterval` while visible, `stopPolling()` on hide, an immediate run on becoming visible, one `AbortController` per run, a `cancelled` flag, and full teardown in the cleanup. A backgrounded tab does not poll.
- An open Preview editor is never disturbed by a refresh. A version-only re-run while the editor is open does not fetch, does not reset the draft, and does not close the editor; a SELECTION change still abandons it exactly as it does today (`PreviewColumn.tsx:150-156`).
- A silent (same-row) refresh does not flash `Loading…`: it leaves `loading` and the current payload alone until an answer arrives. A failed silent refresh still tells the truth (`failed`), because a page another actor just deleted must not keep rendering as if it were there.

**Block If:**
- Bumping at the pipeline's tail appears to require changing `WritePageResult` / `DeletePageResult`, editing any of the ~40 call sites, or bumping inside `writeWikiPage` (`wiki.ts:424`), which lifecycle itself calls 2–4× per op.
- Refreshing the trees appears to require a new API route that returns `KnowledgeGroup[]` / `FileNode[]`, moving the tree build off the server, or changing `page.tsx`'s gate (`listReadableWikiPages(principal)` is the only visibility gate there is).
- Making the Preview refetch appears to require `Workbench.tsx` to take a router, or `PreviewColumn.tsx` to issue a `fetch(` of its own (`workbench-left-column.test.ts:323`).

**Never:**
- Do not introduce a second refresh paradigm: no SWR, no react-query, no `revalidatePath` / `revalidateTag` / `unstable_cache` (none exist anywhere in `src/` today), no `EventSource`, no WebSocket, no polling of the tree data itself.
- Do not remove `router.refresh()` from `WikiSwitcher.tsx:110,135` — switching or creating a Wiki is a registry change, not a kernel page write, and `workbench-left-column.test.ts:217-219` pins it there. Do not add a bump to `seedWikiArtifacts` (`wikis.ts:280`) or to any writer that bypasses `runPageLifecycleOp`.
- Do not make the counter per-tenant, per-wiki or per-page, and do not store it in `config.json`, in the wiki registry, or in `localStorage`. One global integer in the config store is the whole contract (AD-11).
- Do not implement Schema editing (Story 1.8), Settings (1.9), Ingest (Epic 2) or any Activity/toast surfacing of the refresh. This story ships no new visible chrome — a correct refresh is invisible.
- Do not edit any pre-existing test file except `src/lib/__tests__/workbench-left-column.test.ts`, and there only the two assertions that pin the Preview effect's dependency array (`:298` and the slice terminator at `:340-343`) plus that test's title. Every new assertion lands in one new test file.
- Do not write `WorkWiki`, and do not name `Georgia` or `serif` in any file under `src/components/workbench` (`workbench-chrome.test.ts:284-299`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First read, key absent | fresh store | `readDataVersion()` → `0` | No error expected |
| Bump from absent | key absent | stores `1`, returns `1` | No error expected |
| Successive bumps | stored `7` | stores `8`, then `9` | No error expected |
| Corrupt stored value | `"x"` / `-1` / `1.5` / `NaN` | reads as `0`; next bump stores `1` | No throw |
| Store read/write throws | provider rejects | `readDataVersion()` → `0`; `bumpDataVersion()` swallows and warns | Logged, never thrown |
| Kernel write succeeds | `writeWikiPageWithSideEffects` | version is exactly one higher than before the call | No error expected |
| Kernel delete succeeds | `deleteWikiPage` | version is exactly one higher | No error expected |
| Kernel write throws early | invalid slug | version unchanged | The op's own error still propagates |
| Bump throws inside the pipeline | store rejects on put | the write still returns its `WritePageResult` | Warned, op unaffected |
| Route, signed in | `GET /api/workbench/version` | `200 { dataVersion: n }`, `private, no-store` | No error expected |
| Route, signed out | no principal | `401 { error: "Sign in required." }` | No error expected |
| Route, read throws | store rejects | `500 { error: <message> }` | Shape matches every other route |
| Poll parses | `{ dataVersion: 4 }` | `{ status: "ok", version: 4 }` | No error expected |
| Poll malformed | `{}` / `{dataVersion:"4"}` / non-JSON / `500` | `{ status: "unavailable" }` — no refresh | Silent |
| Poll aborted | signal aborted mid-flight | `{ status: "stale" }` — no refresh, no setState | Silent |
| Refresh decision, moved forward | served 3, polled 4, refreshed-for 3 | `true` | No error expected |
| Refresh decision, unchanged | served 3, polled 3 | `false` | No error expected |
| Refresh decision, already refreshed | served 3, polled 4, refreshed-for 4 | `false` — one refresh per version, so a server render that keeps answering `3` cannot loop | No error expected |
| Refresh decision, backwards | served 5, polled 4 | `false` — a stale eventually-consistent read is not a change | No error expected |
| Preview plan, new row | sameRow `false`, editing either | fetch + full reset (loading, payload, editor, confirm, save error) | No error expected |
| Preview plan, version moved, idle | sameRow `true`, editing `false` | fetch, no reset — no `Loading…` flash | Failed fetch still sets `failed` |
| Preview plan, version moved, editing | sameRow `true`, editing `true` | no fetch, no reset — the draft is untouched | No error expected |
| Nudge registry | subscribe ×2, request | both listeners run; after unsubscribe, neither | A throwing listener does not stop the others |

</intent-contract>

## Code Map

**New:**
- `src/lib/data-version.ts` — server-side: `DATA_VERSION_KEY = "data-version"`, `DATA_VERSION_LOCK`, `readDataVersion()`, `bumpDataVersion()`. Copy the module shape of `src/lib/page-index.ts:16-64` (key + lock consts, fail-soft reader, `withFileLock` mutator) — but unlike page-index it defaults to `0` and always writes, never no-ops.
- `src/lib/workbench-data-version.ts` — client-safe and pure: `DATA_VERSION_ROUTE = "/api/workbench/version"`, `DATA_VERSION_POLL_MS`, `fetchDataVersion(signal, fetchImpl = fetch)` mirroring `workbench-preview.ts:344-364`'s result union, `shouldRefreshForDataVersion({ served, polled, refreshedFor })`, `previewFetchPlan({ sameRow, editing })`, `subscribeDataVersionCheck(listener)`, `requestDataVersionCheck()`.
- `src/app/api/workbench/version/route.ts` — the gated read. Structure: `api/workbench/preview/route.ts:47-92` (`NO_STORE` const, `json()` helper, `GET` → try/catch → `handle()`, `getPrincipal()` 401).
- `src/components/workbench/DataVersionWatcher.tsx` — `"use client"`, renders `null`. `useWorkbenchData().dataVersion` is the served baseline, `useRouter()` the refresh, `useSidecarStatus.ts:27-73` the loop, and `subscribeDataVersionCheck` the immediate-check seam.
- `src/lib/__tests__/workbench-data-version.test.ts` — the one new test file.

**Extend:**
- `src/lib/lifecycle.ts:645-649` — step 5 is `appendToLog`; add step 6 (the bump) immediately after it, before `return { slug, crossRefedSlugs, … }`. Note `:637-639` and `:611`: the strip/cross-ref path writes through `writeWikiPage`, NOT the pipeline, so it cannot double-bump.
- `src/app/page.tsx:43-60,84-100` — add `readDataVersion()` (with the same `.catch` + `logger.error` degrade shape as its two siblings, falling back to `0`) as a third element of the existing `Promise.all`, put `dataVersion` in the provider value, and mount `<DataVersionWatcher />` inside `<WorkbenchDataProvider>`.
- `src/components/workbench/WorkbenchData.tsx:13-14,19-41,43-52` — add `dataVersion: number` to the interface and `0` to `EMPTY_DATA`; the docblock's "Story 1.7 adds fields here" becomes a statement of what is there.
- `src/components/workbench/Workbench.tsx:104-110,364-371` — destructure `dataVersion` from `useWorkbenchData()` and pass it to `<PreviewColumn>`. Nothing else in the shell changes; the mount effect's `[]` deps and `latestRef` (`:146-151`) already make a re-render with refetched trees safe.
- `src/components/workbench/PreviewColumn.tsx:58-67,102-103,135-173,234-242` — add `dataVersion: number` to `PreviewColumnProps` and thread it through `PreviewColumn` → `PreviewPane`; add a `shownSelectionRef`; put the effect behind `previewFetchPlan`; deps become `[selection, dataVersion, editing]`; delete `useRouter` (`:4,103`), the `router.refresh()` at `:236` and `router` from `save`'s deps (`:242`), replacing it with `requestDataVersionCheck()`.
- `src/lib/__tests__/workbench-left-column.test.ts:279,298,340-343` — the two dep-array pins and the test title. Nothing else in that file, and no other pre-existing test file.

**Reuse as-is (do not fork, do not edit):**
- `src/lib/storage/types.ts:218,225` + `storage/index.ts:114` `getStorage()` — one API, both providers; `storage/r2.ts:39` already prepends `_idx:`.
- `src/lib/lock.ts:37` `withFileLock` — in-process serialization, the same guarantee every derived index has.
- `src/lib/workbench-tree.ts:132` `isSameSelection` — "is this the same row?" already exists; do not invent a selection key.
- `src/hooks/useSidecarStatus.ts` — the visibility-gated poll. Copy the structure; do not generalize it into a shared hook.
- `src/lib/auth.ts:66` `getPrincipal`, `src/lib/logger.ts` — the gate and the log surface.

**Read-only constraints (do not regress):**
- `workbench-left-column.test.ts:110-112` (provider fields — additive is fine), `:217-219` (`router.refresh()` stays in `WikiSwitcher`), `:285-297` (the fetch wiring literals), `:323` (no `fetch(` in `PreviewColumn`), `:344-345` (`setEditing(false)` / `editingSlugRef.current = null` stay inside the fetch effect), `:367-376` (no `router.push(`), `:437-446` (frozen reset-effect deps; no `useRouter` in `Workbench`), `:462-506` (page.tsx literals, `await Promise.all([`, no `fetch(`, bare `<Workbench>`).
- `workbench-chrome.test.ts:130-134` (`Workbench.tsx` has no router), `:284-299` (no `Georgia`/`serif` under `src/components/workbench`), `:494-506` (page.tsx literals).
- `lifecycle.test.ts`, `wiki.test.ts:471`, `merge.test.ts:71`, `maintenance.test.ts:55`, `tenant-admin.test.ts:47`, `wiki-routes.test.ts:237+` — all drive the real pipeline against a temp `DATA_DIR`; the bump must not make any of them fail or slow.
- `storage-fs.test.ts`, `storage-r2.test.ts:167,262` (`createMockKV`, `YOPEDIA_CONFIG`) — the provider contract this story only consumes.

## Tasks & Acceptance

**Execution:**
- `src/lib/data-version.ts` -- new: the key, the lock, `readDataVersion()` (fail-soft, narrowing a non-integer / negative / non-finite stored value to `0`) and `bumpDataVersion()` (read-modify-write inside `withFileLock`, returning the stored value) -- one module owns the counter so the route, the page and the pipeline cannot each invent their own key or their own idea of what an invalid stored value means.
- `src/lib/lifecycle.ts` -- add step 6 between `appendToLog` and the `return` of `runPageLifecycleOp`: `await bumpDataVersion()` in a `try/catch` that warns -- placing it at the pipeline's single tail is what makes "every successful kernel write or delete bumps" true for all ~40 callers without touching one of them, and fail-soft is what keeps a config-store hiccup from rejecting a write that already landed.
- `src/app/api/workbench/version/route.ts` -- new: `GET` → `getPrincipal()` gate → `{ dataVersion }` with `Cache-Control: private, no-store`, wrapped so a throw answers `500 { error }` -- the browser cannot read KV, and a per-principal answer that a shared cache could store is the one way this route could leak.
- `src/lib/workbench-data-version.ts` -- new, pure and client-safe: the route, the poll cadence, `fetchDataVersion` (ok / unavailable / stale, no message ever derived from a transport string), `shouldRefreshForDataVersion`, `previewFetchPlan`, and the subscribe/request nudge pair -- there is no DOM test environment, so every decision the watcher and the column make has to be a function the node suite can execute rather than a condition typed into an effect.
- `src/components/workbench/DataVersionWatcher.tsx` -- new client component rendering `null`: baseline from `useWorkbenchData().dataVersion` held in a ref assigned during render, `refreshedForRef`, the visibility-gated poll from `useSidecarStatus`, `subscribeDataVersionCheck` wired in the same effect with its unsubscribe in the cleanup, and `router.refresh()` when `shouldRefreshForDataVersion` says so -- the trees are server-rendered, so re-running the server render IS the tree refetch, and it belongs in the one component that already may hold a router.
- `src/app/page.tsx` -- read the version alongside the registry and the page index, carry it in the provider value, and mount `<DataVersionWatcher />` inside the provider -- the watcher needs the served baseline, and the provider is the only seam that crosses the server/client boundary.
- `src/components/workbench/WorkbenchData.tsx` -- add `dataVersion: number` to `WorkbenchData` and `0` to `EMPTY_DATA` -- the docblock has said since Story 1.4 that 1.7 adds a field here rather than a prop.
- `src/components/workbench/Workbench.tsx` -- destructure `dataVersion` and pass it to `<PreviewColumn>` -- the shell is where context becomes props, and it must stay router-free.
- `src/components/workbench/PreviewColumn.tsx` -- thread `dataVersion` to `PreviewPane`, add `shownSelectionRef`, gate the effect on `previewFetchPlan({ sameRow: isSameSelection(shownSelectionRef.current, selection), editing })` with the reset block behind `plan.reset` and an early return when `!plan.fetch`, clear `failed` on a successful answer, extend the deps to `[selection, dataVersion, editing]`, and replace `router.refresh()` in `save` with `requestDataVersionCheck()` (dropping the `useRouter` import and `router` from the deps) -- the owner's own save must not be the only write the shell notices, and a bump landing while they are mid-edit must not take their draft.
- `src/lib/__tests__/workbench-left-column.test.ts` -- update only the dep-array regex, the effect-slice terminator and the title of the "keyed on the selection" test -- the pin is what this story deliberately changes; every other assertion in that file must still pass untouched.
- `src/lib/__tests__/workbench-data-version.test.ts` -- new: execute every I/O matrix row (the counter against a temp-`DATA_DIR` filesystem provider with `_resetStorage()`, using `lifecycle.test.ts:33-66`'s fixture shape; the pure functions directly; `fetchDataVersion` against a stubbed fetch the way `workbench-preview.test.ts` stubs one), assert a real `writeWikiPageWithSideEffects` and `deleteWikiPage` each raise the counter by exactly one and a failed op raises it by none, and scan `page.tsx`, `WorkbenchData.tsx`, `Workbench.tsx`, `PreviewColumn.tsx`, `DataVersionWatcher.tsx` and the route for the wiring a node suite cannot execute -- the bump and the refresh are both invisible when they work, so nothing but a test can tell they still do.

**Acceptance Criteria:**
- Given a signed-in owner with the Workbench open, when any kernel page write or delete succeeds anywhere in the system — the Preview editor's save, the CLI, MCP, an agent — then `dataVersion` in the config store is exactly one higher than before, and no other write path bumps it.
- Given the Workbench is open on a docked row and `dataVersion` moves forward, when the watcher's next poll (or the immediate check the owner's own save requests) sees it, then the trees re-render from the server and the Preview re-reads its bytes, the window does not reload, and the mode, tree tab, selection, scroll offset and column widths the owner arranged all survive.
- Given the owner has the confirm-gated editor open with unsaved text, when a bump lands from another actor, then the draft, the editor and the confirm state are untouched, and the refetch happens after they save or cancel.
- Given the tab is hidden, when it is in the background, then no polling happens at all, and becoming visible again checks immediately.
- Given a signed-out request or a config store that throws, when `GET /api/workbench/version` is called, then it answers `401` or `500` in the `{ error }` shape and never a page's content, and a store failure inside the pipeline never turns a successful write into a failed one.
- Given the full suite, when `npx vitest run`, `npx tsc --noEmit` and `npx eslint` run, then all three are clean and the only pre-existing test file modified is `workbench-left-column.test.ts`.

## Spec Change Log

- 2026-08-22: Worker `dataVersion` increment is provider-atomic. `bumpDataVersion` calls `StorageProvider.incrementIndex` (filesystem: serialized read-modify-write; Cloudflare: R2 `onlyIf` compare-and-swap on `_idx/data-version`). KV `_idx:data-version` seeds the first R2 write only. The fail-soft wrap is unchanged: a store that rejects still answers `0` and does not fail the kernel write.

## Review Triage Log

### 2026-08-16 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 1, low 7)
- defer: 4: (high 0, medium 1, low 3)
- reject: 22: (high 0, medium 2, low 20)
- addressed_findings:
  - `[medium]` `[patch]` The "which row did we last read bytes for" rule was unexecutable and therefore unverified: hoisting `shownSelectionRef.current = selection;` above the `previewFetchPlan(...)` call — an ordinary tidy-up — made `sameRow` permanently `true`, so picking another row while the editor was open kept row A's bytes and A's open draft under row B's header, with every assertion still green. `previewFetchPlan` now takes `{ shown, next, editing }`, applies `isSameSelection` itself, and RETURNS the row to record, so the component writes `shownSelectionRef.current = plan.shown` and there is no separate assignment left to hoist.
  - `[low]` `[patch]` Deleting both `startPolling()` call sites left the suite green — the story's only non-owner refresh path could be removed silently. The watcher's polling test now slices the visible-mount block and `onVisibility`'s visible branch and asserts `void run();` and `startPolling();` inside each.
  - `[low]` `[patch]` The `setFailed(false)` assertion sliced from `if (plan.reset) {`, which already contains the reset block's own copy, so deleting the new line in the ok branch stayed green — and at runtime a row that failed once kept showing the failure copy over bytes it had successfully re-read. The slice is now scoped to the response handler.
  - `[low]` `[patch]` `principal.throws = false` was restored AFTER `await get()` with no `try/finally`, so a throw there would leak a globally throwing `getPrincipal` into every later test in the file. Both mock fields now reset in `afterEach`.
  - `[low]` `[patch]` `DATA_VERSION_LOCK`'s docblock presented `withFileLock` as the reason two concurrent ops cannot both store `n + 1`, but `lock.ts` documents it as in-process only and this app deploys to Workers isolates. The limitation is now stated beside the claim, with what a collapsed bump actually costs; the concurrency test carries a matching note that it proves the property at the filesystem provider, not for KV.
  - `[low]` `[patch]` `narrowStoredVersion`'s "costs one wasted refresh and then self-heals" was false for an already-open client: after a wipe the counter restarts at 1 and a tab baselined at 50 ignores the next 49 writes. Reworded to say that, and that a reload fixes it.
  - `[low]` `[patch]` The banned-refresh-paradigm check missed `WebSocket` (which the spec's Never list bans) and was case-sensitive on SWR. Now a list matched as USE rather than bare substring — a bare `/swr/i` hit a base64 blob in `vendor/yoyo-reference.generated.ts`.
  - `[low]` `[patch]` "the window does not fully reload" is an acceptance criterion that had no assertion at all. Added: no `location.reload(`, no `location.href/assign/replace`, no `window.location =` in the watcher, the column or the shell.

### 2026-08-16 — Review pass (follow-up)

- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 2: (high 0, medium 1, low 1)
- reject: 33: (high 0, medium 3, low 30)
- addressed_findings:
  - `[medium]` `[patch]` `page.tsx` read the baseline CONCURRENTLY with the data it describes, which could serve a version the trees had not caught up to — and forward-only comparison then never refreshes them. The bump is the last step of a kernel op, after the page index is rewritten, so a version read resolving after a racing write's bump while the index read resolved before that write's index update produced a render carrying the new number over the old trees; the route then keeps answering the number the render already claims and the shell waits for the NEXT write. `readDataVersion()` is now awaited BEFORE the `Promise.all`, making the baseline at worst older than the data beside it — one wasted render instead of a missed one. The test pins the ordering and that the read is not back inside the round.
  - `[low]` `[patch]` Deleting the `!` from the watcher's refresh guard left the suite green: the watcher would then refresh on every poll where nothing changed and never when a write landed — the exact inverse of the story. `toContain("shouldRefreshForDataVersion({")` proves the decision is CALLED, not obeyed. A new test slices `run()` and pins the negated guard with its early return, that `router.refresh()` appears exactly once and only after it, and that a poll that could not answer never reaches the decision.
  - `[low]` `[patch]` The two `setFailed` calls were asserted over one slice containing both branches, so swapping them stayed green — every page that read fine would render `This file couldn’t be loaded.` and every genuine failure would keep rendering as if the bytes were there. The assertions are now scoped per branch, each with the matching negative.
  - `[low]` `[patch]` `DATA_VERSION_POLL_MS` was bounded only from below, so a ten-minute cadence would have kept the suite green while making "a write from the CLI or an agent reaches the trees without a reload" untrue for a working session. Added an upper bound.
  - `[low]` `[patch]` `DATA_VERSION_LOCK`'s docblock conceded that two isolates can COLLAPSE a bump, and argued a collapsed bump is survivable because it still moves the signal. The read half is eventually consistent too, so the counter can also move BACKWARDS — and a regression is worse than a collapse, because every write until the counter climbs back past the high-water mark is ignored rather than just one. Stated, with the self-heal and why no provider-atomic increment is added.

### 2026-08-16 — Review pass (follow-up 2)

- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 2, low 2)
- defer: 1: (high 0, medium 1, low 0)
- reject: 27: (high 0, medium 3, low 24)
- addressed_findings:
  - `[medium]` `[patch]` `document.addEventListener("visibilitychange", onVisibility);` was never asserted — it appeared in the suite only as the END INDEX of the mount slice, and deleting it left all 44 tests green (`String.slice(start, -1)` simply runs to the end of the file, and the cleanup's `removeEventListener` keeps `onVisibility` referenced so eslint stays quiet). Unregistered, a Workbench mounted into a hidden tab — a restored session, a background-opened tab — never reaches `startPolling()` for the whole life of that mount, so the story's only non-owner refresh path is dead and the tab updates solely when the owner saves. The registration is now asserted directly; deleting it fails the suite.
  - `[medium]` `[patch]` The abort signal never had to reach the transport. `stubFetch` took only `(url)` and dropped `init`, and every abort case works by pre-aborting a controller `fetchDataVersion` inspects ITSELF — so removing `{ signal }` from the `fetchImpl(...)` call passed all four abort assertions while making every poll uncancellable in the browser, which is exactly what `abortRef` and the effect cleanup depend on. The stub now records `init?.signal` and the ok-path test asserts the caller's signal was forwarded; the mutation now fails.
  - `[low]` `[patch]` The hidden branch's `stopPolling();` was pinned only by a whole-file `toContain("stopPolling();")` that the cleanup's own copy satisfies, so deleting it stayed green while a backgrounded tab kept polling forever — the one claim the visibility gate makes. The whole-file check is replaced by a slice of the `} else {` branch alone, asserting `stopPolling();` and the absence of `startPolling();`.
  - `[low]` `[patch]` `DataVersionWatcher`'s docblock claimed to be "the Workbench's one refresh mechanism" and "the one component that may hold a router". `WikiSwitcher.tsx` sits in the same directory, holds a router and calls `router.refresh()` twice — deliberately, because a Wiki switch is a registry change that moves no `dataVersion`, and `workbench-left-column.test.ts:217-219` pins it there. An absolute claim a reader can falsify by opening the next file invites deleting the refresh the tests require. Both sentences now name the exception and why it is one.

## Design Notes

**Why the bump is inside `runPageLifecycleOp` and not in the two wrappers.** `writeWikiPageWithSideEffects` (`lifecycle.ts:708`) and `deleteWikiPage` (`:664`) are both ten-line wrappers over the same pipeline, and the pipeline is also where the "successful" boundary actually is: every step before `:647` can throw. One line at `:648` covers both verbs, all ~40 call sites and every future caller, and it is impossible to add a new kernel write that forgets to bump without also bypassing the write path the epic says is the only one.

**Why forward-only, and why `refreshedFor`.** KV is eventually consistent, so a poll can legitimately answer a value lower than the one the server rendered with; treating any inequality as a change would refresh on a stale read and then again on the fresh one. Forward-only makes a blip a no-op. `refreshedFor` exists for the opposite failure: if `page.tsx`'s own read degrades to `0` while the route answers `7`, an unguarded watcher would call `router.refresh()` every poll forever. Refreshing at most once per observed version bounds that to a single wasted render.

```ts
// The whole decision, executed by the node suite rather than typed into an effect.
export function shouldRefreshForDataVersion(input: {
  served: number; polled: number; refreshedFor: number;
}): boolean {
  return input.polled > input.served && input.polled > input.refreshedFor;
}
```

**Why `router.refresh()` is the tree refetch.** `page.tsx:18` is `force-dynamic` and builds both trees server-side from `listReadableWikiPages(principal)` — the only visibility gate there is. Adding a client route that returns `KnowledgeGroup[]` would mean a second implementation of that gate in a second place, which is exactly the drift `api/workbench/preview/route.ts:27-33` refuses. `router.refresh()` re-runs the server component and pushes a new payload through the provider without a navigation, without a reload, and without unmounting the shell — so widths, selection, scroll and mode all survive because they were never re-mounted. `Workbench.tsx:146-151` already anticipates this: `latestRef` exists precisely so the mount effect reads the FIRST render's trees and a refetch cannot re-run the restore.

**Why the Preview needs its own dep and cannot ride `router.refresh()`.** The Preview's bytes come from a client fetch keyed on the selection (`PreviewColumn.tsx:135-173`), not from the server render, so a refreshed page changes nothing about them. Adding `dataVersion` to that effect's deps is the whole Preview half — but the effect's first act today is to discard the editor and the draft, which is right for a new row and catastrophic for a bump that lands mid-edit. Hence one plan function with three outcomes, and `editing` in the deps so that closing the editor lets the deferred refresh happen.

```ts
export function previewFetchPlan(input: { sameRow: boolean; editing: boolean }):
  { fetch: boolean; reset: boolean } {
  if (!input.sameRow) return { fetch: true, reset: true };   // a pick abandons the editor
  if (input.editing) return { fetch: false, reset: false };  // never touch an open draft
  return { fetch: true, reset: false };                      // silent refresh, no flash
}
```

**Why a nudge instead of leaving `router.refresh()` in the save.** Two refresh mechanisms is the state this story exists to end, and the comment at `PreviewColumn.tsx:234-236` says so. But a save that only refreshes the trees on the next poll tick is a visible regression, so the column asks the watcher to check NOW: `requestDataVersionCheck()` is a module-level notify over a `Set` of listeners, the watcher subscribes for its lifetime, and the answer still comes from the server's integer rather than from the client's assumption that its own write landed.

## Verification

**Commands:**
- `npx vitest run` -- expected: green. Baseline is 203 files / 4,122 tests; this story adds one file.
- `npx tsc --noEmit` -- expected: exit 0.
- `npx eslint` -- expected: no errors (the pre-existing `jsx-ast-utils` TSNonNullExpression notices are not errors).
- `git status --porcelain src/lib/__tests__ src/components/__tests__` -- expected: exactly two entries — the untracked `workbench-data-version.test.ts` and the modified `workbench-left-column.test.ts`.
- `grep -rn "bumpDataVersion(" src --include=*.ts --include=*.tsx` -- expected: its definition, exactly one call site in `lifecycle.ts`, and the new test file.
- `grep -rn "useRouter\|router.refresh" src/components/workbench` -- expected: `WikiSwitcher.tsx` and `DataVersionWatcher.tsx` only; nothing in `Workbench.tsx` or `PreviewColumn.tsx`.
- `grep -rn "revalidatePath\|revalidateTag\|unstable_cache\|swr\|react-query" src` -- expected: no match.
- `grep -rn "Georgia\|[^-]serif" src/components/workbench` -- expected: only `sans-serif` matches.

**Manual checks (if no CLI):**
- Inspect `lifecycle.ts`'s diff: one added block, after `appendToLog`, before the `return`, inside a `try/catch`; no signature and no call site changed.
- Inspect `DataVersionWatcher.tsx` for any literal comparison of two version numbers — there should be none; the only condition is the call to `shouldRefreshForDataVersion`.

## Auto Run Result

Status: done

### Implemented change

Story 1.7 ships the `dataVersion` refresh signal end to end: one monotonic integer in the config store (`_idx:data-version`), bumped exactly once at the tail of `runPageLifecycleOp` so all ~40 kernel-write call sites move it without knowing it exists; a gated `GET /api/workbench/version`; and one client watcher that polls the route while the tab is visible and calls `router.refresh()` when the served integer has moved FORWARD. The Preview column takes the same integer as an effect dependency, so the docked row re-reads its bytes at the same moment — without disturbing an open editor and without flashing `Loading…` at a reader. `PreviewColumn`'s own `router.refresh()` is gone; its save now nudges the watcher instead, ending the two-refresh-mechanism state the story exists to close.

This run was a follow-up review pass over an already-`done` spec (`review_loop_iteration` reset to 0). It re-derived no code; it added three test assertions and corrected one docblock.

### Files changed (since `8fde226`)

- `src/lib/data-version.ts` — new: the key, the lock, `readDataVersion()` and `bumpDataVersion()`; fail-soft, narrowing any non-integer/negative/non-finite stored value to `0`.
- `src/lib/lifecycle.ts` — step 6 of `runPageLifecycleOp`: `await bumpDataVersion()` between `appendToLog` and the `return`, inside a warning `try/catch`.
- `src/app/api/workbench/version/route.ts` — new: `getPrincipal()` gate, `{ dataVersion }`, `private, no-store`, `{ error }` on 401/500.
- `src/lib/workbench-data-version.ts` — new, pure and client-safe: route, cadence, `fetchDataVersion`, `shouldRefreshForDataVersion`, `previewFetchPlan` and the subscribe/request nudge pair.
- `src/components/workbench/DataVersionWatcher.tsx` — new client component rendering `null`: the visibility-gated poll, the nudge subscription, and the one `router.refresh()`. **This pass** corrected its docblock's two absolute claims about being the only refresh / only router holder.
- `src/app/page.tsx` — reads the baseline *before* the `Promise.all`, carries it in the provider value, mounts the watcher inside the provider.
- `src/components/workbench/WorkbenchData.tsx` — `dataVersion: number` on the interface, `0` in `EMPTY_DATA`.
- `src/components/workbench/Workbench.tsx` — destructures `dataVersion` and passes it to `<PreviewColumn>`; still router-free.
- `src/components/workbench/PreviewColumn.tsx` — `shownSelectionRef`, the effect behind `previewFetchPlan`, deps `[selection, dataVersion, editing]`, `requestDataVersionCheck()` in place of `router.refresh()`.
- `src/lib/__tests__/workbench-data-version.test.ts` — new, the only new test file. **This pass** added the `visibilitychange` registration assertion, the hidden-branch `stopPolling()` slice, and the forwarded-abort-signal assertion (with `stubFetch` now recording `init`).
- `src/lib/__tests__/workbench-left-column.test.ts` — the two permitted dep-array pins and the test title; nothing else.

### Review findings breakdown

- Patches applied: 4 (high 0, medium 2, low 2) — three closed verification gaps in the new suite, one corrected docblock claim. All four listed under the follow-up 2 triage entry.
- Items deferred: 1 (medium) — a silent refresh conflates "deleted" with "unreachable", so a transient blip replaces the page being read with the failure copy and does not self-heal. Recorded in frontmatter `deferred`.
- Items rejected: 27 (high 0, medium 3, low 24). The largest groups: findings against the route's blanket catch and its lack of `force-dynamic`, which describe the shape `api/workbench/preview/route.ts` already has and the spec mandates copying; findings against the watcher's poll loop (no in-flight abort on hide, no request deadline, no backoff or jitter, a tick that supersedes a slower poll), which are `useSidecarStatus.ts:27-73` verbatim — the idiom the spec requires; the extra preview read on save and on cancel, which follows from the `editing` dependency the spec prescribes and is harmless against the strongly-consistent byte store; the unreachable `try/catch` around `bumpDataVersion()`, which the spec requires as a defensive guard; and duplication findings (the narrowing rule, the `useSidecarStatus` loop, the `"Sign in required."` literal) that the spec's Reuse and Never lists settle explicitly.

### Follow-up review recommendation

`true`. Patched this pass: high 0, medium 2, low 2 → score `3 × 2 + 1 × 2 = 8`, which is ≥ 5. No `high` patch.

### Verification performed

- `npx vitest run` — **green**: 204 files / 4,166 tests passed (baseline 203 / 4,122; this story adds one file and 44 tests).
- `npx tsc --noEmit` — exit 0.
- `npx eslint` — exit 0 (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- `git status --porcelain src/...` — exactly the expected entries; the only pre-existing test file modified is `workbench-left-column.test.ts`.
- `grep -rn "bumpDataVersion(" src` — the definition, one call site in `lifecycle.ts`, and the new test file.
- `grep -rn "useRouter\|router.refresh" src/components/workbench` — `WikiSwitcher.tsx` and `DataVersionWatcher.tsx` only.
- `grep -rn "revalidatePath\|revalidateTag\|unstable_cache\|react-query" src` — only the new test's own ban list; `grep -rn "Georgia\|[^-]serif" src/components/workbench` — no match.
- **Mutation-checked the three new assertions rather than trusting them.** Deleting `document.addEventListener("visibilitychange", onVisibility);`, deleting the hidden branch's `stopPolling();`, and dropping `{ signal }` from `fetchImpl(DATA_VERSION_ROUTE, …)` each failed exactly one test (44 → 43 passed); every one of the three had left the suite fully green beforehand. All mutations reverted, suite restored to 44/44.

### Residual risks

- **The composition is still unexecuted.** The counter, the pipeline, the route, the poll and both decision functions run for real; the wiring that joins them — server read → provider → props → refs → dep array → interval → router — is pinned by source scan, because `vitest.config.ts` is `environment: "node"` with no DOM. This pass closed three specific holes in that scan; the class remains, and is already recorded in `deferred` as needing a project-level DOM-test-environment decision.
- **The signal is not exact across Workers isolates.** `withFileLock` is in-process only, so two isolates can collapse a bump, and an eventually-consistent read can move the counter backwards — costing every write until it climbs past the old high-water mark. Documented at `DATA_VERSION_LOCK`; self-heals on the next bump or a reload.
- **A refresh whose server re-render still reads the old version is never retried** (`refreshedFor` has already advanced) — recorded in `deferred`, and needs a bounded-retry policy from whichever story next revisits the signal.
- **Writers that bypass `runPageLifecycleOp` move nothing** — template seeding of `purpose.md` / `schema.md` in `seedWikiArtifacts`, per the spec's Never list. Story 1.8 routes Schema edits through the kernel path; template re-apply remains open in `deferred`.



