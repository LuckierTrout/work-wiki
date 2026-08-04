# Production owner-session acceptance: 2026-08-03

## Verdict

The trusted-memory release is deployed and most owner workflows passed,
including the owner-confirmed rollback and repeatable Structured Knowledge
extraction. The release is **not fully accepted** only because production still
uses Clerk development keys.

Acceptance was run against:

- Git commit: `ae2ab6ae5a335e67d9a93132c2b143572babb230`
- Main Worker version: `5f82c8d8-61e3-4ea6-932f-59ca59eb0ad8`
- Task consumer version: `215edeab-31ec-41a5-b8dd-75b286cdc757`
- Production origins: `https://workwiki.app` and `https://www.workwiki.app`

The verified commit was deployed without pushing, opening a pull request, or
merging the feature branch.

## Passed

### Authentication and owner boundaries

- The signed-in browser resolved Christian Lee as the owner on private routes.
- Signed-out GET requests returned `401` for Knowledge, System Health, Backups,
  Integrations, and owner-scoped agent listing.
- Signed-out POST requests returned `401` for Knowledge extraction, Backup
  creation, Integration settings, and agent creation.
- Both production domains returned `200` over HTTPS.

### Review Desk, evidence, and monitoring

- A source monitor established a baseline, detected a meaningful source change,
  and created a medium-risk review proposal with the exact source excerpt.
- A JSON endpoint produced the expected useful failure state for unsupported
  `application/json` content.
- Pause and resume both worked.
- A proposal did not alter the live page before review.
- Owner editing, review notes, rejection, acceptance, revision attribution, and
  the revision-history controls all worked.
- The owner-confirmed rollback restored revision `1785785059024`
  (`2026-08-03T19:24:19.024Z`, 4,471 bytes) on `live-verification`. The restored
  page rendered its original sections and source figure, and History recorded
  the displaced 1,530-byte temporary content at
  `2026-08-03T19:59:36.325Z`, attributed to `@christianlee`.
- The operation ledger recorded monitor and review receipts.

### Hermes chat

- The Chat workspace reported `Hermes connected`.
- A My Pages query returned the correct next step for Email attachments and
  cited `yopedia-project-tracking`.
- The conversation persisted in the thread list.

### Structured Knowledge

- The primary app route remained Ollama Cloud `gpt-oss:120b`, while Knowledge
  extraction used its owner-configured OpenAI `gpt-4o` feature route.
- Extracting `yopedia-project-tracking` produced six source-linked records and
  four relationships in the Knowledge Atlas.
- Every displayed record linked back to the source page and carried exactly one
  citation after extraction.
- A second extraction changed some model wording and relationship labels but
  remained at six records, four relationships, and one citation per record.
  Re-extraction now replaces the page's prior derived contribution instead of
  accumulating model variants.

### Agent Studio and task safety

- Created the useful owner agent `Action Extractor` rather than a disposable
  test agent.
- Configured owner-only knowledge scope, OpenAI, an after-ingest trigger, search
  plus task-proposal grants, and review-required writes.
- Enabled automatic after-ingest runs with bounded instructions that forbid
  inferred commitments and duplicate tasks.
- A manual dry run completed in 8.4 seconds after retrieving five pages.
- The run receipt recorded 5,835 total tokens and no task or memory proposals.
- The task inbox remained empty, confirming that dry-run mode produced no
  writes.

### Integrations and operational resilience

- The owner-only Integrations workspace loaded with zero failed or in-flight
  deliveries.
- Webhook delivery remained disabled and correctly reported that messages are
  unsigned until `YOPEDIA_WEBHOOK_SIGNING_SECRET` is configured.
- Two queued backups completed and passed isolated restore verification. The
  latest verified 40 files and 107.4 KB without overwriting live data.
- The Cloudflare Queue consumer recorded successful delivery.
- Added one durable golden question for the Email attachments next step.
- The retrieval suite passed source recall, citation precision, privacy, and
  groundedness at 100% for the one-case baseline.

## Blocking findings

1. **Clerk is using development keys in production.** The browser repeatedly
   reported the Clerk development-instance warning. Move `workwiki.app` to a
   Clerk production instance and production publishable/secret keys before
   treating identity as production-ready.

## Non-blocking operational findings

- Image requests log `env.IMAGES binding is not defined`; the image route still
  returned `200`, but the missing optional binding should be either configured
  or intentionally suppressed.
- Acceptance left two manual-cadence monitors, two verified backup manifests,
  one golden evaluation case, one Hermes conversation, and the useful enabled
  `Action Extractor`. The monitors are inert unless manually run, but removing
  them is an owner-confirmed destructive action.
- Webhook end-to-end delivery is intentionally untested because no approved
  external endpoint or signing secret is configured.
- After-ingest automatic Agent Studio execution is configured but has not yet
  been triggered by a fresh production ingest.

## Closure order

1. Migrate Clerk to production keys and repeat signed-in and signed-out gates.
2. Trigger one controlled ingest to verify the Action Extractor after-ingest
   path while ensuring every task remains proposed.
3. Clean up the two acceptance monitors after explicit owner confirmation.
