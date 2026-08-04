# Christian's Yopedia Deployment Backlog

This file tracks deployment-specific work for Christian's Yopedia instance. It
does not replace the upstream project's issue tracker.

## Current work

- [x] Make the provider selected in Settings authoritative so Anthropic,
  OpenAI, Google, and Ollama Cloud credentials can coexist without Anthropic
  automatically becoming primary.
- [x] Securely install the Ollama Cloud, OpenAI, Anthropic, and Google API keys
  as Cloudflare Worker secrets. Never store keys in this repository or chat.
- [x] Select each provider in Settings and pass **Test Connection** with the
  other provider keys also present. Confirm the selected model, useful error
  messages, and persistence after reload.

The items below begin after the API-key checks pass.

## Production acceptance blockers

The 2026-08-03 owner-session run is recorded in
[`docs/production-owner-session-acceptance-2026-08-03.md`](docs/production-owner-session-acceptance-2026-08-03.md).

- [x] Confirm the prepared rollback of the temporary accepted
  `live-verification` revision, then verify the restored page and revision
  receipt. Owner-confirmed production verification passed on 2026-08-03; the
  restored 4,471-byte revision and the new `@christianlee` history receipt were
  both verified.
- [x] Fix Structured Knowledge extraction with a reliable feature-level
  provider override. Production acceptance passed on 2026-08-03 using OpenAI
  `gpt-4o` while the primary route remained Ollama Cloud. Two consecutive
  extractions remained stable at six records, four relationships, and one
  citation per record.
- [ ] Move `workwiki.app` from Clerk development keys to a Clerk production
  instance and repeat the owner and signed-out access gates.

## Retrieval and chat

- [x] Correct vector-search readiness. Resolve the current Vectorize index and
  embedding dimension mismatch, align provider/model detection, rebuild the
  embeddings, and verify hybrid search against known documents.
- [ ] Add a multi-turn, citation-first chat agent over the user's wiki. Include
  durable conversations, follow-up questions, retrieval scope controls,
  per-answer source citations, context/token limits, and an option to save a
  useful answer back to the wiki. **Deployed 2026-08-03:** the native chat path
  and an optional, safety-gated Hermes API backend are live. Hermes 0.19.1 now
  runs in an isolated, zero-tool profile on the Abacus.ai host behind the
  `hermes.workwiki.app` Cloudflare Tunnel; its bearer credential is installed
  only as a Worker secret. **Production owner-session verification passed for
  a persisted My Pages conversation with a grounded answer and page citation
  on 2026-08-03.** A multi-turn follow-up and Save to wiki remain before full
  closure.

## Personal agents and actions

- [ ] Add a private **Action Extractor** that runs after new material is
  ingested and proposes to-do items with task, owner, due date, priority,
  source, supporting excerpt, and confidence. **Deployed 2026-08-03;** live
  owner-session ingest-to-proposal acceptance remains.
- [ ] Add an owner-only task inbox with `inbox`, `accepted`, `dismissed`, and
  `done` states, duplicate detection, source links, and human approval before a
  proposed task becomes an active to-do. **Deployed 2026-08-03;** the private
  route and sign-in gate are live, with owner-session workflow acceptance
  remaining.
- [ ] Add configurable specialized agents with reusable instructions, manual or
  scheduled triggers, restricted tools, per-agent provider/model selection,
  scoped knowledge access, and an auditable activity history. **Deployed
  2026-08-03;** owner-session manual and scheduled-run acceptance remains.

## Imports and document handling

- [x] Add secure single-file DOCX, PPTX, XLSX, and CSV upload plus inbound-email
  attachment extraction through R2 staging and the asynchronous ingest queue.
- [x] Add single-file and bulk import with destination selection, progress,
  retry, errors, duplicate detection, and source provenance. Deployed and
  owner-session verified on 2026-08-02 with a completed production CSV ingest.
- [ ] Support Markdown, TXT, HTML, PDF, DOCX, PPTX, CSV, ZIP archives, and an
  Obsidian-vault/folder import. Preserve titles, dates, hierarchy, and links
  where the source format allows it. Evaluate Notion and other export adapters
  after the core import flow works. **Deployed 2026-08-03:** the live ingest UI
  exposes drag/drop and folder selection for up to 200 files, with bounded ZIP
  expansion and preserved folder paths/Markdown links. A signed-in production
  folder ingest remains before closure.
- [x] Design the document extraction/conversion pipeline for DOCX and PPTX,
  including slide order, headings, tables, images, speaker notes, and storage
  of the original file in R2. Deployed and owner-session verified on 2026-08-02
  with a live DOCX, rendered embedded figure, and byte-for-byte R2 source check.
- [ ] Extend inbound email ingestion to process supported attachments, route
  them to the correct owner/vault/agent, and send clear success or failure
  receipts after the conversion pipeline is settled. The implementation,
  settings UI, routing, Cloudflare send binding, and expanded attachment formats
  are deployed. Production receipt sending passed for one verified destination.
  Two remaining approved senders need their one-time Cloudflare
  destination-verification links opened.

## Trusted memory roadmap

Architecture and acceptance criteria are recorded in
[`docs/trusted-memory-roadmap.md`](docs/trusted-memory-roadmap.md).

- [ ] Add reviewable memory updates with owner-scoped proposals, semantic diffs,
  evidence, stale-base protection, approval, rejection, revision history, and
  rollback. **Deployed and production owner-session verified on 2026-08-03 for
  proposal isolation, owner editing, rejection, acceptance, and revision
  history. Owner-confirmed rollback also passed and produced an attributed
  revision receipt.**
- [ ] Add claim-level evidence anchored to exact source excerpts, document
  sections, PDF pages, slides, spreadsheet ranges, email sections, and URL
  fragments where the source format provides them. **Implemented locally;** the
  private page marginalia marks evidence stale when it belongs to an older page
  revision.
- [ ] Add continuous source monitoring with conditional fetches, meaningful
  change detection, review proposals, failure handling, and owner-controlled
  digests. **Production owner-session verification passed on 2026-08-03 for
  baseline creation, meaningful-change proposals, unsupported-content failure,
  pause, and resume.** Digest delivery remains a follow-up.
- [x] Add source-linked structured records for people, organizations, projects,
  decisions, commitments, risks, events, and temporal relationships.
  **Deployed** with Atlas, filtered views, timeline, and relationship ledger.
  **Production extraction passed on 2026-08-03** through the owner-configured
  OpenAI `gpt-4o` feature route. Repeat extraction replaces the source page's
  prior derived contribution and remained stable at six records, four
  relationships, and one citation per record.
- [ ] Harden Agent Studio with scoped permissions, budgets, dry runs, approval
  policies, auditable activity, and rollback. Hermes remains optional
  orchestration, not the authorization or storage boundary. **Implemented
  and deployed** with explicit grants, proposal-only writes, budgets, timeouts,
  dry runs, and richer receipts. **A production Action Extractor dry run passed
  on 2026-08-03 with five pages retrieved, 5,835 tokens recorded, and zero
  writes.** A fresh-ingest automatic-trigger run remains.
- [ ] Add an idempotent integration outbox and owner-approved delivery adapters.
  Begin with provider-neutral webhook and iCalendar output; select any task or
  calendar SaaS adapter separately. **Webhook, HMAC signing, iCalendar, retries,
  and idempotency are deployed;** the owner workspace and disabled safe state
  passed production verification on 2026-08-03. Signed external delivery awaits
  an approved endpoint and secret, and selecting a SaaS-specific adapter remains
  a separate product choice.
- [ ] Add owner-only operational health for queue failures, retries, backups,
  restore verification, retrieval quality, provider usage, cost, and privacy
  boundary checks. **Deployed** with a System workspace, operation
  ledger, queued checksummed backups, isolated restore verification, and a
  golden-question evaluation suite. **Two production backups passed isolated
  restore verification, and the initial retrieval case passed all four quality
  measures at 100% on 2026-08-03.** Cloudflare queue depth and DLQ inspection
  remain in provider telemetry. Off-account backup replication remains a future
  disaster-recovery hardening step.

## Definition of done for backlog features

Each feature needs owner-level privacy controls, visible runtime verification,
useful failure states, and deployment documentation before it is considered
complete.
