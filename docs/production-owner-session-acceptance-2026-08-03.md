# Production owner-session acceptance: 2026-08-03

## Verdict

The trusted-memory release is deployed and most owner workflows passed, but the
release is **not fully accepted**. Structured-knowledge extraction fails with
the current Ollama Cloud default, and the temporary accepted revision on
`live-verification` still needs its prepared owner confirmation to restore the
previous revision. Production also still uses Clerk development keys.

Acceptance was run against:

- Git commit: `8f6661b097666b1998f016c80edc5cf60841682e`
- Main Worker version: `a37d7c32-9e8c-4185-92a1-8bb5003b05c2`
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
- The operation ledger recorded monitor and review receipts.

### Hermes chat

- The Chat workspace reported `Hermes connected`.
- A My Pages query returned the correct next step for Email attachments and
  cited `yopedia-project-tracking`.
- The conversation persisted in the thread list.

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

1. **Structured Knowledge does not pass production extraction.** Extracting
   `yopedia-project-tracking` while Ollama Cloud `gpt-oss:120b` is the app
   default ended with `No object generated: could not parse the response.` No
   records were written. The extraction path needs a provider override, a more
   reliable structured-output strategy, or a deliberate production-default
   provider change before Phase C can be accepted.
2. **The temporary accepted page revision is still live.** The correct prior
   revision is `1785785059024` (`2026-08-03T19:24:19.024Z`, 4,471 bytes). The
   History panel is open in the handed-off Chrome tab at the exact first
   `Revert` control. The owner must confirm this public content edit before the
   rollback can complete.
3. **Clerk is using development keys in production.** The browser repeatedly
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

1. Confirm the prepared `live-verification` rollback and verify the restored
   page plus its new revision receipt.
2. Correct Structured Knowledge model selection or structured-output handling,
   redeploy, and rerun extraction against `yopedia-project-tracking`.
3. Migrate Clerk to production keys and repeat signed-in and signed-out gates.
4. Trigger one controlled ingest to verify the Action Extractor after-ingest
   path while ensuring every task remains proposed.
5. Clean up the two acceptance monitors after explicit owner confirmation.

