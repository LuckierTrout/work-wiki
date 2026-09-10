---
title: 'Bulk history deletion: owner resolution and strict absence'
status: done
baseline_commit: e289968a9dc53d202ab7650f64b9bdeb3d59c00c
---

## Intent

Implement DW-768 and DW-770 under the owner-approved deferred-work plan. A selected owner-silo orphan must be deleted through the lifecycle before its terminal job is cleared. An indeterminate storage read must retain the job evidence and report a retryable failure; only confirmed absence permits cleanup without deleting a page.

## Boundaries

Preserve route authentication, read-only refusal, whole-batch active-job and delete-ACL gates, per-item read cloaking, raw-source behavior, and the shared lifecycle. The caller supplies an explicit owner resolution hint separately from the actor. The authorized page bytes become the locked delete precondition. No cloud actions, identifiers, protected configuration, historical frozen contracts or manual ledger changes.

## Implementation

- Fresh strict owner-aware reads for indexed and hidden-index absence checks; per-item verification failures retain jobs while unrelated confirmed-absent jobs can clear.
- Carry the owner hint into lifecycle title and locked pre-delete reads; compare the bytes admitted by the route before deleting.
- Real history DELETE → lifecycle → temporary filesystem tests for silo-only deletion and indexed read failures, including hidden-index and mixed-batch cases.

## Validation

Local validation: 52 focused route/composition tests pass. Full suite: 413 files passed, 10,160 tests passed and one existing skip (150.59 seconds). Full lint passes with the three existing TSNonNullExpression diagnostics. Production build with synthetic public identity, standalone TypeScript and diff checks pass. The initial sandbox-restricted full run was stopped after socket-dependent failures and rerun with local networking enabled; only the completed rerun counts as evidence.

The owner explicitly approved public publication of this packet on 2026-09-10. Exact-head CI and merge are complete; the orchestrator reconciles the corresponding ledger entries.

## Merge evidence

[PR #31](https://github.com/LuckierTrout/work-wiki/pull/31) merged on 2026-09-10 as `4a64156d6e7b2f31268f53c120ea47d2e92bf62c`. Application, Browser E2E and Sandbox Worker checks all passed on exact head `bf958297b341bf51fda6cbd4341ceea4d18246f0` in [CI run 34514831533](https://github.com/LuckierTrout/work-wiki/actions/runs/34514831533). No production deployment is claimed.
