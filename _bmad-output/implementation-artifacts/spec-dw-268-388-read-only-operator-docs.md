---
title: 'Document the YOPEDIA_READONLY boundary for operators in DEPLOY.md'
type: 'chore'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 2
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Three in-repo sites assert the wrong queue semantics for a read-only 403 —
      the code is right and the comments are wrong, and DEPLOY.md now
      contradicts them.
    evidence: |-
      `src/app/api/tasks/run/route.ts:166-173` states "4xx means the consumer
      ACKS AND DROPS the message ... work queued against a read-only deployment
      is discarded rather than replayable"; `src/app/api/tasks/scan/route.ts:73-77`
      repeats "the consumer treats a 4xx as terminal"; and
      `src/lib/__tests__/scan-route.test.ts:409-414` restates it inside a passing
      test's rationale. `workers/task-consumer/index.ts:114` acks and drops on
      `400 || 404 || 422` only; a 403 falls to the transient branch at `:126-139`
      and is retried to `MAX_DELIVERY_ATTEMPTS = 4`, then parked in the DLQ. The
      first draft of this doc inherited the falsehood from the route comment,
      which is how it was found. Whoever edits the consumer next reads these
      comments, not DEPLOY.md.
    location: >-
      src/app/api/tasks/run/route.ts:166
    severity: medium
  - summary: >-
      `POST /api/tasks/run`'s read-only 403 is pinned by no test, and the one
      check that touches it passes even if the gate is deleted.
    evidence: |-
      `READ_ONLY_REFUSAL.queuedWork` has exactly two references repo-wide — its
      definition at `src/lib/read-only.ts:255` and the route at
      `src/app/api/tasks/run/route.ts:176` — and no test reference.
      `src/lib/__tests__/tasks-route.test.ts` never sets `YOPEDIA_READONLY`.
      `read-only-copy-parity.test.ts:376-397` lists `tasks/scan` but not
      `tasks/run`. `read-only-door-coverage.test.ts:225-249` is a source regex
      matching `isReadOnly()` OR `isReadOnlyError(`, and the route's catch
      already uses the latter, so removing the early gate keeps it green. The
      scan's identical claims are pinned twice; this door's are pinned zero
      times, and DEPLOY.md now publishes both its status and its sentence as an
      operator alerting contract.
    location: >-
      src/lib/__tests__/tasks-route.test.ts
    severity: low
  - summary: >-
      `task-consumer.test.ts` never drives a 403, leaving the poison-set boundary
      that DEPLOY.md's "replayable, not lost" rests on unpinned.
    evidence: |-
      The suite asserts only 200, 422 -> ack and 503 -> retry. Both are satisfied
      by many poison sets, including one containing 403. Appending
      `|| res.status === 403` to `workers/task-consumer/index.ts:114` keeps every
      case green and silently inverts the documented outcome to the one that
      discards queued ingests.
    location: >-
      src/lib/__tests__/task-consumer.test.ts
    severity: low
  - summary: >-
      DEPLOY.md quotes two `READ_ONLY_REFUSAL` sentences verbatim with no parity
      pin, though the repo established that idiom twice for this same file.
    evidence: |-
      `src/lib/__tests__/workbench-settings.test.ts:5599` ("keeps DEPLOY.md's
      quoted refusal identical to the constant it quotes (DW-222)") and
      `src/components/__tests__/embedding-substitution-copy-parity.test.tsx:191`
      both read DEPLOY.md off disk and compare against the shipped copy. Neither
      can reach the new section: both harvest only lines beginning with `>`, and
      the new quotes are inline JSON in prose. Rewording either constant leaves
      every suite green and DEPLOY.md quoting a body no deployment returns —
      exactly the drift those two pins exist to stop, and the section's alerting
      advice depends on the bodies being exact.
    location: >-
      src/lib/__tests__/read-only-copy-parity.test.ts
    severity: low
  - summary: >-
      `agents/[id]/route.ts`'s comment states unconditionally that `updateAgent`
      writes through the kernel before persisting, which is true only when the
      request adds pages.
    evidence: |-
      `src/app/api/agents/[id]/route.ts:268-272` says `updateAgent` "writes the
      agent's identity PAGE through the kernel before it persists the profile
      with `registerAgent`". In `src/lib/agents.ts:772-846` that
      `writeWikiPageWithSideEffects` call sits inside
      `if (options.addPages && options.addPages.length > 0)`; a name, description,
      trigger, instructions, `defaultVault` or `removePages` edit reaches only
      `registerAgent`, a bare `storage.writeFile`, and returns 200 on a read-only
      deployment. DEPLOY.md now documents the split correctly, so the comment is
      the remaining wrong statement.
    location: >-
      src/app/api/agents/[id]/route.ts:268
    severity: low
baseline_revision: 'ee3a8a10dc511a48b03c9d0c478973668746c2e0'
---

<intent-contract>

## Intent

**Problem:** `YOPEDIA_READONLY` is described only in code docstrings (`src/lib/config.ts` `isReadOnly()`) and spec artifacts. An operator who sets the flag has nowhere to read what it actually refuses versus what still mutates (DW-268), and nothing outside code comments records that `POST /api/tasks/scan` now answers 403 on every cron pass under the flag — so a monitor treating non-2xx as failure alerts once per tick, and the DW-137 workspace-profile backfill and the orphan-directory sweep silently never run (DW-388).

**Approach:** Add a `YOPEDIA_READONLY` row to DEPLOY.md's **Additional Settings** table and a `### Read-only deployments` subsection at the end of the Environment Variables section that states the boundary the code enforces today — what refuses through every caller, what still mutates, and the scan's per-tick 403 with its two consequences.

## Boundaries & Constraints

**Always:**
- Documentation only. No source, test, or config file changes.
- Every claim must match the code as it stands today, verified against `src/lib/config.ts`, `src/lib/read-only.ts`, and the gated routes — not against the (partly stale) DW-268 ledger prose, which predates the settings and wiki-lifecycle route gates.
- Match DEPLOY.md's existing voice: prose paragraphs under a `###` heading, bold lead-ins, backticked identifiers, ~78-column wrapping.
- The table row must point the reader at the subsection rather than trying to compress the boundary into a cell.

**Block If:** A claim required by the intent cannot be confirmed in the code (do not soften it into a hedge and continue — halt and say which claim).

**Never:**
- Do not edit README.md. DW-268 names README's silence as evidence; the intent scopes the fix to DEPLOY.md.
- Do not restate the boundary inside the existing embeddings/vector-search prose, and do not touch the read-only sentences already at DEPLOY.md:253-276 — those are about Workbench Settings affordances and stay as they are.
- Do not change `src/lib/config.ts`'s docstring, add tests, or edit the deferred-work ledger.
- Do not document `AUTONOMOUS_MAINTENANCE` semantics beyond the one clause needed to explain what the scan stops doing.

</intent-contract>

## Code Map

- `DEPLOY.md:49-61` -- the **Additional Settings** table (`LLM_WIKI_PROVIDER` … `PORT`). The `YOPEDIA_READONLY` row goes here, last.
- `DEPLOY.md:62-428` -- embeddings/vector prose that follows the table; the workers-ai block at :63 is what the table's "see below" points at, so nothing may be inserted between the table and it.
- `DEPLOY.md:429` -- `## Volume Mounts`. The new `### Read-only deployments` subsection goes immediately before this line, ending the Environment Variables section.
- `DEPLOY.md:253-276` -- existing read-only prose, scoped to Workbench Settings affordances (fields described not marked, Remove button gone). Evidence for DW-388's "says nothing about the scan". Read-only; do not edit.
- `src/lib/config.ts:252-307` -- `isReadOnly()` and its docstring: the authoritative two lists. Refuses via four kernel writers (`writeWikiPageWithSideEffects`, `deleteWikiPage`, `patchMetadata`, `writeWikiArtifact`) through every caller — REST, the stdio MCP server, the CLI, agents, ingest, lint-fix, merge, `deleteTenant`. Notes that the settings store, the wiki registry and workspace profile are gated *at their routes*, not by the kernel.
- `src/lib/read-only.ts:160-320` -- `READ_ONLY_REFUSAL`; `maintenanceScan` = "Maintenance scans cannot run while this deployment is read-only.", `queuedWork` = the `POST /api/tasks/run` twin. Lines 96-100 record that the orphan sweep has no sentence of its own because the scan refuses first.
- `src/app/api/tasks/scan/route.ts:28-83` -- the 403. Gate sits after the service-principal 401 and before `scanForMaintenance`; refuses whole rather than degrading to `dry`. Its docstring names the scan as the *only* scheduled trigger for `sweepOrphanWikiDirs` and the *only* trigger of any kind for `backfillWorkspaceProfiles` (DW-137).
- `src/lib/read-only.ts:102-110` -- **"THE FOUR KERNEL WRITERS" IS DW-188'S STARTING SET, NOT THE WHOLE LIST.** The wiki-lifecycle writers joined them (`createWiki`, `applyScenarioTemplate`, `renameWiki`, `deleteWiki`, `setCurrentWiki` in `wikis.ts`), and DW-385 pushed `assertWritable` into three more stores that had carried HTTP gates only: `research-projects.ts:442,656`, `names-terms.ts:333,360,380`, `email-ingest.ts:120`. `review-queue.ts`, `graph-insight-dismissals.ts`, `source-meeting.ts`, `todos.ts`, `workspace-profile.ts` and `research-runtime.ts` assert too. So a direct CLI/library caller is refused for far more than pages — "refused only at its route" is false for most of these.
- `src/app/api/tasks/run/route.ts:157-178` -- serves `READ_ONLY_REFUSAL.queuedWork` ("Queued work cannot run while this deployment is read-only."), a *different* sentence from the scan's. **ITS SOURCE COMMENT'S QUEUE SEMANTICS ARE WRONG — DO NOT REPEAT THEM.** The comment claims "4xx means the consumer ACKS AND DROPS the message" and advises draining the queue first. The consumer disagrees.
- `workers/task-consumer/index.ts:114-139` -- **the authority on what a 403 does to a queued message, verified this session.** Ack-and-drop is `400 || 404 || 422` ONLY (`:114`). A 403 falls to the next branch (`:126-139`), whose comment reads "Other 4xx (notably auth/rate-limit) and 5xx are operational/transient; retry instead of silently dropping a valid task" — so `message.retry()`, up to `MAX_DELIVERY_ATTEMPTS = 4` (`:56`), then the dead-letter queue. Read-only work is therefore **retried and replayable, not discarded**. One more consequence lives here: on the final attempt `notifyEmailReceipt(..., status: "failed")` fires, so an email-origin ingest message sends the submitter a failure receipt for what is only a paused deployment.
- `src/app/api/tasks/scan/route.ts:33-42,130-190` -- the scan also drives the scheduled-agent, source-monitor, monitor-digest, integration-outbox and owner-backup blocks, all of which stop when it refuses. The gate precedes the `?dry=1` branch, so the documented inspection switch is refused too.
- Gated-route inventory verified this session (`grep -rln "isReadOnly()" src/app/api`, refusal key each serves) -- pages: `wiki/[slug]` (`pageEdit`/`pageDelete`/`pageMetadata`), `ingest/history` (`bulkPageDelete`); artifacts: `workbench/artifact` + `workbench/artifact/revisions` (`artifactEdit`); settings: `settings` (`settingsSave`), `settings/rebuild-embeddings` (`embeddingRebuild`), `email/settings` (`emailSettings`), `workspace-profile` (`wikiFileWrite`); wiki lifecycle: `wikis`, `wikis/[id]`, `wikis/[id]/template`, `wikis/current`; ingest-family (`ingest`): all six `ingest/*` doors plus `ingest/reingest` (`reingest`), `email/ingest`, `agents/[id]/ingest`, `extract/jobs`, `sources/meeting` (`sourceMeeting`), `workbench/intake`, `workbench/source`, `workbench/activity`, `v1/projects/[wikiId]/sources/rescan`; saved answers: `query/save` **and** `chat/conversations/[id]/save` (`savedAnswer`); plus `lint/fix` + `lint/workbench-fix` (`lintFix`), `research`/`research/[id]`/`research/[id]/run`, `names-terms`(+`[id]`), `todos`(+`[id]`), `review-queue/[id]` and the three `v1/.../reviews*` doors (`reviewQueue`), `graph/insights` (`graphInsightDismiss`), `tasks/run` (`queuedWork`), `tasks/scan` (`maintenanceScan`), `workbench/preview` and `graph/workbench` (read-shaping, no refusal sentence).
- `src/app/api/admin/rebuild-embeddings/route.ts:10-15` -- service-token only, never gated, precisely so a rebuild is still possible on a read-only Workers deployment while the Settings button refuses. Note the Settings button is **not** `disabled`: `src/components/EmbeddingSettings.tsx:355-368` uses `aria-disabled` plus a described note so it stays focusable (the DW-191/299/387 pattern DEPLOY.md:255-266 already describes) — do not write "hard-disabled".
- **Other ungated doors, verified this session — the rebuild is NOT "the one deliberate exception".** `POST /api/admin/reset` deletes `wiki/`, `raw/`, `discuss/` and `tenants/` through `storage.deleteDirectory`, touching no kernel writer; `POST /api/admin/migrate` runs `migrateToTenants`; `POST /api/archive/import` writes a whole archive back (`importPortableArchive` asserts nothing) — and that is the door `tools/work-wiki-sync.mjs:85` drives for the documented `sync push --confirm` restore. All three carry no gate.
- `src/lib/read-only.ts:60-72` -- names the flag's **deliberate** ungated boundary and the parity suite pins it: `POST /api/vaults`, `PATCH`/`DELETE /api/vaults/[id]`, `POST`/`PATCH`/`DELETE /api/agent-skills[/id]` and `POST /api/archive/import` refuse nothing, so their panels render no read-only copy.
- Ungated writes verified this session (no `isReadOnly`, no `assertWritable`, and no kernel writer on the path): `src/app/api/vaults/route.ts:31`, `src/app/api/monitors/route.ts:22`, `src/app/api/monitor-digests/*`, `src/app/api/knowledge/route.ts:37`, plus `tasks.ts` (enqueue), `backups.ts`, `operation-ledger.ts`, `revisions.ts`, `raw.ts` and the ingest-ledger bookkeeping.
- `src/app/api/agents/seed/route.ts:119-126`, `src/lib/agents.ts:497-531,772-845` -- **agent profiles are a PARTIAL exception, and the boundary runs through the middle of one route.** `POST /api/agents/seed` does answer 403: `seedAgent` writes identity pages through a kernel writer before `registerAgent`. But `PUT /api/agents/[id]` reaches a kernel writer only inside `if (options.addPages && options.addPages.length > 0)` — a request moving `name`, `description`, `trigger`, `enabled`, `instructions`, `defaultVault` or only `removePages` falls through to `registerAgent`, a bare `storage.writeFile`, and returns 200. `DELETE /api/agents/[id]` (`deleteAgent`) is ungated outright. So the doc must say "seeding an agent refuses, editing or deleting one does not", never "agent profiles refuse".
- `src/app/api/tasks/scan/route.ts` upkeep blocks -- the refused scan also stops `rebuildDerivedIndexes` (derived-index self-heal) and `purgeStaleJobs` (terminal ingest-job GC), not only the backfill and the sweep.
- Further ungated write doors verified this session (no gate, no kernel writer): `POST`/`PATCH`/`DELETE /api/agent-skills[/id]`, `POST /api/agents/[id]/token`, `POST /api/agents/ensure`, `/api/agent-workspaces`, `POST`/`DELETE /api/vaults/[id]/pages`, `POST /api/chat/conversations` and its `[id]`/`messages` doors, `POST /api/query/history`, `/api/action-items*`, `/api/integrations*`, `POST /api/review/proposals` (`createMemoryChangeProposal` asserts nothing, unlike the rest of the Review queue).
- `docker-compose.yml` -- the deployment this document describes uses `env_file: .env`, and Compose strips surrounding quotes before the process sees the value. So `YOPEDIA_READONLY="1"` in `.env` most likely arrives as `1` and IS on. Claim the untrimmed/exact comparison for `true`/`yes`/`on`/whitespace only; do not tell an operator a quoted `1` reads as off on this path.

## Tasks & Acceptance

**Execution:**
- `DEPLOY.md` -- add a `YOPEDIA_READONLY` row as the final row of the **Additional Settings** table (:61). Name the only accepted value and do not overpromise what the flag does: "Set to `1` to refuse most content writes — see [Read-only deployments](#read-only-deployments)". Use a real anchor link, not italics: the target is ~370 lines below and this row is the one place a reader jumps from. Default cell: "Unset (writable)" -- the table is what an operator copies, and `YOPEDIA_READONLY=true` is a silent no-op.
- `DEPLOY.md` -- add a `### Read-only deployments` subsection immediately before `## Volume Mounts` (:429), organised around **who is refused** rather than which layer holds the check. Every claim must come from the Code Map's verified inventory; where the Code Map and a source comment disagree, the Code Map wins. Cover, in order:
  - (a) On only at the literal `1`, compared exactly and untrimmed, so `true`, `yes`, `on`, a whitespace-padded value or an unset variable all read as off with nothing logged. Do **not** claim a quoted `"1"` reads as off — Compose strips quotes from `.env` on the path this document describes.
  - (b) One sentence on what is unaffected, before the refusals: reading, search, query and chat answering all work, and a browser user meets a standing explanatory sentence beside a control rather than a broken app.
  - (c) **Refused for every caller, HTTP or not** — page and artifact writes through the kernel writers, plus (DW-385 pushed the same assertion into the stores) wiki create/rename/delete/template/switch, every write to a file inside a Wiki's own directory including the Workspace Purpose profile, research projects and runs, Names & Terms, email-ingestion settings, Todos, the Review queue, marking a source as a meeting and Graph Insight dismissal. Say the four kernel writers were the *starting* set. An HTTP door maps it to **403**; a CLI, stdio-MCP, agent or library caller gets the same sentence thrown as an error.
  - (d) **Refused at the HTTP door too** — say plainly that most items in (c) *also* gate at their route so the refusal arrives before bytes are staged or LLM calls spent, and that the two lists are not disjoint; then name the ones gated on the HTTP path alone: saving Settings, the Settings rebuild-vector-index button, and the ingest family that is not covered by (c) (`extract/jobs`, the Workbench `intake`/`source`/`activity` doors, the v1 project source rescan), plus saving an answer as a page from **either** Query or Chat, lint auto-fix from either surface, and both `/api/tasks` doors.
  - (e) **Still writable, and this is where an operator gets hurt.** Lead with the destructive ones: `POST /api/admin/reset` still wipes `wiki/`, `raw/`, `discuss/` and `tenants/`; `POST /api/archive/import` — the door the documented `sync push --confirm` restore drives — still writes a whole archive over the wiki; `POST /api/admin/migrate` still runs. Then vaults and vault page membership, agent skills, agent tokens, chat conversations and messages, query history, action items, integrations and the outbox, source monitors and digests, structured knowledge and the graph (Graph Insight dismissal the one exception), memory change proposals, the queue's enqueue side, backups, the operation ledger, the revision store, `raw/` snapshots and the ingest ledger. `read-only.ts:60-72` calls vaults, agent skills and archive restore this flag's *deliberate* boundary — say so, so the omission does not read as an oversight. Agents split mid-route: **seeding** an agent refuses (its identity page hits a kernel writer first), **editing** one that adds no pages, and **deleting** one, do not.
  - (f) It is a gate, not a deployment-wide write lock: a writer added tomorrow is writable until it spells the check, so read the lists as today's boundary. If a real write lock is wanted, that is the container's or volume's read-only mount, not this variable.
- `DEPLOY.md` -- the maintenance paragraph: `POST /api/tasks/scan` answers **403** on every cron pass with `{"error": "Maintenance scans cannot run while this deployment is read-only."}`; the gate precedes the `?dry=1` branch, so the inspection switch is refused too rather than degrading to a `dry`-shaped 200. Consequences: a monitor treating non-2xx as failure alerts **once per tick**; and the work this scan alone drives stops — the Workspace Purpose backfill, the orphan wiki-directory sweep, the derived-index self-heal, the terminal ingest-job GC, and the scheduled-agent, source-monitor, digest, integration-outbox and owner-backup passes. Tie it to (e): those stores are ungated, so nothing refuses their writes — nothing is asking for them.
- `DEPLOY.md` -- the queue paragraph, and **the previous draft had this exactly backwards**: `POST /api/tasks/run` refuses with the same 403 but its own sentence, `{"error": "Queued work cannot run while this deployment is read-only."}`, so an alert rule matching the scan's body never fires on it. The consumer acknowledges and drops only `400`, `404` and `422`; a **403 is treated as transient and retried**, up to four delivery attempts, then parked in the dead-letter queue — so queued work is **replayable, not discarded**. The cost is noise, not loss: every queued message burns its retries against a deployment that cannot succeed, and on the final attempt an email-origin ingest sends its submitter a *failure* receipt for what is only a paused deployment. Pausing the producer, or draining the queue, avoids that -- but never repeat `tasks/run/route.ts`'s own source comment, which claims ack-and-drop and is wrong.

**Acceptance Criteria:**
- Given an operator reading DEPLOY.md's Environment Variables section, when they scan the Additional Settings table, then `YOPEDIA_READONLY` appears there with `1` named as the accepted value and an anchor link to the `Read-only deployments` subsection.
- Given the flag documented, when the reader finishes the subsection, then they can name a write refused for every caller (a page edit through the CLI), a write refused only at its HTTP door (saving Settings), and a write that still succeeds (creating a vault, restoring an archive) — without opening the source.
- Given an operator who believes the flag protects their content, when they read the still-writable paragraph, then they learn that the admin reset and the archive restore still destroy or overwrite it.
- Given a deployment with `YOPEDIA_READONLY=1` and a cron hitting `POST /api/tasks/scan`, when the operator consults DEPLOY.md, then it states the per-tick alerting, that `?dry=1` is refused too, and every scheduled pass that stops.
- Given queued work on a deployment about to be set read-only, when the operator reads the queue paragraph, then it says the messages are retried and end in the dead-letter queue (replayable), and warns about the failure receipts email-origin ingests will send.
- Given any claim in the subsection, when it is traced to the Code Map, then none contradicts a gate's presence or absence in the code — in particular editing or deleting an agent is not described as refused, the embeddings rebuild button is not called "hard-disabled", and a quoted `"1"` is not called a no-op.
- Given the change, when `git diff --stat` is inspected, then `DEPLOY.md` is the only modified file.

## Spec Change Log

### 2026-08-30 — Pass 1 (bad_spec loopback)

**Triggering findings.** Review pass 1 caught the enumerated lists stating things
the code contradicts: agent profiles listed as "still mutates" when `seedAgent`
and `updateAgent` write an identity page through a kernel writer and both routes
answer 403; source monitors and structured knowledge listed as ungated when
`v1/.../sources/rescan` and `extract/jobs` gate; research projects, Names &
Terms, email-ingest settings, the wiki lifecycle and the Review queue framed as
"refused at its own route" when DW-385 put `assertWritable` in their stores, so a
CLI caller is refused too; seven gated doors missing entirely, `POST
/api/settings/rebuild-embeddings` most damagingly, since DEPLOY.md's own drift
remedy earlier in the section is "rebuild embeddings"; "four kernel writers"
stated as the whole set when `read-only.ts:102` says it is the starting set; the
`/api/tasks/run` ACK-and-drop queue semantics and its "drain or pause the queue
first" instruction absent altogether; `raw/`, the ingest ledger and revisions —
named by the intent — omitted from still-writable; `?dry=1` refused but unstated;
`tasks/run` said to refuse "the same way" while serving a different sentence;
"every door answers 403" colliding with non-HTTP callers, who get a thrown error;
the table row omitting the only accepted value.

**Amended.** Code Map replaced its two summary bullets with a verified
door-by-door inventory (each door and the `READ_ONLY_REFUSAL` key it serves), the
store-level assertion set, the agent-seed indirection, the deliberate
`admin/rebuild-embeddings` exception, and the `tasks/run` queue-semantics
comment. Tasks were re-cut so the subsection is organised by **who is refused**
(every caller / HTTP door only / still writable) instead of by which layer holds
the check, and a fifth task was added for the queue paragraph. ACs now name the
three-way distinction, the drain-the-queue instruction, and a traceability
criterion.

**Known-bad state avoided.** An operator doc whose "safe to keep using" list
names a surface that 403s, and whose "refused at its own route" framing tells a
CLI operator their scripts bypass gates that in fact refuse them — the exact
inversion DW-268 exists to end. Plus a deployment set read-only with a live queue
silently discarding work.

**KEEP.** These survived review and must survive re-derivation: the `###
Read-only deployments` heading sited at the end of the Environment Variables
section immediately before `## Volume Mounts`; the table row pointing at it
rather than compressing the boundary into a cell; the opening literal-`1`
paragraph; the closing "gate, not a deployment-wide write lock" paragraph; the
scan paragraph's core (refuses whole rather than a `dry`-shaped 200, once-per-tick
alerting, backfill and orphan sweep named); DEPLOY.md's prose voice — bold
lead-in sentences, backticked identifiers, ~78-column wrap, no bullet
reference tables; and the habit of calling out an exception inline (as the Graph
Insight dismissal was) rather than flattening a list that has one.

### 2026-08-30 — Pass 2 (bad_spec loopback)

**Triggering findings.** Two independent reviewers, confirmed against source:
the queue paragraph was **inverted**. `workers/task-consumer/index.ts:114`
acks-and-drops on `400 || 404 || 422` only; a 403 falls to the transient branch
at `:126-139` and is retried to `MAX_DELIVERY_ATTEMPTS = 4`, then parked in the
DLQ — replayable, the opposite of what pass 1 shipped. The bolded "drain or
pause the queue" instruction rested on a data-loss mode that does not exist, and
the real cost (a `notifyEmailReceipt` "failed" receipt to each email-origin
submitter on the final attempt) went unsaid. The error was inherited honestly:
`src/app/api/tasks/run/route.ts:166-173`'s own comment asserts ack-and-drop, and
the pass-1 spec promoted that comment into an operator instruction. Also: "one
ungated door is deliberate" was false — `POST /api/admin/reset` (wipes `wiki/`,
`raw/`, `discuss/`, `tenants/`), `POST /api/admin/migrate` and `POST
/api/archive/import` (the door `tools/work-wiki-sync.mjs:85` drives for the
documented restore) are all ungated, so the paragraph told an operator their
content was protected from doors that destroy it. `PUT /api/agents/[id]` was
overstated: `updateAgent` reaches a kernel writer only when `addPages` is
non-empty, so an ordinary field edit returns 200, and `DELETE /api/agents/[id]`
is ungated. The still-writable list omitted agent skills, agent tokens, vault
page membership, chat conversations, query history, action items, integrations
and memory change proposals — several of which `read-only.ts:60-72` names as the
flag's *deliberate* boundary. Minor: the scan also stops `rebuildDerivedIndexes`
and `purgeStaleJobs`; a quoted `"1"` is unquoted by Compose on this document's
own `env_file` path; the rebuild button is `aria-disabled`, not "hard-disabled";
the two paragraphs were framed as disjoint sets while most items gate at both
layers; the table pointer was italics rather than an anchor.

**Amended.** Code Map gained the consumer's real disposition table, the three
ungated admin/archive doors, `read-only.ts:60-72`'s deliberate-boundary note, the
agent split, the extra ungated doors, and the Compose quote-stripping fact — and
a standing warning never to repeat `tasks/run/route.ts`'s source comment. Tasks
re-cut: the queue bullet now states retry-then-DLQ and the receipt-email noise;
the still-writable bullet leads with the destructive doors; a new bullet (b) says
what still works before the refusals; (d) says outright that the two lists are
not disjoint.

**Known-bad state avoided.** An operator draining a queue to prevent data loss
that cannot happen, while believing `admin/reset` and the archive restore are
blocked — and a doc that would have been the second place, after the route
comment, to record the inverted queue contract as fact.

**KEEP.** Everything KEPT in pass 1 still holds. Additionally, these pass-1
results survived review and must survive re-derivation: the literal-`1` opening
(minus the quoted-`"1"` claim); the every-caller / HTTP-door / still-writable
three-way split; naming the four kernel writers as the *starting* set; the
`POST /api/admin/rebuild-embeddings` escape hatch tied to the drift remedy
earlier in the section; the agent-profile correction (as a split, not a blanket);
the scan paragraph in full; and quoting each door's refusal body as JSON so an
alert rule can be matched to it.

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 12: (high 0, medium 4, low 8)
- patch: 0
- defer: 0
- reject: 7
- addressed_findings:
  - `[medium]` `[bad_spec]` "Still mutates" list named agent profiles, source monitors and structured knowledge as ungated; agent seed/update answer 403 through a kernel writer, and `v1/.../sources/rescan` and `extract/jobs` gate. Spec Tasks re-cut and Code Map given the verified inventory; implementation loopback.
  - `[medium]` `[bad_spec]` "Refused at its own route" framing was false for research projects, Names & Terms, email-ingest settings, the wiki lifecycle and the Review queue, whose stores assert too (DW-385) — it told a CLI operator the opposite of the truth. Reorganised around who is refused.
  - `[medium]` `[bad_spec]` Seven gated doors omitted, `POST /api/settings/rebuild-embeddings` most damagingly (DEPLOY.md prescribes rebuilding embeddings as the drift remedy earlier in the same section). Inventory added, plus the deliberate ungated `admin/rebuild-embeddings` exception.
  - `[medium]` `[bad_spec]` `/api/tasks/run`'s 4xx makes the consumer acknowledge and drop rather than retry, so queued work is discarded; "drain or pause the queue before setting `YOPEDIA_READONLY`" was absent. Added as its own task and AC.
  - `[low]` `[bad_spec]` `raw/`, the ingest ledger and the revision store — named by the intent — missing from the still-writable list.
  - `[low]` `[bad_spec]` "The four kernel writers" presented as the whole enforcement set; `read-only.ts:102` calls it DW-188's starting set.
  - `[low]` `[bad_spec]` `POST /api/tasks/run` said to refuse "the same way" while serving `queuedWork`, a different sentence — an alert rule matching the quoted text would miss it.
  - `[low]` `[bad_spec]` "Every door answers 403" collided with the same paragraph's CLI/MCP claim; non-HTTP callers get a thrown refusal, not a status.
  - `[low]` `[bad_spec]` The scan gate precedes `?dry=1`, so the documented inspection switch is refused too — unstated.
  - `[low]` `[bad_spec]` The scan also drives the scheduled-agent, source-monitor, digest, outbox and backup passes, all of which stop with it; only two casualties were named.
  - `[low]` `[bad_spec]` Table row omitted the only accepted value, inviting `YOPEDIA_READONLY=true`, which the prose itself calls a silent no-op.
  - `[low]` `[bad_spec]` The `=== "1"` comparison is exact and untrimmed; a quoted or whitespace-padded value reads as off.

## Verification

**Commands:**
- `git diff --stat` -- expected: `DEPLOY.md` is the only file changed.
- `grep -n "YOPEDIA_READONLY" DEPLOY.md` -- expected: a hit in the Additional Settings table plus hits in the new subsection.
- `grep -n "tasks/scan" DEPLOY.md` -- expected: at least one hit inside the new subsection.

**Manual checks (if no CLI):**
- Re-read the new subsection against `src/lib/config.ts:252-307` and `src/app/api/tasks/scan/route.ts:62-83`: every "refuses" and "still mutates" claim must be traceable to a gate (or its absence) named in the Code Map.
- Confirm the existing read-only prose at DEPLOY.md:253-276 is untouched and the workers-ai block still directly follows the Additional Settings table.

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 12: (high 1, medium 3, low 8)
- patch: 0
- defer: 0
- reject: 7
- addressed_findings:
  - `[high]` `[bad_spec]` The `/api/tasks/run` queue paragraph was inverted — the consumer acks-and-drops only 400/404/422, so a 403 retries to four attempts and parks in the DLQ (replayable), and each final attempt emails an email-origin submitter a failure receipt. Spec corrected against `workers/task-consumer/index.ts:114-139`; implementation loopback.
  - `[medium]` `[bad_spec]` "One ungated door is deliberate" was false: `POST /api/admin/reset`, `POST /api/admin/migrate` and `POST /api/archive/import` are ungated, the last being the door the documented restore drives. Still-writable bullet re-cut to lead with them.
  - `[medium]` `[bad_spec]` `PUT /api/agents/[id]` refuses only when the request adds identity pages; an ordinary field edit and `DELETE /api/agents/[id]` are ungated. The blanket "agent profiles refuse" claim replaced with the split.
  - `[medium]` `[bad_spec]` Still-writable list omitted agent skills, agent tokens, vault page membership, chat conversations and messages, query history, action items, integrations and memory change proposals — three of which `read-only.ts:60-72` pins as the deliberate boundary.
  - `[low]` `[bad_spec]` The refused scan also stops `rebuildDerivedIndexes` and `purgeStaleJobs`.
  - `[low]` `[bad_spec]` A quoted `"1"` was called a no-op, but Compose strips quotes from `.env` on the path this document describes.
  - `[low]` `[bad_spec]` "the Settings button is hard-disabled" contradicts `EmbeddingSettings.tsx:355-368`, which uses `aria-disabled` to keep it focusable.
  - `[low]` `[bad_spec]` The every-caller and HTTP-door paragraphs read as disjoint sets while most items gate at both layers, making "marking a source as a meeting" in both look like an error.
  - `[low]` `[bad_spec]` Wiki lifecycle, todos, names-terms, research, email settings, graph insights and the v1 review doors gate at the door too, but were presented as kernel-only.
  - `[low]` `[bad_spec]` The section never said what still works, leaving "is my deployment still usable" unanswered.
  - `[low]` `[bad_spec]` The table's pointer was italic text ~370 lines from its target rather than an anchor link.
  - `[low]` `[bad_spec]` The table row promised "refuse writes across the deployment" — the very belief the closing paragraph exists to correct.

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 3, low 4)
- defer: 5: (high 0, medium 1, low 4)
- reject: 11
- addressed_findings:
  - `[medium]` `[patch]` "Memory change proposals" sat in the still-writable list, but accepting one is refused (`review/proposals/[id]/route.ts:87-92`; `applyMemoryChangeProposal` reaches a kernel writer). Split by action: raising, reject and revise still write; accepting is refused and leaves the proposal pending.
  - `[medium]` `[patch]` "does not protect content from the administrative doors" over-generalised — `DELETE /api/admin/tenant/[handle]` IS refused (`tenant-admin.ts:40`). Reworded to "three of the four administrative doors are ungated" and the fourth named.
  - `[medium]` `[patch]` "chat answering are untouched" was wrong for the Workbench: `ChatCanvas.tsx:433,1053,1228,1237` disables the composer on the flag. Narrowed to reads/search/query, with the composer exception stated.
  - `[low]` `[patch]` The promise that a refused control always carries a standing sentence overstated the client copy — Todos, lint auto-fix and the chat composer carry none. Qualified to "most".
  - `[low]` `[patch]` "the drift remedy earlier in this section" pointed at the sibling `### Additional Settings`; repointed to the embedding-provider notes above.
  - `[low]` `[patch]` "alerts once per tick" left the cadence undefined and implied the deployment raises it; the bundled cron is daily (`0 6 * * *`) and the `scheduled` handler only logs, so the alert comes from an external monitor. Stated.
  - `[low]` `[patch]` The Compose quote-stripping claim was version-independent; qualified to Compose v2, with v1 and `docker run --env-file` noted as not stripping.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

`YOPEDIA_READONLY` now has operator-facing documentation (DW-268), and the
maintenance scan's read-only 403 is recorded outside code comments (DW-388).
DEPLOY.md gains a `YOPEDIA_READONLY` row in the **Additional Settings** table
(anchor-linked, naming `1` as the only accepted value) and a
`### Read-only deployments` subsection closing the Environment Variables
section. The subsection is organised by **who is refused** rather than by which
layer holds the check: what still works; what is refused for every caller
(kernel writers plus the wiki-lifecycle and DW-385 store writers, 403 over HTTP
and a thrown error everywhere else); what is refused at the HTTP door only; what
is still writable — led by the ungated administrative doors that destroy or
overwrite content, with the memory-proposal and agent-profile splits called out;
the scan's per-pass 403 and every scheduled pass that stops with it; the queue
door's own sentence and its retry-then-DLQ disposition; and a closing note that
this is a gate, not a deployment-wide write lock.

### Files changed

- `DEPLOY.md` — added the `YOPEDIA_READONLY` settings row and the
  `### Read-only deployments` subsection (127 insertions, 0 deletions; the
  existing read-only prose at :253-276 is provably untouched).

### Review findings

Three review passes, four layers each (blind hunter, edge-case hunter,
verification-gap, intent-alignment).

- Pass 1 — 12 `bad_spec` (medium 4, low 8), spec amended and code re-derived.
  The enumerated lists stated things the code contradicts: agent profiles,
  monitors and structured knowledge wrongly listed as ungated; "refused at its
  own route" framing that told a CLI operator the opposite of the truth; seven
  gated doors omitted, `POST /api/settings/rebuild-embeddings` most damagingly.
- Pass 2 — 12 `bad_spec` (high 1, medium 3, low 8), spec amended and code
  re-derived. The high: the queue paragraph was inverted. The consumer acks and
  drops only 400/404/422, so a read-only 403 is retried and ends in the DLQ —
  replayable, not discarded. The draft had promoted `tasks/run/route.ts`'s own
  (incorrect) source comment into a bolded operator instruction. Also: the
  ungated administrative doors, the agent seed/edit/delete split.
- Pass 3 — 7 `patch` (medium 3, low 4) applied, 5 `defer`, 11 `reject`. Patches:
  the memory-proposal split, the tenant-delete admin exception, the Workbench
  chat composer, the overstated client-copy promise, a cross-reference, the
  alert cadence, and the Compose-version qualification.
- Deferred (5, in frontmatter): three in-repo sites still assert the wrong queue
  semantics; `POST /api/tasks/run`'s 403 is pinned by no test; the consumer's
  poison-set boundary is unpinned; DEPLOY.md's two quoted refusal sentences lack
  the repo's own doc-parity pin; and `agents/[id]/route.ts`'s comment overstates
  when `updateAgent` reaches a kernel writer.
- Rejected: scope expansion beyond the boundary the intent asked for — how to
  set, apply and confirm the flag, Workers `wrangler.jsonc` vars, stale browser
  tabs, mid-request flag flips, DLQ redrive procedure, the `YOPEDIA_` prefix
  history, converting the prose lists to tables, and version-stamping them.

Follow-up review recommended: **true** — patched findings were medium 3, low 4;
score `3 x 3 + 1 x 4 = 13`, at or above the threshold of 5. No patched finding
was high.

### Verification

- `git diff --stat` → `DEPLOY.md` only, 127 insertions / 0 deletions.
- `grep -n "YOPEDIA_READONLY" DEPLOY.md` → the table row at :59 plus the
  subsection hits; the pre-existing mention at :255 unchanged.
- `grep -n "tasks/scan" DEPLOY.md` → :515, inside the new subsection.
- Manual: every claim traced to the Code Map — `src/lib/config.ts:252-307`,
  `src/lib/read-only.ts`, `src/app/api/tasks/{scan,run}/route.ts`,
  `workers/task-consumer/index.ts:114-139`, `src/lib/agents.ts:497-531,772-846`,
  `src/lib/tenant-admin.ts:40`, `src/components/workbench/ChatCanvas.tsx`, and
  the ungated `admin/{reset,migrate}` and `archive/import` routes. Line widths
  are within the file's existing norms; DEPLOY.md was not Prettier-clean before
  this change and is unchanged in that respect.

### Residual risks

- The document deliberately contradicts two source comments and one test
  rationale that state the opposite queue semantics. The code is right and the
  comments are wrong; deferred rather than fixed, since the intent scoped this
  to documentation.
- Nothing pins the two refusal sentences DEPLOY.md quotes against their
  constants, so a reworded constant would leave the doc quoting a body no
  deployment returns. Deferred.
- The enumerated door lists are accurate as of this commit but will drift; the
  section says so and tells the reader to re-check after an upgrade.
