# Write-safety capture feasibility

Verdict: **BLOCKED for live capture and production activation.** Documentation
handoff completed against source baseline
`0e8f1166557c6159b7a9069d8865c7eebd440441` on 2026-09-08. The
[local publication proof](write-safety-cutover-design.md) supports an isolated
commit-authority candidate. It does not establish complete source capture.
The [conditional integration specification](write-safety-production-integration-spec.md)
is proposed future work, subject to architecture and implementation approval.

No real data, credentials, authenticated cloud state, or external outcomes were
inspected. No resources were provisioned, paused, copied or changed. AD-15's
[rollout prerequisites](ad15-production-rollout.md) remain binding. A blocked
capture verdict is a completed outcome for this investigation, not permission
to waive a gate.

## Evidence and decision rules

**Observed** means local source at the baseline, not deployed behavior.
**Documented** means the linked official provider documentation, retrieved
2026-09-08 using Context7 and the Cloudflare documentation site. **Inference**
is the consequence drawn here; **unknown** means evidence still required.
Local configuration values are never a statement about the live account.

A capture boundary must account for every accepted input, every canonical
mutation and every possibly started external effect, including old executions
that already passed their checks. A complete file inventory alone cannot
answer whether a missing page represents an unstarted task, a completed delete,
a partial lifecycle operation or a lost write. An acceptable boundary needs
both a state inventory and operation/effect accounting.

## State inventory and capture omissions

The IDs below are shared with the integration packets. Paths are storage-relative
unless they name source files. C = canonical or irreplaceable evidence;
P = projection, rebuildable only from a proven canonical generation;
O = operational state that must be preserved and reconciled, not replayed as authority.
Unclassified keys, old layouts and corrupt/quarantine files are retained as
unknowns; they cannot be discarded because current code does not read them.
This is a source-backed family inventory. A complete, exact live key/capability
census and a transitive caller coverage report are still required by B1/B2.

| ID / class | Observed source and state | Omission or resolution required |
| --- | --- | --- |
| S1 C | [lifecycle.ts](../src/lib/lifecycle.ts#L440), [wiki.ts](../src/lib/wiki.ts), [raw.ts](../src/lib/raw.ts), [silo.ts](../src/lib/silo.ts): tenant Pages, immutable raw Sources, assets, discussions, revisions; flat `wiki/`, `raw/`, `discuss/` compatibility layouts | Capture all tenants and both layouts, exact bytes, metadata and case variants. Preserve differing copies; resolve canonical ownership using current read rules, without overwriting disagreement. Capture delete/merge receipts and cross-page changes as part of an operation. |
| S2 C/P | [lifecycle.ts](../src/lib/lifecycle.ts#L636), [wiki-log.ts](../src/lib/wiki-log.ts), [page-index.ts](../src/lib/page-index.ts), [revisions.ts](../src/lib/revisions.ts): `wiki/log.md`, index files, append-only history, compatibility copies | The log and revision bytes are historical evidence, not recreatable indexes. `wiki/index.md` is a projection with current read-path significance. Lifecycle primary writes, indexes, crossrefs, log and receipts are separate writes; capture must detect partial operations. |
| S3 C | [wikis.ts](../src/lib/wikis.ts#L162), [wiki-artifact-revisions.ts](../src/lib/wiki-artifact-revisions.ts), [workspace-profile.ts](../src/lib/workspace-profile.ts): `tenants/<t>/wikis.json`, Wiki artifacts, purpose/schema, revision history, discard/recovery state and legacy workspace purpose | Keep registries and artifacts together; resolve interrupted create/delete/re-template states. Preserve executable schema/purpose inputs used by admitted computation. Archive purpose overrides are transformed export bytes, not physical capture. |
| S4 C | [todos.ts](../src/lib/todos.ts#L44), [chat.ts](../src/lib/chat.ts#L234), [chat-conversation-store.ts](../src/lib/chat-conversation-store.ts), [review-queue.ts](../src/lib/review-queue.ts#L87): Todos, conversations/messages, review queue and review outbox | Preserve decisions, rejected/completed items, ordering, pending turns, source-missing flags, CAS state and pending review effects. Do not rebuild these from Pages or browser state. |
| S5 C/O | [research-projects.ts](../src/lib/research-projects.ts#L317), [research-runtime.ts](../src/lib/research-runtime.ts), [research-completion.ts](../src/lib/research-completion.ts): research state, provider results, resumable completion/quarantine evidence | Capture pending/running/terminal state and exact inputs/results; correlate remote calls and completion receipts before resume. A lease timeout is not a completed provider call. |
| S6 C/O | [action-items.ts](../src/lib/action-items.ts#L47), [memory-proposals.ts](../src/lib/memory-proposals.ts#L95), [structured-knowledge.ts](../src/lib/structured-knowledge.ts#L156), [graph-insight-dismissals.ts](../src/lib/graph-insight-dismissals.ts), [query-history.ts](../src/lib/query-history.ts#L71), [retrieval-evals.ts](../src/lib/retrieval-evals.ts), [evidence.ts](../src/lib/evidence.ts) | Preserve user-edited graph/evidence, dismissals, action state, proposals and history. Generated origin does not make owner decisions disposable. Preserve associated indexes until their rebuild inputs and completeness are proven. |
| S7 C | [config.ts](../src/lib/config.ts#L369), [agents.ts](../src/lib/agents.ts#L27), [agent-skills.ts](../src/lib/agent-skills.ts#L27), [agent-workspaces.ts](../src/lib/agent-workspaces.ts): root `.llm-wiki-config.json`, `agents/`, `agent-secrets/`, tenant Skills and kernel agent records | Tenant archive misses root configuration and agent credentials. Preserve config version/digest together. Sensitive values require approved protected capture; public evidence records names, identities and hashes only. Do not expose secrets in the handoff. |
| S8 C | [email-ingest.ts](../src/lib/email-ingest.ts#L107), [vault.ts](../src/lib/vault.ts#L121), [monitor-digests.ts](../src/lib/monitor-digests.ts#L212): logical KV keys `email-ingest-config`, vault definitions/membership, per-owner digest settings | `getIndex` does not imply disposable data. Capture canonical KV values, metadata/expiry if present and matching revisions under a supported consistency protocol. Tenant R2 archive cannot include them. |
| S9 P | [storage/r2.ts](../src/lib/storage/r2.ts#L310), [maintenance.ts](../src/lib/maintenance.ts), page/owner/contributor/backlink/recent/discussion indexes; digest/outbox schedule summaries | Separate rebuildable indexes from S8 and S10. Capture keys and dependencies; rebuild from accepted generation, compare semantic counts and member identities, and keep stale projections from controlling canonical reads or scheduling. |
| S10 C/O | [storage/types.ts](../src/lib/storage/types.ts#L291), [storage/r2.ts](../src/lib/storage/r2.ts#L310), [data-version.ts](../src/lib/data-version.ts): `data-version` and `embedding-rebuild-epoch` | Current adapter reads/writes R2 counter objects and increments with CAS; absent objects can seed from legacy KV. Capture both and reconcile monotonic floors. AD-11 still says KV: an architecture reconciliation is proposed, not silently adopted. |
| S11 P | [storage/r2.ts](../src/lib/storage/r2.ts#L400), [embeddings.ts](../src/lib/embeddings.ts): Vectorize and fallback KV vectors, model tags | Isolate and rebuild, or keep optional vectors off. Current managed clear is a logged best-effort no-op, not erasure evidence. Validate generation, model, revision and canonical visibility on reads; keep original resource intact. |
| S12 C/O | [ingest-jobs.ts](../src/lib/ingest-jobs.ts#L125), [ingest-analysis.ts](../src/lib/ingest-analysis.ts), [ingest-bookkeeping.ts](../src/lib/ingest-bookkeeping.ts), [ingest-staging.ts](../src/lib/ingest-staging.ts#L52): global `ingest-jobs/`, `raw/uploads/<jobId>/`, analysis and ingest ledger | Preserve durable inputs, attachments, analysis output, source digests, cancellations and partial publications before cleanup. Global staging/status are outside tenant-only export; URL alone cannot reproduce historical fetched bytes. |
| S13 C/O | [extract-jobs.ts](../src/lib/extract-jobs.ts#L129), [extract-heartbeat.ts](../src/lib/extract-heartbeat.ts), [graphify-jobs.ts](../src/lib/graphify-jobs.ts#L62): global extract jobs/poll state, tenant graphify jobs/latest pointers | Preserve raw input, claim/attempt identity, extraction output and pending kernel completion. A sidecar poll heartbeat does not establish that claimed work is terminal. |
| S14 C/O | [source-monitors.ts](../src/lib/source-monitors.ts), [monitor-digests.ts](../src/lib/monitor-digests.ts#L133), [integration-outbox.ts](../src/lib/integration-outbox.ts#L295), [operation-ledger.ts](../src/lib/operation-ledger.ts#L34) | Preserve schedules, durable effect payloads, destination/config identity, receipts and uncertain sends. Operation history is capped at 2,000 and safe recording can swallow errors: not a complete admission ledger or authoritative deduplication. |
| S15 C/O | [backups.ts](../src/lib/backups.ts#L100), [local-sync-clients.ts](../src/lib/local-sync-clients.ts#L25), [lock.ts](../src/lib/lock.ts#L153), [storage/filesystem.ts](../src/lib/storage/filesystem.ts): global `backups/`, sync records, locks/locks-v2, scratch and recovery artifacts | Retain backups/manifests and operational evidence, including truncation. Do not carry old lock tokens into new authority, delete orphan locks, or treat hidden scratch as proof of no work. Filesystem is local-dev, not a second production canonical tree. |
| S16 O/C | [tasks.ts](../src/lib/tasks.ts#L432), [consumer](../workers/task-consumer/index.ts#L69), [email Worker](../workers/email-ingest/index.ts#L1108), [sidecar](../sidecar/server.mjs#L380), [sandbox-service.ts](../src/lib/sandbox-service.ts), root/Worker Wrangler configs | Queue/DLQ bodies, attempts/delays/expiry, provider jobs and receipts, runtime versions/routes/bindings/secret names, outstanding HTTP/background/cron/email work, local shell or extraction results not yet accepted by kernel. No application archive captures these. Capture configuration identity separately from data and resolve any unpublished accepted input. |

`buildPortableArchive` [lines 32–159](../src/lib/portable-archive.ts#L32)
walks one tenant sequentially, excludes `wiki/index.md` and `wiki/log.md`,
substitutes effective purpose bytes, adds Obsidian stubs, and builds an in-memory
ZIP. Checksums prove only the bytes read/exported. Neither the first listing nor
the last hash establishes a common instant. Its [import](../src/lib/portable-archive.ts#L288)
writes tenant objects and compatibility copies, then rebuilds indexes; the R2
[batch adapter](../src/lib/storage/r2.ts#L583) is pass-through. Restore is therefore
another multi-step writer, not a capture or atomic rollback primitive.

## Admission, execution and effect coverage

Each A row must get an authoritative pause/cutoff identity, an inverse procedure,
a census of pre-cutoff accepted work, and dispositions for S-state/effects it
can touch. “Paused” without coverage of already-admitted work is insufficient.

| ID / family | Observed entry/effect path | Required resolution |
| --- | --- | --- |
| A1 Browser and HTTP | `src/app/api/`: Page edit/delete/revert/merge, Workbench intake/upload/source/activity, `/save`, clips/bookmarklet/share, URL/folder import, Chat save, Settings/Wikis/Review/Todos/graph/actions | Gate admission before work or provider calls; inventory each route and hidden write on reads. Preserve response-lost requests and accepted bodies. Owner-auth is identity, not a cutoff. |
| A2 MCP/API/direct tools | [src/mcp.ts](../src/mcp.ts), [mcp-http.ts](../src/lib/mcp-http.ts), `/api/v1`, agent runtime and direct library/CLI callers | Include stdio processes, HTTP MCP, tokens, direct store callers and API retries. Every mutating tool needs stable operation identity or an explicit rejected disposition before acceptance. |
| A3 Sidecar/local agents | [server.mjs](../sidecar/server.mjs#L380), Chat transport/provider, extract worker, shell/Skills and agent-workspace | Its local admission gate cannot enumerate remote kernel work. A 60-second proxy abort reports `kernel_unreachable`, not upstream cancellation. Capture pending turns, extract claims/results and shell/provider outcomes; deny legacy credentials access to new authority. |
| A4 Queue producers | [tasks.ts](../src/lib/tasks.ts#L432), intake/email/agent/scan enqueues | `enqueueTask` can return unavailable; `enqueueTasks` records only completed 100-message batches. A rejected send/response-lost batch may have been accepted remotely. Preserve each input and mark that batch ambiguous, never assume the whole tail is unsent. |
| A5 Queue consumers/DLQ | [runTask](../workers/task-consumer/index.ts#L69), [tasks/run](../src/app/api/tasks/run/route.ts#L194) | Local config has concurrency **4**, batch size 1, max retries 3; a nearby comment says three and is not authoritative. Preserve independent deliveries, ACK/retry and notification outcomes. Read-only 403 is transient here, consuming retries and potentially sending failure email. Kernel ingest failure threshold `attempt >= 3` can return 422 and poison-ACK earlier than the consumer's 4-delivery ceiling. Do not normalize budgets from comments. |
| A6 Scheduled/background work | [tasks/scan](../src/app/api/tasks/scan/route.ts#L100), [consumer cron](../workers/task-consumer/index.ts#L257), agent/monitor/digest/outbox/backup scheduling | `AUTONOMOUS_MAINTENANCE` off does not stop index repair, job GC, orphan/scratch cleanup, schema/purpose repairs or other enqueue/delivery families. Stop admission and independently account for active scans, chained tasks and background promises. |
| A7 Email/inbound integrations | [email Worker](../workers/email-ingest/index.ts#L1108), [email route](../src/app/api/email/ingest/route.ts#L432), Intake integrations | Email Worker reads shared KV before forwarding and may reply independently. A request already past that read survives a flag change. Message-ID-derived job lookup does not bind payload digest or atomically cover attachments, jobs, staging and enqueue. Preserve each attachment and raw input accepted at each boundary; distinguish explicit rejection from acceptance whose reply was lost. |
| A8 Remote effects | [integration-outbox.ts](../src/lib/integration-outbox.ts#L295), monitor digest send, task completion/failure email, email replies, LLM/embedding/research/extract providers, sandbox and approved shell | Persist request identity, exact payload digest and intended destination before send; reconcile provider IDs and outcome evidence. Webhook `Idempotency-Key` does not prove receiver enforcement. Remote success before local receipt is unknown, not safe to replay. Provider spend is also an external outcome. |
| A9 Administrative/bulk work | [admin/reset](../src/app/api/admin/reset/route.ts), [tenant-admin.ts](../src/lib/tenant-admin.ts), admin/migrate/rebuild-embeddings, archive import, backup restore, source cascade, Wiki delete/re-template | Read-only leaves reset, archive import and tenant migration writable; tenant deletion has an early refusal but still needs new authority coverage. Capture partial bulk results; fence direct recursive delete and rebuild paths, including restore compatibility copies. |
| A10 Operator/script/resources | [tools/work-wiki-sync.mjs](../tools/work-wiki-sync.mjs), `scripts/`, external schedules, local stdio/CLI, old Worker versions, object APIs/service bindings and credentials | Inventory actual running tools and credentials with approved inspection, including direct R2/KV/queue access, alternate origins and preview/version routes. Prefix separation does not restrict a whole-bucket binding. Control-plane changes must not destroy original resources. |

All twelve task kinds parsed by [tasks.ts](../src/lib/tasks.ts#L492) are in scope:
`ingest`, `maintain`, `extract-actions`, `extract-todo-candidates`,
`extract-knowledge`, `compile-knowledge`, `run-agent`, `run-research`,
`monitor-source`, `deliver-monitor-digest`, `deliver-integration`, `create-backup`.
They map respectively to A4–A6 with S12, S1–S2, S6, S4, S13/S6, S6,
S7/S1, S5, S14/S12, S14, S14 and S15; their provider effects also map to A8.
Unknown legacy message kinds remain preserved/quarantined.
[DEPLOY.md](../DEPLOY.md#L550) documents read-only exceptions;
[withDurableLock](../src/lib/lock.ts#L153) gates callers using that lock only.
Neither is deployment-wide admission control.

## Provider guarantees and candidate feasibility

| Candidate / evidence | Documented guarantee | Inference and required missing evidence |
| --- | --- | --- |
| Worker version capture/rollback | Versions contain code/config; associated storage changes are excluded. [Versions](https://developers.cloudflare.com/workers/versions-and-deployments/) | Not a data snapshot or proof old executions ended. Need complete version/execution/background accounting and routing/capability coverage (B2). |
| Pause all queues plus maintenance flags | Paused queues continue accepting messages and messages still expire. [Pause delivery](https://developers.cloudflare.com/queues/configuration/pause-purge/) | No documented cross-service barrier or in-flight terminal census supplied. Need approved lossless retention plan and pause/resume evidence (B3), plus A1–A10 cutoff. Purge is forbidden. |
| R2 scan/copy/checksum | Object reads/writes/deletes and lists are strongly consistent; IAM updates are eventually consistent. [Consistency](https://developers.cloudflare.com/r2/reference/consistency/) | Individual operations do not freeze a sequence of reads, an entire paginated capture or KV. Token revocation is not proof old bindings/requests stopped. Require provider-backed freeze semantics or complete mutation journal (B1/B2). |
| R2 bucket retention lock | Prevents deletion/overwrite of retained objects. [Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) | Does not establish prohibition of new keys, a coherent lifecycle commit, KV freeze or effect fencing. It can strand partial legacy writes. Retention is not the required barrier; do not enable it in this packet. |
| R2 change notifications plus copy | Notifications cover object creation/overwrite and deletion; messages identify object metadata. [Events](https://developers.cloudflare.com/r2/buckets/event-notifications/) | No historical overwritten bytes, KV changes, operation-wide commit boundary or external outcome is provided by this schema. Need lossless ordered/reconcilable history, start/end coverage and retained bytes before any overwrite/delete; notifications alone fail B1/B4. |
| KV export after waiting | KV is eventually consistent, including negative lookups; same-location visibility is not guaranteed. [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/) | A fixed wait cannot certify a snapshot. Need supported authoritative capture of S8 and legacy counter seeds at cutoff, including expiry; otherwise blocked (B1). |
| Instrumented admission journal, then reconcile | No such complete protocol exists in observed legacy code; S14 history is capped/fail-soft | Promising prospective design only. Must bootstrap around uninstrumented in-flight work; deploying a journal today cannot retroactively enumerate yesterday's accepted requests (B2/B4). |
| Distinct destination resources and authority | The local synthetic proof rejects delayed legacy publication when old code lacks destination capabilities | Protects new current data, but not completeness of its seed or old remote effects. Required isolation is necessary, not sufficient (B5). |
| Provider-backed coordinated freeze/snapshot | None of the retrieved documentation establishes this primitive across the required stores/effects | Conditional candidate, currently blocked. Require explicit scope, start/end identity, behavior of running writes/background work and captured operation frontier. Do not invent an API or infer availability (B1/B2). |

## Bootstrap around already-running legacy work

A future journal can be introduced only through an approved bootstrap with one
of two evidence paths. Both are presently blocked.

1. **Authoritative old-world cutoff.** Establish a supported admission cutoff for
   every A row, preserve queue/input evidence before expiry/cleanup, then obtain
   complete terminal accounting for every pre-cutoff execution and its children.
   Capture S1–S16 under a supported coordinated freeze, or after proved terminal
   writes plus authoritative per-store capture. Include admitted-but-not-started
   work and unsent/ambiguous effects. Repair partial operations only under an
   explicit reconciled disposition. A missing execution census or KV capture
   guarantee stops this path before any production change.
2. **Lossless bridge across overlapping versions.** Before relying on any overlap,
   establish an independently complete retained baseline and mutation/input/effect
   journal covering every old writer, including work admitted before bridge
   deployment. Seal a provider-backed frontier; partition each accepted operation
   into captured-complete, durably pending, reconciled effect, or explicit unknown.
   New admissions then receive durable journal IDs before acknowledgement.
   Reconcile old work into the candidate generation with deterministic identity
   mapping. Existing legacy code has no universal journal or retained old values,
   so application instrumentation alone cannot supply the initial frontier.

Isolating the old world and allowing it to finish is safe for the destination
only after capability denial is established. It does not tell us when the old
world has finished or whether its email/LLM/shell calls succeeded. Owner review
can decide a specific unknown outcome; it cannot certify missing bytes exist
or convert a lossy reset into a lossless migration. If no supported bootstrap
can be demonstrated, keep this migration blocked and leave production unchanged.

## Retention and capacity gates

The capture must preserve original bytes and unresolved evidence until forward
recovery and owner acceptance finish; no source deletion, job purge or blob GC
is authorized here. Exact live quantities, oldest input age, queue retention,
DLQ retention, lifecycle rules, KV expiry, provider idempotency windows and
available storage/memory are **unknown**.

- Queues document at-least-once delivery, possible duplicates and no ordering
  guarantee. The limits page specifies plan-dependent retention (paid configurable up to fourteen days; free twenty-four hours). These are
  documented bounds, not this account's settings. Record each queue/DLQ's
  actual retention and oldest message before selecting a window; pause does not
  reset age. [Delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
  [ordering](https://developers.cloudflare.com/queues/reference/how-queues-works/),
  [limits](https://developers.cloudflare.com/queues/platform/limits/).
- `portable-archive.ts:32` caps payload at 10,000 files / 500 MiB and materializes
  object buffers plus ZIP output. `backups.ts:71` caps 10,000 files / 2 GiB and
  32 MiB per file, and manifests can declare truncation. These are application
  limits, not proof the Worker has sufficient memory or that the dataset fits.
- `ingest-jobs.ts:16` and `extract-jobs.ts:67` have seven-day terminal-job GC;
  extract claims use ten-minute expiry (`extract-jobs.ts:64`). Staging can be
  deleted by task completion/error paths. Expired claims are not terminal-work
  evidence. Capture and preserve input/status before any such cleanup can run.
- Budget must include old and new data, retained input/output versions, manifests,
  receipts/outbox, retries, duplicate projections, backup histories and upload
  orphans. Use a bounded streaming copy with restart checkpoints; preserve every
  enumerated version. Measure sizes, throughput and recovery time on approved
  synthetic/representative nonproduction data before real capture.
- If the conservative completion-and-recovery window exceeds remaining retention,
  block before maintenance. A supported durable preservation mechanism must be
  demonstrated and approved first; silently extending a wait or pulling/ACKing
  messages without durable verified input custody is not a remedy.

## Blocking evidence register and unsent questions

These questions are prepared only; no provider/operator message was sent.

| Gate | Exact evidence needed / question for later authorized investigation | Owner of resolution |
| --- | --- | --- |
| B1 Consistent complete source | Does the provider offer a supported common snapshot/freeze frontier for R2 objects/metadata, canonical KV values/expiry and pending queue inputs? If not, what authoritative per-store capture plus complete change history can establish one boundary? Supply exact scope and consistency guarantees; inventory every S row and unknown key. | Provider guarantee plus operator capture plan |
| B2 Legacy admission and terminal coverage | How can every old-version HTTP, service-binding, queue, scheduled/email execution, background task and child effect be enumerated and proven terminal across alternate routes? How does a cutoff cover work already past a flag/auth check and direct storage credentials? No sampled logs or duration inference. | Provider/runtime evidence and operator process census |
| B3 Lossless queue preservation | What are actual retention/age/retry/DLQ and delayed/in-flight inventories? Can pause/restore and durable preservation finish without expiry or retry burn? How are response-lost batch sends reconciled per input? | Operator plus documented queue capabilities |
| B4 Inputs and external outcomes | Are exact accepted request/attachment/provider-input bytes available for every outstanding operation? Which remote destinations enforce idempotency, for how long, and expose durable queryable results? Resolve email, webhook, LLM/research/extract/sandbox/shell uncertainty individually. | Input custodian and each provider/destination |
| B5 Capability isolation | Enumerate old/new resource IDs, service bindings, routes, credentials and privileges. Can any delayed legacy actor overwrite/delete destination data, mutate its jobs/projections or send new authorized effects? Demonstrate denial for old bindings as well as tokens; prefix differences alone fail. | Operator/security architecture |
| B6 Capacity and recovery | Measure capture counts/bytes, sensitive-data handling, retention headroom and restart/recovery capacity; rehearse failure before/after activation and reconciliation after first new write. | Operator and implementation owner |
| B7 Architecture and release | Explicitly approve proposed AD-2 metadata authority and AD-11 storage-location reconciliation; preserve AD-3/7/9/13 and every AD-15 release gate. Full source/caller coverage and exact-artifact nonproduction evidence precede activation. | Architecture/release owner |

All B gates remain open. A later feasibility decision must attach authoritative
artifacts and revalidate current official guarantees and source/config identities;
checking a document box cannot itself close any gate.

## Acceptance counterexamples

| Failure injected / observed risk | Required safe result in the proposed protocol |
| --- | --- |
| Legacy request pauses after config/auth/read, then resumes after activation | Keep its old admission identity; deny destination capabilities and publication; reconcile any old-store changes and provider effects. Without complete frontier evidence activation was blocked. Never attach a new generation to old computed output. |
| Queue expires during maintenance | Before starting, prove durable verified custody of every accepted input beyond retention or block. If unexpected expiry occurs, retain evidence and recover only from verified journal inputs; missing input blocks completion, not an automatic success/ACK. |
| First batch sends; second batch response is lost | Preserve confirmed first batch, ambiguous second batch and proven unattempted tail separately. Reconcile remote acceptance or redeliver only through receipt-deduplicated, side-effect-safe admission; never resubmit the entire legacy workload blindly. |
| Canonical commit succeeds; HTTP/proxy response is lost | Look up the durable receipt by operation ID and request digest; return historical result without another revision or another provider spend. A timeout is not proof the commit failed. |
| Webhook/email/provider accepts; sender dies before receipt | Mark outcome unknown. Query durable provider outcome or use proven idempotency semantics for that exact request within its window. Otherwise quarantine and obtain an explicit outcome decision; do not claim exactly-once delivery. |
| Same email Message-ID, different body/attachment | Compare verified canonical input digest; conflict/quarantine rather than reusing legacy job existence as evidence that both payloads were accepted and preserved. |
| Primary page lands; crossrefs/log/index/job completion do not | Preserve all raw observations and repair under one reconciled operation. A matching page checksum does not close the missing effects or prove the original computation's read set. |
| New owner edit lands, then migration needs recovery | Fence new admission, retain destination receipts/inputs and recover forward from destination revision. Routing to the old snapshot would lose an accepted edit and is forbidden without explicit complete reconciliation. |

Verification for this packet is source/doc inspection and these walkthroughs.
No fresh runtime test, live drain, source capture or production readiness is claimed.
