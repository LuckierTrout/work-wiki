---
title: 'Write-safety migration: isolated cutover proof'
type: 'refactor'
created: '2026-09-07'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'b751141486778d6b7ee5a72c7a9eb6e894869b2a'
baseline_commit: 'b751141486778d6b7ee5a72c7a9eb6e894869b2a'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Legacy Workers write unconditionally. Locks and R2 copies do not prove safe cutover.

**Approach:** First prove transactional publication and cutover refusal in an isolated local runtime. Deliver an integration plan, not production wiring or readiness.

## Boundaries & Constraints

**Always:** Installed Miniflare/workerd, SQLite Durable Object, synthetic fixtures, separate old/new stores, temporary persistence. Workspace authority owns references/revision/generation/receipts/outbox. Upload before publication; recheck eligibility after I/O. Preserve existing runtime code and safety gates.

**Ask First:** Real data export, cloud provisioning, dependency changes, runtime integration, architecture adoption, merge or deployment. Approval covers local implementation/review only.

**Never:** Remote bindings, credentials, real external effects, deploy configuration, ledger edits, identifier renames or changed frozen contracts. No blob cleanup. No drain inference from time/logs/scans/checksums. No R2 transaction or exactly-once external-delivery claims.

## I/O & Edge-Case Matrix

| Scenario | Input/state | Expected result | Failure |
|---|---|---|---|
| Publish | Current generation/revision | Atomic multi-path references, tombstones, receipt/outbox | No mixed state |
| Stale work | Generation changes during upload | No publication | Stale-generation |
| Race | Same expected revision | One winner | Conflict |
| Retry | Same operation ID and digest | Original receipt | Changed digest conflicts |
| Crash | Before publish / after commit | Invisible orphan / persistent receipt | Safe retry |
| Legacy resume | Old-only bindings | New reads unchanged | Shared-resource fixture rejected |
| Capture gap | Changing source or unknown job/effect | Block cutover | Explicit reasons |

</frozen-after-approval>

## Code Map

Read-only: `src/lib/lock.ts` (lease bridge), `src/lib/storage/r2.ts` (unconditional R2/KV/Vectorize mutations), `src/lib/lifecycle.ts` (page composition), `src/lib/portable-archive.ts` (incomplete sequential export), `workers/task-consumer/index.ts` (ACK/retry/cron). Reuse local runtime patterns from `src/lib/__tests__/email-ingest-workerd.test.ts`. Preserve architecture AD-2/3/7/9/11/13 and lifecycle lessons in `.yoyo/learnings.md`.

## Tasks & Acceptance

**Execution:**
- [x] `tools/write-safety-lab/worker.mjs`: coordinator: validate bounded requests; hash canonical requests; upload verified create-only blobs; transactionally check generation/revision and publish references/tombstones/receipts/outbox. Reads/list/stat use references. Synthetic projection retries check revision.
- [x] `tools/write-safety-lab/preflight.mjs`: validator/local-file CLI for source consistency/inventory, isolated resources, pauses, jobs/effects and recovery. Reject malformed paths/digests, duplicates and unknown outcomes. Always emit `productionReady: false`; valid synthetic evidence is rehearsal-only.
- [x] `src/lib/__tests__/write-safety-workerd.test.ts`: drive actual local Worker → DO → R2 → reads through every matrix case, deterministic interleaving, persistent restart, stale deletes and projection retries. Deny outbound networking; dispose runtimes/owned temporary files. No skipped runtime cases or mock fallback.
- [x] `src/lib/__tests__/write-safety-preflight.test.ts`: execute validator/CLI on temporary fixtures; incomplete or inconsistent capture, shared resources and unresolved effects block. No input certifies production.
- [x] `docs/write-safety-cutover-design.md`: inventory authority/projections/operational state across admin/restore, R2/KV/Vectorize, jobs/queues/DLQ, cron/email, sidecar/API/MCP and external effects. Record evidence/live gaps, capture/reconciliation, resume/replay/quarantine and forward recovery. Propose architecture/resource additions; preserve AD-15 gates.

**Acceptance Criteria:**
- Given stale and current operations, when the local composition runs, then only eligible commits change published data.
- Given restart after commit-before-response, when retrying, then the original receipt returns without another revision increment.
- Given a changing legacy fixture or missing real evidence, when reporting, then source-consistency/production blockers remain explicit despite successful isolated publication tests.

## Spec Change Log

- 2026-09-08: Closed four review findings: hash stored bytes before decoding; reject unpaired surrogates before upload; reject FIFO input without blocking; read evidence through EOF within the size limit. A subsequent verification review added concrete projection-content/version assertions. Frozen intent and production boundaries are unchanged.

## Design Notes

Workspace scope covers global indexes/locks. Resource isolation neither proves source completeness nor suppresses old external effects. A safe live capture barrier remains unestablished; prototype success cannot clear it.

## Verification

- `pnpm exec vitest run --project node src/lib/__tests__/write-safety-workerd.test.ts src/lib/__tests__/write-safety-preflight.test.ts` — all cases execute/pass.
- `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test` — passed for the pre-PR review on 2026-09-08. The PR follow-up below distinguishes its focused local evidence from the required final-head CI gate.
- Whitespace verification includes the new, initially untracked files; the local commit contains this spec and five named new files only. Three historical review-input files remain outside the commit. No production/config/dependency/ledger edits.

## Implementation evidence

- Local branch: `fix/write-safety-cutover-proof`; baseline preserved above.
- Implemented directly after the prescribed context-free subagent launch failed with `agent thread limit reached`.
- Pre-PR focused composition/evidence suites at `f4decb5f055e2606abe05ea46cdfa92ac36fced7`: 22/22 passed (13 workerd cases, 9 checker cases), 2.55 seconds. Every matrix row has executed coverage; no runtime skips or mock fallback. New regressions reproduced all four original failures before their fixes.
- Pre-PR TypeScript and full lint passed. Full lint retains the three previously recorded TSNonNullExpression diagnostics.
- Pre-PR full suite: 401 files passed, 10,012 tests passed and one existing skip in `research-runtime.test.ts`; 119.94 seconds. This run followed the projection-test correction. No production or dependency changes.
- Matrix mapping: Publish → multi-path/tombstone test; Stale → barrier/advance test; Race → concurrent revisions; Retry → canonical/concurrent retries; Crash → before-publish, transaction rollback and persisted receipt restart; Legacy → old capability and shared-resource negative control; Capture → changing/incomplete evidence tests.

## Review disposition

- 2026-09-08: Resumed the in-review packet through `bmad-build`. All three context-free review layers ran successfully against the corrected six-file product diff. The full change inventory also accounted for the three historical review-input artifacts; their embedded old diffs were not treated as current implementation.
- Blind Hunter: no actionable findings. Edge Case Hunter: no findings. Verification Gap: one accepted `medium` / `patch` finding — projection delivery could be omitted while the existing assertions still passed.
- Patched the projection test to assert the full snapshot, unchanged path, tombstone, generation and revision; retries and obsolete deliveries must preserve the expected projection. Focused tests and all verification gates then passed. No intent gap, spec loopback, deferred-work entry or further review cycle was required.
- Disposition: local proof complete. The owner subsequently authorized PR #12 follow-up, push and merge once final-head CI passes. Production integration, real-data capture, architecture adoption and deployment remain outside this packet's authorization.

### PR #12 follow-up — 2026-09-08

- Accepted the malformed UTF-8 finding: decoding failures now return HTTP 400 `invalid-utf8` during both streamed decoding and EOF flush. The workerd regression reproduced the prior HTTP 500 and verifies malformed input leaves blobs, references, receipts and outbox unchanged.
- Clarified the digest boundary: operation/effect IDs are reconciled and `inputDigest` syntax is validated, but this synthetic checker does not compare the digest to captured bytes or an independently trusted inventory. Production input verification is separate approved work.
- Retained invisible orphan uploads as intended by the frozen no-cleanup boundary; the isolated runtime owns temporary persistence and removes it after disposal. No production resource-retention policy is introduced.
- Rejected the one-file review nit: the PR contains the six files named in this spec, as verified through GitHub's file list.
- Follow-up local validation: 23/23 focused tests passed (14 workerd, 9 checker), plus TypeScript and focused ESLint. The earlier full-suite totals above are historical; the new commit must pass both Application and Sandbox Worker CI before merge. Final CI and merge evidence are recorded on PR #12.

## Suggested Review Order

**Design and authority**

- Start with the proposed commit boundary and its explicit production limits.
  [write-safety-cutover-design.md:7](../../docs/write-safety-cutover-design.md#L7)

- Check transactional eligibility, immutable uploads, references, receipts and outbox publication.
  [worker.mjs:71](../../tools/write-safety-lab/worker.mjs#L71)

- Verify input validation rejects text that cannot survive UTF-8 encoding unchanged.
  [worker.mjs:18](../../tools/write-safety-lab/worker.mjs#L18)

- Read published references and verify stored bytes before decoding.
  [worker.mjs:129](../../tools/write-safety-lab/worker.mjs#L129)

**Cutover refusal**

- Keep the unresolved live capture barrier explicit.
  [write-safety-cutover-design.md:124](../../docs/write-safety-cutover-design.md#L124)

- Validate synthetic evidence without authorizing production.
  [preflight.mjs:15](../../tools/write-safety-lab/preflight.mjs#L15)

- Reject non-files and consume bounded evidence through EOF.
  [preflight.mjs:75](../../tools/write-safety-lab/preflight.mjs#L75)

**Executed evidence**

- Assert projection contents and versions through retries and obsolete deliveries.
  [write-safety-workerd.test.ts:165](../../src/lib/__tests__/write-safety-workerd.test.ts#L165)

- Exercise corrupt bytes and malformed Unicode in real local workerd.
  [write-safety-workerd.test.ts:214](../../src/lib/__tests__/write-safety-workerd.test.ts#L214)

- Exercise real named pipes and forced short reads through the CLI.
  [write-safety-preflight.test.ts:84](../../src/lib/__tests__/write-safety-preflight.test.ts#L84)
