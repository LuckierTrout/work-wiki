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

## Retrieval and chat

- [x] Correct vector-search readiness. Resolve the current Vectorize index and
  embedding dimension mismatch, align provider/model detection, rebuild the
  embeddings, and verify hybrid search against known documents.
- [ ] Add a multi-turn, citation-first chat agent over the user's wiki. Include
  durable conversations, follow-up questions, retrieval scope controls,
  per-answer source citations, context/token limits, and an option to save a
  useful answer back to the wiki.

## Personal agents and actions

- [ ] Add a private **Action Extractor** that runs after new material is
  ingested and proposes to-do items with task, owner, due date, priority,
  source, supporting excerpt, and confidence.
- [ ] Add an owner-only task inbox with `inbox`, `accepted`, `dismissed`, and
  `done` states, duplicate detection, source links, and human approval before a
  proposed task becomes an active to-do.
- [ ] Add configurable specialized agents with reusable instructions, manual or
  scheduled triggers, restricted tools, per-agent provider/model selection,
  scoped knowledge access, and an auditable activity history.

## Imports and document handling

- [x] Add secure single-file DOCX, PPTX, XLSX, and CSV upload plus inbound-email
  attachment extraction through R2 staging and the asynchronous ingest queue.
- [x] Add single-file and bulk import with destination selection, progress,
  retry, errors, duplicate detection, and source provenance. Deployed and
  owner-session verified on 2026-08-02 with a completed production CSV ingest.
- [ ] Support Markdown, TXT, HTML, PDF, DOCX, PPTX, CSV, ZIP archives, and an
  Obsidian-vault/folder import. Preserve titles, dates, hierarchy, and links
  where the source format allows it. Evaluate Notion and other export adapters
  after the core import flow works.
- [ ] Design the document extraction/conversion pipeline for DOCX and PPTX,
  including slide order, headings, tables, images, speaker notes, and storage
  of the original file in R2.
- [ ] Extend inbound email ingestion to process supported attachments, route
  them to the correct owner/vault/agent, and send clear success or failure
  receipts after the conversion pipeline is settled.

## Definition of done for backlog features

Each feature needs owner-level privacy controls, visible runtime verification,
useful failure states, and deployment documentation before it is considered
complete.
