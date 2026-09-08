# Conditional production integration specification

Status: **PROPOSED; runtime integration and activation are blocked.** Source
baseline `0e8f1166557c6159b7a9069d8865c7eebd440441`, assessed 2026-09-08.
This document implements a documentation handoff only. It does not adopt the
architecture, authorize runtime/configuration edits, provision resources, access
real data, merge code or deploy. The [capture feasibility decision](write-safety-capture-feasibility.md)
defines S1–S16 state families, A1–A10 admission/effect families and B1–B7 blockers;
those IDs are normative inputs to every packet below.

## Preconditions and architecture decisions

The [local proof](write-safety-cutover-design.md) is evidence for publication
mechanics, not a production adapter. Its unauthenticated test controls must never
be exposed. The production design proposed here uses one workspace commit
authority behind the kernel storage port, because existing global index/log/merge
coordination crosses owner boundaries. Partitioning that authority is a separate
architecture decision with a cross-partition consistency contract.

| Invariant | Required disposition before implementation/activation |
| --- | --- |
| AD-2 | Obtain explicit amendment for authoritative SQLite Durable Object metadata/references/receipts behind `getStorage()`, with immutable content in R2. Kernel stays sole system of record; sidecar remains HTTP-only. This amendment is not adopted here. |
| AD-3 | Preserve `writeWikiPageWithSideEffects` / `deleteWikiPage` and immutable `saveRawSource` / `saveRawSourceFor` as domain ownership. Refactor their composition into prepared commits; do not add a parallel Page/Source writer. |
| AD-7 | Preserve frozen binding/env/resource/tenant/wire spellings. Distinct resources require approved additions and a reviewed mapping; do not rename or reuse old resources as the destination. |
| AD-9 | Preserve serial Analysis→Generation admission per Wiki. Separate queue delivery concurrency from compile concurrency; workspace revision conflicts cannot authorize a second simultaneous compile or repay Analysis silently. |
| AD-11 | Preserve monotonic refresh after canonical commit. Reconcile adopted KV wording with current R2 CAS counters and proposed authority transaction explicitly. Preserve the legacy counter floor; never reset visible `dataVersion` to zero on generation change. |
| AD-13 | Keep consumer a thin authenticated dispatcher, outside `src/lib`. Wire protocol changes and effect ownership changes require an approved compatibility packet; consumer still does not implement domain mutation. |
| AD-15 | Preserve exact-head CI/review, approved merged artifact, correct public build settings, no E2E secrets, real producer pauses, complete legacy execution accounting, two-stage lock readiness, owner validation and forward recovery. A candidate authority cannot bypass the existing rollout gates. |

B1/B2 bootstrap must be established before production bridge installation is
proposed. Non-active local implementation may proceed only under a separately
approved packet. No partial migration may be activated: one unconverted write,
projection read, queue kind, legacy credential or admin door blocks activation.

## Contract C1: durable admission and identity

The authority authenticates the caller and resolves workspace, owner, Wiki,
resource permissions and operation kind server-side. Transport callers cannot
choose another tenant, mint a generation or grant themselves a capability.
A request-scoped immutable context is passed explicitly; the shared singleton in
[storage/index.ts](../src/lib/storage/index.ts#L64) contains adapters only.

An admission record must contain:

- Protocol/schema version, workspace identity, authenticated principal/owner,
  operation ID, operation kind and immutable request digest.
- Input manifest identity and exact input blob digests/lengths, semantic options,
  intended destinations, source/job/parent IDs and stable effect IDs.
- Admission sequence and generation, captured read snapshot/revision, resource
  capability identity, creation time and current durable state.

Reserve `(workspace, operationId)` and its request digest durably before any
provider work or acknowledgement of acceptance. Retries with the same digest
return the same admission/receipt; a different digest conflicts. IDs must remain
unique for the workspace lifetime, independent of generation. Retaining a
receipt digest/tombstone is mandatory if bulky history is archived; the capped
[operation-ledger](../src/lib/operation-ledger.ts#L34) remains secondary audit.

Uploads may be staged create-only before admission. The authority verifies all
required input blobs exist and match their manifest before accepting the
operation; missing/partial uploads are unaccepted orphans. Do not acknowledge
an attachment merely because its parent job exists. Legacy email Message-ID
maps to a retained legacy identity plus verified payload digest, not a universal
content identity. Unidentifiable old inputs remain blocked/quarantined.

Admission, computation, canonical publication and external completion are distinct
states. Operational claim/attempt transitions have their own durable sequence;
they must not silently refresh the computation's canonical snapshot or make a
prepared payload appear current. Capture that snapshot after initial claim
setup and before reading domain inputs. Any operational state used as a domain
precondition is also explicitly checked at publication. A durable proposed lifecycle is `accepted → computing → prepared →
committed`, with explicit `conflict`, `cancelled`, `failed` or `quarantined`
dispositions; effect state is tracked separately. A lost response must never
cause an accepted operation to be replaced by a new random ID.

## Contract C2: actual input and manifest verification

The existing [preflight](../tools/write-safety-lab/preflight.mjs) checks synthetic
evidence shape and digest syntax. It cannot authorize production. A separately
approved capture verifier must compare actual bytes, not accept a caller's
SHA-256-looking field as evidence.

1. Under the proven B1/B2 frontier, enumerate all S families with storage identity,
   exact key bytes, size, content type/metadata, relevant expiry/version/ETag,
   canonical/projection/operational classification and source evidence identity.
   Keep original and transformed representations distinct. List pagination and
   missing objects require explicit completeness evidence, not silent skips.
2. Read bytes through EOF in bounded chunks, compute SHA-256 over raw bytes
   before decoding, and compare size and digest against the trusted captured
   manifest. Verify destination bytes again. ETags are version/precondition
   evidence, not substitutes for content hashes. Reject truncated reads, invalid
   manifests, duplicate/conflicting paths and unaccounted items.
3. For each operation, hash a versioned canonical encoding of semantic input:
   operation kind, workspace/owner/Wiki, exact input-blob manifest, ordered
   attachments, source identity, destination, relevant options and provider/model
   configuration identity. Pin Unicode/JSON encoding rules, reject invalid text
   representations, and retain raw HTTP/email/binary envelopes separately.
   Exclude changing transport attempt counters from the stable request digest.
4. Independently reconstruct that digest from the preserved inputs and compare
   it with admission, queue/job/effect records and destination receipt. Legacy
   records with no trustworthy digest get a verified migration manifest mapping,
   not an assertion that their unrecorded original input is known. A mutable URL
   alone cannot verify earlier fetched input.
5. Produce a reconciliation artifact binding source frontier, all object/input
   manifests, operation/effect inventories, resource/config/artifact identities,
   dispositions and evidence provenance. Restrict sensitive input access; reports
   contain references/hashes, not credential or message bodies. Checksums do not
   establish that the frontier was complete or authoritative.

Composition-root verification must mutate one input byte, attachment ordering,
owner, provider option and destination independently; each must reject reused
identity. Include raw invalid UTF-8, valid Unicode, short reads, oversized input,
missing blob, ambiguous legacy identity and tampered evidence provenance.

## Contract C3: snapshot, generation and canonical commit

The authority issues a snapshot handle `(workspace, generation, revision,
snapshotId)` bound to immutable references and relevant canonical configuration.
Read/list/stat and paginated listings use that handle consistently, including
negative reads, range membership, aliases, ownership and link targets. If snapshot
retention expires, explicitly restart/recompute; do not silently read current data.

A conservative first implementation uses the full workspace revision as its read
precondition. Computation must use the snapshot obtained before it started,
including source, purpose/schema, permissions and provider configuration inputs.
A caller must never fetch a fresh revision and attach it to stale generated
content. Any revision change causes conflict; recompute/revalidate through a
new recorded attempt against a fresh snapshot. Finer read sets require separate
proof of every dependency, including absent paths and range phantoms.

Generation is a server-owned capability boundary, not a clock or an HTTP hint.
Advance it only through an authenticated administrative operation with approved
capture/reconciliation evidence. Recheck active generation, admission validity,
read revision, owner permissions and all publication preconditions inside the
SQLite transaction after any R2/provider I/O. Cancellation and claim replacement
must prevent the stale attempt from committing even within one generation.

Prepare all immutable content objects create-only, verify stored bytes, then
perform a **SQLite-only transaction** containing canonical path references,
tombstones, canonical metadata/settings/job changes that belong to the operation,
revision/dataVersion increments, durable result receipt and outbox intents.
R2, KV, Vectorize, Queues and provider requests are outside that transaction.
[SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
and [Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
are the provider basis; implementation must recheck current APIs and limits.

A transaction either publishes the complete logical mutation or publishes none.
A Page mutation's crossrefs/backlink Page edits and historical log semantics
cannot be silently demoted to lossy projections. Inventory each lifecycle side
effect: canonical changes join the transaction; rebuildable indexes become
versioned projection intents; remote effects become C5 intents. Optional vector
failure must continue to leave ingest successful. Domain deletes publish
appropriate tombstones and preserve required history/evidence; physical erasure
policy is separately reviewed, with no blob deletion in this integration rollout.
Any conflict with an existing hard-delete/retention contract requires an explicit
ruling before its packet exits, not a quiet semantic change.

An identical retry returns its historical receipt even after a generation change,
subject to current read authorization. That receipt does not grant fresh
publication rights. If a commit response is lost, query receipt before retrying
computation/effects. A transaction failure may leave invisible R2 orphans but no
receipt/reference/outbox; retain them. Authority outage fails closed for writes;
never fall back to legacy direct storage.

## Contract C4: readers and projections

All canonical reads, assets, export, tree/search/graph, API/MCP and sidecar kernel
proxy reads resolve published references and tombstones. Physical bucket
enumeration and flat compatibility fallbacks must not resurrect unpublished,
deleted or previous-generation content. Snapshot-backed multi-read routes use
one handle; caches include generation, revision, owner/Wiki and relevant model.

KV/Vectorize projections carry generation, source revision, schema and model
identity. Write immutable projection versions and publish their authoritative
pointer/completeness state through the authority. Do not rely on a KV
read-compare-write high-water mark: KV is eventually consistent. A reader can
use a projection only when its version satisfies the canonical snapshot/read
contract; otherwise read/rebuild from authoritative references, or explicitly
report unavailability. Optional vector search falls back to tokenized retrieval.

A delayed projection worker must not overwrite current projection data or
advance the current pointer. Use generation/revision-isolated keys and validate
publication in the authority; verify every candidate result against canonical
visibility. Check model match and tombstones as well as revision. Rebuild jobs
must prove full membership, unchanged paths and deletes, not just advance a
counter. Current dataVersion remains monotonic from the captured floor and
changes after successful canonical commit, without waiting for eventual indexes.

## Contract C5: jobs, delivery and external outcomes

For S5/S12/S13/S14/S16, persist exact accepted inputs and stable job/effect identity
before dispatch. Queue messages reference that durable admission and input
manifest, carrying generation, operation/job ID and delivery-attempt metadata.
A receipt lookup and digest check precede every claim. The consumer forwards
authenticated transport; the kernel owns reconciliation, compile scheduling and
canonical outcome. Legacy envelopes are processed only through a proven mapping,
not by stamping them with the active generation.

Preserve serial ingest per Wiki across restarts and claims; claim replacement
fences stale completion. Persist Analysis for Generation-only retry. A provider
call begun before lease expiry may still run: a new claim cannot automatically
start a duplicate paid call. Preserve provider attempt/outcome state and use
query/idempotency evidence or explicit reconciliation before retry. Sidecar
extract keeps original bytes/hash, claim token, extracted result and kernel
receipt; a local completion or HTTP timeout does not establish kernel acceptance.

| Durable outcome | Required handling |
| --- | --- |
| Accepted, never dispatched, exact input verified | Dispatch from durable intent under active authority and documented retry policy. |
| Queue send confirmed, receipt absent | Await/reconcile delivery; duplicate transport only if kernel admission/commit and every resulting effect are idempotency-safe. |
| Send returned error or timed out after it may have reached service | Record `send_unknown` per batch/member; do not mark it unsent. Retain bytes. Query supported evidence or safely deduplicate eventual delivery through authority. Legacy unknown sends cannot be blindly replayed. |
| Canonical receipt present, response/queue ACK absent | Return historical result and settle transport from that evidence; do not rerun lifecycle/provider work. Track email notification separately. |
| Claimed/computing but no known provider outcome | Fence canonical publication, retain inputs and claim history, quarantine/reconcile the external call. Lease expiry is not a safe replay disposition. |
| Permanent invalid input | Preserve a durable reason and accepted-input custody before terminal disposition. Do not poison-ACK a valid request merely because migration is paused. |
| Partial canonical legacy operation | Reconcile captured changes and outstanding effects under one mapped operation identity; no inferred success from page bytes alone. |
| Effect prepared and proven not sent | Dispatch same stable effect ID with verified payload and pinned destination/config identity. |
| Effect sending, outcome unknown | Query provider/destination or use verified idempotency enforcement within its retention window. Otherwise quarantine for explicit owner reconciliation; no automatic resend. |
| Effect delivered, durable outcome verified | Persist authoritative receipt and never send again merely because a job was replayed. |

Effect intents contain effect ID, parent operation, generation, exact payload
hash, destination and credential-version identity, provider request key,
attempt history and durable evidence references. Persist `prepared` before
send and `sending` before external I/O. The latter means unknown after a crash.
`delivered`, `failed_known`, `cancelled_before_send`, `superseded` and
`outcome_unknown` are distinct. A local HTTP error may be unknown rather than
known failure. Destination settings changes cannot redirect an already prepared
effect to a new receiver without a new explicitly linked intent.

[Current integration delivery](../src/lib/integration-outbox.ts#L295) sends
before persisting the final receipt. Consumer/email-worker receipts are also
independent sends. A header named `Idempotency-Key` is insufficient without
receiver guarantees and expiry evidence. Email, webhook, provider billing,
research/extraction, sandbox and shell each need an outcome strategy. Do not
promise exactly-once remote delivery or infer “never sent” from absent logs.

Outbox generation checks alone cannot stop a paused sender already past its
check from calling a provider. New effect dispatch requires a capability gateway
or provider enforcement that old actors cannot bypass, **and** authoritative
accounting/reconciliation of previously dispatched calls. A gateway itself must
record in-flight sends before dispatch; cancellation after remote acceptance
cannot undo the outcome. Unknown legacy outcomes remain B4 blockers.

Maintenance refusals must preserve work without consuming a delivery budget.
Establish delivery pause first; future wire changes need a coordinated consumer
and kernel compatibility contract preserving AD-13. Record the observed 3-vs-4
attempt distinction from A5; do not change retry semantics accidentally.
Pause expiry and DLQ custody remain B3 gates regardless of new idempotency.

## Contract C6: permissions and resource separation

Exact names/IDs and IAM grants are an approval deliverable, not supplied or
applied here. Logical roles below describe required access. Frozen identifiers
remain unchanged; approved new resources are additions.

| Principal / role | Required access | Must be denied |
| --- | --- | --- |
| Legacy Workers, deliveries, email, scripts and sidecar credentials | Original resources retained for approved reconciliation only | Destination content, authority mutations, canonical metadata, new jobs/queues/DLQ and projection writes; ability to authorize new-generation effects |
| New kernel domain | Authenticated authority port and permitted reads; computation provider access only through C5 | Direct canonical mutable R2/KV writes, raw prefix deletion, authority admin transitions, arbitrary receipt insertion |
| Commit authority/content adapter | Own SQLite transaction state; create-only verified content access under enforced code/capability design | Legacy-store mutation, remote provider send inside transaction, public unauthenticated admin/test controls |
| Projection worker | Read accepted snapshot/outbox; write isolated versioned projections; request validated pointer publication | Canonical bytes/receipts/admin generation changes; deleting original vectors/resources |
| Thin queue consumer | Consume approved queue and authenticated kernel dispatch; approved receipt transport only | Canonical storage writes or new operation identity minting on retry |
| Sidecar/browser/API/MCP/agents | Owner-scoped kernel routes with admission IDs; sidecar local temp/workspace under existing policy | Destination bucket/authority credentials; parallel canonical store; legacy token upgraded implicitly |
| Capture/reconciliation operator | Separately approved source read/export and destination import scope; evidence-bound activation operation | Unreviewed secret export, broad resource deletion, automatic reset/restore or outcome invention |

A binding granting whole-bucket access can overwrite/delete regardless of code's
“create-only” convention; enforce trust boundaries by resources and narrow
interfaces, not path prefixes. Prove effective access for old deployed versions,
service bindings, API/S3 tokens, previews, alternate origins and pending calls.
R2's documented IAM propagation is not proof Workers bindings are revoked or
in-flight calls cancelled. Denial evidence and old-execution accounting are
separate required artifacts. No live permission inspection is authorized here.

## File-scoped future packets

All packets require separate implementation approval. Proposed new filenames
are marked **new**. Existing files remain unchanged in this handoff. Each packet
must execute its real composition root end-to-end with synthetic inputs; unit
mocks/source scans alone do not establish completion. Tests run against the
packet's immutable SHA and exercise actual storage/runtime boundaries.

| Packet / coverage | Files and concrete work | Dependencies / entry evidence | Exit evidence and composition-root test |
| --- | --- | --- | --- |
| P0 Coverage and bootstrap contract; all S/A/B | This document, feasibility doc, architecture spine and `docs/ad15-production-rollout.md` in a separately approved decision packet; expand route/tool/task/store/resource census into a machine-readable manifest **new** `tools/write-safety-capture/coverage.json` | Architecture decision owner; B1–B7 evidence investigation authorization. No cloud changes from source inventory | Every S1–S16 and A1–A10 has explicit callers, stores, effects and disposition; actual live inventory has no unexplained capability/key. B1/B2 bootstrap proven or packet reports blocked. Architecture amendments approved explicitly. |
| P1 Authority and input verifier; all canonical S, C1–C3 | **new** `src/lib/write-authority/{types,admission,client}.ts`, **new** authority Worker entry/schema under `workers/write-authority/`; **new** bounded verifier under `tools/write-safety-capture/`; adapt `storage/types.ts`, `storage/index.ts`, `storage/r2.ts`, `storage/filesystem.ts`; retain lab as isolated regression proof | P0 approved contracts, resource/size limits and no-active-routing design; synthetic-only implementation authorization | Real local Worker→authority→SQLite/R2 commit/read/receipt flow; invalid input digest, concurrent ID/revision conflicts, stale generation after upload, transaction failure and commit-before-response restart. No fallback/direct writer capability; scope-bound context never leaks through singleton. |
| P2 Canonical lifecycle and bulk domain; S1–S3/S10/S15, A1/A2/A9 | `lifecycle.ts`, `wiki.ts`, `raw.ts`, `silo.ts`, `wiki-log.ts`, `merge.ts`, `source-cascade.ts`, `source-meeting.ts`, `talk.ts`, `revisions.ts`, `wikis.ts`, `wiki-artifact-revisions.ts`, `workspace-profile.ts`, `data-version.ts`, `tenant-admin.ts`, `portable-archive.ts`, `backups.ts`; admin reset/migrate/tenant/rebuild and archive import routes | P1; operation boundaries, compatibility election, historical log/deletion semantics approved | Authenticated route→lifecycle→authority, including merge/delete crossrefs, immutable source, conflicting compatibility copies, archive/bulk partial-failure recovery, monotonic version. Failure between preparation/publication exposes no partial canonical operation. Large bulk work uses staged generation publication or approved resumable chunks with explicit per-chunk semantics; never labels sequential writes atomic. |
| P3 Durable owner/settings state; S4/S6–S8/S14/S15, A1–A3/A9 | `config.ts`, `agents.ts`, `agent-skills.ts`, `agent-workspaces.ts`, `chat.ts`, `chat-conversation-store.ts`, `todos.ts`, `review-queue.ts`, `action-items.ts`, `memory-proposals.ts`, `structured-knowledge.ts`, `graph-insight-dismissals.ts`, `query-history.ts`, `evidence.ts`, `retrieval-evals.ts`, `vault.ts`, `email-ingest.ts`, `monitor-digests.ts`, `local-sync-clients.ts`, relevant Workbench/settings/API routes | P1; canonical-vs-projection key classification including all `putIndex` callers; privacy and config digest policy | Browser/API entry→kernel→authority settings, conversation, Todo decision, Review and vault mutation across restart; simultaneous owners/requests do not share admission context; stale settings/token and lost-response retries do not duplicate or overwrite accepted state. |
| P4 Jobs and computation; S5/S12/S13/S16, A1–A7 | `ingest.ts`, `ingest-jobs.ts`, `ingest-analysis.ts`, `ingest-bookkeeping.ts`, `ingest-staging.ts`, `fetch.ts`, `vision.ts`, `illustration.ts`, `extract-dispatch.ts`, `ingest-async.ts`, `workbench-intake.ts`, `extract-jobs.ts`, `extract-heartbeat.ts`, `graphify-jobs.ts`, `research-projects.ts`, `research-runtime.ts`, `research-completion.ts`, `agent-runtime.ts`, `source-monitors.ts`; `sidecar/extract-loop.mjs`; intake/extract/email routes | P1–P3; C5 provider outcome strategy and AD-9 schedule contract | Real intake→raw input→claim→Analysis→Generation→lifecycle or sidecar extract→kernel completion with local provider service fixture; concurrent same-Wiki deliveries serialize; cancelled/replaced claims cannot publish; byte-digest mismatch and missing attachment fail before acceptance; generation-only retries preserve paid Analysis and unknown provider outcomes quarantine. |
| P5 Queue and external delivery; S14/S16, A4–A8 | `tasks.ts`, tasks/run and tasks/scan routes, `integration-outbox.ts`, `monitor-digests.ts`, `operation-ledger.ts`, `workers/task-consumer/index.ts`, `workers/email-ingest/index.ts`, `sandbox-service.ts`, provider adapters and sidecar shell/Chat dispatch; approved consumer wire compatibility changes | P1/P4; explicit policy for every task kind and provider/destination; retry/retention and effect capability contract | Real consumer→kernel→authority→local remote service; partial batch response loss, duplicate delivery, effect-before-receipt crash, ACK loss, pause refusal and legacy email already past config read. Verify remote fixture sees one accepted idempotent effect where supported; unknown outcomes remain visibly blocked elsewhere. No provider/email messages to real recipients. |
| P6 Reference reads and projections; S1–S11/S14, A1–A3/A6/A9 | `storage/*`, `page-index.ts`, `backlink-index.ts`, `owner-index.ts`, `contributor-index.ts`, `recent-index.ts`, `discuss-stats-index.ts`, `names-terms.ts`, `embeddings.ts`, `maintenance.ts`, canonical index consumers, tree/search/graph/asset/archive routes, `src/mcp.ts`, `mcp-http.ts`, sidecar kernel proxy | P1–P5 canonical contract; complete read caller inventory and generation/model cache keys | Real HTTP/MCP read/list/stat/search/export after create/delete/merge and restart; delayed projection cannot resurrect tombstones or drop unchanged paths; stale/negative KV reads fall back safely; explicit snapshot pagination sees one revision; optional vector model mismatch falls back. |
| P7 Admission and capabilities; all S/A, especially A1–A3/A9/A10 | Auth/admission middleware and all mutating routes/tools; `src/mcp.ts`, `mcp-http.ts`, `sidecar/server.mjs`, Chat transport, extract/shell, `tools/work-wiki-sync.mjs`, `scripts/`; root and Worker Wrangler configs only in separately approved configuration packet | P0 live capability census, P1–P6 complete coverage; explicit resource provisioning/config authorization | Whole-system synthetic rehearsal suspends every A family after acceptance/read and before write/send, advances generation, then resumes legacy execution. Denial covers storage/jobs/projections and effects; all accepted inputs accounted. Verify reset/restore/direct CLI and alternate route bypasses fail closed; no old token gains new authority. |
| P8 Capture, activation and forward recovery; all S/A/B | Approved capture verifier/copy/reconciliation tooling, integration runbook and AD-15 rollout record; configuration only under separate release authorization | P0–P7 exact-head acceptance, B1–B7 resolved, current official/live evidence, capacity/retention rehearsal, source-capture and architecture approval | Representative isolated nonproduction full capture→verified import→projection rebuild→activation→new write→failure→forward recovery; original resources retained. Production only after separate authorized rollout with exact artifact/config IDs, owner-auth reads/reversible isolated write, operation/effect accounting and recovery evidence. |

P4 must preserve the existing intake composition in `extract-dispatch.ts` and
`ingest-async.ts`; `workbench-intake.ts` supplies classification policy rather
than a second storage writer. Provider adapters selected by configuration must
also appear in P0. Any discovered mutator/read/effect outside these families
extends P0 and blocks activation until assigned and tested.
No quota of findings or source-string test can substitute for this coverage.

## Activation and forward recovery sequence

1. Keep the current runtime unchanged while B1–B7 remain unresolved. Complete
   P0's supported bootstrap, approval and coverage; do not install a “temporary”
   bridge that assumes old unjournaled work has drained.
2. Rehearse P1–P8 on isolated synthetic resources with denied real outbound access.
   Record artifact hash, configs, capability identities and every failure verdict.
   Real-data export/inspection, provisioning and release require explicit approval.
3. In the approved window, apply recorded reversible pauses to every A family.
   Preserve queue/DLQ inputs before expiry/cleanup, establish the authoritative
   legacy frontier and reconcile every operation/effect. Source unknowns block.
4. Verify C2 actual bytes and semantic consistency across all S families. Import
   into an inactive destination generation through an evidence-bound authority
   operation; no owner writes yet. Rebuild/verify projections, monotonic counter
   floors and owner reads. Import completion is recorded durably and restartable.
5. Activate only when the coverage manifest, real capture evidence and exact
   artifact are complete; atomically choose the accepted destination generation
   at the authority. Routing may propagate separately: old routes must be denied
   new capabilities/admission, and routing percentages never stand in for drain.
   Preserve AD-15's readiness ordering and obtain a ruling if the proposed
   authority changes that procedure; this spec does not silently replace it.
6. Resume admissions deliberately with durable IDs, verify owner behavior and
   reconcile queued/delayed/retried inputs and external receipts. Record the
   first new committed revision as the point beyond which old-snapshot rollback
   is insufficient.
7. If failure occurs before new writes, an approved return to the source is
   allowed only after proving it still matches the cutoff and reconciling any
   effects/admissions since capture. If new writes or effects have occurred,
   fence further admission, retain destination receipts/inputs and recover
   forward. Replay verified committed references and safe projection intents;
   reconcile external unknowns. Do not route back and discard accepted work.
8. Preserve source resources, jobs, unresolved inputs and upload orphans. Recovery
   is complete only when each accepted operation and effect has a verified
   disposition and owner reads agree with the accepted revision. Physical cleanup
   or irreversible erasure is a different approved task.

## Handoff acceptance

The feasibility walkthroughs for delayed legacy execution, expiry, partial sends,
commit-before-response, effect-before-receipt, changed email payload, partial
lifecycle and recovery after new writes map to C1–C6 and P1–P8 above. Before
activation those walkthroughs must become composition-root executions with
controlled barriers and durable restart, plus provider/live evidence where a
local fixture cannot establish the guarantee. Tests must inspect actual input
bytes, canonical references/tombstones, revision/receipt counts and observed
remote outcome records; checking only a status field is insufficient.

This prose packet has not run those future tests, migrated code or established
production readiness. Its completed result is a conditional, file-scoped handoff
and an explicit blocked capture decision.
