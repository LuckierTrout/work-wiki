---
title: 'Correct two stale in-repo claims: .yoyo/status.md metrics and the poison-task DLQ comments'
type: 'chore'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
baseline_revision: '959a4bde89f31ac5a10042078c4df8f890e7d708'
deferred:
  - summary: >-
      `.yoyo/status.md` tech-debt item 1 still says the repo has no E2E browser
      tests, but a Playwright suite exists and now carries a fresh 2026-09-05
      date stamp.
    evidence: |-
      Line 30 reads "No E2E browser tests — Unit and integration tests are
      strong (9,672) but no Playwright/Cypress tests". The repo has
      `playwright.config.ts`, three specs under `e2e/`
      (`retired-routes.spec.ts`, `workbench-layout.spec.ts`,
      `workbench-owner.spec.ts`) and `"test:e2e": "playwright test"` in
      `package.json`. This pass refreshed only the parenthetical figure on that
      line — the intent scoped the edit to the metrics block, the Generated date
      and the repeated figures — so the false sentence survived and was re-dated
      with the rest of the document. The real remaining gap is CI: no workflow in
      `.github/workflows/` invokes `test:e2e`. An owner reading this item would
      plan browser-test work that is already done.
    location: >-
      .yoyo/status.md:30
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two in-repo claims are false today. `.yoyo/status.md` still reports a
2026-06-02 snapshot (58 test files, 2,054 tests, 32 API routes, ~56,082 lines, 12
frontmatter fields) against 386 test files, 9,672 passing tests, 149 `route.ts`
files and ~360,810 lines now. Separately, three comments say a poison task goes to
the DLQ, but `workers/task-consumer/index.ts` acks and drops poison messages on the
spot; only the transient/retry branch ever reaches `yopedia-tasks-dlq`.

**Approach:** Refresh the stale figures, the `Generated` date and its two repeats in
`.yoyo/status.md` with measured values, and align the three stale poison comments to
the wording that already exists verbatim at `src/app/api/tasks/run/route.ts:145-146`.

## Boundaries & Constraints

**Always:** Use the measured values recorded in Design Notes — do not re-estimate.
Keep each edited line's existing shape, tone and wrap width. The DLQ rewording must
say the same thing as `src/app/api/tasks/run/route.ts:145-146` ("discarded on the
spot and never reaches the DLQ") without copying that block wholesale.

**Block If:** `pnpm test` no longer passes clean, or the measured counts in Design
Notes cannot be reproduced by the commands in Verification.

**Never:** Do not touch the `MCP tools` (40) or `Lint checks` (15) bullets — both were
verified accurate this pass. Do not rewrite, remove or renumber any `Known tech debt`
item; only the parenthetical figure inside item 1 changes. Do not touch the
`work-wiki Phase Progress` table. Do not change any DLQ mention outside the three
sites named in the Code Map — every other one describes the transient path and is
correct. Do not change executable code, only comments and the status document. Do not
edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Poison task (400/404/422) | Consumer POSTs a malformed body to `/api/tasks/run` | Consumer acks and returns; message discarded on the spot, never enqueued to `yopedia-tasks-dlq` | No error expected — this is the documented drop path |
| Transient failure (other 4xx / 5xx) | Consumer POSTs a valid task, route answers 403/429/500 | Consumer retries; after `max_retries: 3` Cloudflare parks the message in `yopedia-tasks-dlq` | Retry, then DLQ — not dropped |

</intent-contract>

## Code Map

- `.yoyo/status.md` -- 37 lines. Stale figures at L3 (`**Generated:** 2026-06-02`),
  L4 (`2,054 tests, 32 API routes`), L10 (`Total lines`), L11 (`Test files: 58`),
  L12 (`Test count: 2,054`), L13 (`12 frontmatter fields (...)`), L14 (`API routes:
  32`), L30 (tech-debt item 1's `(2,054)`), L37 (`generated on 2026-06-02`). The
  intent's "line 49" is a mis-numbering of the wrapped view — the only other repeated
  figure is L30. L15/L16 (MCP tools, lint checks) are verified correct — read-only.
- `src/app/api/tasks/run/route.ts:143-152` -- READ-ONLY anchor. The correct status
  contract: 400/404/422 "discarded on the spot and never reaches the DLQ"; other 4xx
  "retried, then parked in the DLQ".
- `workers/task-consumer/index.ts:113-125` -- READ-ONLY evidence. The 400/404/422
  branch calls `message.ack(); return;`. The DLQ is reached only past line 128.
- `src/lib/tasks.ts:328` -- inside the `MAINTAIN_FIX_TYPES` JSDoc: "so the task was
  poison and / went to the DLQ with `tsc` perfectly happy." Stale site 1.
- `src/lib/tasks.ts:454` -- inside the `parseTask` JSDoc: "reject malformed / messages
  as poison (4xx -> DLQ) rather than retrying them forever." Stale site 2.
- `src/lib/__tests__/prose-inventory-parity.test.ts:347` -- inside the rationale
  comment for `it("parseTask dispatches on exactly the Task kinds")`: "(poison ->
  DLQ)". Stale site 3. This file's assertions read the `switch (t.kind)` block of
  `tasks.ts` and the fix-type lists in `maintenance.ts` / the consumer README — none
  of them parse the JSDoc prose being edited, so these edits cannot move a parity
  assertion.
- `SCHEMA.md:56-74` -- READ-ONLY source of truth for the frontmatter field set: 6 base
  fields plus a 12-row work-wiki table.

## Tasks & Acceptance

**Execution:**
- `.yoyo/status.md` -- replace the nine stale spots listed in the Code Map with the
  measured values in Design Notes, leaving L15/L16 and the tech-debt prose untouched
  -- the document's header and metrics block currently misreport the repo by roughly
  6x on lines and 4.7x on tests.
- `src/lib/tasks.ts` -- reword the two poison/DLQ clauses (L328, L454) so each says the
  poison message is acked and discarded on the spot and never reaches the DLQ --
  the consumer drops it there; the DLQ only ever holds transient-exhaustion messages.
- `src/lib/__tests__/prose-inventory-parity.test.ts` -- reword the `(poison -> DLQ)`
  aside at L347 the same way -- it restates the same false claim inside a passing
  test's rationale.

**Acceptance Criteria:**
- Given `.yoyo/status.md` after the edit, when its `Test files`, `Test count` and
  `API routes` bullets and the figures on L4 are compared to `pnpm test` output and
  `find src/app/api -name route.ts | wc -l`, then every figure matches exactly.
- Given `.yoyo/status.md` after the edit, when the `Generated` line and the closing
  `*This report was generated on ...*` line are read, then both say `2026-09-05`.
- Given `.yoyo/status.md` after the edit, when the `MCP tools` and `Lint checks`
  bullets and all four `Known tech debt` items are diffed, then only the `(2,054)`
  figure inside tech-debt item 1 has changed.
- Given a repo-wide search for `DLQ`, when the three sites in the Code Map are read,
  then none of them claims a poison message reaches the DLQ, and every remaining
  mention still describes the transient/retry path.
- Given `pnpm test` and `npx tsc --noEmit` after the edits, when both are run, then
  both pass with the same 386-file / 9,672-test result as before.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 1: (high 0, medium 0, low 1)
- reject: 6
- addressed_findings:
  - `[low]` `[patch]` The three reworded DLQ sites used three different verbs
    ("discarded on the spot" / "dropped on the spot" / "dropped"), so no single
    phrase tied them to the `route.ts:145-146` anchor the intent said to align
    to. Settled all three on the anchor's "discarded"; `src/lib/tasks.ts:455-456`
    and `src/lib/__tests__/prose-inventory-parity.test.ts:347-348` rewrapped
    accordingly.

Rejected, with reasons: (1) `.yoyo/status.md:22`'s Phase 1 row enumerates nine
frontmatter fields against the metrics bullet's eighteen — a pre-existing drift
in a phase-history row, not the metrics block the intent named. (2) `Total lines`
counts `src/**` only, omitting `workers/` and `e2e/` — the same scope the bullet
always used; the pass preserved the convention rather than changing it.
(3) A reviewer proposed redefining the `mcp` bucket as
`src/lib/mcp-http.ts` + `src/app/api/mcp/route.ts` (~1,493); that is smaller than
the bullet's own 2026-06-02 figure of 2,344, so it cannot be the original
definition — `wc -l src/mcp.ts` = 3,446 is. (4) `title` was dropped from the
field list: `SCHEMA.md:33` puts the title in the page body as an H1, and
`frontmatter.ts:225` only guards `title` defensively on untrusted input, so the
canonical eighteen are right. (5) Narrowing `parseTask`'s JSDoc from `4xx` to
`400` was not requested but is exact — `route.ts:211` is the only status that
`parseTask` returning `null` can produce. (6) No test was added to pin the
refreshed counts; the intent asked to refresh the figures, and pinning a live
test count inside a status document would break CI on every added test.

## Design Notes

Measured on 2026-09-05, at the tip of `epic8-stories1-9` with a clean tree:

- `find src/app/api -name route.ts | wc -l` -> **149**
- `pnpm test` -> **Test Files 386 passed (386)**, **Tests 9672 passed | 1 skipped (9673)**
- `npx tsc --noEmit` -> exit 0, no output
- Line counts over `src/**/*.{ts,tsx}` (buckets exclude `__tests__`, which is its own
  bucket; the six buckets below sum to 359,233 of a 360,810 total, the 1,577 residual
  being `cli.ts`, `middleware.ts` and `src/test/`):
  total **360,810** · lib **84,586** · tests **212,791** · components **33,818** ·
  app **21,205** · hooks **3,387** · mcp **3,446**
  `app` is a new bucket in the parenthetical: at 21,205 lines it is now the fourth
  largest and omitting it would leave a 22,782-line hole in a figure this pass is
  meant to make trustworthy.
- Frontmatter fields per `SCHEMA.md:56-74`: **18** = 6 base (`type`, `source_url`,
  `tags`, `created`, `updated`, `source_count`) + 12 work-wiki (`confidence`,
  `expiry`, `valid_from`, `owner`, `visibility`, `authors`, `contributors`,
  `content_hash`, `disputed`, `supersedes`, `aliases`, `sources`). The current
  bullet's list is wrong in composition as well as count — it names `title` and omits
  `owner`, `visibility`, `content_hash` and four of the six base fields.
- MCP tools: 40 `server.registerTool(` calls in `src/mcp.ts` — bullet is correct.
- Lint checks: `ALL_CHECK_TYPES` in `src/lib/lint-types.ts` has 15 members in the
  bullet's order — bullet is correct.

Golden wording for the three DLQ sites, matching `route.ts:145-146` without copying it:

    // src/lib/tasks.ts:328
    ... so the task was poison — acked and
     * discarded on the spot, never reaching the DLQ — with `tsc` perfectly happy.

    // src/lib/tasks.ts:454
    ... to reject malformed
     * messages as poison (400 -> acked and dropped on the spot, never reaching the
     * DLQ) rather than retrying them forever.

    // prose-inventory-parity.test.ts:347
    ... a runtime `null` from `parseTask` (poison -> acked and
       * dropped, never reaching the DLQ), so pin the switch here ...

Use the file's real `→` arrow character where the existing line uses one; the ASCII
`->` above is only to keep this spec plain.

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: exit 0, no output
- `pnpm test` -- expected: `Test Files  386 passed (386)`, `Tests  9672 passed | 1 skipped (9673)`
- `find src/app/api -name "route.ts" | wc -l` -- expected: 149, matching the refreshed `API routes` bullet
- `grep -rn "DLQ" src workers *.md | grep -v vendor/yoyo-reference` -- expected: no remaining line claims a poison message reaches the DLQ
- `git diff --stat` -- expected: exactly 3 files changed (`.yoyo/status.md`, `src/lib/tasks.ts`, `src/lib/__tests__/prose-inventory-parity.test.ts`)

## Auto Run Result

Status: done

**Summary.** Corrected two false in-repo claims. `.yoyo/status.md` was a
2026-06-02 snapshot reporting 58 test files, 2,054 tests, 32 API routes and
~56,082 lines against a repo that now measures 386 / 9,672 / 149 / ~360,810; its
header, metrics block and both date stamps were refreshed from measured values.
Separately, three comments claimed a poison task reaches the DLQ, but
`workers/task-consumer/index.ts:113-125` acks and returns on 400/404/422 — the
message is dropped on the spot, and only the transient-exhaustion branch reaches
`yopedia-tasks-dlq`. All three now say so, in the wording anchored at
`src/app/api/tasks/run/route.ts:145-146`.

**Files changed.**
- `.yoyo/status.md` — Generated date and closing date stamp to 2026-09-05; build-status figures to 9,672 tests / 149 API routes; Total lines, Test files, Test count, API routes and the frontmatter-field bullet re-measured; tech-debt item 1's parenthetical figure refreshed. `MCP tools` (40), `Lint checks` (15), the Phase Progress table and tech-debt items 2-4 are byte-identical.
- `src/lib/tasks.ts` — the `MAINTAIN_FIX_TYPES` and `parseTask` JSDoc no longer say a poison task reaches the DLQ.
- `src/lib/__tests__/prose-inventory-parity.test.ts` — the same claim, restated in a test's rationale comment, corrected.

**Review findings.** 1 patch applied (low), 1 item deferred (low), 6 rejected;
no intent gaps and no spec repairs.

**Follow-up review recommendation:** false. Patched findings by severity — high
0, medium 0, low 1. Score: no high-severity patch, so no further pass.

**Verification.**
- `npx tsc --noEmit` — exit 0, no output (run before and after the review patch).
- `pnpm test` — `Test Files 386 passed (386)`, `Tests 9672 passed | 1 skipped (9673)`, identical to the pre-change baseline and re-run after the patch.
- `find src/app/api -name "route.ts" | wc -l` — 149, matching the refreshed bullet.
- Repo-wide `DLQ` sweep across `src`, `workers` and the root docs — no surviving line pairs "poison" with the DLQ; every remaining mention describes the transient/retry path or names the `yopedia-tasks-dlq` resource.
- `git diff --stat` — exactly the three expected files.
- I/O matrix rows are covered by tests that ran and passed: the poison row by `task-consumer.test.ts:82` (422 → `entry.ack` called once, no retry), the transient row by `task-consumer.test.ts:93` (503 at attempt 4 → `entry.retry`).

**Residual risks.**
- Nothing enforces the refreshed figures. `src/lib/__tests__/mcp-annotations.test.ts` pins only the MCP tool list, which is why that bullet stayed correct while the rest drifted; `Test files`, `Test count`, `API routes` and `Total lines` will re-stale on their own. Adding a pin was outside this intent, and pinning a live test count to a status document would break CI on every added test.
- `.yoyo/status.md` tech-debt item 1 remains false (see the frontmatter `deferred` entry): a Playwright suite exists, and this pass re-dated the document around that sentence.
