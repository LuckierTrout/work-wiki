---
title: 'Epic 8 exact-head review remediation'
type: 'bugfix'
created: '2026-08-26'
status: 'in-progress'
review_loop_iteration: 0
baseline_commit: 6b255de958984951773e7b946c7c57aa17733605
context:
  - _bmad-output/implementation-artifacts/epic-8-retro-2026-08-25.md
  - _bmad-output/implementation-artifacts/epic-8-sidecar-runtime.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Exact-head review of `6b255de958984951773e7b946c7c57aa17733605` found three release blockers: missing-leaf and re-pointed paths can evade shell approval containment; a nested Source listing failure can silently lose work or invalidate pagination; and the registry poller does not maintain trustworthy `currentId` lifecycle state.

**Approach:** Make canonical path snapshots immutable and missing-leaf aware, fail implicit rescan before queueing when any listing branch is unreadable, and make current-Wiki identity an explicit fail-closed registry snapshot. Add mutation-grade regressions, commit the result, and run fresh exact-head command gates and independent review.

## Boundaries & Constraints

**Always:** Preserve server-owned, single-use capability scope; keep the sidecar free of `src/lib` imports; treat incomplete Source enumeration as unavailable rather than complete; retain explicit last-good path rows while refusing an unresolved `current` door; preserve the existing Node ESM sidecar and five SSE event names.

**Ask First:** Any public cursor/body-shape change, weakening of Wiki/conversation capability binding, or change to the Node sidecar decision.

**Never:** Start the large `server.mjs`/`ChatCanvas.tsx`/Settings architecture split; edit `llm-wiki.md`, `.github/`, `.yoyo/`, frozen identifiers, intent contracts, or the orchestrator-owned deferred-work ledger; claim acceptance from story status or tests without a clean exact-head review.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Missing leaf under symlink | `workspace/escape -> outside`, target leaf absent | Target is outside; modal is required | No spawn before approval |
| Path re-pointed after modal | Approval-time canonical target changes before resume | Immutable stored snapshot differs from live target | Deny with path-changed result; do not remember executable |
| Spawn never starts | Approved executable resolves to ENOENT | Approval is not persisted | Next attempt still requires approval |
| Nested Source listing fails | One unreadable descendant plus readable siblings | No paths queue and no offset advances | `listing_unavailable`, HTTP 503, `nextCursor: null`; retry from original cursor |
| Remote current lifecycle | Good A, then empty or failed poll | Empty clears A; failure retains explicit rows but current-door authority becomes unknown | `/current` Chat refuses until identity is authoritative |
| Local current lifecycle | No-token disk registry names A, then B | Refresh derives and rotates current UUID | Ambiguous/invalid registry yields no current authority |

</frozen-after-approval>

## Code Map

- `sidecar/workspace.mjs:219-242` -- `contains` and the lexical missing-leaf fallback; add one nearest-existing-ancestor canonicalizer shared with shell classification.
- `sidecar/shell.mjs:107-158,226-255` -- capture canonical external targets, compare stored snapshots without re-following them, and report whether spawn actually started.
- `sidecar/agent.mjs:784-840` -- recheck immediately before spawn and remember the executable only after the child starts.
- `sidecar/loopback.mjs:612-761` -- disk registry reader and remote snapshot lifecycle for rows/current identity.
- `sidecar/server.mjs:796-803,880-895` -- refuse `/current` tool turns while the poller cannot resolve an authoritative UUID; keep exact capability matching.
- `src/lib/workbench-files.ts:401-497` -- nested listing errors currently degrade into a lossy partial page.
- `src/lib/source-rescan.ts:83-106` and `src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts:91-105` -- retain terminal `listing_unavailable` behavior and ensure no queue side effects.
- `src/lib/__tests__/epic8-chat-agent.test.ts` and `src/lib/__tests__/epic8-remediation.test.ts` -- focused security, registry, listing, route, and mutation regressions.

## Tasks & Acceptance

**Execution:**
- [x] `sidecar/workspace.mjs`, `sidecar/shell.mjs`, `sidecar/agent.mjs` -- implement fail-closed canonical snapshots and post-spawn approval persistence.
- [x] `src/lib/workbench-files.ts` -- make any incomplete implicit Source enumeration fail atomically.
- [x] `sidecar/loopback.mjs`, `sidecar/server.mjs` -- make remote/local current identity lifecycle authoritative and block unresolved current-door pauses.
- [x] Relevant test files -- cover missing leaves, symlink re-pointing, failed spawn, nested read failure with siblings and retry, remote empty/failure, local current rotation, and real server-issued current-to-UUID resume.
- [ ] Commit the remediation, then run same-SHA typecheck, lint, full Vitest, focused exploit gates, and three independent review lenses.

**Acceptance Criteria:**
- Given each known-bad mutation from the `6b255de9` review, when it is restored independently, then at least one focused test fails.
- Given the remediation commit, when all required gates and independent lenses run against its exact SHA, then the worktree remains clean and no architecture-split changes appear.

## Spec Change Log

## Design Notes

The current numeric rescan cursor is an offset over a complete ordered set. A partial tree cannot produce a safe offset, so the smallest honest behavior is an atomic retryable failure before queueing—not partial success or a new cursor protocol. Current-Wiki identity follows the same principle: explicit last-good paths may remain usable, but the mutable `current` alias cannot authorize a pause while its UUID is unknown.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/epic8-chat-agent.test.ts src/lib/__tests__/epic8-remediation.test.ts src/lib/__tests__/epic8-v1-routes.test.ts` -- expected: all focused regressions pass and mutation reversions fail.
- `pnpm exec tsc --noEmit` -- expected: exit 0.
- `pnpm lint` -- expected: exit 0.
- `pnpm test` -- expected: complete full-suite exit 0 on the committed SHA.
