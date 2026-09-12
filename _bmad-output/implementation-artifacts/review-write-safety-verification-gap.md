Read `/Users/christianlee/App-Development/work-wiki/_bmad/render/bmad-build/work-wiki-c0d963009af6/8a8fffa6a84e9e192b04/review-prompts/verification-gap.md` completely and follow it as your review instructions.

Review content:

diff --git a/_bmad-output/implementation-artifacts/spec-write-safety-cutover-proof.md b/_bmad-output/implementation-artifacts/spec-write-safety-cutover-proof.md
new file mode 100644
index 00000000..d4653bee
--- /dev/null
+++ b/_bmad-output/implementation-artifacts/spec-write-safety-cutover-proof.md
@@ -0,0 +1,79 @@
+---
+title: 'Write-safety migration: isolated cutover proof'
+type: 'refactor'
+created: '2026-09-07'
+status: 'in-review'
+review_loop_iteration: 0
+baseline_revision: 'b751141486778d6b7ee5a72c7a9eb6e894869b2a'
+baseline_commit: 'b751141486778d6b7ee5a72c7a9eb6e894869b2a'
+context: []
+---
+
+<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">
+
+## Intent
+
+**Problem:** Legacy Workers write unconditionally. Locks and R2 copies do not prove safe cutover.
+
+**Approach:** First prove transactional publication and cutover refusal in an isolated local runtime. Deliver an integration plan, not production wiring or readiness.
+
+## Boundaries & Constraints
+
+**Always:** Installed Miniflare/workerd, SQLite Durable Object, synthetic fixtures, separate old/new stores, temporary persistence. Workspace authority owns references/revision/generation/receipts/outbox. Upload before publication; recheck eligibility after I/O. Preserve existing runtime code and safety gates.
+
+**Ask First:** Real data export, cloud provisioning, dependency changes, runtime integration, architecture adoption, merge or deployment. Approval covers local implementation/review only.
+
+**Never:** Remote bindings, credentials, real external effects, deploy configuration, ledger edits, identifier renames or changed frozen contracts. No blob cleanup. No drain inference from time/logs/scans/checksums. No R2 transaction or exactly-once external-delivery claims.
+
+## I/O & Edge-Case Matrix
+
+| Scenario | Input/state | Expected result | Failure |
+|---|---|---|---|
+| Publish | Current generation/revision | Atomic multi-path references, tombstones, receipt/outbox | No mixed state |
+| Stale work | Generation changes during upload | No publication | Stale-generation |
+| Race | Same expected revision | One winner | Conflict |
+| Retry | Same operation ID and digest | Original receipt | Changed digest conflicts |
+| Crash | Before publish / after commit | Invisible orphan / persistent receipt | Safe retry |
+| Legacy resume | Old-only bindings | New reads unchanged | Shared-resource fixture rejected |
+| Capture gap | Changing source or unknown job/effect | Block cutover | Explicit reasons |
+
+</frozen-after-approval>
+
+## Code Map
+
+Read-only: `src/lib/lock.ts` (lease bridge), `src/lib/storage/r2.ts` (unconditional R2/KV/Vectorize mutations), `src/lib/lifecycle.ts` (page composition), `src/lib/portable-archive.ts` (incomplete sequential export), `workers/task-consumer/index.ts` (ACK/retry/cron). Reuse local runtime patterns from `src/lib/__tests__/email-ingest-workerd.test.ts`. Preserve architecture AD-2/3/7/9/11/13 and lifecycle lessons in `.yoyo/learnings.md`.
+
+## Tasks & Acceptance
+
+**Execution:**
+- [x] `tools/write-safety-lab/worker.mjs`: coordinator: validate bounded requests; hash canonical requests; upload verified create-only blobs; transactionally check generation/revision and publish references/tombstones/receipts/outbox. Reads/list/stat use references. Synthetic projection retries check revision.
+- [x] `tools/write-safety-lab/preflight.mjs`: validator/local-file CLI for source consistency/inventory, isolated resources, pauses, jobs/effects and recovery. Reject malformed paths/digests, duplicates and unknown outcomes. Always emit `productionReady: false`; valid synthetic evidence is rehearsal-only.
+- [x] `src/lib/__tests__/write-safety-workerd.test.ts`: drive actual local Worker → DO → R2 → reads through every matrix case, deterministic interleaving, persistent restart, stale deletes and projection retries. Deny outbound networking; dispose runtimes/owned temporary files. No skipped runtime cases or mock fallback.
+- [x] `src/lib/__tests__/write-safety-preflight.test.ts`: execute validator/CLI on temporary fixtures; incomplete or inconsistent capture, shared resources and unresolved effects block. No input certifies production.
+- [x] `docs/write-safety-cutover-design.md`: inventory authority/projections/operational state across admin/restore, R2/KV/Vectorize, jobs/queues/DLQ, cron/email, sidecar/API/MCP and external effects. Record evidence/live gaps, capture/reconciliation, resume/replay/quarantine and forward recovery. Propose architecture/resource additions; preserve AD-15 gates.
+
+**Acceptance Criteria:**
+- Given stale and current operations, when the local composition runs, then only eligible commits change published data.
+- Given restart after commit-before-response, when retrying, then the original receipt returns without another revision increment.
+- Given a changing legacy fixture or missing real evidence, when reporting, then source-consistency/production blockers remain explicit despite successful isolated publication tests.
+
+## Spec Change Log
+
+## Design Notes
+
+Workspace scope covers global indexes/locks. Resource isolation neither proves source completeness nor suppresses old external effects. A safe live capture barrier remains unestablished; prototype success cannot clear it.
+
+## Verification
+
+- `pnpm exec vitest run --project node src/lib/__tests__/write-safety-workerd.test.ts src/lib/__tests__/write-safety-preflight.test.ts` — all cases execute/pass.
+- `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test`, `git diff --check` — pass on final local head; distinguish existing skips.
+- Final diff: this spec and five named new files only; no production/config/dependency/ledger edits.
+
+## Implementation evidence
+
+- Local branch: `fix/write-safety-cutover-proof`; baseline preserved above.
+- Implemented directly after the prescribed context-free subagent launch failed with `agent thread limit reached`.
+- Focused composition/evidence suites: 18/18 passed (11 workerd cases, 7 checker cases). Every matrix row has executed coverage; no runtime skips or mock fallback.
+- TypeScript and focused ESLint passed. Full lint passed with the three existing TSNonNullExpression diagnostics; a new anonymous-export warning was removed and focused lint rerun clean.
+- Full suite: 401 files passed, 10,008 tests passed and one existing credential skip; 113.80 seconds. No production or dependency changes.
+- Matrix mapping: Publish → multi-path/tombstone test; Stale → barrier/advance test; Race → concurrent revisions; Retry → canonical/concurrent retries; Crash → before-publish, transaction rollback and persisted receipt restart; Legacy → old capability and shared-resource negative control; Capture → changing/incomplete evidence tests.

diff --git a/docs/write-safety-cutover-design.md b/docs/write-safety-cutover-design.md
new file mode 100644
index 00000000..22681c35
--- /dev/null
+++ b/docs/write-safety-cutover-design.md
@@ -0,0 +1,202 @@
+# Write-safety cutover: local proof and integration proposal
+
+Status: isolated prototype; **not production-integrated or deployment-ready**.
+Baseline: `b751141486778d6b7ee5a72c7a9eb6e894869b2a`.
+Approval is for this local proof only. Existing [AD-15 rollout gates](ad15-production-rollout.md) remain binding.
+
+## Decision supported by the proof
+
+Use a workspace-wide commit authority as the candidate design, rather than a
+lease that merely surrounds arbitrary writes. Existing indexes, log and merge
+locks span the workspace; per-owner partitioning would require a separate
+cross-partition consistency design. This proposal changes neither production
+bindings nor the adopted architecture.
+
+The local Worker uploads content to create-only, SHA-256-addressed R2 objects.
+It verifies stored bytes, then enters a **SQLite-only transaction** which checks
+the active generation and expected workspace revision and publishes all path
+references/tombstones, a persistent operation receipt and projection outbox
+entry together. A global expected revision is a conservative read-set check:
+any intervening commit conflicts, even if paths are unrelated. Production
+admission/authentication and reading a consistent domain snapshot remain
+integration work; callers must not attach a fresh revision to stale computed
+content.
+
+Requests normalize change order and hash semantic fields. An operation ID has
+one request digest and one receipt for the lifetime of the workspace. Identical
+retries return that historical receipt, including after generation changes;
+this does not authorize new writes in an obsolete generation. Reusing an ID
+with a different payload conflicts. Different operations competing on one
+revision have one winner. State changes after R2 I/O are rechecked inside the
+transaction. No request-scoped authority is stored in the application's shared
+storage-provider singleton.
+
+Reads/list/stat follow published references, not physical blob enumeration.
+Deleted paths have tombstones; uncommitted uploads remain invisible and are not
+garbage-collected in this packet. Repeated uploads verify existing content
+rather than trusting a key that happens to look like a hash. Multi-path
+publication is atomic at the reference boundary; multiple separate client
+reads are not themselves a snapshot transaction.
+
+Projection outbox records contain full synthetic snapshots. Their application
+checks generation/revision, supersedes obsolete entries and can retry without
+losing unchanged paths. The projection in this prototype is another SQLite
+table, **not real KV, Vectorize, email or queue delivery**. Production external
+effects need their own idempotency/reconciliation design. A transactional
+outbox alone cannot promise exactly-once delivery after a remote service
+accepts an effect but the sender crashes before recording its receipt.
+
+Cloudflare documents local transactional storage and warns that external I/O
+allows request interleaving. R2 writes are not included in the DO transaction.
+See [Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/),
+[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
+and [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
+
+## What runs locally
+
+`tools/write-safety-lab/worker.mjs` is loaded as source into the installed
+Miniflare 5 runtime. The only entry point is the test-created local runtime;
+there is no deploy configuration, production route, secret loading or app
+import. Test-only fault and generation controls have no production auth and
+must never be exposed. Network fetches are denied by each Worker's outbound
+service; barriers are explicit local service bindings. Telemetry and remote
+bindings are disabled. Storage roots are newly created temporary directories;
+runtimes are disposed before those owned directories are removed.
+
+The legacy fixture possesses only its old R2 binding. The authority possesses
+only the new content binding and its own SQLite state. A deliberate
+shared-bucket negative control gives the legacy fixture the destination bucket
+and demonstrates corruption, caught by the integrity-checked published read.
+Different textual prefixes inside a bucket are not a capability boundary for
+an old Worker with unrestricted bucket access.
+
+Tests cover:
+
+- Atomic multi-path publication, tombstones, reference-driven reads/list/stat,
+  receipts and outbox; arbitrary physical orphans remain invisible.
+- A deterministic barrier after upload and before publication: advance the
+  generation while the request is suspended, then reject both stale content
+  and stale deletes when it resumes.
+- Concurrent revision conflicts, concurrent identical retries, canonical
+  request reordering and conflicting operation-ID reuse.
+- Injected failure before publication and inside the SQLite transaction:
+  no references/receipt/outbox survive, while immutable uploads can remain.
+- Commit-before-response failure followed by complete runtime disposal and
+  restart using the same persistent storage: recover one durable receipt,
+  with no second revision increment.
+- Superseded and retried synthetic projection effects.
+- Old-store overwrite/delete after activation, absent new-store/authority
+  capabilities, denied outbound fetch, and the shared-resource negative control.
+- Malformed/oversized requests and incomplete or contradictory cutover evidence.
+
+These are real local workerd, SQLite and emulated R2 executions. Injected errors
+plus controlled restart are not proof of arbitrary machine power-loss behavior
+or Cloudflare deployment propagation. Neither mocked-provider tests nor this
+local runtime establish a live legacy drain or source snapshot.
+
+## Production writer and resource inventory
+
+This is a family-level integration map, not a claim that every call site has
+already been migrated. All listed production files are unchanged.
+
+| Family / current evidence | Candidate authority or isolation requirement |
+| --- | --- |
+| `src/lib/storage/r2.ts`: file/asset overwrite, append, delete, recursive delete and pass-through batches | Published canonical objects need operation-level references; batching today is not a multi-object transaction. Audit every mutator caller, not only locks. |
+| `src/lib/lifecycle.ts`, `wiki.ts`, `page-index.ts`, `wiki-log.ts`, `merge.ts` | Workspace publication must include primary page state and canonical indexes/log semantics; explicitly classify post-commit crossrefs and fail-soft effects. Preserve the single lifecycle entry path. |
+| `src/lib/ingest.ts`, `research-completion.ts`, `research-runtime.ts` | Separate long computation from publishing with the original generation/read revision; preserve serial ingest admission and avoid duplicate provider spend on retry. |
+| `src/lib/ingest-jobs.ts`, `ingest-staging.ts`, extract/research job stores | Isolate durable inputs, claim/state transitions and cleanup; new wiki storage with shared mutable job state is insufficient. |
+| `src/lib/operation-ledger.ts` and lifecycle receipts | Existing capped audit history and separately written receipts are not transactional deduplication. Retain history while adding authoritative operation receipts. |
+| `src/lib/wikis.ts`, `workspace-profile.ts`, todos, conversations, review and configuration modules | Canonical user state remains kernel-owned. Some KV keys are configuration, not disposable indexes. Inventory and capture explicitly. |
+| `src/lib/storage/r2.ts`: KV indexes, fallback vectors, R2 counters | Separate canonical settings/counters from rebuildable projections. Projections need version-aware publication and reads; KV alone is not the new commit authority. |
+| `src/lib/storage/r2.ts`: Vectorize upsert/delete/clear | Isolate or disable during cutover, rebuild derived vectors from the accepted generation, validate revision/model at reads; current clear is not guaranteed deletion. |
+| `src/app/api/admin/reset/route.ts`, `tenant-admin.ts`, `portable-archive.ts`, `backups.ts` | Reset, restore/import and tenant deletion bypass ordinary page composition. Make them explicit authority operations before activation. |
+| `workers/task-consumer/index.ts`, `src/app/api/tasks/run/route.ts` | Queue/DLQ, deliveries, retry budgets, generation and operation IDs need reconciliation. Pause delivery without purge; independent cron must also be quiesced. |
+| `workers/email-ingest/index.ts`, intake integrations and external receipts | Account for raw input, shared KV configuration, outgoing notifications and uncertain delivery. Never blindly replay an unknown remote outcome. |
+| Browser, API/MCP, sidecar, agent scripts and cron scanner | All producer/admission paths need reversible maintenance and generation handling; ordinary read-only mode does not cover every writer. |
+| `src/lib/storage/index.ts` and `storage/types.ts` | Keep domain access through the kernel port; do not store per-operation revision/generation in a global singleton. Read/list/stat and write interfaces require coherent adaptation. |
+
+Adopting authoritative DO metadata requires an explicit amendment to AD-2 and
+the storage contract. Preserve AD-3 lifecycle ownership, AD-7 frozen resources,
+AD-9 serial ingest, AD-11 monotonic refresh and AD-13 thin queue dispatch. New
+resources would be additions with approved names, not renames or destruction
+of existing buckets, KV namespaces, queues or identifiers.
+
+## Legacy cutover feasibility: remaining hard gate
+
+**There is still no established safe live source-capture barrier.** A separate
+destination prevents old code from modifying new current data only if every
+relevant capability is isolated. It does not prove the starting data is complete
+or internally consistent, nor prevent old email/provider effects.
+
+`buildPortableArchive` reads tenant objects sequentially, excludes infrastructure
+and supplies checksums of what it read. It does not include all deployment state
+or prove one consistent instant. Matching two scans, quiet logs, absent leases
+and an empty queue do not supply the missing guarantee. R2 bucket retention
+locks prevent overwrites/deletions but do not prohibit new object creation or
+freeze KV and external effects; they are not proposed as a complete barrier.
+
+A future production packet must obtain either an authoritative, provider-backed
+source freeze/snapshot covering the affected stores, or a demonstrated lossless
+capture/reconciliation protocol with an explicit admission cutoff. No such
+primitive is assumed available. If neither can be established, stop and obtain
+an operator decision; do not turn a data-loss or ambiguous-operation risk into
+an automatic migration.
+
+The offline checker accepts only synthetic evidence. Its schema requires:
+
+- `source`: synthetic transaction identity, explicit completeness/change state,
+  a path/size/SHA-256 inventory and operation/effect ID inventories;
+- `destination.files`: matching captured inventory;
+- `resources`: distinct old/new R2, KV, Vectorize, queue, DLQ and authority
+  identities, plus denial of legacy access to the new resource;
+- `producers`: paused browser, API/MCP, sidecar, queue, cron, email, agents and
+  admin/restore, each with a restore-procedure identity;
+- `operations` and `effects`: one disposition, input digest and evidence
+  identity per inventoried item; unknown external outcomes block;
+- `recovery`: a forward-reconciliation procedure.
+
+This checks the shape and internal consistency of supplied rehearsal evidence,
+not its truth or authenticity. Even successful output always has
+`productionReady: false`. The process exits zero only for a valid rehearsal;
+production automation must never use that exit code as a deploy gate.
+
+## Proposed integration sequence — separately approved work
+
+1. Resolve the live capture barrier and approve the architecture/resource plan.
+   Map all canonical state and mutable effects, exact permissions, backup scope,
+   restore procedures and capacity before provisioning or copying anything.
+2. Integrate authority-mediated reads and commits behind a non-active storage
+   adapter; cover the full writer inventory, auth, stable operation identity,
+   snapshot/read-set semantics and generation-tagged projections/jobs. Partial
+   wiring must never activate production.
+3. Rehearse a complete migration with isolated nonproduction resources and a
+   representative synthetic workload. Resume intentionally delayed legacy
+   requests after cutover and verify all state/effect boundaries, not only R2.
+4. In an approved maintenance window, reversibly pause every producer and
+   delivery source. Preserve retry/DLQ state and all original resources. Perform
+   the proven capture, validate bytes and semantic consistency, and reconcile
+   each admitted operation before activating the destination.
+5. Mark completed jobs complete from evidence; replay only with durable inputs
+   and an idempotency-safe disposition; quarantine recoverable interrupted jobs
+   for explicit owner handling. Unknown external outcomes block or require
+   reconciliation, never an inferred replay. Preserve every unclassified item.
+6. Activate only the fully isolated, verified destination. Resume producers
+   deliberately and verify owner reads, isolated reversible writes, retry/DLQ
+   accounting and external receipts. Record the exact artifact/config identity.
+7. Before any new writes, an approved rollback may return to a verified source
+   consistent with the cutoff. After new writes, recover forward or explicitly
+   reconcile them; routing back to an old snapshot loses accepted work. Do not
+   delete source data or clear orphan locks automatically.
+
+## Verification commands
+
+```sh
+pnpm exec vitest run --project node src/lib/__tests__/write-safety-workerd.test.ts src/lib/__tests__/write-safety-preflight.test.ts
+pnpm exec tsc --noEmit
+pnpm lint
+pnpm test
+git diff --check
+```
+
+The spec records final results and review disposition. No remote runtime test,
+production capture, migration or owner acceptance is claimed by this document.

diff --git a/src/lib/__tests__/write-safety-preflight.test.ts b/src/lib/__tests__/write-safety-preflight.test.ts
new file mode 100644
index 00000000..b32c04ca
--- /dev/null
+++ b/src/lib/__tests__/write-safety-preflight.test.ts
@@ -0,0 +1,105 @@
+import { mkdtemp, rm, writeFile } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { fileURLToPath } from "node:url";
+import { spawnSync } from "node:child_process";
+import { describe, expect, it } from "vitest";
+import { validateEvidence, RESOURCE_FAMILIES, PRODUCERS } from "../../../tools/write-safety-lab/preflight.mjs";
+
+const hash = "a".repeat(64);
+function fixture() {
+  return {
+    kind: "synthetic-cutover-v1",
+    source: { mechanism: "synthetic-transaction", snapshot: "snapshot-one", complete: true,
+      changedDuringCapture: false, files: [{ path: "wiki/a.md", sha256: hash, size: 3 }],
+      operationIds: ["job-one"], effectIds: ["email-one"] },
+    destination: { files: [{ path: "wiki/a.md", sha256: hash, size: 3 }] },
+    resources: Object.fromEntries(RESOURCE_FAMILIES.map((name: string) => [name, { old: `old-${name}`, new: `new-${name}`, legacyCanAccessNew: false }])),
+    producers: Object.fromEntries(PRODUCERS.map((name: string) => [name, { paused: true, restoreProcedure: `restore-${name}` }])),
+    operations: [{ id: "job-one", inputDigest: hash, disposition: "replay", evidence: "captured-input" }],
+    effects: [{ id: "email-one", inputDigest: hash, disposition: "confirmed-not-sent", evidence: "synthetic-receipt" }],
+    recovery: { direction: "forward", procedure: "reconcile-new-writes" },
+  };
+}
+
+describe("offline cutover evidence checker", () => {
+  it("accepts complete synthetic rehearsal evidence but never authorizes production", () => {
+    expect(validateEvidence(fixture())).toMatchObject({ rehearsalReady: true, productionReady: false, blockers: [] });
+    expect(validateEvidence({ ...fixture(), productionReady: true }).productionReady).toBe(false);
+  });
+  it("does not mistake a matching archive or repeated scan for a consistent complete source capture", () => {
+    for (const mechanism of ["two-matching-scans", "archive-checksums", "quiet-logs", "timeout", "bucket-isolation"]) {
+      const evidence = fixture(); evidence.source.mechanism = mechanism;
+      expect(validateEvidence(evidence).blockers).toContain("source-capture-unproven");
+    }
+    const incomplete = fixture(); incomplete.source.complete = false;
+    expect(validateEvidence(incomplete).rehearsalReady).toBe(false);
+  });
+  it("rejects a legacy source changed during capture and mismatched destination bytes", () => {
+    const changing = fixture(); changing.source.changedDuringCapture = true;
+    expect(validateEvidence(changing).blockers).toContain("source-changed-or-unknown");
+    changing.source.changedDuringCapture = false;
+    changing.destination.files[0].sha256 = "b".repeat(64);
+    expect(validateEvidence(changing).blockers).toContain("capture-mismatch");
+  });
+  it("rejects incomplete resources, shared old/new capabilities, aliases and unpaused producers", () => {
+    for (const family of RESOURCE_FAMILIES) {
+      const evidence = fixture(); evidence.resources[family].new = evidence.resources[family].old;
+      expect(validateEvidence(evidence).blockers).toContain("shared-resource");
+      delete evidence.resources[family];
+      expect(validateEvidence(evidence).blockers).toContain("resource-inventory-incomplete");
+    }
+    const aliased = fixture(); aliased.resources.r2.new = aliased.resources.kv.new;
+    expect(validateEvidence(aliased).blockers).toContain("resource-alias");
+    for (const name of PRODUCERS) {
+      const evidence = fixture(); evidence.producers[name].paused = false;
+      expect(validateEvidence(evidence).blockers).toContain("producer-pause-unproven");
+    }
+  });
+  it("refuses lost jobs, duplicate dispositions, unknown external outcomes and reverse rollback", () => {
+    const missing = fixture(); missing.operations = [];
+    expect(validateEvidence(missing).blockers).toContain("reconciliation-incomplete");
+    const duplicate = fixture(); duplicate.operations.push(duplicate.operations[0]);
+    expect(validateEvidence(duplicate).blockers).toContain("invalid-disposition");
+    for (const disposition of ["unknown", "replay", "quarantine"]) {
+      const effect = fixture(); effect.effects[0].disposition = disposition;
+      expect(validateEvidence(effect).blockers).toContain("unresolved-outcome");
+    }
+    const rollback = fixture(); rollback.recovery.direction = "legacy";
+    expect(validateEvidence(rollback).blockers).toContain("recovery-unproven");
+  });
+  it("rejects malformed inventories, duplicate paths and unsupported evidence", () => {
+    for (const path of ["../a", "/a", "a//b", "a\\b", "a/../b", ""]) {
+      const evidence = fixture(); evidence.source.files[0].path = path;
+      expect(validateEvidence(evidence).blockers).toContain("invalid-inventory");
+    }
+    const duplicate = fixture(); duplicate.source.files.push(duplicate.source.files[0]);
+    expect(validateEvidence(duplicate).blockers).toContain("invalid-inventory");
+    const badHash = fixture(); badHash.source.files[0].sha256 = "bad";
+    expect(validateEvidence(badHash).blockers).toContain("invalid-inventory");
+    for (const input of [null, [], {}, "text", { kind: "production" }]) {
+      expect(validateEvidence(input)).toMatchObject({ rehearsalReady: false, productionReady: false });
+    }
+  });
+  it("executes the local-file CLI, returning nonzero for blocked/invalid/oversized input without leaking file data", async () => {
+    const directory = await mkdtemp(join(tmpdir(), "cutover-evidence-"));
+    const cli = fileURLToPath(new URL("../../../tools/write-safety-lab/preflight.mjs", import.meta.url));
+    try {
+      const path = join(directory, "evidence.json");
+      const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
+      await writeFile(path, JSON.stringify(fixture()));
+      expect(run(path).status).toBe(0);
+      expect(JSON.parse(run(path).stdout).productionReady).toBe(false);
+      const blocked = fixture(); blocked.source.changedDuringCapture = true;
+      await writeFile(path, JSON.stringify(blocked));
+      expect(run(path).status).toBe(1);
+      await writeFile(path, "private-test-marker");
+      expect(run(path).stdout).not.toContain("private-test-marker");
+      expect(run(path).status).toBe(1);
+      await writeFile(path, "x".repeat(1_000_001));
+      expect(run(path).status).toBe(1);
+      expect(run().status).toBe(1);
+      expect(run(directory).status).toBe(1);
+    } finally { await rm(directory, { recursive: true, force: true }); }
+  });
+});

diff --git a/src/lib/__tests__/write-safety-workerd.test.ts b/src/lib/__tests__/write-safety-workerd.test.ts
new file mode 100644
index 00000000..d5c620c5
--- /dev/null
+++ b/src/lib/__tests__/write-safety-workerd.test.ts
@@ -0,0 +1,212 @@
+import { mkdtemp, readFile, rm } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { createHash } from "node:crypto";
+import { Miniflare, Response as LocalResponse } from "miniflare";
+import { afterEach, beforeEach, describe, expect, it } from "vitest";
+
+// Real local workerd/SQLite/R2, not Cloudflare production acceptance.
+const scriptUrl = new URL("../../../tools/write-safety-lab/worker.mjs", import.meta.url);
+const sha = (text: string) => createHash("sha256").update(text).digest("hex");
+const legacy = `export default { async fetch(request, env) {
+  if(new URL(request.url).pathname === '/network') return fetch('https://external.invalid/');
+  if(new URL(request.url).pathname === '/capabilities') return Response.json({newStore: !!env.CONTENT, authority: !!env.AUTHORITY});
+  const {path, content} = await request.json();
+  if(content === null) await env.OLD.delete(path); else await env.OLD.put(path,content);
+  return Response.json({written: true});
+}};`;
+function deferred() {
+  let resolve!: () => void;
+  const promise = new Promise<void>((done) => { resolve = done; });
+  return { promise, resolve };
+}
+type Barrier = { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
+
+describe("isolated write authority in real local workerd", () => {
+  let runtime: Miniflare;
+  let directory: string;
+  let blockedNetwork: number;
+  const barriers = new Map<string, Barrier>();
+  async function start(shared = false) {
+    runtime = new Miniflare({
+      host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false },
+      resourcePersistencePath: directory,
+      workers: [
+        {
+          config: {
+            name: "write-safety-lab", type: "worker", compatibilityDate: "2026-08-01",
+            exports: { CommitAuthority: { type: "durable-object", storage: "sqlite" } },
+            env: {
+              AUTHORITY: { type: "durable-object", worker: "write-safety-lab", exportName: "CommitAuthority" },
+              CONTENT: { type: "r2", name: "synthetic-new" },
+              BARRIER: { type: "fetcher", handler: async (request) => {
+                const barrier = barriers.get(new URL(request.url).pathname.slice(1));
+                if (!barrier) throw new Error("Unknown local barrier");
+                barrier.entered.resolve();
+                await barrier.release.promise;
+                return new LocalResponse("released");
+              } },
+            },
+            manifest: { mainModule: "worker.mjs", modules: { "worker.mjs": { type: "esm", contents: await readFile(scriptUrl, "utf8") } } },
+          },
+          dev: { unsafeRegisterWorker: false, outboundService: { type: "fetcher", handler: () => {
+            blockedNetwork += 1; return new LocalResponse("outbound denied", { status: 403 });
+          } } },
+        },
+        {
+          config: {
+            name: "synthetic-legacy", type: "worker", compatibilityDate: "2026-08-01",
+            env: { OLD: { type: "r2", name: shared ? "synthetic-new" : "synthetic-old" } },
+            manifest: { mainModule: "legacy.mjs", modules: { "legacy.mjs": { type: "esm", contents: legacy } } },
+          },
+          dev: { unsafeRegisterWorker: false, outboundService: { type: "fetcher", handler: () => {
+            blockedNetwork += 1; return new LocalResponse("outbound denied", { status: 403 });
+          } } },
+        },
+      ],
+    });
+    await runtime.ready;
+  }
+  beforeEach(async () => {
+    directory = await mkdtemp(join(tmpdir(), "write-safety-proof-"));
+    blockedNetwork = 0;
+    await start();
+  }, 30_000);
+  afterEach(async () => {
+    for (const barrier of barriers.values()) barrier.release.resolve();
+    barriers.clear();
+    try { await runtime?.dispose(); }
+    finally { await rm(directory, { recursive: true, force: true }); }
+  });
+  async function call(path: string, body?: unknown) {
+    const response = await runtime.dispatchFetch(`https://lab.invalid${path}`, body === undefined ? {} : {
+      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
+    });
+    return { status: response.status, body: await response.json() as Record<string, unknown> };
+  }
+  const command = (operation = "one", revision = 0, generation = 1) => ({
+    operation, revision, generation,
+    changes: [{ path: "wiki/a.md", content: "α" }, { path: "wiki/b.md", content: "B" }],
+  });
+
+  it("publishes multiple paths, tombstones, receipts and outbox atomically; reads exclude physical orphans", async () => {
+    expect((await call("/commit", command())).status).toBe(200);
+    expect((await call("/read?path=wiki/a.md")).body.content).toBe("α");
+    expect((await call("/stat?path=wiki/a.md")).body.size).toBe(2);
+    const bucket = await runtime.getR2Bucket("CONTENT", "write-safety-lab");
+    await bucket.put("unpublished", "not visible");
+    expect((await call("/list")).body.paths).toEqual(["wiki/a.md", "wiki/b.md"]);
+    expect((await call("/commit", { ...command("delete", 1), changes: [{ path: "wiki/a.md", content: null }] })).status).toBe(200);
+    expect((await call("/read?path=wiki/a.md")).status).toBe(404);
+    const state = (await call("/state")).body;
+    expect(state).toMatchObject({ revision: 2, generation: 1 });
+    expect(state.refs).toContainEqual({ path: "wiki/a.md", blob: null, size: 0 });
+    expect(state.receipts).toHaveLength(2);
+    expect(state.outbox).toHaveLength(2);
+  });
+
+  it("rejects stale uploads and stale deletes after an interleaved generation advance", async () => {
+    await call("/commit", command());
+    const barrier = { entered: deferred(), release: deferred() };
+    barriers.set("stale", barrier);
+    const pending = call("/commit", { ...command("stale", 1), pause: "stale", changes: [
+      { path: "wiki/a.md", content: null }, { path: "wiki/b.md", content: "stale" },
+    ] });
+    try {
+      await barrier.entered.promise;
+      expect((await call("/advance", { generation: 1, revision: 1 })).status).toBe(200);
+    } finally { barrier.release.resolve(); }
+    expect(await pending).toEqual({ status: 409, body: { error: "stale-generation" } });
+    expect((await call("/read?path=wiki/a.md")).body.content).toBe("α");
+    expect((await call("/read?path=wiki/b.md")).body.content).toBe("B");
+  });
+
+  it("lets only one concurrent revision commit; same-ID concurrent retries return one receipt", async () => {
+    const results = await Promise.all([call("/commit", command("one")), call("/commit", command("two"))]);
+    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
+    expect((await call("/state")).body.revision).toBe(1);
+    const duplicate = await Promise.all([call("/commit", command("three", 1)), call("/commit", command("three", 1))]);
+    expect(duplicate[0]).toEqual(duplicate[1]);
+    expect(duplicate[0].status).toBe(200);
+    expect((await call("/state")).body.revision).toBe(2);
+  });
+
+  it("deduplicates canonical requests but rejects an operation ID reused with different content", async () => {
+    const first = await call("/commit", command());
+    expect(await call("/commit", { ...command(), changes: command().changes.reverse() })).toEqual(first);
+    expect(await call("/commit", { ...command(), changes: [{ path: "wiki/a.md", content: "changed" }] }))
+      .toEqual({ status: 409, body: { error: "operation-conflict" } });
+  });
+
+  it.each(["before-publish", "in-transaction"])("recovers an injected %s interruption without partial publication", async (fault) => {
+    expect((await call("/commit", { ...command(), fault })).status).toBe(503);
+    expect((await call("/state")).body).toMatchObject({ revision: 0, refs: [], receipts: [], outbox: [] });
+    const bucket = await runtime.getR2Bucket("CONTENT", "write-safety-lab");
+    expect((await bucket.list()).objects).toHaveLength(2);
+    await runtime.dispose();
+    await start();
+    expect((await call("/list")).body.paths).toEqual([]);
+    expect((await call("/commit", command())).status).toBe(200);
+    expect((await call("/state")).body.revision).toBe(1);
+  });
+
+  it("recovers the persisted receipt after commit-before-response and restart, even after advancing generation", async () => {
+    expect((await call("/commit", { ...command(), fault: "after-commit" })).status).toBe(503);
+    const before = (await call("/state")).body;
+    await runtime.dispose();
+    await start();
+    expect((await call("/state")).body).toEqual(before);
+    await call("/advance", { generation: 1, revision: 1 });
+    const retried = await call("/commit", command());
+    expect(retried).toMatchObject({ status: 200, body: { operation: "one", revision: 1, generation: 1 } });
+    expect((await call("/state")).body.revision).toBe(1);
+  });
+
+  it("replays full synthetic projections safely and rejects superseded revision/generation effects", async () => {
+    await call("/commit", command());
+    await call("/commit", { ...command("two", 1), changes: [{ path: "wiki/b.md", content: null }] });
+    expect((await call("/project", { id: "1:1" })).body.status).toBe("superseded");
+    expect((await call("/project", { id: "1:2" })).body.status).toBe("applied");
+    const projected = (await call("/state")).body.projection;
+    await call("/project", { id: "1:2" });
+    expect((await call("/state")).body.projection).toEqual(projected);
+    await call("/advance", { generation: 1, revision: 2 });
+    expect((await call("/project", { id: "1:2" })).body.status).toBe("superseded");
+    expect((await call("/project", { id: "2:2" })).body.status).toBe("applied");
+  });
+
+  it("a resumed legacy writer can overwrite/delete old objects but has no new-store or authority capability", async () => {
+    await call("/commit", command());
+    await call("/advance", { generation: 1, revision: 1 });
+    const old = await runtime.getWorker("synthetic-legacy");
+    expect(await (await old.fetch("https://lab.invalid/capabilities")).json()).toEqual({ newStore: false, authority: false });
+    for (const content of ["late old write", null]) await old.fetch("https://lab.invalid/write", {
+      method: "POST", body: JSON.stringify({ path: sha("α"), content }),
+    });
+    expect((await call("/read?path=wiki/a.md")).body.content).toBe("α");
+    const network = await old.fetch("https://lab.invalid/network");
+    expect(network.status).toBe(403);
+    expect(blockedNetwork).toBe(1);
+  });
+
+  it("negative control: sharing the destination bucket permits corruption and fails the read integrity check", async () => {
+    await runtime.dispose(); await start(true);
+    await call("/commit", command());
+    const old = await runtime.getWorker("synthetic-legacy");
+    await old.fetch("https://lab.invalid/write", { method: "POST", body: JSON.stringify({ path: sha("α"), content: "corrupt" }) });
+    expect(await call("/read?path=wiki/a.md")).toEqual({ status: 500, body: { error: "blob-integrity" } });
+    expect(await call("/commit", command("next", 1))).toEqual({ status: 500, body: { error: "blob-integrity" } });
+    expect((await call("/state")).body.revision).toBe(1);
+  });
+
+  it("refuses invalid paths, duplicate paths, invalid revisions and oversized bodies without publishing", async () => {
+    for (const request of [
+      { ...command(), changes: [{ path: "../escape", content: "x" }] },
+      { ...command(), changes: [command().changes[0], command().changes[0]] },
+      { ...command(), revision: -1 }, { ...command(), operation: 123 },
+      { ...command(), changes: [{ path: "a", content: "x".repeat(8193) }] },
+    ]) expect((await call("/commit", request)).status).toBe(400);
+    expect((await call("/commit", { data: "x".repeat(300_001) })).status).toBe(413);
+    expect((await call("/state")).body).toMatchObject({ revision: 0, refs: [], receipts: [] });
+  });
+});

diff --git a/tools/write-safety-lab/preflight.mjs b/tools/write-safety-lab/preflight.mjs
new file mode 100644
index 00000000..b3de98ac
--- /dev/null
+++ b/tools/write-safety-lab/preflight.mjs
@@ -0,0 +1,95 @@
+// Offline synthetic evidence checker, NOT a production release authorization.
+import { open } from "node:fs/promises";
+import { resolve } from "node:path";
+import { fileURLToPath } from "node:url";
+
+export const RESOURCE_FAMILIES = ["r2", "kv", "vectorize", "queue", "dlq", "authority"];
+export const PRODUCERS = ["browser", "api-mcp", "sidecar", "queue", "cron", "email", "agents", "admin-restore"];
+const id = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
+const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
+const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
+const path = (value) => typeof value === "string" && value.length <= 200 && /^[a-zA-Z0-9_-]+(?:[./][a-zA-Z0-9_-]+)*$/.test(value);
+const array = (value) => Array.isArray(value) && value.length <= 10_000;
+
+export function validateEvidence(input) {
+  const blockers = [];
+  const block = (reason) => { if (!blockers.includes(reason)) blockers.push(reason); };
+  if (!object(input) || input.kind !== "synthetic-cutover-v1") block("synthetic-evidence-required");
+  const source = object(input?.source) ? input.source : {};
+  if (source.mechanism !== "synthetic-transaction" || !id(source.snapshot) || source.complete !== true) block("source-capture-unproven");
+  function inventory(value) {
+    if (!array(value)) { block("invalid-inventory"); return null; }
+    const seen = new Set();
+    const rows = [];
+    for (const row of value) {
+      if (!object(row) || !path(row.path) || !digest(row.sha256) ||
+          !Number.isSafeInteger(row.size) || row.size < 0 || seen.has(row.path)) {
+        block("invalid-inventory"); continue;
+      }
+      seen.add(row.path);
+      rows.push([row.path, row.sha256, row.size]);
+    }
+    return JSON.stringify(rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
+  }
+  const sourceFiles = inventory(source.files);
+  if (sourceFiles !== inventory(input?.destination?.files)) block("capture-mismatch");
+  if (source.changedDuringCapture !== false) block("source-changed-or-unknown");
+  if (!object(input?.resources) || Object.keys(input.resources).length !== RESOURCE_FAMILIES.length) block("resource-inventory-incomplete");
+  const oldIds = new Set(), newIds = new Set();
+  for (const family of RESOURCE_FAMILIES) {
+    const resource = input?.resources?.[family];
+    if (!object(resource) || !id(resource.old) || !id(resource.new) || resource.legacyCanAccessNew !== false) {
+      block("resource-isolation-unproven"); continue;
+    }
+    if (oldIds.has(resource.old) || newIds.has(resource.new)) block("resource-alias");
+    oldIds.add(resource.old); newIds.add(resource.new);
+  }
+  if ([...oldIds].some((key) => newIds.has(key))) block("shared-resource");
+  for (const name of PRODUCERS) {
+    const producer = input?.producers?.[name];
+    if (!object(producer) || producer.paused !== true || !id(producer.restoreProcedure)) block("producer-pause-unproven");
+  }
+  function reconcile(expected, actual, effect) {
+    if (!array(expected) || !array(actual)) { block("reconciliation-incomplete"); return; }
+    const wanted = new Set(expected);
+    if (wanted.size !== expected.length || !expected.every(id)) block("invalid-operation-inventory");
+    const seen = new Set();
+    for (const row of actual) {
+      if (!object(row) || !id(row.id) || seen.has(row.id) || !wanted.has(row.id) || !digest(row.inputDigest)) {
+        block("invalid-disposition"); continue;
+      }
+      seen.add(row.id);
+      const allowed = effect ? ["confirmed-complete", "confirmed-not-sent"] : ["complete", "replay", "quarantine"];
+      if (!allowed.includes(row.disposition) || !id(row.evidence)) block("unresolved-outcome");
+    }
+    if (seen.size !== wanted.size) block("reconciliation-incomplete");
+  }
+  reconcile(source.operationIds, input?.operations, false);
+  reconcile(source.effectIds, input?.effects, true);
+  if (input?.recovery?.direction !== "forward" || !id(input?.recovery?.procedure)) block("recovery-unproven");
+  return { productionReady: false, rehearsalReady: blockers.length === 0,
+    blockers, limitation: "Synthetic evidence only; live capture, capability isolation and operator approval remain unproven." };
+}
+
+export async function runCli(args) {
+  if (args.length !== 1) return { productionReady: false, rehearsalReady: false, blockers: ["one-local-evidence-file-required"] };
+  let handle;
+  try {
+    handle = await open(resolve(args[0]), "r");
+    const metadata = await handle.stat();
+    if (!metadata.isFile() || metadata.size > 1_000_000) throw new Error("invalid-size");
+    // Bounded even if the file grows after stat; no network or production SDK.
+    const bytes = Buffer.alloc(1_000_001);
+    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
+    if (bytesRead > 1_000_000) throw new Error("invalid-size");
+    return validateEvidence(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
+  } catch {
+    return { productionReady: false, rehearsalReady: false, blockers: ["invalid-evidence-file"] };
+  } finally { await handle?.close(); }
+}
+
+if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
+  const report = await runCli(process.argv.slice(2));
+  process.stdout.write(`${JSON.stringify(report)}\n`);
+  process.exitCode = report.rehearsalReady ? 0 : 1;
+}

diff --git a/tools/write-safety-lab/worker.mjs b/tools/write-safety-lab/worker.mjs
new file mode 100644
index 00000000..0edec695
--- /dev/null
+++ b/tools/write-safety-lab/worker.mjs
@@ -0,0 +1,178 @@
+// LOCAL SYNTHETIC PROOF ONLY. No deploy config, production auth or app imports.
+// Fault/barrier routes deliberately belong only to the isolated test runtime.
+import { DurableObject } from "cloudflare:workers";
+
+const encoder = new TextEncoder();
+const ID = /^[a-zA-Z0-9_-]{1,80}$/;
+const PATH = /^[a-zA-Z0-9_-]+(?:[./][a-zA-Z0-9_-]+)*$/;
+function fail(code, status = 409) {
+  throw Object.assign(new Error(code), { status });
+}
+async function hash(value) {
+  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
+    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
+}
+function validate(input) {
+  if (!input || typeof input.operation !== "string" || !ID.test(input.operation) ||
+      !Number.isSafeInteger(input.generation) || input.generation < 1 ||
+      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
+      !Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 32 ||
+      ![undefined, "before-publish", "in-transaction", "after-commit"].includes(input.fault) ||
+      (input.pause !== undefined && (typeof input.pause !== "string" || !ID.test(input.pause)))) fail("invalid-request", 400);
+  const paths = new Set();
+  const changes = input.changes.map((change) => {
+    if (!change || typeof change.path !== "string" || change.path.length > 200 ||
+        !PATH.test(change.path) || paths.has(change.path) ||
+        !(change.content === null || typeof change.content === "string") ||
+        (typeof change.content === "string" && encoder.encode(change.content).length > 8192)) {
+      fail("invalid-change", 400);
+    }
+    paths.add(change.path);
+    return { path: change.path, content: change.content };
+  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
+  return { operation: input.operation, generation: input.generation, revision: input.revision, changes };
+}
+
+export class CommitAuthority extends DurableObject {
+  constructor(ctx, env) {
+    super(ctx, env);
+    this.sql = ctx.storage.sql;
+    this.sql.exec(`
+      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER, revision INTEGER);
+      INSERT OR IGNORE INTO state VALUES (1,1,0);
+      CREATE TABLE IF NOT EXISTS refs (path TEXT PRIMARY KEY, blob TEXT, size INTEGER);
+      CREATE TABLE IF NOT EXISTS receipts (operation TEXT PRIMARY KEY, digest TEXT, result TEXT);
+      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, generation INTEGER, revision INTEGER, snapshot TEXT, status TEXT);
+      CREATE TABLE IF NOT EXISTS projection (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER, revision INTEGER, snapshot TEXT);
+    `);
+  }
+  state() { return this.sql.exec("SELECT generation, revision FROM state").one(); }
+  refs() { return this.sql.exec("SELECT path, blob, size FROM refs ORDER BY path").toArray(); }
+  receipt(operation, digest) {
+    const row = this.sql.exec("SELECT * FROM receipts WHERE operation=?", operation).toArray()[0];
+    if (!row) return null;
+    if (row.digest !== digest) fail("operation-conflict");
+    return JSON.parse(row.result);
+  }
+  eligible(input) {
+    const state = this.state();
+    if (input.generation !== state.generation) fail("stale-generation");
+    if (input.revision !== state.revision) fail("revision-conflict");
+  }
+  enqueue() {
+    const { generation, revision } = this.state();
+    this.sql.exec("INSERT INTO outbox VALUES (?,?,?,?,?)", `${generation}:${revision}`,
+      generation, revision, JSON.stringify(this.refs()), "pending");
+  }
+  async commit(raw) {
+    const input = validate(raw);
+    const digest = await hash(JSON.stringify(input));
+    const previous = this.receipt(input.operation, digest);
+    if (previous) return previous;
+    this.eligible(input);
+    const prepared = [];
+    for (const change of input.changes) {
+      if (change.content === null) { prepared.push({ path: change.path, blob: null, size: 0 }); continue; }
+      const blob = await hash(change.content);
+      const bytes = encoder.encode(change.content);
+      await this.env.CONTENT.put(blob, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
+      // Verify both new uploads and reused create-only objects before publishing.
+      const stored = await this.env.CONTENT.get(blob);
+      if (!stored || await hash(await stored.text()) !== blob) fail("blob-integrity", 500);
+      prepared.push({ path: change.path, blob, size: bytes.length });
+    }
+    if (raw.pause) await this.env.BARRIER.fetch(`https://barrier.invalid/${raw.pause}`);
+    if (raw.fault === "before-publish") fail("injected-before-publish", 503);
+    const result = this.ctx.storage.transactionSync(() => {
+      const racedReceipt = this.receipt(input.operation, digest);
+      if (racedReceipt) return racedReceipt;
+      this.eligible(input); // No await from here through receipt + outbox publication.
+      for (const item of prepared) this.sql.exec("INSERT OR REPLACE INTO refs VALUES (?,?,?)", item.path, item.blob, item.size);
+      if (raw.fault === "in-transaction") fail("injected-transaction", 503);
+      this.sql.exec("UPDATE state SET revision=revision+1 WHERE id=1");
+      const receipt = { operation: input.operation, digest, ...this.state() };
+      this.sql.exec("INSERT INTO receipts VALUES (?,?,?)", input.operation, digest, JSON.stringify(receipt));
+      this.enqueue();
+      return receipt;
+    });
+    if (raw.fault === "after-commit") fail("injected-after-commit", 503);
+    return result;
+  }
+  advance(input) {
+    if (!input || !Number.isSafeInteger(input.generation) || !Number.isSafeInteger(input.revision)) fail("invalid-request", 400);
+    return this.ctx.storage.transactionSync(() => {
+      this.eligible(input);
+      this.sql.exec("UPDATE state SET generation=generation+1 WHERE id=1");
+      this.enqueue();
+      return this.state();
+    });
+  }
+  project(input) {
+    if (!input || typeof input.id !== "string" || input.id.length > 80) fail("invalid-request", 400);
+    return this.ctx.storage.transactionSync(() => {
+      const row = this.sql.exec("SELECT * FROM outbox WHERE id=?", input.id).toArray()[0];
+      if (!row) fail("not-found", 404);
+      const state = this.state();
+      if (row.generation !== state.generation || row.revision !== state.revision) {
+        this.sql.exec("UPDATE outbox SET status='superseded' WHERE id=?", input.id);
+        return { status: "superseded" };
+      }
+      this.sql.exec("INSERT OR REPLACE INTO projection VALUES (1,?,?,?)", row.generation, row.revision, row.snapshot);
+      this.sql.exec("UPDATE outbox SET status='applied' WHERE id=?", input.id);
+      return { status: "applied" };
+    });
+  }
+  async fetch(request) {
+    try {
+      const url = new URL(request.url);
+      if (request.method === "GET" && url.pathname === "/state") return Response.json({
+        ...this.state(), refs: this.refs(),
+        receipts: this.sql.exec("SELECT * FROM receipts ORDER BY operation").toArray(),
+        outbox: this.sql.exec("SELECT * FROM outbox ORDER BY generation, revision").toArray(),
+        projection: this.sql.exec("SELECT * FROM projection").toArray(),
+      });
+      if (request.method === "GET" && ["/read", "/stat", "/list"].includes(url.pathname)) {
+        const state = this.state();
+        const refs = this.refs().filter((row) => row.blob !== null);
+        if (url.pathname === "/list") return Response.json({ ...state, paths: refs.map((row) => row.path) });
+        const ref = refs.find((row) => row.path === url.searchParams.get("path"));
+        if (!ref) fail("not-found", 404);
+        if (url.pathname === "/stat") return Response.json({ ...state, size: ref.size });
+        const object = await this.env.CONTENT.get(ref.blob);
+        if (!object) fail("blob-missing", 500);
+        const content = await object.text();
+        if (await hash(content) !== ref.blob) fail("blob-integrity", 500);
+        return Response.json({ ...state, content });
+      }
+      if (request.method !== "POST") fail("not-found", 404);
+      // Bound the stream, not just a caller-controlled Content-Length header.
+      const reader = request.body?.getReader();
+      if (!reader) fail("invalid-request", 400);
+      let text = "", count = 0;
+      const decoder = new TextDecoder("utf-8", { fatal: true });
+      for (;;) {
+        const { value, done } = await reader.read();
+        if (done) break;
+        count += value.byteLength;
+        if (count > 300_000) { await reader.cancel(); fail("request-too-large", 413); }
+        text += decoder.decode(value, { stream: true });
+      }
+      text += decoder.decode();
+      let input;
+      try { input = JSON.parse(text); } catch { fail("invalid-json", 400); }
+      if (url.pathname === "/commit") return Response.json(await this.commit(input));
+      if (url.pathname === "/advance") return Response.json(this.advance(input));
+      if (url.pathname === "/project") return Response.json(this.project(input));
+      fail("not-found", 404);
+    } catch (error) {
+      return Response.json({ error: error.status ? error.message : "runtime-error" }, { status: error.status ?? 500 });
+    }
+  }
+}
+
+const worker = {
+  fetch(request, env) {
+    return env.AUTHORITY.get(env.AUTHORITY.idFromName("synthetic-workspace")).fetch(request);
+  },
+};
+export default worker;



Do not invoke any skill. If the instruction file is unreadable, report that exact failure and stop. Return only the review result.
