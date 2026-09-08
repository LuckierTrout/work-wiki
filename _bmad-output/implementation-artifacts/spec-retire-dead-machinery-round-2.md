---
title: 'Retire dead machinery, round 2: contributor MCP tools, HomeGraph, task-consumer reconcile docs, getDiscussionStats'
type: 'chore' # feature | bugfix | refactor | chore
created: '2026-08-16'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
baseline_revision: 'b21f130bb509e7e6c38473660441105a99c1ec93'
review_loop_iteration: 0 # incremented by step-04 before each review loopback
followup_review_recommended: true # set by step-04 on status: done — true if the LLM decided another review pass is worthwhile
context: []
warnings: [multiple-goals, oversized] # four DW entries bundled by the orchestrator as one cleanup intent; Code Map spans all four
deferred:
  - summary: >-
      `listContributors` and `buildContributorProfile` in `src/lib/contributors.ts` now have
      test-only callers — retiring the two contributor MCP tools removed their last production
      consumers.
    evidence: |-
      `src/lib/contributors.ts` exports `buildContributorProfile` (:278) and `listContributors`
      (:331). Their only remaining callers are `src/lib/__tests__/contributors.test.ts` and
      `src/lib/__tests__/contributor-index.test.ts:13`; the production call sites in `src/mcp.ts`
      (`handleListContributors` / `handleGetContributor`) were deleted in this pass. The sibling
      `buildContributorProfiles` (:313) is in the same test-only state, which predates this pass.
      The module itself must stay: `src/lib/contributor-index.ts:37-43` imports `computeScanData`
      and `computeTrustScore` from it, and `lifecycle.ts:33`, `talk.ts:46`, `maintenance.ts:231`
      keep the index live. The
      spec's Code Map called this residue explicitly out of scope ("record as deferred, do not
      delete") because deleting the scan functions would mean deciding whether the trust-score
      surface returns, which is a product call rather than a cleanup.
    location: >-
      src/lib/contributors.ts:278
    severity: low
  - summary: >-
      The daily maintenance scan still rebuilds the contributor index, but after this pass no
      production code reads what it builds.
    evidence: |-
      `src/lib/maintenance.ts:231` registers `["contributors", () => rebuildContributorIndex()]`,
      and `lifecycle.ts:33` / `talk.ts:46` still write into the index. The read side
      (`profilesFromIndex`, `contributorProfileFromIndex`) is reached only through
      `src/lib/contributors.ts`'s fast paths, whose own callers are now test-only. So the cron
      pays for a full-wiki scan whose output nothing consumes. Removing it is not a cleanup
      decision: it depends on whether the contributor trust surface returns, the same product
      call recorded in the entry above.
    location: >-
      src/lib/maintenance.ts:231
    severity: low
  - summary: >-
      `src/lib/maintenance.ts`'s module header documents only three deterministic `fix` lint
      types while the scan emits eight.
    evidence: |-
      The header (`src/lib/maintenance.ts:11-14`) names `unmigrated-page`,
      `supersedes-dangling`, and `stale-index`; the scan body also emits `orphan-page` (:60),
      `broken-link` (:127), `empty-page` (:143), `stale-page` (:160), and `missing-crossref`
      (:193), matching `MaintainFixType` in `src/lib/tasks.ts:164-172`. Pre-existing drift
      surfaced while correcting the task-consumer README against this file — the README now
      carries the accurate list, so the module header is the remaining stale copy.
    location: >-
      src/lib/maintenance.ts:11
    severity: medium
  - summary: >-
      `.yoyo/status.md` still advertises `list_contributors` and `get_contributor` and an MCP
      tool count of 31.
    evidence: |-
      `.yoyo/status.md:15` lists both retired tool names inside "**MCP tools:** 31 (...)". The
      count was already stale before this pass (the real count was 42, now 40), so this is
      pre-existing drift in an agent-written status doc rather than a consequence of this
      change; it is out of the retirement's file scope and `.yoyo/` is upstream-agent territory.
    location: >-
      .yoyo/status.md:15
    severity: low
  - summary: >-
      `SCHEMA.md` still documents the contributor REST routes, wiki pages, and
      `ContributorBadge` component as live surfaces.
    evidence: |-
      `SCHEMA.md:195-201` advertises `GET /api/contributors`,
      `GET /api/contributors/:handle`, the `/wiki/contributors` index, the
      `/wiki/contributors/:handle` detail pages, and `ContributorBadge`
      components on wiki pages; `:68-69` cites the same surfaces as the consumers
      of the `authors`/`contributors` frontmatter fields. All three routes are
      `retiredRoute()` / `retiredPage()` 404s and `ContributorBadge` no longer
      exists anywhere under `src/`. This drift predates this pass — the routes
      were retired earlier, and this pass only removed the MCP tools — but it is
      the same contributor surface, so it belongs with DW-8's residue.
    location: >-
      SCHEMA.md:195
    severity: low
  - summary: >-
      `DESIGN-triggers.md` states the MCP server exposes 21 tools; the real count
      is 40.
    evidence: |-
      `DESIGN-triggers.md:338` reads "work-wiki's MCP server (`src/mcp.ts`)
      exposes 21 tools over stdio transport." The count guard in
      `src/lib/__tests__/mcp-annotations.test.ts:41-59` scans only
      `public/agent-api.md` and `src/lib/mcp-http.ts`, so this third hand-written
      count is unpinned and was already stale by ~20 before this pass. Out of the
      retirement's file scope.
    location: >-
      DESIGN-triggers.md:338
    severity: low
  - summary: >-
      The graph page's canvas accessibility fallback points readers at `/wiki`,
      which is a retired 404.
    evidence: |-
      `src/app/wiki/graph/page.tsx:161` sets
      `aria-label="Wiki page relationship graph. Visit the wiki index for a
      text-based list of all pages."` and the canvas fallback text (`:164`)
      repeats it, but `/wiki` is listed in `RETIRED_SURFACES`
      (`src/lib/retired.ts:23`) and 404s. Deleting `HomeGraph.tsx` in this pass
      made this the only remaining graph canvas, so it is now the sole
      accessibility escape hatch for the visualization and it leads nowhere. The
      file was not touched by this pass and fixing it means choosing a live
      replacement target, which is a product call.
    location: >-
      src/app/wiki/graph/page.tsx:161
    severity: medium
  - summary: >-
      Two more hand-maintained tool/task inventories have no test pinning them
      against their source of truth.
    evidence: |-
      `src/mcp.ts`'s header comment carries a per-tool name list (the lines this
      pass edited at :33-37), and `workers/task-consumer/README.md:7-13` carries
      the `Task`-kind list. The new parity test pins `MCP_TOOLS` against the
      registrations and `mcp.json` against them too, and the count test pins the
      two numeric counts — but a tool or task kind added or retired without
      touching these two prose lists drifts silently. That is the exact failure
      mode DW-80 was filed for, one layer over. Pinning prose lists needs a
      convention decision (a test that greps Markdown/comments) rather than a
      cleanup edit.
    location: >-
      src/mcp.ts:33
    severity: low
  - summary: >-
      No test exercises a `wontfix` thread through the KV-index fast path of
      `getDiscussionStatsForSlugs`.
    evidence: |-
      `getDiscussionStatsForSlugs` fast-paths through the discuss-stats index
      when one exists and falls back to a directory scan otherwise. The
      mixed-status case added in this pass
      (`src/lib/__tests__/talk.test.ts`, "counts a wontfix thread toward total
      but not open") seeds no index, so it covers only the scan path, and the
      fast-path parity test at
      `src/lib/__tests__/discuss-stats-index.test.ts:133-162` uses only `open`
      and `resolved` threads. So `wontfix` never reaches `statsFromThreads()`.
      Pre-existing: the deleted `getDiscussionStats` never touched the index
      path either, so this pass neither created nor widened the gap.
    location: >-
      src/lib/__tests__/discuss-stats-index.test.ts:133
    severity: low
  - summary: >-
      `/api/tasks/scan?dry=1` is documented as pure inspection but still rebuilds
      derived indexes and purges stale jobs.
    evidence: |-
      `src/app/api/tasks/scan/route.ts:57` calls `rebuildDerivedIndexes()` and
      `:60` calls `purgeStaleJobs()` before the `dry` branch is consulted — both
      write. `workers/task-consumer/README.md` defines dry-run as "logs/returns
      what it *would* enqueue and enqueues nothing" without noting them, which
      matters for the "inspect what it would do" step it recommends. Pre-existing
      route behavior; documenting it accurately means first deciding whether
      those two calls should move behind the flag, which is beyond a doc
      correction.
    location: >-
      src/app/api/tasks/scan/route.ts:57
    severity: low
---

<intent-contract>

## Intent

**Problem:** Four pieces of machinery outlived the surfaces that reached them. `list_contributors` and `get_contributor` still register as MCP tools although every contributor page and REST route now 404s (DW-8, with a recorded "retire the tools" decision). `src/components/HomeGraph.tsx` has had zero importers since before the retirement work (DW-78). `workers/task-consumer/` docs still walk the reader through the retired `reconcile` task kind (DW-80). `getDiscussionStats` in `src/lib/talk.ts` lost its last production callers when the discussion lint checks were deleted (DW-81).

**Approach:** Delete each dead path and the tests that pinned it, retargeting coverage onto the live sibling where one exists. Deletion and documentation correction only — no product or authorization change, and `src/lib/talk.ts` itself stays on disk per AD-21.

## Boundaries & Constraints

**Always:**
- Keep the two hand-written MCP tool counts (`public/agent-api.md`, the `src/lib/mcp-http.ts` header JSDoc) equal to the real registration count — `src/lib/__tests__/mcp-annotations.test.ts` pins this.
- Keep `mcp.json` exactly in sync with the tools `createMcpServer()` registers — `src/lib/__tests__/mcp.test.ts` "mcp.json manifest sync" pins this.
- Retire `list_contributors`/`get_contributor` at every layer they exist: the stdio registration, the HTTP `MCP_TOOLS` descriptor, the shared handlers in `src/mcp.ts`, the manifest, and the tests.
- Corrections to `workers/task-consumer/` docs must describe what the queue actually carries today (`ingest`, `maintain` with ops `staleness`/`fix`, and the other live `Task` kinds), not a rewrite of the worker.
- Full type-check, lint, and test suite green after the change.

**Block If:**
- A symbol slated for deletion turns out to have a live (non-test) caller not listed in the Code Map.
- Removing the contributor tools would require changing `src/lib/contributors.ts` or `src/lib/contributor-index.ts` behavior (they keep live callers through `lifecycle.ts`, `talk.ts`, and `maintenance.ts`).

**Never:**
- Do not edit the deferred-work ledger (`_bmad-output/implementation-artifacts/deferred-work.md`) — the orchestrator records resolution.
- Do not delete `src/lib/talk.ts`, `src/lib/contributors.ts`, `src/lib/contributor-index.ts`, or `src/hooks/useGraphSimulation.ts` (the graph page at `src/app/wiki/graph/page.tsx` still uses the hook).
- Do not remove `getDiscussionStatsForSlugs` — `src/lib/browse.ts` still calls it.
- Do not change the behavior of the retired 404 surfaces or the task executor.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Removed stdio tool | `tools/call list_contributors` on the stdio MCP server | Unknown-tool error; `tools/list` omits it and `get_contributor` | MCP SDK default |
| Removed HTTP tool | `tools/call get_contributor` via `dispatchMcp` | Unknown-tool error envelope from the existing unknown-tool path; `tools/list` omits both names | Existing `dispatchMcp` unknown-tool handling |
| Manifest parity | `createMcpServer()` vs `mcp.json` | Sets match exactly (40 each), no duplicates | Test throws naming the drifting tool |
| Documented counts | `public/agent-api.md`, `src/lib/mcp-http.ts` header | Every "`N` tools" phrase reads 40 | Annotations test fails on mismatch |
| Reopened thread stats | Thread resolved then reopened, read through `getDiscussionStatsForSlugs` | `open` goes 0 → 1 for that slug | — |

</intent-contract>

## Code Map

**DW-8 — contributor MCP tools (retire at every layer):**
- `src/mcp.ts:36-37` — header tool list lines for `list_contributors`/`get_contributor`; `:79` imports `listContributors, buildContributorProfile` from `./lib/contributors` (becomes unused → remove the import); `:81` imports type `ContributorProfile` (used only by the two handlers → remove from the type import list); `:990-1014` the "Contributor handlers" section (`handleListContributors`, `handleGetContributor`); `:2809-2879` the two `server.registerTool` blocks.
- `src/lib/mcp-http.ts:62-63` — imports `handleListContributors`/`handleGetContributor` from `@/mcp`; `:889-910` the "Contributor trust awareness" `MCP_TOOLS` entries; header JSDoc "All 42 tools are exposed" (~line 15).
- `mcp.json:31-32` — manifest entries.
- `public/agent-api.md:180` — "42 tools covering pages, ingestion, …".
- `src/lib/__tests__/mcp-http.test.ts:95-96` (tools/list name assertions), `:1215-1270` (the two dispatch describes).
- `src/lib/__tests__/mcp-annotations.test.ts:32-33` (`registers exactly 42 tools`), `:60-69` (the `no longer exposes %s` retired-tool table — add both names), `:143-144` (`readOnlyTools` list entries).
- `src/lib/__tests__/mcp.test.ts:4098-4145` — manifest-sync test; no edit needed, it derives both sets.
- Read-only evidence: `src/lib/contributors.ts` and `src/lib/contributor-index.ts` stay — `contributor-index.ts:43` imports from `contributors.ts`, and `lifecycle.ts:33`, `talk.ts:46`, `maintenance.ts:231` keep the index live. After this change `listContributors`/`buildContributorProfile` have test-only callers; that residue is out of scope (record as deferred, do not delete).

**DW-78 — HomeGraph:**
- `src/components/HomeGraph.tsx` (57 lines) — delete. `git grep HomeGraph` shows no importer; no test file references it.
- `src/hooks/useGraphSimulation.ts` — keep; `src/app/wiki/graph/page.tsx:6,60` still uses it.

**DW-80 — task-consumer docs:**
- `workers/task-consumer/README.md:9-10` ("the actual work (`reconcile` a page from a discussion thread, async `ingest`)"), `:15-17` (producer claim: the "Ask yoyo to address this" button — `src/app/api/wiki/[slug]/discuss/[threadIndex]/ask-yoyo/route.ts` is now a bare `retiredRoute()` 404 listed in `src/lib/retired.ts:41`), `:34-35` (the disputed-page → reconcile scan bullet), `:143-150` ("Test it" via the retired discussion button).
- `workers/task-consumer/index.ts:6` — header comment "The actual work (reconcile / ingest)".
- Ground truth for the rewrite: `src/lib/tasks.ts:26+` (`Task` union: `ingest`, `extract-actions`, `extract-knowledge`, `compile-knowledge`, `run-agent`, `run-research`, `maintain`, plus monitor/digest/integration/backup kinds) and `src/lib/maintenance.ts:1-24` (scan enqueues `maintain` with `op: "staleness"` or `op: "fix"`; `src/app/api/tasks/scan/route.ts:55-145` also enqueues `run-agent`, `monitor-source`, `deliver-monitor-digest`, `deliver-integration`, `create-backup`). Code in `workers/task-consumer/` is untouched — comments and README prose only.

**DW-81 — getDiscussionStats:**
- `src/lib/talk.ts:340-350` — `getDiscussionStats` (delete). Keep the `DiscussionStats` interface (`:333-339`) and `getDiscussionStatsForSlugs` (`:357+`, called by `src/lib/browse.ts`).
- `src/lib/__tests__/talk.test.ts:17` (import), `:283-295` (reopen-stats test — retarget to `getDiscussionStatsForSlugs`), `:372-399` (the `getDiscussionStats` describe — delete; its zero-file and mixed-status cases are already covered by the `getDiscussionStatsForSlugs` describe at `:401-440`).

## Tasks & Acceptance

**Execution:**
- `src/mcp.ts` -- delete the two `registerTool` blocks, the two handlers, the two header-comment lines, and the now-unused `listContributors`/`buildContributorProfile`/`ContributorProfile` imports -- the stdio server is the registration source of truth the manifest and annotation tests derive from.
- `src/lib/mcp-http.ts` -- delete the two `MCP_TOOLS` entries and their `@/mcp` imports; update the header JSDoc tool count to 40 -- the HTTP endpoint must not keep serving a tool the stdio server no longer has.
- `mcp.json` -- remove the `list_contributors` and `get_contributor` entries -- manifest-sync test compares this file against the live registrations.
- `public/agent-api.md` -- change "42 tools" to the new count -- it is served at `/agent-api` and pinned by the annotations test.
- `src/lib/__tests__/mcp-http.test.ts` -- drop the two `tools/list` name assertions and delete both contributor dispatch describes -- they pin tools that no longer exist.
- `src/lib/__tests__/mcp-annotations.test.ts` -- update the registered-tool count, drop both names from `readOnlyTools`, and add both to the `no longer exposes %s` table -- converts the pins into retirement guards.
- `src/components/HomeGraph.tsx` -- delete the file -- zero importers since before the retirement work.
- `workers/task-consumer/README.md` -- rewrite the reconcile-era passages (dispatcher description, producer list, maintenance-scan bullets, "Test it") to describe the live task kinds and a live trigger -- the doc currently instructs operators through a 404'd button.
- `workers/task-consumer/index.ts` -- correct the header comment's task-kind list -- same stale reconcile claim, in code comments.
- `src/lib/talk.ts` -- delete `getDiscussionStats`, keeping `DiscussionStats` and `getDiscussionStatsForSlugs` -- the single-slug variant has no reachable caller; AD-21 keeps the rest of talk.ts on disk.
- `src/lib/__tests__/talk.test.ts` -- drop the `getDiscussionStats` import and describe block, and retarget the reopen-counts test onto `getDiscussionStatsForSlugs` -- keeps the reopen→open-count behavior covered on the surviving function.

**Acceptance Criteria:**
- Given the stdio MCP server, when `createMcpServer()` registers its tools, then neither `list_contributors` nor `get_contributor` appears and the count assertion in `mcp-annotations.test.ts` matches the real registration count.
- Given `mcp.json` and `createMcpServer()`, when the manifest-sync test runs, then the two sets match exactly with no extras on either side.
- Given the HTTP MCP endpoint, when a client calls `tools/list`, then neither contributor tool name is returned.
- Given the repository, when `git grep -n "HomeGraph\|getDiscussionStats\b\|list_contributors\|get_contributor"` runs over `src/`, `workers/`, `public/` and `mcp.json`, then the only surviving hits are retirement guards in tests (and `getDiscussionStatsForSlugs`, which is a different symbol).
- Given `workers/task-consumer/README.md` and `index.ts`, when read end to end, then no passage describes `reconcile` as live work or points the reader at the retired ask-yoyo button, and every task kind named exists in `src/lib/tasks.ts`.
- Given the full suite, when `pnpm exec vitest run`, `pnpm lint`, and `npx tsc --noEmit` run, then all pass.

## Spec Change Log

## Review Triage Log

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 3, low 4)
- defer: 3: (high 0, medium 1, low 2)
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[medium]` `[patch]` The new "the same scan also enqueues run-agent / monitor-source / …" sentence sat directly above "It is OFF by default", which claims the scan enqueues nothing until `AUTONOMOUS_MAINTENANCE` is on — true only of `maintain` (gated on `dry`), while those kinds are gated on `?dry=1` alone. Scoped the flag section to `maintain` and stated the other kinds' real gating, citing `src/app/api/tasks/scan/route.ts`.
  - `[low]` `[patch]` The maintain-scan guardrails paragraph had drifted behind the other-kinds sentence and read as if it governed them. Reordered so the guardrails sit under the maintain bullets, with an explicit note that they do not apply to the other kinds.
  - `[low]` `[patch]` The rewritten producer list read as exhaustive but omitted `/api/tasks/run`'s chained enqueues, `/api/system/backups`, `/api/monitor-digests`, `integration-outbox.ts`, and `memory-proposals.ts`. Added them and marked the list as main entry points, pointing at `enqueueTask()` callers as the authoritative set.
  - `[low]` `[patch]` `workers/task-consumer/index.ts` transcribed all eleven `Task` kinds, creating a second unpinned copy of the same list DW-80 was filed for. Replaced the enumeration with a grouped description pointing at the union in `src/lib/tasks.ts`; the README keeps its list as the operator reference.
  - `[low]` `[patch]` The new "Test it" recipe omitted auth. Stated that `/api/tasks/scan` is service-token only and `/api/ingest` needs a principal (session cookie or the service token).
  - `[medium]` `[patch]` Deleting the `getDiscussionStats` describe dropped the only assertion that a `wontfix` thread counts toward `total` but not `open`. Added a mixed open/resolved/wontfix case to the surviving `getDiscussionStatsForSlugs` describe.
  - `[medium]` `[patch]` Nothing structurally pinned the HTTP `MCP_TOOLS` set against the stdio registrations although `mcp-http.ts` claims "full parity" and this change hand-edited both sides. Added a set-equality test (both sides already matched at 40; nothing was forced).

### 2026-08-16 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 4, low 2)
- defer: 6: (high 0, medium 1, low 5)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` `workers/task-consumer/index.ts`'s `scheduled()` comment still claimed the cron "dry-runs (logs only) when AUTONOMOUS_MAINTENANCE isn't on. So this is safe to run on schedule before it's enabled" — the exact misconception this pass corrected in the README two files over, left standing in a file the pass edited. Rewrote it to scope the flag to `maintain` and name the kinds gated on `?dry=1` alone.
  - `[medium]` `[patch]` `workers/task-consumer/README.md`'s "How to disable" section ("The cron keeps running but reverts to harmless dry-runs") contradicted the gating paragraph this same pass added ~80 lines above it. Scoped it to `maintain` and gave the actual way to suppress everything (stop the cron, or `?dry=1`).
  - `[medium]` `[patch]` The new HTTP↔stdio parity test pinned tool *names* only, while the semantic that actually diverges is `ToolDef.write` (which gates HTTP auth and the vault-filing suffix) against its stdio counterpart `annotations.readOnlyHint` — a tool whose flags disagree passed the name check silently. Added a second case asserting `write === !readOnlyHint` for every tool; probed first, all 40 already agree, so nothing was forced.
  - `[medium]` `[patch]` The I/O matrix's stdio row (`tools/call list_contributors` on the stdio server → unknown-tool error) was only ever asserted against the private `_registeredTools` map, never over a transport, although `mcp-error-wrap.test.ts` already stands up the `InMemoryTransport` + `Client` harness. Added a `describe` that round-trips `tools/list` and `tools/call` for both retired names. Doing so corrected a factual error in the matrix: the SDK's -32602 rejection surfaces as an `isError` result envelope, not a thrown error, because the server wraps tool failures. The test now pins the real observable behavior.
  - `[low]` `[patch]` The README's new "for the authoritative list, grep the callers of `enqueueTask()`" advice missed `enqueueTasks()` (plural), which is what `/api/knowledge/graphify` — named two lines earlier in the same paragraph — actually calls. Named both functions.
  - `[low]` `[patch]` The rewritten `index.ts` header's new claim "kind-agnostic — it forwards whatever it drains" is inaccurate: `notifyEmailReceipt` inspects the payload via `emailMetadata()` and mails a "Ready"/"Could not import" receipt. Scoped the claim to dispatch and named the exception.

## Design Notes

The two contributor tools are the only consumers of `handleListContributors`/`handleGetContributor`, so unregistering without deleting the handlers would leave a second layer of dead machinery and immediately re-earn a ledger entry — delete both layers in one pass. Stop at the module boundary: `src/lib/contributors.ts` still feeds `contributor-index.ts`, which `lifecycle.ts`/`talk.ts`/`maintenance.ts` keep live, so the scan functions stay even though their last production callers are gone.

For the tool counts, do not hand-count: derive the new number from the registrations that remain (42 today, minus the two removed) and make `public/agent-api.md` and the `mcp-http.ts` header agree — the annotations test scans both files for every "`N` tools" phrase and compares each against `Object.keys(_registeredTools).length`.

The retargeted talk test should assert through the batch API on a single slug, e.g.:

```ts
await createThread("reopen-stats", "Bug", "alice", "body");
await resolveThread("reopen-stats", 0, "resolved");
let stats = await getDiscussionStatsForSlugs(["reopen-stats"]);
expect(stats.get("reopen-stats")!.open).toBe(0);
await resolveThread("reopen-stats", 0, "open");
stats = await getDiscussionStatsForSlugs(["reopen-stats"]);
expect(stats.get("reopen-stats")!.open).toBe(1);
```

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: no type errors (proves no dangling imports or references).
- `pnpm exec vitest run` -- expected: full suite green (invoke vitest directly; a stray `~/pnpm-workspace.yaml` outside this repo has broken `pnpm <script>` in past runs).
- `pnpm lint` -- expected: no unused-import or other ESLint errors.
- `git grep -n "list_contributors\|get_contributor\|HomeGraph" -- src/ workers/ public/ mcp.json` -- expected: only the retirement guards in `mcp-annotations.test.ts`.
- `git grep -n "reconcile" -- workers/` -- expected: no hits.

## Auto Run Result

Status: done

**Implemented change.** Four pieces of dead machinery retired in one pass: the `list_contributors`/`get_contributor` MCP tools (removed at all five layers — stdio registration, HTTP `MCP_TOOLS` descriptor, shared handlers, manifest, docs), `src/components/HomeGraph.tsx` (zero importers), the `reconcile`-era passages in the `workers/task-consumer/` docs, and `getDiscussionStats` in `src/lib/talk.ts`. Coverage was retargeted onto live siblings rather than dropped, and the retirements were converted into guards.

**Files changed:**
- `src/mcp.ts` — deleted both `registerTool` blocks, both handlers, the two header tool lines, and the now-unused `listContributors`/`buildContributorProfile`/`ContributorProfile` imports.
- `src/lib/mcp-http.ts` — deleted both `MCP_TOOLS` descriptors and their `@/mcp` imports; header count 42 → 40.
- `mcp.json` — removed both manifest entries (40 remain).
- `public/agent-api.md` — "42 tools" → "40 tools".
- `src/components/HomeGraph.tsx` — deleted (57 lines).
- `src/lib/talk.ts` — deleted `getDiscussionStats`; `DiscussionStats` and `getDiscussionStatsForSlugs` kept.
- `src/lib/__tests__/mcp-annotations.test.ts` — count 42 → 40, both names moved from `readOnlyTools` into the `no longer exposes` retirement table, plus a new transport-level `describe` round-tripping `tools/list` / `tools/call` for both retired names.
- `src/lib/__tests__/mcp-http.test.ts` — both contributor dispatch describes replaced by retirement guards; new `MCP_TOOLS ↔ stdio registration parity` describe pinning both the name sets and the `write` ↔ `readOnlyHint` flag.
- `src/lib/__tests__/talk.test.ts` — reopen-counts test retargeted onto `getDiscussionStatsForSlugs`; mixed open/resolved/wontfix coverage reconstructed on the sibling.
- `workers/task-consumer/README.md` — reconcile-era dispatcher description, producer list, maintenance-scan bullets and "Test it" recipe rewritten against the live `Task` union and the real scan gating.
- `workers/task-consumer/index.ts` — header and `scheduled()` comments corrected (task kinds, email-receipt exception, real `AUTONOMOUS_MAINTENANCE` scope).

**Review findings breakdown (this follow-up pass):** 6 patches applied (4 medium, 2 low), 6 items deferred (1 medium, 5 low), 10 rejected. No intent gaps and no spec defects — every divergence found was either fixable in place or pre-existing. The rejections were mostly duplicates of already-recorded deferrals (`.yoyo/status.md`, the newly test-only `contributors.ts` exports), suggestions the intent explicitly fenced off (deleting those exports, bumping `mcp.json`'s version), and two claims that did not survive checking: the parity test cannot pass vacuously (`MCP_TOOLS` is statically imported, so an empty stdio registry fails on `extraInHttp`), and its final sorted-equality assertion is harmless redundancy rather than a weakened error message (the named diffs assert first).

**Follow-up review recommendation:** `true`. Patched findings this pass: 0 high, 4 medium, 2 low → score `3×4 + 1×2 = 14`, at or above the threshold of 5.

**Verification performed:**
- `npx tsc --noEmit` — clean, exit 0.
- `npx vitest run` — 211 files, 4356 tests, all passing.
- `npx eslint` over every changed source and test file — 0 errors. (`pnpm lint` still aborts with `packages field missing or empty` from the stray `~/pnpm-workspace.yaml` outside this repo, as the Verification section anticipated; ESLint was invoked directly.)
- `git grep -n "list_contributors\|get_contributor\|HomeGraph" -- src/ workers/ public/ mcp.json` — only the retirement guards in `mcp-annotations.test.ts` and `mcp-http.test.ts`.
- `git grep -n "reconcile" -- workers/` — no hits.
- Ad-hoc probe before adding the `write` ↔ `readOnlyHint` assertion confirmed all 40 tools already satisfy it.

**Residual risks:**
- The I/O matrix's stdio row predicted a thrown "MCP SDK default" error; the real behavior is an `isError` result envelope carrying the -32602 text, because the server wraps tool failures. The new transport test pins the real behavior. The matrix row itself sits inside `<intent-contract>` and was left unedited.
- `workers/task-consumer/README.md` is the one artifact here whose correctness rests entirely on prose — no test pins it. Every claim was verified against `src/app/api/tasks/scan/route.ts`, `src/lib/tasks.ts`, and `src/lib/maintenance.ts` at review time, but it can drift again. Ledgered as a deferred item alongside the `src/mcp.ts` header tool list.
- Retiring the two tools removed the last production readers of the contributor index while its write path stays live (every page edit still takes a file lock to maintain it, and the daily scan still rebuilds it). Deliberately out of scope — deleting it means deciding whether the trust-score surface returns. Recorded as the first two deferred items.

