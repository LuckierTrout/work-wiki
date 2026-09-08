# Write-safety cutover: local proof and integration proposal

Status: isolated prototype; **not production-integrated or deployment-ready**.
Baseline: `b751141486778d6b7ee5a72c7a9eb6e894869b2a`.
Approval is for this local proof only. Existing [AD-15 rollout gates](ad15-production-rollout.md) remain binding.

## Decision supported by the proof

Use a workspace-wide commit authority as the candidate design, rather than a
lease that merely surrounds arbitrary writes. Existing indexes, log and merge
locks span the workspace; per-owner partitioning would require a separate
cross-partition consistency design. This proposal changes neither production
bindings nor the adopted architecture.

The local Worker uploads content to create-only, SHA-256-addressed R2 objects.
It verifies stored bytes, then enters a **SQLite-only transaction** which checks
the active generation and expected workspace revision and publishes all path
references/tombstones, a persistent operation receipt and projection outbox
entry together. A global expected revision is a conservative read-set check:
any intervening commit conflicts, even if paths are unrelated. Production
admission/authentication and reading a consistent domain snapshot remain
integration work; callers must not attach a fresh revision to stale computed
content.

Requests normalize change order and hash semantic fields. An operation ID has
one request digest and one receipt for the lifetime of the workspace. Identical
retries return that historical receipt, including after generation changes;
this does not authorize new writes in an obsolete generation. Reusing an ID
with a different payload conflicts. Different operations competing on one
revision have one winner. State changes after R2 I/O are rechecked inside the
transaction. No request-scoped authority is stored in the application's shared
storage-provider singleton.

Reads/list/stat follow published references, not physical blob enumeration.
Deleted paths have tombstones; uncommitted uploads remain invisible and are not
garbage-collected in this packet. Repeated uploads verify existing content
rather than trusting a key that happens to look like a hash. Multi-path
publication is atomic at the reference boundary; multiple separate client
reads are not themselves a snapshot transaction.

Projection outbox records contain full synthetic snapshots. Their application
checks generation/revision, supersedes obsolete entries and can retry without
losing unchanged paths. The projection in this prototype is another SQLite
table, **not real KV, Vectorize, email or queue delivery**. Production external
effects need their own idempotency/reconciliation design. A transactional
outbox alone cannot promise exactly-once delivery after a remote service
accepts an effect but the sender crashes before recording its receipt.

Cloudflare documents local transactional storage and warns that external I/O
allows request interleaving. R2 writes are not included in the DO transaction.
See [Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/),
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
and [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

## What runs locally

`tools/write-safety-lab/worker.mjs` is loaded as source into the installed
Miniflare 5 runtime. The only entry point is the test-created local runtime;
there is no deploy configuration, production route, secret loading or app
import. Test-only fault and generation controls have no production auth and
must never be exposed. Network fetches are denied by each Worker's outbound
service; barriers are explicit local service bindings. Telemetry and remote
bindings are disabled. Storage roots are newly created temporary directories;
runtimes are disposed before those owned directories are removed.

The legacy fixture possesses only its old R2 binding. The authority possesses
only the new content binding and its own SQLite state. A deliberate
shared-bucket negative control gives the legacy fixture the destination bucket
and demonstrates corruption, caught by the integrity-checked published read.
Different textual prefixes inside a bucket are not a capability boundary for
an old Worker with unrestricted bucket access.

Tests cover:

- Atomic multi-path publication, tombstones, reference-driven reads/list/stat,
  receipts and outbox; arbitrary physical orphans remain invisible.
- A deterministic barrier after upload and before publication: advance the
  generation while the request is suspended, then reject both stale content
  and stale deletes when it resumes.
- Concurrent revision conflicts, concurrent identical retries, canonical
  request reordering and conflicting operation-ID reuse.
- Injected failure before publication and inside the SQLite transaction:
  no references/receipt/outbox survive, while immutable uploads can remain.
- Commit-before-response failure followed by complete runtime disposal and
  restart using the same persistent storage: recover one durable receipt,
  with no second revision increment.
- Superseded and retried synthetic projection effects.
- Old-store overwrite/delete after activation, absent new-store/authority
  capabilities, denied outbound fetch, and the shared-resource negative control.
- Malformed/oversized requests and incomplete or contradictory cutover evidence.

These are real local workerd, SQLite and emulated R2 executions. Injected errors
plus controlled restart are not proof of arbitrary machine power-loss behavior
or Cloudflare deployment propagation. Neither mocked-provider tests nor this
local runtime establish a live legacy drain or source snapshot.

## Production writer and resource inventory

This is a family-level integration map, not a claim that every call site has
already been migrated. All listed production files are unchanged.

| Family / current evidence | Candidate authority or isolation requirement |
| --- | --- |
| `src/lib/storage/r2.ts`: file/asset overwrite, append, delete, recursive delete and pass-through batches | Published canonical objects need operation-level references; batching today is not a multi-object transaction. Audit every mutator caller, not only locks. |
| `src/lib/lifecycle.ts`, `wiki.ts`, `page-index.ts`, `wiki-log.ts`, `merge.ts` | Workspace publication must include primary page state and canonical indexes/log semantics; explicitly classify post-commit crossrefs and fail-soft effects. Preserve the single lifecycle entry path. |
| `src/lib/ingest.ts`, `research-completion.ts`, `research-runtime.ts` | Separate long computation from publishing with the original generation/read revision; preserve serial ingest admission and avoid duplicate provider spend on retry. |
| `src/lib/ingest-jobs.ts`, `ingest-staging.ts`, extract/research job stores | Isolate durable inputs, claim/state transitions and cleanup; new wiki storage with shared mutable job state is insufficient. |
| `src/lib/operation-ledger.ts` and lifecycle receipts | Existing capped audit history and separately written receipts are not transactional deduplication. Retain history while adding authoritative operation receipts. |
| `src/lib/wikis.ts`, `workspace-profile.ts`, todos, conversations, review and configuration modules | Canonical user state remains kernel-owned. Some KV keys are configuration, not disposable indexes. Inventory and capture explicitly. |
| `src/lib/storage/r2.ts`: KV indexes, fallback vectors, R2 counters | Separate canonical settings/counters from rebuildable projections. Projections need version-aware publication and reads; KV alone is not the new commit authority. |
| `src/lib/storage/r2.ts`: Vectorize upsert/delete/clear | Isolate or disable during cutover, rebuild derived vectors from the accepted generation, validate revision/model at reads; current clear is not guaranteed deletion. |
| `src/app/api/admin/reset/route.ts`, `tenant-admin.ts`, `portable-archive.ts`, `backups.ts` | Reset, restore/import and tenant deletion bypass ordinary page composition. Make them explicit authority operations before activation. |
| `workers/task-consumer/index.ts`, `src/app/api/tasks/run/route.ts` | Queue/DLQ, deliveries, retry budgets, generation and operation IDs need reconciliation. Pause delivery without purge; independent cron must also be quiesced. |
| `workers/email-ingest/index.ts`, intake integrations and external receipts | Account for raw input, shared KV configuration, outgoing notifications and uncertain delivery. Never blindly replay an unknown remote outcome. |
| Browser, API/MCP, sidecar, agent scripts and cron scanner | All producer/admission paths need reversible maintenance and generation handling; ordinary read-only mode does not cover every writer. |
| `src/lib/storage/index.ts` and `storage/types.ts` | Keep domain access through the kernel port; do not store per-operation revision/generation in a global singleton. Read/list/stat and write interfaces require coherent adaptation. |

Adopting authoritative DO metadata requires an explicit amendment to AD-2 and
the storage contract. Preserve AD-3 lifecycle ownership, AD-7 frozen resources,
AD-9 serial ingest, AD-11 monotonic refresh and AD-13 thin queue dispatch. New
resources would be additions with approved names, not renames or destruction
of existing buckets, KV namespaces, queues or identifiers.

## Legacy cutover feasibility: remaining hard gate

**There is still no established safe live source-capture barrier.** A separate
destination prevents old code from modifying new current data only if every
relevant capability is isolated. It does not prove the starting data is complete
or internally consistent, nor prevent old email/provider effects.

`buildPortableArchive` reads tenant objects sequentially, excludes infrastructure
and supplies checksums of what it read. It does not include all deployment state
or prove one consistent instant. Matching two scans, quiet logs, absent leases
and an empty queue do not supply the missing guarantee. R2 bucket retention
locks prevent overwrites/deletions but do not prohibit new object creation or
freeze KV and external effects; they are not proposed as a complete barrier.

A future production packet must obtain either an authoritative, provider-backed
source freeze/snapshot covering the affected stores, or a demonstrated lossless
capture/reconciliation protocol with an explicit admission cutoff. No such
primitive is assumed available. If neither can be established, stop and obtain
an operator decision; do not turn a data-loss or ambiguous-operation risk into
an automatic migration.

The offline checker accepts only synthetic evidence. Its schema requires:

- `source`: synthetic transaction identity, explicit completeness/change state,
  a path/size/SHA-256 inventory and operation/effect ID inventories;
- `destination.files`: matching captured inventory;
- `resources`: distinct old/new R2, KV, Vectorize, queue, DLQ and authority
  identities, plus denial of legacy access to the new resource;
- `producers`: paused browser, API/MCP, sidecar, queue, cron, email, agents and
  admin/restore, each with a restore-procedure identity;
- `operations` and `effects`: one disposition, input digest and evidence
  identity per inventoried item; unknown external outcomes block;
- `recovery`: a forward-reconciliation procedure.

This checks the shape and internal consistency of supplied rehearsal evidence,
not its truth or authenticity. Operation/effect inventories contain IDs only;
`inputDigest` is validated for SHA-256 syntax, not compared with captured input
bytes or an independently trusted digest. Real input verification belongs to
the separately approved capture/reconciliation protocol. Even successful output always has
`productionReady: false`. The process exits zero only for a valid rehearsal;
production automation must never use that exit code as a deploy gate.

## Proposed integration sequence — separately approved work

1. Resolve the live capture barrier and approve the architecture/resource plan.
   Map all canonical state and mutable effects, exact permissions, backup scope,
   restore procedures and capacity before provisioning or copying anything.
2. Integrate authority-mediated reads and commits behind a non-active storage
   adapter; cover the full writer inventory, auth, stable operation identity,
   snapshot/read-set semantics and generation-tagged projections/jobs. Partial
   wiring must never activate production.
3. Rehearse a complete migration with isolated nonproduction resources and a
   representative synthetic workload. Resume intentionally delayed legacy
   requests after cutover and verify all state/effect boundaries, not only R2.
4. In an approved maintenance window, reversibly pause every producer and
   delivery source. Preserve retry/DLQ state and all original resources. Perform
   the proven capture, validate bytes and semantic consistency, and reconcile
   each admitted operation before activating the destination.
5. Mark completed jobs complete from evidence; replay only with durable inputs
   and an idempotency-safe disposition; quarantine recoverable interrupted jobs
   for explicit owner handling. Unknown external outcomes block or require
   reconciliation, never an inferred replay. Preserve every unclassified item.
6. Activate only the fully isolated, verified destination. Resume producers
   deliberately and verify owner reads, isolated reversible writes, retry/DLQ
   accounting and external receipts. Record the exact artifact/config identity.
7. Before any new writes, an approved rollback may return to a verified source
   consistent with the cutoff. After new writes, recover forward or explicitly
   reconcile them; routing back to an old snapshot loses accepted work. Do not
   delete source data or clear orphan locks automatically.

## Verification commands

```sh
pnpm exec vitest run --project node src/lib/__tests__/write-safety-workerd.test.ts src/lib/__tests__/write-safety-preflight.test.ts
pnpm exec tsc --noEmit
pnpm lint
pnpm test
git diff --check
```

The spec records final results and review disposition. No remote runtime test,
production capture, migration or owner acceptance is claimed by this document.
