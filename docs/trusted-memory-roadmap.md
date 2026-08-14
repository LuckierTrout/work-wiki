# Trusted memory roadmap

This roadmap covers the seven product additions selected for Christian's
Yopedia deployment: reviewable memory updates, claim-level evidence,
continuous source monitoring, structured knowledge objects, a safe Agent
Studio, owner-approved integrations, and operational resilience.

The implementation order is deliberate. Evidence and proposals form a shared
trust layer. Monitoring, agents, and integrations must produce proposals or
outbox records through that layer rather than writing or transmitting directly.

## Product principles

- The wiki page and its revision history remain the durable source of truth.
- Vector embeddings and derived indexes are rebuildable, never authoritative.
- Every consequential automated change is attributable, reviewable, and
  reversible.
- Exact evidence locations are preferable to page-level confidence scores.
- Private pages stay owner-scoped throughout storage, retrieval, review, and
  automation.
- External actions require explicit owner approval unless the owner has created
  a narrowly scoped standing rule.
- Provider credentials remain server-side secrets.

## UX direction

The selected additions should feel like a research desk, not a generic admin
dashboard.

- **Evidence marginalia:** claims and their supporting source passages sit side
  by side. Selecting a claim highlights its source passage, slide, sheet, email
  section, or document location.
- **Review desk:** proposed changes show the current page, proposed page, exact
  evidence, and a plain-language change summary. Actions are **Accept changes**,
  **Edit proposal**, **Reject**, and **Split into a new page**.
- Use the existing folio tokens and typography. Reserve accent color for
  evidence state: supported, conflicting, incomplete, or stale.
- Empty and failure states always identify the next useful action.

## Phase A: Trust fabric (reviewable updates + claim-level evidence)

### Data contracts

- `EvidenceAnchor` identifies an immutable source excerpt and an optional exact
  location: text range, PDF page, slide, spreadsheet range, email section, URL
  fragment, or document section.
- `ClaimEvidence` links a page claim to one or more evidence anchors and records
  whether the evidence supports, contradicts, or only contextualizes it.
- `PageEvidenceBundle` binds the claims to the exact page content hash from
  which they were derived.
- `MemoryChangeProposal` stores the current page hash, proposed content, reason,
  evidence references, risk, actor, and review state.

### Acceptance

- Creating a proposal never changes the live page.
- Proposals and evidence are owner-scoped and inaccessible across tenants.
- Accepting against a changed base revision fails closed as stale.
- Acceptance uses the normal page lifecycle so revisions, embeddings, indexes,
  backlinks, attribution, and activity stay consistent.
- A rejected proposal remains auditable but cannot later be applied.
- Citations can open the exact stored excerpt even when the external source is
  no longer reachable.

## Phase B: Continuous source monitoring

- Store owner-scoped subscriptions with cadence, source identity, last content
  hash, ETag/Last-Modified metadata, next check, and failure state.
- Scheduled checks use conditional requests where possible and semantic diffs
  where byte-level changes are noisy.
- A meaningful change creates a review proposal; it never silently overwrites a
  page.
- Digests group changes, failures, and sources requiring attention. Frequency
  and delivery are owner-controlled.

## Phase C: Structured knowledge

- Extract people, organizations, projects, decisions, commitments, risks,
  events, and dates from accepted page revisions.
- Keep structured objects as derived, source-linked records. They do not replace
  the human-readable page.
- Relationships carry temporal validity and supporting evidence.
- Initial views: Decisions, Projects, People, and Timeline.

## Phase D: Safe Agent Studio

- Each agent has explicit read scopes, write scopes, permitted operations,
  provider/model selection, run budget, timeout, and approval policy.
- Dry runs return an execution plan and expected changes without writing.
- Agent writes create review proposals unless a narrowly scoped rule permits an
  automatic low-risk operation.
- Every run records inputs, retrieved pages, proposed changes, costs, outcome,
  and rollback references.
- Hermes remains an optional orchestrator; Yopedia owns authorization,
  retrieval, approvals, durable state, and audit history.

## Phase E: Owner-approved integrations

- An integration outbox receives accepted action items and approved agent
  actions with deterministic idempotency keys.
- Delivery adapters are isolated from the core memory model and return durable
  receipts.
- Initial provider-neutral targets are webhook and iCalendar export. A specific
  task/calendar provider is added only after the owner chooses it.
- Retries never create duplicate external actions.

## Phase F: Operational resilience

- A canonical operation ledger spans ingest, review, monitoring, agents, and
  integrations.
- Failed queue items and outbox deliveries are inspectable, retryable, and
  dismissible from an owner-only system-health surface.
- Automated backups include pages, raw sources, revisions, evidence, proposals,
  indexes needed for recovery, and a manifest with checksums.
- Restore is tested into an isolated prefix before production recovery.
- A retrieval evaluation set measures recall, citation coverage, citation
  correctness, contradiction handling, privacy boundaries, and answer
  groundedness.
- Usage records expose provider, model, tokens, estimated cost, latency, and
  operation without exposing credentials or private prompts.

## Delivery gates

Each phase must pass unit tests, lint, TypeScript, Cloudflare build, Wrangler
dry-run, and owner-session browser acceptance. Deployment does not imply merge.
Production rollout requires an explicit deployment gate, and merging requires
separate owner approval.

## Local implementation status

The feature branch now contains the trust fabric, Review Desk with owner edits,
private claim-evidence marginalia, source monitoring, Knowledge Atlas and
relationship ledger, hardened Agent Studio, an idempotent webhook/iCalendar
outbox, and the System operator workspace. Automated changes remain proposals.
Accepted page updates flow through the existing revision lifecycle and can be
reverted from page history.

The local verification gate includes focused unit coverage, the complete test
suite, lint, TypeScript, a production Next build, the OpenNext Cloudflare build,
and a Wrangler dry-run. Owner-session browser acceptance and production rollout
are deliberately separate gates. Source-monitor digest delivery is implemented
locally with owner-private history, cadence controls, manual generation, and
optional queued email; production destination verification and acceptance remain.
Any named task/calendar SaaS adapter remains a follow-up choice rather than
implicit scope.
The first backup implementation is an isolated, checksummed snapshot in the
configured storage account; off-account disaster-recovery replication remains a
separate hardening step.

## Production acceptance status

The production owner-session run on 2026-08-03 is documented in
[`production-owner-session-acceptance-2026-08-03.md`](production-owner-session-acceptance-2026-08-03.md).
Review, monitoring, Hermes chat, Agent Studio dry-run safety, owner access
boundaries, queued backups, isolated restore verification, and the first
golden-question retrieval evaluation passed. The owner-confirmed rollback of
the temporary accepted test revision also passed, including verification of the
restored page and its new owner-attributed history receipt. Structured Knowledge
also passed through an owner-configured OpenAI `gpt-4o` feature route while the
primary route remained Ollama Cloud. Consecutive extraction runs stayed stable
at six records, four relationships, and one citation per record. Production
Clerk keys must replace the development instance before the identity boundary is
considered production-ready.
