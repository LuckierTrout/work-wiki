---
title: 'Write-safety capture feasibility and integration handoff'
type: 'chore'
created: '2026-09-08'
status: 'done'
review_loop_iteration: 0
baseline_commit: '0e8f1166557c6159b7a9069d8865c7eebd440441'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The isolated publication proof leaves live source capture unproven and production integration underspecified. An archive or maintenance flag cannot establish a consistent migration boundary.

**Approach:** Deliver an evidence-backed feasibility decision and a conditional integration specification. An explicit blocked verdict with exact missing evidence is a valid result; this packet does not establish production readiness.

## Boundaries & Constraints

**Always:** Use local source and current official documentation. Distinguish observed code, documented guarantees, inference and unknown live state. Preserve AD-2/3/7/9/11/13 and AD-15 gates; describe architectural amendments as proposals. Cover all canonical stores, operations, effects and legacy capabilities.

**Ask First:** Real-data access/export, authenticated cloud inspection, provisioning, dependency changes, runtime integration, architecture adoption, merge or deployment.

**Never:** Change runtime/configuration, frozen contracts/identifiers, protected files, existing frozen intent or the deferred-work ledger. Send provider/operator messages. Infer drain from elapsed time, logs, scans or checksums. Delete blobs, jobs or source resources. Claim R2 transactions or exactly-once remote delivery.

</frozen-after-approval>

## Code Map

Read-only anchors at the baseline; inspect neighboring symbols when writing the inventory:

- `docs/write-safety-cutover-design.md`: existing proof and family map; `docs/ad15-production-rollout.md`: capture and rollout gates. Architecture spine under `_bmad-output/planning-artifacts/architecture/architecture-work-wiki-2026-08-12/`: adopted invariants.
- `src/lib/portable-archive.ts:71` `buildPortableArchive`: sequential tenant-only capture, exclusions at 35, transformed bytes at 127, memory/capacity limits at 32/134; import at 288.
- `src/lib/storage/r2.ts:310`: KV indexes versus R2 counters; mutators and pass-through batch at 583. `storage/types.ts:291`: atomic counter keys. AD-11's KV wording differs from current R2 CAS. `storage/index.ts:64`: shared provider, not request authority.
- `src/lib/lifecycle.ts:1535` write and 1281 delete: silo/compatibility state, indexes, crossrefs, log and separate receipts. `operation-ledger.ts:34`: capped history, not admission evidence.
- Global state: `src/lib/config.ts:369`, `agents.ts:27`, `ingest-jobs.ts:125`, `extract-jobs.ts:129`, `ingest-staging.ts:52`, `backups.ts:100`; canonical KV: `email-ingest.ts:107`, `monitor-digests.ts:212`, `vault.ts:121`. Tenant state includes todos, wikis, research and review. All abbreviated paths in this list are under `src/lib/`.
- `src/lib/tasks.ts:432`: sends and partial batches. `workers/task-consumer/index.ts:69`: dispatch/email/ACK; cron at 257. Its `wrangler.jsonc:29` configures four concurrent deliveries. `src/app/api/tasks/run/route.ts:194`: read-only rejection; 886/990: terminal ingest failures. `src/app/api/tasks/scan/route.ts:100`: independent scanner effects.
- `workers/email-ingest/index.ts:1108`: config read before forwarding at 1603; `src/app/api/email/ingest/route.ts:432`: Message-ID dedup, separate job/staging/enqueue. `src/lib/integration-outbox.ts:295`: remote delivery before receipt persistence.
- `sidecar/server.mjs:380`: timed proxy; 542: local admission. `src/lib/lock.ts:153`: partial migration gate; `DEPLOY.md:550`: read-only exceptions. Include API/MCP, scripts, reset, tenant deletion and restore bypasses.
- Official evidence: Cloudflare docs at `developers.cloudflare.com`: `/queues/configuration/pause-purge/` (expiry continues), `/workers/versions-and-deployments/` (storage excluded), `/r2/reference/consistency/`, `/r2/buckets/bucket-locks/`, `/r2/buckets/event-notifications/`, `/kv/concepts/how-kv-works/`. None of the evidence collected establishes a cross-service capture barrier.

## Tasks & Acceptance

**Execution:**
- [x] `docs/write-safety-capture-feasibility.md`: inventory canonical/projection/operational state and every admission/effect family; evaluate freeze/snapshot and lossless reconciliation candidates. Record guarantees, limitations, missing evidence, retention/capacity and unsent provider/operator questions. Explain how a cutoff could bootstrap around already-running legacy work; leave feasibility blocked where unproven.
- [x] `docs/write-safety-production-integration-spec.md`: specify proposed authority/read-set/generation/receipt contracts, resource permissions, job/effect reconciliation, projection reads and forward recovery. Break future implementation into concrete file-scoped packets with dependencies, entry/exit evidence and composition-root tests. Include actual input-digest verification, ambiguous sends and external outcomes; require full coverage before activation.
- [x] `docs/write-safety-cutover-design.md`: link both deliverables and reconcile the decision without overstating the local proof.

**Acceptance Criteria:**
- Given existing capture omissions and partial gates, when reviewing the feasibility matrix, each has source evidence and a required resolution; unknown provider/live guarantees remain explicit blockers.
- Given the conditional integration specification, an implementer can identify affected files, contracts, sequencing and verification without inventing migration authority or enabling a partially migrated runtime.
- Given delayed legacy execution, queue expiry, partial send, commit-before-response and effect-before-receipt failures, walkthroughs preserve accepted inputs and unknown outcomes, reject unsafe replay, and require forward reconciliation after new writes.

## Spec Change Log

## Verification

- Check source anchors and official links; distinguish local config from live configuration.
- Walk through acceptance counterexamples and cross-check inventories between documents.
- `git diff --check`; inspect final diff: this spec and the three named documents only. No runtime tests are required for prose-only changes; do not claim a fresh runtime pass.

## Implementation Evidence

- Completed the three documentation tasks; all acceptance counterexamples have explicit preservation, blocking and reconciliation outcomes.
- Independent blind, edge-case and verification-gap reviews returned no findings.
- Relative links, source-anchor bounds, packet paths and inventory coverage checked; whitespace checks passed. No fresh runtime test or live capture performed.

## Suggested Review Order

**Decision and evidence**

- Start with the blocked verdict and evidence boundaries.
  [write-safety-capture-feasibility.md:1](../../docs/write-safety-capture-feasibility.md#L1)

- See the seven evidence gates that must close before activation.
  [write-safety-capture-feasibility.md:178](../../docs/write-safety-capture-feasibility.md#L178)

**Authority and recovery**

- Follow durable identity through input verification, publication and effects.
  [write-safety-production-integration-spec.md:35](../../docs/write-safety-production-integration-spec.md#L35)

- Review implementation dependencies and required composition tests.
  [write-safety-production-integration-spec.md:273](../../docs/write-safety-production-integration-spec.md#L273)

- Check activation ordering and preservation of accepted destination writes.
  [write-safety-production-integration-spec.md:300](../../docs/write-safety-production-integration-spec.md#L300)

**Navigation**

- See how the handoff extends the existing isolated proof.
  [write-safety-cutover-design.md:7](../../docs/write-safety-cutover-design.md#L7)
