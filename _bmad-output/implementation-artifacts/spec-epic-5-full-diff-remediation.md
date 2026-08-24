---
title: 'Remediate the remaining Epic 5 full-diff findings'
type: 'bugfix'
created: '2026-08-24'
status: 'done'
review_loop_iteration: 0
baseline_commit: '15a34824debd64d5cd0e731c5f68cf80918f589c'
context:
  - AGENTS.md
  - .yoyo/learnings.md
  - _bmad-output/implementation-artifacts/spec-5-1-through-5-10-see-the-wikis-shape.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The post-Chunk-4 full-diff review found remaining scope, recovery, write-safety, scaling, compatibility, and verification defects across Epic 5. Several can expose another Wiki's Review state, lose or duplicate work, overwrite concurrent edits, or leave regressions unobserved.

**Approach:** Patch only findings validated against the current tree, grouped by feature area. Preserve legacy unscoped Review items, keep `wikiId` as queue scope only, and verify every chunk before continuing.

## Boundaries & Constraints

**Always:** Keep legacy Review rows without `wikiId` visible under every explicit current-Wiki scope. Keep Page publication tenant-scoped and independent of queue `wikiId`. Route Page mutations through the shared lifecycle. Preserve existing user changes and protected identifiers.

**Ask First:** Any product-rule change, destructive migration, deployment, or edit to protected `.github/`, `.yoyo/yoyo.toml`, `SCHEMA.md`, or `llm-wiki.md`.

**Never:** Edit the existing Epic 5 `<intent-contract>`, reorganize its prose, flip the retrospective verdict, clear `followup_review_recommended`, mutate `deferred-work.md`, commit, or treat local verification as production Worker/R2 proof.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Review scope | Missing/late/stale Wiki scope | HTTP refuses missing scope; old UI responses cannot update the new Wiki | Preserve legacy unscoped rows inside explicit scope |
| Review recovery | Partial lifecycle, expired claim, replayed outbox | Repair before completion; renew live claims; dedupe terminal delivery | Retry or dead-letter without hiding incomplete work |
| Mechanical fix | Transient read or concurrent Page edit | No destructive mutation or overwrite | Surface changed/indeterminate issue and rerun Lint |
| Graph | Large/overlapping Insight sets and legacy dismissals | Bounded deduplicated reads; unchanged dismissals stay hidden and migrate | Reject oversized dismissal inputs |
| Verification | Failure and UI-event paths regress | Executable assertions fail | No source-order or click-without-observation substitutes |

</frozen-after-approval>

## Code Map

- `src/components/workbench/ReviewCanvas.tsx`, `Workbench.tsx` -- fence list/research state by Wiki and avoid unscoped no-Wiki requests.
- `src/app/api/review-queue/{route.ts,[id]/route.ts}` -- require explicit queue scope after auth/read-only gates.
- `src/lib/review-queue.ts`, `ingest-async.ts` -- optional real scope, delivery identity, bounded retry/dead-letter, claim renewal, and lifecycle repair.
- `src/lib/wiki.ts`, `lifecycle.ts` -- strict reads and provider-CAS expected-content lifecycle publication.
- `src/lib/lint-fix.ts`, `workbench-lint.ts`, `workbench-lint-fix.ts`, `markdown-link-rewrite.ts` -- fail-closed mechanical fixes and external-link preservation.
- `src/lib/research-prefill.ts`, `app/api/graph/workbench/route.ts` -- request-local bounded Page reads.
- `src/lib/graph-surprise.ts`, `graph-insight-dismissals.ts`, `app/api/graph/insights/route.ts` -- bounded fingerprints and one-time legacy reconciliation.
- `src/lib/__tests__/**`, `src/components/workbench/__tests__/**`, `e2e/workbench-owner.spec.ts` -- focused regression coverage. Existing Epic 5 spec/retro acceptance metadata is read-only.

## Tasks & Acceptance

**Execution:**
- [x] Patch Review UI/API scope fencing and legacy-row regression coverage.
- [x] Patch Review delivery/recovery, replay identity, bounded retry, claim renewal, and lifecycle repair.
- [x] Patch strict reads, CAS-backed mechanical writes, cached orphan repair, and external-link handling.
- [x] Patch Graph read budgets, bounded dismissal identities, and legacy fingerprint migration.
- [x] Replace weak storage, Sigma interaction, and ingest-fallback verification.
- [x] Run TypeScript, affected ESLint, focused tests per chunk, then final verification.

**Acceptance Criteria:**
- Given a Wiki switch or missing HTTP scope, when Review work completes, then only the explicit current-Wiki view changes and legacy unscoped rows remain visible.
- Given partial or repeated Review delivery, when recovery runs, then incomplete lifecycle work stays recoverable and a resolved delivery is not recreated.
- Given transient storage failure or a competing Page edit, when Lint fixes run, then no valid link, index row, or newer Page bytes are overwritten.
- Given large Graph inputs or persisted old fingerprints, when Graph loads, then reads and stored identities are bounded and unchanged dismissals migrate without reappearing.
- Given each previously weak verification path regresses, when focused tests run, then an observable assertion fails.

## Spec Change Log

## Design Notes

An unresolved Review scope is represented by omitted `wikiId`, not the synthetic string `current`. That preserves the explicit ruling for legacy rows without turning queue scope into a Page destination. Mechanical rewrites carry the exact source bytes into the shared lifecycle so provider CAS can reject stale transforms before index or log side effects.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean after every chunk.
- `pnpm exec vitest run <focused files>` -- expected: affected suites pass after every chunk.
- `pnpm exec eslint <affected files>` -- expected: no findings after every chunk.
- `git diff --check` -- expected: clean final diff; no commit created.

## Suggested Review Order

**Review delivery and recovery**

- Start with the bounded, CAS-retried queue mutation and lifecycle recovery kernel.
  [`review-queue.ts:437`](../../src/lib/review-queue.ts#L437)

- Backpressure preserves active deliveries while bounding terminal deadletters.
  [`review-queue.ts:897`](../../src/lib/review-queue.ts#L897)

- Forced CAS conflicts prove queue and outbox mutations are reapplied.
  [`review-queue.test.ts:954`](../../src/lib/__tests__/review-queue.test.ts#L954)

**Safe Page publication**

- Filesystem writers share a byte-hash CAS publication lock.
  [`filesystem.ts:63`](../../src/lib/storage/filesystem.ts#L63)

- Lifecycle expected-content writes reject stale transformations before side effects.
  [`lifecycle.ts:239`](../../src/lib/lifecycle.ts#L239)

- Executable interleaving coverage proves competing Page edits survive.
  [`stale-index-lifecycle.test.ts:143`](../../src/lib/__tests__/stale-index-lifecycle.test.ts#L143)

**Wiki-scoped Review UI**

- Wiki changes fence list, action, and research completion state.
  [`ReviewCanvas.tsx:46`](../../src/components/workbench/ReviewCanvas.tsx#L46)

**Graph compatibility and bounded work**

- Exact legacy fingerprints migrate dismissals without resurfacing unchanged Insights.
  [`graph-surprise.ts:62`](../../src/lib/graph-surprise.ts#L62)

- Research prefill fairly allocates the fixed Page-read budget.
  [`research-prefill.ts:33`](../../src/lib/research-prefill.ts#L33)

- Fit tolerates missing display records and preserves remaining nodes.
  [`GraphCanvas.tsx:347`](../../src/components/workbench/GraphCanvas.tsx#L347)

**Behavioral verification**

- Sigma tests observe zoom, hover, and reducer behavior directly.
  [`graph-lint-review-canvas.test.tsx:168`](../../src/components/workbench/__tests__/graph-lint-review-canvas.test.tsx#L168)

- Legacy-format tests cover every committed fingerprint shape.
  [`graph-surprise.test.ts:121`](../../src/lib/__tests__/graph-surprise.test.ts#L121)
