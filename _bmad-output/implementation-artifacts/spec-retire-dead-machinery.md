---
title: 'Retire dead machinery: publish-to-commons, reconcile-from-talk, commons realm branch, HomeDashboard'
type: 'chore' # feature | bugfix | refactor | chore
created: '2026-08-16'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
baseline_revision: '1aac75ea210dc301d99597d6c4add020d7942f79'
review_loop_iteration: 0 # incremented by step-04 before each review loopback
followup_review_recommended: true # set by step-04 on status: done — true if the LLM decided another review pass is worthwhile
context: []
warnings: [multiple-goals, oversized] # five DW entries bundled by the orchestrator as one cleanup intent; Code Map spans all five
deferred:
  - summary: >-
      LintFilterControls.tsx keeps a hand-copied ALL_CHECK_TYPES with only 11 entries while the lib
      const in lint-checks.ts has 14, so the lint UI cannot toggle uncited-claims,
      supersedes-dangling, or incomplete-coverage, and useLint's length comparison uses the wrong
      total.
    evidence: |-
      Pre-existing drift, not introduced here: src/components/LintFilterControls.tsx:5-16 lacks
      uncited-claims, supersedes-dangling, incomplete-coverage; src/lib/lint-checks.ts
      ALL_CHECK_TYPES has 14 entries; no parity test ties the two constants together.
    location: >-
      src/components/LintFilterControls.tsx:5
    severity: medium
  - summary: >-
      The disputed frontmatter flag is now one-way — ingest still sets disputed: true on
      contradicting merges and ArticleView still renders the disputed banner, but with
      reconcile-from-talk and the disputed-page lint check removed (intent-directed) no surface
      lists disputed pages and nothing clears the flag except a manual metadata edit.
    evidence: |-
      src/lib/ingest.ts parseDisputedMarker still sets the flag; src/components/ArticleView.tsx
      still renders the "This page is disputed" banner; the bundle intent explicitly directed
      deleting checkDisputedPages, so the surfacing gap is a knowing consequence to revisit with
      whatever story owns disputed-page semantics.
    location: >-
      src/lib/ingest.ts
    severity: medium
  - summary: >-
      authz.ts still carries the commons-realm delete-deny branch with no commons behind it; after
      this change the client delete gate no longer mirrors it for a hypothetical non-admin owner of
      a public page (irrelevant in the shipped single-owner deployment where the owner is the site
      admin).
    evidence: |-
      src/lib/authz.ts:193-198 denies body/delete on belongsInCommons pages for non-service,
      non-admin principals, pinned by authz.test.ts:228-231; DW-6's ledger explicitly kept delete
      authorization out of scope, so the server-side realm residue remains dead machinery.
    location: >-
      src/lib/authz.ts:193
    severity: low
  - summary: >-
      HomeGraph.tsx had zero references already at the baseline revision — a pre-existing dead
      component, not orphaned by this story (unlike HomeAsk.tsx, which this story deleted).
    evidence: |-
      git grep HomeGraph at baseline 1aac75ea returns no references outside the component file
      itself.
    location: >-
      src/components/HomeGraph.tsx
    severity: low
  - summary: >-
      The orchestrator's ledger sweep truncates entry headings at a fixed width mid-word — DW-75's
      heading in deferred-work.md ends "or incom" and DW-76's ends "and the disputed", and DW-75's
      useLint-length-comparison clause survives only in this spec's frontmatter, not in the ledger
      entry.
    evidence: |-
      _bmad-output/implementation-artifacts/deferred-work.md:609 and :617 carry the truncated
      headings; the entries' reason fields hold the evidence text, not the lost summary tails.
      Ledger entries are orchestrator-owned (invocation constraint), so this pass records the
      defect instead of editing them.
    location: >-
      _bmad-output/implementation-artifacts/deferred-work.md:609
    severity: low
  - summary: >-
      workers/task-consumer docs still describe reconcile as live work — its README walks through
      "reconcile a page from a discussion thread" and index.ts's header says the actual work is
      "(reconcile / ingest)" — though such queue messages now parse as 400 poison; the intent's
      Never forbade touching the directory, so the residue stays.
    evidence: |-
      workers/task-consumer/README.md:9 and :35 plus workers/task-consumer/index.ts:6 reference
      the retired reconcile task kind; the spec's "verified: no reconcile/publish references"
      parenthetical covered live code paths, not docs and comments. Intent Never: "Do not touch
      workers/task-consumer/".
    location: >-
      workers/task-consumer/README.md:9
    severity: medium
  - summary: >-
      talk.ts getDiscussionStats is newly orphaned by this story — its last production callers
      were the deleted discussion lint checks — and reports green under talk.test.ts with no
      reachable caller; the batch variant getDiscussionStatsForSlugs keeps a live caller
      (browse.ts).
    evidence: |-
      grep after this change shows no non-test caller of getDiscussionStats; talk.ts itself is
      intent-protected ("Do not delete src/lib/talk.ts"; AD-21 deliberately keeps talk machinery
      on disk), so whether to trim the export or leave it as deliberate AD-21 residue belongs to
      a story that owns talk.ts.
    location: >-
      src/lib/talk.ts:342
    severity: low
---

<intent-contract>

## Intent

**Problem:** After the commons and pre-Workbench landing page were retired (stories 1.1 and 1.3), five pieces of machinery survive with no live surface reaching them: the CLI `publish` command + `src/lib/publish.ts`, the reconcile-from-talk task plumbing + `reconcile_page` MCP tool + two discussion lint checks, ArticleActions' `isCommonsPage` realm branch, middleware's `AGENT_PUBLISH_RE` exemption for the now-404 publish route, and the unmounted `HomeDashboard` component. Tests still pin each, reporting green on surfaces nothing renders or serves. (Bundle: DW-1, DW-5, DW-6, DW-9, DW-28.)

**Approach:** Delete each dead path and its module where no live caller remains; retarget or remove the tests that pinned them. Deletion of dead code only — effective behavior for the shipped single-owner deployment is preserved; no authz or product change.

## Boundaries & Constraints

**Always:**
- Preserve effective behavior for the shipped single-owner deployment: retired routes keep answering 404; live surfaces (lint UI, tasks route, MCP tools that remain, delete/save-to-vault actions for the owner) behave identically.
- Keep the retired 404 route handler `src/app/api/agents/[id]/publish/route.ts` and its test — the 404 surface itself is intentional; only the middleware exemption goes.
- Removing the `reconcile`/`maintain:reconcile` task kinds must make such queue messages parse as malformed (400 poison → ack/drop), never fall through to another handler.
- Runtime identifiers stay `yopedia`-named (AGENTS.md policy); this change renames nothing.
- Full type-check, lint, and test suite green after the change.

**Block If:**
- A supposedly dead module turns out to have a live (non-test) caller not listed in the Code Map.
- Deleting the lint check types would force changes to persisted data formats or stored settings (none found in planning — enabled checks are client state, not stored server-side).

**Never:**
- Do not edit the deferred-work ledger (`_bmad-output/implementation-artifacts/deferred-work.md`) — the orchestrator records resolution.
- Do not delete `src/lib/talk.ts`, `src/lib/commons.ts`, or other modules with remaining live callers (lifecycle, authz, trail, maintenance).
- Do not change delete/curate authorization semantics beyond collapsing the dead commons branch (`canDelete` becomes `isOwner || isSiteOwner`; `isCuratable` gating stays).
- Do not touch `workers/task-consumer/` (verified: no reconcile/publish references).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Removed CLI command | `pnpm cli publish <slug> --agent <id>` | `error` parse result: "Unknown command: publish" + help pointer | Standard unknown-command path |
| Poisoned queue message | POST /api/tasks/run body `{kind:"reconcile",...}` or `{kind:"maintain",op:"reconcile",...}` with service token | 400 "malformed task" (parseTask returns null) | Consumer acks + drops (poison) |
| Removed MCP tool | `tools/call reconcile_page` on stdio or HTTP MCP | Standard unknown-tool error; `tools/list` omits it | MCP SDK default |
| Retired publish route, no exemption | POST /api/agents/x/publish with Bearer token | 401 from middleware (was 404 from route) — still unreachable, no live caller | Middleware jsonError |
| Lint run | Lint with all checks enabled | No `unresolved-discussions` / `disputed-page` issues possible; other 14 checks unchanged | — |
| Landing page | GET / as owner | Workbench shell renders; `<h1>` owner is `Workbench.tsx` (`wb-title`) | — |

</intent-contract>

## Code Map

**DW-1 — CLI publish + publish.ts:**
- `src/cli.ts` — remove: usage lines 18/194, `ParsedCommand` variant line 42, `parseArgs` case lines 155-169, `runPublish` lines 507-520, dispatch case lines 680-682. Nothing else imports `./lib/publish`.
- `src/lib/publish.ts` — delete file (sole export `publishToCommons` + `PublishError`; callers: cli.ts only).
- `src/lib/__tests__/cli.test.ts` — remove "publish command" describe (lines 179-198), `vi.mock("../publish", ...)` (lines 377-379), `runPublish` tests (lines 1219-1247).
- `src/lib/__tests__/publish.test.ts` — delete file (pins `publishToCommons` end-to-end).

**DW-5 — reconcile plumbing + discussion lint checks:**
- `src/lib/reconcile.ts` — delete file (sole export `reconcileFromTalk` + type).
- `src/app/api/tasks/run/route.ts` — remove import (line 4), `kind === "reconcile"` branch (lines 127-137), `maintain op === "reconcile"` branch (lines 141-150); update the header comment's "reconcile re-reconciles harmlessly" phrasing.
- `src/lib/tasks.ts` — remove `kind: "reconcile"` Task variant (lines 26-34), `"reconcile"` from maintain `op` union (line 164) + doc comment, `parseTask` cases (lines 279-291, 420-425). Malformed → null → 400 poison.
- `src/lib/maintenance.ts` — remove the disputed→reconcile producer (lines 101-115) and its header-comment bullet (lines 6-9); drop now-unused `listThreads`/`isAgentHandle` imports if unreferenced elsewhere in the file.
- `src/mcp.ts` — remove header comment line 30, import line 92, handler wrapper around line 1257, `registerTool("reconcile_page", ...)` block at lines 2558+.
- `src/lib/mcp-http.ts` — remove `reconcile_page` tool entry (lines ~488-520; read the region to bound it — name/schema/handler + description).
- `src/lib/lint-checks.ts` — remove `checkUnresolvedDiscussions` (801-819), `checkDisputedPages` (821-850), the two `ALL_CHECK_TYPES` entries (29-30); drop `getDiscussionStatsForSlugs`/`getDiscussionStats` import (line 11) if then unused.
- `src/lib/lint.ts` — remove imports (21-22, 59-60), the two Promise.all slots + destructure names (95, 126-130), spread names (151).
- `src/lib/types.ts` — remove `"unresolved-discussions" | "disputed-page"` from `LintIssue["type"]` (line 70).
- `src/lib/lint-fix.ts` — remove the two FixValidationError cases (706-709, 714-717).
- `src/components/LintFilterControls.tsx` — remove from local `ALL_CHECK_TYPES` (line 17) and `checkTypeLabels` (33-34). Check `src/hooks/useLint.ts` line 6 import source; `mcp.ts`/`api/lint/route.ts` derive from the shrunk const automatically.
- Tests: delete `reconcile.test.ts`; trim `tasks.test.ts` (25-39, 162-177, 345-355), `tasks-route.test.ts` (mock lines 4/48/63, dispatch tests 126, ~200-215, 536-545, 625-628), `scan-route.test.ts` (fixture line 43, assertion 210 — re-check surrounding expectations on task count/order), `maintenance.test.ts` (~line 89 region), `mcp.test.ts` (fixture comment 48, reconcile_page describe 2663-2740ish), `mcp-http.test.ts` (tool-list line 149, describe 504-520ish), `mcp-annotations.test.ts` (line 118), `lint-checks.test.ts` (imports 18-19, describes 860-925ish), `lint.test.ts` (filter list line 99), `lint-fix.test.ts` (disputed-page test 938-944).

**DW-6 — ArticleActions realm branch:**
- `src/components/ArticleActions.tsx` — drop `isCommonsPage` prop (interface 20-21, destructure 54, `canDelete` line 86 → `isOwner || isSiteOwner`); update the delete-gate comment (83-85) and component doc (39-41). `isCuratable` stays.
- `src/components/ArticleView.tsx` — remove `isCommonsPage` computation (174-185) and prop (492); drop `belongsInCommons` import (line 8; `isVaultEligible` stays). Comment at line 139 region may reference the realm — adjust if it does.

**DW-9 — middleware exemption:**
- `src/middleware.ts` — remove `AGENT_PUBLISH_RE` (line 73), its test in `authenticatesInRoute` (line 106), header-comment line 18.
- `src/lib/__tests__/middleware-write-gate.test.ts` — line 39: move `/api/agents/alice--yoyo/publish` expectation to the "does NOT exempt" block asserting `false` (the retired route needs no exemption).

**DW-28 — HomeDashboard:**
- `src/components/HomeDashboard.tsx`, `src/lib/home-dashboard.ts`, `src/lib/__tests__/home-dashboard.test.ts` — delete (component unmounted; `src/app/page.tsx` renders Workbench; only these files + tests reference them).
- `src/lib/__tests__/create-wiki-ui.test.ts` — retarget lines 199-204: keep `WikiWorkbench` has-no-h1 assertion; assert the `<h1>` owner is the shell — `src/components/workbench/Workbench.tsx` (wb-title at line 541; note its `read()` helper resolves inside `src/components/`, so path is `workbench/Workbench.tsx`).
- `src/lib/__tests__/workbench-chrome.test.ts` lines 506-517 — negative assertions on page.tsx; still pass unchanged.

## Tasks & Acceptance

**Execution:**
1. `src/lib/publish.ts` + `src/lib/__tests__/publish.test.ts` -- delete; `src/cli.ts` + `cli.test.ts` -- remove publish command/tests -- DW-1.
2. `src/lib/reconcile.ts` + `reconcile.test.ts` -- delete; `src/app/api/tasks/run/route.ts`, `src/lib/tasks.ts`, `src/lib/maintenance.ts` -- remove reconcile dispatch/types/producer; trim `tasks.test.ts`, `tasks-route.test.ts`, `scan-route.test.ts`, `maintenance.test.ts` -- DW-5 plumbing.
3. `src/mcp.ts`, `src/lib/mcp-http.ts` -- remove `reconcile_page` tool; trim `mcp.test.ts`, `mcp-http.test.ts`, `mcp-annotations.test.ts` -- DW-5 MCP.
4. `src/lib/lint-checks.ts`, `src/lib/lint.ts`, `src/lib/types.ts`, `src/lib/lint-fix.ts`, `src/components/LintFilterControls.tsx` (+ `useLint.ts` import check) -- remove the two discussion checks + types; trim `lint-checks.test.ts`, `lint.test.ts`, `lint-fix.test.ts` -- DW-5 lint.
5. `src/components/ArticleActions.tsx`, `src/components/ArticleView.tsx` -- drop `isCommonsPage` prop/branch/threading -- DW-6.
6. `src/middleware.ts`, `middleware-write-gate.test.ts` -- remove `AGENT_PUBLISH_RE` exemption; flip test expectation -- DW-9.
7. `src/components/HomeDashboard.tsx`, `src/lib/home-dashboard.ts`, `home-dashboard.test.ts` -- delete; `create-wiki-ui.test.ts` -- retarget h1 assertion at `workbench/Workbench.tsx` -- DW-28.
8. Full verification run (below) -- confirm no dangling imports or type errors anywhere.

**Acceptance Criteria:**
- Given the CLI, when invoked with `publish x --agent y`, then parseArgs returns the unknown-command error and `src/lib/publish.ts` no longer exists.
- Given a service-token POST to `/api/tasks/run` with `{kind:"reconcile",slug:"p",threadIndex:0}` or `{kind:"maintain",op:"reconcile",...}`, when handled, then the response is 400 "malformed task".
- Given a `tools/list` call on the stdio and HTTP MCP servers, when listed, then `reconcile_page` is absent, and the `lint_wiki`/`fix_lint_issue` schemas no longer accept `unresolved-discussions`/`disputed-page`.
- Given `authenticatesInRoute("/api/agents/alice--yoyo/publish")`, when evaluated, then it returns `false`, and every other exemption in `middleware-write-gate.test.ts` still returns its prior value.
- Given the landing page source, when tests run, then no file under `src/` references `HomeDashboard` or `buildHomeDashboardSnapshot`, and the retargeted h1 test pins `workbench/Workbench.tsx` as the `<h1>` owner while `WikiWorkbench.tsx` has none.
- Given the full suite, when `pnpm test`, `pnpm lint`, and `npx tsc --noEmit` run, then all pass with zero references to the deleted symbols outside git history.

## Spec Change Log

## Review Triage Log

### 2026-08-16 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 0, low 7)
- defer: 2: (high 0, medium 1, low 1)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[low]` `[patch]` `README.md:30` still advertised "contradictions reconcile on talk pages" — the retired reconcile-from-talk mechanism; reworded to "reconcile on merge", the live ingest-merge behavior.
  - `[low]` `[patch]` `SCHEMA.md` `disputed` row's set-by cell said "Set manually or by future contradiction resolution" — ingest's `parseDisputedMarker` sets it today and nothing clears it automatically; cell corrected.
  - `[low]` `[patch]` `middleware-write-gate.test.ts` comment claimed the retired publish route "answers 404 in-route; it needs no exemption" without noting bearer callers now stop at the 401 gate — the same distinction the first pass fixed in `public/agent-api.md`; comment clarified.
  - `[low]` `[patch]` No test passed a retired check type to `lint_wiki` (HTTP schema is free-form strings; rejection lives in the shared handler) — added a retired-check rejection test to `mcp-http.test.ts`; spec grep-exception list updated to name it.
  - `[low]` `[patch]` The retired-reconcile poison test asserted only `status === 400` — any other 400 branch would satisfy it; added `{ error: "malformed task" }` body assertions for both retired kinds.
  - `[low]` `[patch]` The retargeted h1 test decoupled `/<h1[\s>]/` from `toContain("wb-title")` and `Workbench.tsx` has two h1s, so the pin held even if `wb-title` moved off the h1 — tightened to one `<h1 className="wb-title">` token and renamed the stale test title.
  - `[low]` `[patch]` `mcp-annotations.test.ts` comment "The retirement removed six tools" went stale when `reconcile_page` became the seventh — reworded without the hand count.

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 0, low 9)
- defer: 4: (high 0, medium 2, low 2)
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[low]` `[patch]` `public/agent-api.md` claimed the retired publish route "answers 404"; with the middleware exemption removed a bearer caller gets 401 at the auth gate — doc reworded.
  - `[low]` `[patch]` `src/components/HomeAsk.tsx` orphaned by the HomeDashboard deletion (sole consumer) — deleted.
  - `[low]` `[patch]` Dead `.home-dashboard`/`.dashboard-*` CSS family in `src/app/globals.css` — 471 lines removed, zero remaining consumers.
  - `[low]` `[patch]` `mcp-http.test.ts` pinned only the tools/list omission for `reconcile_page`; added the tools/call unknown-tool assertion (parity with the publish_to_commons retired describe, completes I/O matrix row 3).
  - `[low]` `[patch]` `ArticleActions.tsx` doc comments were stale (commons Save-to-vault line, commons-first framing, overstated "mirrors authz.canWritePage" claim) — comments corrected, no code change.
  - `[low]` `[patch]` `src/app/api/agents/[id]/ingest/route.ts` asOwner comment still described the deleted "agent→commons publish path" — reworded to current behavior.
  - `[low]` `[patch]` New lint-checks test comment and a spec AC named a nonexistent `run_lint` tool — corrected to `lint_wiki`/`fix_lint_issue` in both.
  - `[low]` `[patch]` Spec Verification grep-exception list omitted the intentional pins in `mcp-http.test.ts`, `mcp-annotations.test.ts`, `lint-checks.test.ts` — list completed.
  - `[low]` `[patch]` `src/lib/retired.ts` header claimed all underlying lib modules were "deliberately left on disk", now partially false after deleting publish.ts/reconcile.ts — header adjusted.

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 1: (high 0, medium 0, low 1)
- reject: 17: (high 0, medium 0, low 17)
- addressed_findings:
  - `[medium]` `[patch]` The collapsed delete gate (`canDelete = isOwner || isSiteOwner`) — the one Always-constraint with no automated check; a wrong collapse or future edit would ship green — added `src/lib/__tests__/article-actions-gate.test.ts` pinning the gate expression by source scan (repo idiom) and asserting no commons realm flag returns to ArticleActions/ArticleView.
  - `[low]` `[patch]` `SCHEMA.md` still documented the retired `unresolved-discussions`/`disputed-page` checks as live (two bullets, the `disputed` row's used-by cell, "nine of sixteen"/"seven exceptions" counts) — residue removed, counts corrected to fourteen; the rewritten sentence's pre-existing `supersedes-dangling` misclassification (it IS auto-fixable via `fixSupersededDangling`) corrected in passing rather than perpetuated.
  - `[low]` `[patch]` Spec Verification grep swept only `src workers`, so doc residue (found in `SCHEMA.md`) escaped it — scope widened to `src workers public *.md`; exception list updated for the new pin test.
  - `[low]` `[patch]` `src/lib/maintenance.ts` body comments still numbered (2)/(3)/(4) after the (1) disputed→reconcile block was deleted — renumbered (1)/(2)/(3).
  - `[low]` `[patch]` I/O matrix row 1 promises "error + help pointer" but `cli.test.ts` asserted only the unknown-command half — help-pointer assertion added.
  - `[low]` `[patch]` `public/agent-api.md` §5 read "is retired: the … route is retired — … — and …" (double "retired", nested em-dash asides) — sentence restructured, same facts.

**Commands:**
- `npx tsc --noEmit` -- expected: no type errors (proves no dangling imports/union members).
- `pnpm test` -- expected: full Vitest suite green.
- `pnpm lint` -- expected: no unused-import or other ESLint errors.
- `grep -rn "publishToCommons\|reconcileFromTalk\|reconcile_page\|checkUnresolvedDiscussions\|checkDisputedPages\|unresolved-discussions\|disputed-page\|isCommonsPage\|AGENT_PUBLISH_RE\|HomeDashboard\|buildHomeDashboardSnapshot" src workers public *.md` -- expected: no hits except intentional retirement pins — negative assertions in `workbench-chrome.test.ts` (page.tsx must NOT contain HomeDashboard), the retired-tool omission and retired-check rejection tests in `mcp-http.test.ts` and `mcp-annotations.test.ts` (name lists + retirement comment), the retired-check negative assertions in `lint-checks.test.ts`, and the delete-gate pin in `article-actions-gate.test.ts` (ArticleActions/ArticleView must NOT contain isCommonsPage). Doc scope (`public` + root `*.md`) added by the follow-up review pass after retired-check residue surfaced in `SCHEMA.md`.

## Auto Run Result

Status: done

**Summary:** Second follow-up review pass over the retire-dead-machinery bundle (DW-1, DW-5, DW-6, DW-9, DW-28). Four parallel review layers ran against the full diff since baseline `1aac75ea210dc301d99597d6c4add020d7942f79`. The verification-gap layer found no gaps and the intent-alignment audit judged the diff a faithful implementation of the broadest defensible reading of the intent. This pass applied seven low-severity doc/test-polish patches, deferred two findings, and rejected nine.

**Files changed this pass:**
- `README.md` — "reconcile on talk pages" → "reconcile on merge" (retired-mechanism prose residue).
- `SCHEMA.md` — `disputed` row set-by cell corrected (ingest sets it today; nothing clears it automatically).
- `src/lib/__tests__/middleware-write-gate.test.ts` — comment clarified: bearer callers stop at the 401 gate; the 404 is in-route when reached.
- `src/lib/__tests__/mcp-http.test.ts` — added `lint_wiki` retired-check rejection test (handler-level, since the HTTP schema is free-form strings).
- `src/lib/__tests__/tasks-route.test.ts` — poison test now asserts the `{ error: "malformed task" }` body for both retired kinds, not just status 400.
- `src/lib/__tests__/create-wiki-ui.test.ts` — h1 pin tightened to the single `<h1 className="wb-title">` token; stale test title renamed.
- `src/lib/__tests__/mcp-annotations.test.ts` — stale "removed six tools" hand count reworded.
- `_bmad-output/implementation-artifacts/spec-retire-dead-machinery.md` — grep-exception list updated for the new rejection test; two deferred items and this pass's triage log appended.

**Review findings breakdown:** 7 patches applied (all low). 2 deferred: workers/task-consumer docs still describe reconcile as live work (medium — the intent's Never forbids touching that directory) and `talk.ts` `getDiscussionStats` newly orphaned by this story (low — talk.ts is intent-protected, AD-21). 9 rejected: spec-text tensions the I/O matrix already resolves (404/401), workflow-conformant frontmatter/change-log observations, findings already ledgered as DW-75/77/78/79, and runtime-surface test observations where the repo's unit-surface idiom pins the deciding function.

**Follow-up review recommendation:** patched counts — high 0, medium 0, low 7; score = 3×0 + 1×7 = 7 ≥ 5 → `followup_review_recommended: true`.

**Verification performed:**
- `npx tsc --noEmit` — clean.
- Full Vitest suite (`vitest run`, invoked directly because a stray `~/pnpm-workspace.yaml` outside this repo currently breaks `pnpm <script>`) — 205 files, 4282 tests, all green.
- `eslint` (the `pnpm lint` script body) — no warnings or errors.
- Spec residue grep over `src workers public *.md` — zero hits outside the enumerated intentional pin files.
- Spec frontmatter re-parsed as YAML — `deferred` is one list of 7 items with intended text intact.

**Residual risks:** The 401-at-middleware behavior for the retired publish route is pinned at the `authenticatesInRoute` unit surface, not by an HTTP-level middleware test (repo idiom; the generic non-exempt 401 path is pre-existing and unchanged). Stdio MCP unknown-tool behavior for `reconcile_page` rests on the SDK default plus the registration-set pin. workers/task-consumer doc residue remains by intent constraint (deferred, medium).

