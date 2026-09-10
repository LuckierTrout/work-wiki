# B1/B2: lossless bootstrap feasibility and the next evidence request

Investigated 2026-09-09 against source
`3e786d97090347b012d30b0dee485c3b761c2c2d` and current public Cloudflare docs.
**Verdict: neither gate can be closed from the evidence available.** This is a
completed bounded investigation, not a claim the provider can never support it.
Do not build or activate a production migration on an assumed capture barrier.

This refreshes the proposed [PR #13 handoff](https://github.com/LuckierTrout/work-wiki/pull/13)
after canonical-owner work and the raw-source/browser-CI changes. PR #13 remains
a proposal; its architecture and release gates are not adopted here. No cloud
account, credentials, real data or external outcome was inspected. No provider
message was sent and no resource was changed.

## What the current evidence establishes

| Question | Documented or observed fact | Consequence / still missing |
| --- | --- | --- |
| Can a Worker version restore the starting data? | Versions capture code/config; associated storage changes are outside versions. [Versions](https://developers.cloudflare.com/workers/versions-and-deployments/) | A code rollback does not supply B1's data frontier. |
| Does a sequence of R2 reads form one snapshot? | R2 read/write/delete/list operations are strongly consistent; competing writes use last-completed-write behavior. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) | Inference: individual operation guarantees do not establish a shared snapshot across a changing multi-request capture, KV and queues. |
| Can an R2 retention lock freeze all writes? | Bucket locks prevent object overwrite/deletion for the retention period. [Locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) | No documented cross-store admission or execution barrier is supplied; this is not a complete capture protocol. |
| Can we wait for KV to settle and call it complete? | KV is eventually consistent, including cached absence; even same-location immediate visibility is not guaranteed. [KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/) | A fixed wait or repeated matching scan cannot certify the required frontier. Need authoritative capture semantics including values/expiry and concurrent writes. |
| Can a fixed delay prove old HTTP work is finished? | HTTP execution can continue while the client remains connected; waitUntil's post-response limit is not total request duration. [Limits](https://developers.cloudflare.com/workers/platform/limits/), [context](https://developers.cloudflare.com/workers/runtime-apis/context/) | A duration bound is not an operation census or a receipt proving what completed. No timeout-based drain inference. |
| Does one queue delivery settle an operation? | Queues provides at-least-once delivery; duplicates are possible. [Delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) | Queue/ACK observations need stable input identity, preserved bytes and effect reconciliation. |
| Can current app history enumerate accepted work? | operation-ledger.ts caps retained history and has fail-soft recording; portable archive is sequential and excludes state families. | The existing ledger/archive cannot serve as complete admission or capture evidence. |

Context7 was queried first for Workers and KV; broad combined queries had no
match, so narrower official pages were checked directly. A missing search result
is not evidence of a nonexistent capability. R2 Data Catalog's Iceberg table
snapshots were also excluded: they are not snapshots of this application's
arbitrary object/KV/queue state. [Catalog scope](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/)

## Source refresh after the owner changes

The [source evidence record](write-safety-b1-b2-source-evidence-2026-09-09.json)
records exact file hashes and reference locations for selected current source
families. It is navigation evidence, not a complete call graph or live census.

- Canonical-owner addressing now separates authenticated actors from storage
  tenant selection. It deliberately preserves already-existing drifted tenant
  data. A capture must inventory those older silos as well as the canonical one;
  changing active readers does not authorize discarding old bytes.
- Canonical settings still pass through generic index APIs: email configuration,
  vault membership and digest settings are not all disposable search indexes.
  R2-only export remains insufficient even after ordinary owner fixes.
- The existing source deletion, merge/recovery, ingest/extract staging and
  provider/outbox paths span multiple writes. Source-level locks and current
  receipts do not constitute a universal admission journal.
- The new browser CI job verifies product behavior with synthetic data. It proves
  neither live capture completeness nor termination of old Workers.

## B1 — precise acceptance evidence

The provider/operator must identify a supported capture boundary, not merely a
copy command. Its retained evidence must name:

1. Exact resource/config identities and every canonical, historical, operational
   and projection store, including global keys, legacy silos, metadata and expiry.
2. A common frontier or a documented per-store reconciliation method: what can
   change during capture, how every intervening mutation is retained, and how
   original bytes remain recoverable after overwrite/delete.
3. Captured input/operation/effect inventories linked to verified bytes and
   digests. Missing or unclassified records remain explicit unknowns.
4. Resumable capture receipts, completeness checks, and how partial lifecycle
   state is reconciled without inventing success or replaying an unknown effect.

**Blocking gap:** no authoritative source frontier or complete retained mutation
history has been supplied for this deployment. The repository cannot manufacture
that evidence after the fact.

## B2 — precise acceptance evidence

The provider/operator must cover browser/API/MCP, service bindings, alternate
routes, queue/DLQ consumers, cron, email, sidecar/agents, direct credentials, and
child/background/provider work. For each family retain:

1. The admission cutoff identity and evidence it covers every relevant route,
   version, capability and producer, with an inverse procedure.
2. A complete inventory of pre-cutoff accepted work, including work already past
   application gates, response-lost requests and not-yet-started deliveries.
3. Per-operation terminal disposition or durable pending custody, plus external
   outcome reconciliation. Killing an execution is not proof its effect did not
   happen or that its accepted input was saved.
4. A supported guarantee explaining old-version behavior during cutoff and
   retirement. Logs, quiet traffic, elapsed time and empty queues alone do not
   meet this requirement.

**Blocking gap:** no complete pre-cutoff admission/execution inventory or
provider-backed terminal-accounting guarantee has been established. Instrumenting
new admissions prospectively does not retroactively close this gap.

## Recommended path and stop conditions

Prefer an approved maintenance/capture path **only if** the operator/provider can
prove the cutoff, terminal accounting and authoritative state capture above.
Test that proposed sequence locally with delayed old requests, interrupted
capture, and ambiguous queue/effect outcomes before any live execution.

If the provider cannot supply that path, evaluate a retained baseline plus
lossless mutation/input/effect journal. It must cover old work already admitted
before the journal was deployed; a new journal alone is not sufficient. If neither
path meets the requirements, leave the migration blocked and continue ordinary
fixes. A reset or accepted loss of unresolved work would be a new owner-approved
intent, not a successful lossless migration.

## Ready-to-send provider/operator request — not sent

> We are evaluating a lossless cutover of legacy Workers using R2, canonical KV
> settings and Queues/DLQ, with HTTP, service-binding, scheduled, email and
> background/provider effects. We need documented guarantees for two points:
> (1) a supported consistent capture frontier across the affected stores, or a
> complete retained change/reconciliation protocol; (2) a cutoff and complete
> accounting of old accepted/in-flight/child work, including requests already
> past application checks. Please identify supported APIs/procedures, scope and
> exclusions, propagation/termination behavior, and evidence we can retain.
> A code version, retention lock, fixed wait, sampled logs or matching scans alone
> will not meet the acceptance requirements. If no such supported mechanism
> exists for this account/runtime, please state the limitation explicitly.

The operator's companion packet should contain **redacted metadata only** first:
resource IDs and roles; deployed version/config identities; routes/triggers and
service bindings; credential *names/scopes*, not values; queue retention settings
and existing input-custody/accounting coverage. Actual values/exports and any
mutation require their separate scoped authorization. No live action is implied
by preparing this request.

## Concrete next work

- Owner: choose the operator/provider contact and authorize the redacted
  metadata inspection and/or sending the request above.
- Engineer: compare returned guarantees to B1/B2 and produce one executable
  nonproduction protocol with acceptance counterexamples, or retain a precise
  blocked verdict. Do not provision destination resources while feasibility is
  unresolved.
- Continue independent deferred fixes and the six contract decisions. The other
  five write-safety gates remain open; passing B1/B2 would not by itself authorize
  architecture adoption or deployment.
