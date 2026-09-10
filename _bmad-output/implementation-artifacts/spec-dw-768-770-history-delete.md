---
title: 'Bulk history deletion: owner resolution and strict absence'
status: in-review
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

Pending final local checks and exact-head CI. Existing route tests remain alongside the new composition suite. Ledger closure belongs to post-merge orchestrator reconciliation.
