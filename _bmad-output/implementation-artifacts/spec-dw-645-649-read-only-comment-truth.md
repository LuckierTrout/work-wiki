---
title: 'Correct the in-repo comments that misstate read-only queue and agent-write behaviour'
type: 'chore'
created: '2026-09-02'
status: 'done'
baseline_revision: 'f40a2531ac3e26548b97412ef2c90406959ae384'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Three comments state that a poison task goes to the DLQ; poison messages
      are acked and dropped and never reach it.
    evidence: |-
      `src/lib/tasks.ts:452-454` (`parseTask` JSDoc) reads "reject malformed
      messages as poison (4xx -> DLQ) rather than retrying them forever";
      `src/lib/tasks.ts:326-328` says a poison task "went to the DLQ";
      `src/lib/__tests__/prose-inventory-parity.test.ts:347` restates
      "poison -> DLQ" inside a passing test's rationale.
      `workers/task-consumer/index.ts:114-125` acks and RETURNS for the poison
      set, so the message is discarded on the spot. `yopedia-tasks-dlq` is
      reached only through the transient/retry branch after `max_retries: 3`
      (`workers/task-consumer/wrangler.jsonc`). This is a different claim from
      DW-645 (which statuses are poison, now corrected): it is where a poison
      message ends up. The operational cost is an operator searching the DLQ
      for a malformed ingest that was never parked there. DW-645's own pass
      added the correct rule at `src/app/api/tasks/run/route.ts:144-145`
      ("discarded on the spot and never reaches the DLQ"), so the fix has an
      in-repo anchor to cite.
    location: >-
      src/lib/tasks.ts:454
    severity: low
---

<intent-contract>

## Intent

**Problem:** Five comment blocks state falsehoods a maintainer reads before they ever open `DEPLOY.md`. Three assert that the task consumer treats a 4xx as terminal (acks and drops), so read-only work is "discarded rather than replayable" — but `workers/task-consumer/index.ts:114` acks only on `400 || 404 || 422`, and a 403 falls to the transient branch, retries to `MAX_DELIVERY_ATTEMPTS = 4`, then parks in the DLQ. A fourth states unconditionally that `updateAgent` writes the identity page through the kernel before persisting, which is true only when the request carries `addPages`.

**Approach:** Comment-only corrections against behaviour already verified in code and already documented correctly in `DEPLOY.md`. No production logic, no test assertions, and no `DEPLOY.md` prose changes. Two test files carry a "correcting those comments is DW-645, tracked separately" forward reference that becomes false the moment the corrections land; those paragraphs are rewritten in the same pass so the repo does not trade one wrong comment for another.

## Boundaries & Constraints

**Always:** State what the code does today, with the concrete anchor a reader can check (`workers/task-consumer/index.ts:114`'s `400 || 404 || 422` set; `src/lib/agents.ts`'s `if (options.addPages && options.addPages.length > 0)` guard). Keep each comment's existing purpose, voice and surrounding structure — these are dense rationale blocks, not headers to rewrite wholesale. Keep the parts of each comment that are already true (the read-only gate's placement rationale, the scan's REFUSES-WHOLE decision, the agents route's "the catch only has to classify it").

**Block If:** A comment's correction would require changing an assertion, a status code, a poison set, or any runtime behaviour to make it true. That is a behaviour change, not a comment correction, and this bundle is not authorised for it.

**Never:** Do not change `workers/task-consumer/index.ts` (the code is right). Do not change `DEPLOY.md` (already correct — verified at its read-only section). Do not add, remove, or alter any `expect(...)` or test case. Do not touch the read-only gates themselves in either route. Do not resolve the other DW entries that share this source spec (the test-pin ones are already landed, others are out of bundle).

</intent-contract>

## Code Map

- `src/app/api/tasks/run/route.ts:142-147` -- WRONG, AND IT IS THE FILE HEADER. The route's own JSDoc "Status contract (drives the consumer's ack/retry, which maps to CF Queues)" reads `4xx -> permanently-bad/poison task -> ack + drop (don't retry; -> DLQ on the consumer side if it chooses)`. Same falsehood as `:166-173`, different words — and it is the block a consumer maintainer reads FIRST, and the block `:166` points back at ("the status contract above"). The `2xx` and `5xx` lines are correct and stay.
- `src/app/api/tasks/run/route.ts:166-173` -- WRONG. "4xx means the consumer ACKS AND DROPS the message" and "work queued against a read-only deployment is discarded rather than replayable". The gate itself (`:175-180`) and the placement rationale above it (`:158-164`) are correct and stay.
- `src/app/api/tasks/scan/route.ts:78-80` -- WRONG. "the consumer treats a 4xx as terminal — which is the honest answer here too". Doubly wrong: the consumer's poison set excludes 403, AND the scan is never queue-delivered (see the cron path below). The REFUSES-WHOLE rationale at `:74-78` is correct and stays.
- `src/lib/__tests__/scan-route.test.ts:455-456` -- WRONG. Rationale comment inside the `?dry=1` case: "the consumer treats the 4xx as terminal exactly as it does for `POST /api/tasks/run`". Comment only; the three `expect`s below it are correct.
- `src/app/api/agents/[id]/route.ts:267-270` -- WRONG (unconditional). "`updateAgent` writes the agent's identity PAGE through the kernel before it persists the profile with `registerAgent`, so the refusal aborts with neither written."
- `workers/task-consumer/index.ts:114` -- TRUTH SOURCE, do not edit. `if (res.status === 400 || res.status === 404 || res.status === 422)` → ack. `:126-139` transient branch → `message.retry()`. `MAX_DELIVERY_ATTEMPTS = 4` at `:56`.
- `workers/task-consumer/index.ts:243-265` -- TRUTH SOURCE for the scan. `scheduled()` POSTs `/api/tasks/scan`; no queue message, no ack, no retry. It logs `` `task-consumer cron: scan → ${res.status} ${body}` `` — status AND the first 400 chars of the body — so the refusal SENTENCE does reach the log stream and a log-matching monitor can catch it, not only a status probe.
- `workers/task-consumer/wrangler.jsonc` -- TRUTH SOURCE for the retry ceiling and the DLQ hop: `max_retries: 3`, `dead_letter_queue: "yopedia-tasks-dlq"`. THIS is what governs redelivery and parking — a Cloudflare Queues concern, not the worker's.
- `workers/task-consumer/index.ts:56, :130` -- `MAX_DELIVERY_ATTEMPTS = 4` does NOT set the retry ceiling. `message.retry()` at `:139` is unconditional; the constant appears only in `if (message.attempts >= MAX_DELIVERY_ATTEMPTS)` guards that gate the final FAILURE-RECEIPT EMAIL. Four attempts = 1 initial delivery + `max_retries: 3`.
- `src/lib/agents.ts:591-627` -- `UpdateAgentOptions` has SIXTEEN fields. `addPages` is the only one that reaches a kernel writer. The other fifteen include `enabled`, `allowedTools`, `approvalPolicy`, `knowledgeScope`, `maxSteps`, `maxOutputTokens`, `timeoutMs`, `provider` and `model` — several of them tool-grant and autonomy switches. Any comment enumerating "every other edit" by name reads as exhaustive and understates the boundary; say "every field except `addPages`" instead.
- `src/lib/agents.ts:772-846` -- TRUTH SOURCE for the agents comment. `writeWikiPageWithSideEffects` sits inside `if (options.addPages && options.addPages.length > 0)`. `registerAgent` is called unconditionally at `:853`; `registerAgent` (`:497-512`) is a bare `getStorage().writeFile` with no `assertWritable`. `agents.ts` imports no read-only symbol at all.
- `src/lib/lifecycle.ts:1385-1390` -- `writeWikiPageWithSideEffects` calls `assertWritable(READ_ONLY_REFUSAL.pageWrite)` first, which is why the addPages arm genuinely refuses.
- `src/lib/__tests__/task-consumer.test.ts:110-115` -- STALE-ON-LANDING. DW-647's rationale says the route and `scan-route.test.ts` "still say in prose that 4xx acks and drops … Correcting those comments is DW-645, tracked separately". Must be rewritten to past tense once corrected.
- `src/lib/__tests__/tasks-route.test.ts:1325-1331` -- STALE-ON-LANDING. DW-646's "One prose conflict to know about" paragraph, same forward reference.
- `DEPLOY.md:604-616` -- ALREADY CORRECT, do not edit. Publishes the 400/404/422 poison set, the 403-retries-then-DLQ path, and "replayable, not lost". `DEPLOY.md:574-580` already documents the agent-edit split correctly.

## Tasks & Acceptance

**Execution:**
- `src/app/api/tasks/run/route.ts` (JSDoc header, `:142-147`) -- Correct the `4xx` line of the "Status contract" block. It must stop asserting blanket 4xx terminality: only `400`, `404` and `422` are the poison set the consumer acks and drops; every other 4xx — the read-only `403`, and the auth/rate-limit cases the consumer's own comment names — takes the transient branch and is retried, then parks in the DLQ. Keep the `2xx` and `5xx` lines and the block's compact arrow shape. -- This is the file's header and the block the gate comment below points back at; leaving it wrong makes the file contradict itself in one screenful and puts the falsehood FIRST.
- `src/app/api/tasks/run/route.ts` (gate comment, `:166-173`) -- Rewrite the second paragraph so it says the consumer does NOT drop a 403: it acks only on 400/404/422, so the 403 lands in the transient branch and is retried before the message parks in the `yopedia-tasks-dlq` DLQ — queued work is replayable, not lost. Attribute the mechanism correctly: redelivery and parking are governed by `max_retries: 3` in `workers/task-consumer/wrangler.jsonc` (four attempts total = 1 delivery + 3 retries); `MAX_DELIVERY_ATTEMPTS = 4` in the worker gates only the final failure-receipt email, so do not name it as the retry ceiling. Keep the "THIS CHANGES QUEUE SEMANTICS" framing and the closing drain/pause advice, re-pointed at the real cost: burned retries and a final-attempt failure receipt to an email-origin submitter, rather than discarded work. -- The comment a consumer maintainer reads first must not contradict the consumer, and a comment whose job is to be trustworthy about this mechanism must not misattribute it.
- `src/app/api/tasks/scan/route.ts` -- Rewrite the trailing cross-reference (`:78-80`) so it stops asserting terminal 4xx semantics. State that `POST /api/tasks/run` refuses the same way, and that this door is not queue-delivered at all — the consumer's `scheduled()` cron POSTs it and logs the status plus the first 400 chars of the body, so there is no ack/retry/DLQ decision here and an external monitor can match either the status or the refusal sentence itself. Keep the REFUSES-WHOLE rationale and the `AUTONOMOUS_MAINTENANCE` sentence intact. -- Removes the falsehood and the false analogy in one edit.
- `src/lib/__tests__/scan-route.test.ts` -- Rewrite the last sentence of the `?dry=1` case's rationale comment (`:455-456`) so it no longer claims terminal 4xx. Point at the refusal decision the case actually pins. Change no assertion. -- A passing test's rationale is read as authority.
- `src/app/api/agents/[id]/route.ts` -- Condition the `updateAgent` claim (`:267-270`): the kernel write happens only when the request carries `addPages`, so only that arm refuses; EVERY OTHER FIELD of `UpdateAgentOptions` — all fifteen of them, `enabled`, `allowedTools` and `approvalPolicy` included — reaches `registerAgent`'s bare `storage.writeFile` and returns 200 on a read-only deployment. Phrase it as "every field except `addPages`" rather than listing names: a name list reads as exhaustive and understates the boundary. Note this is `DEPLOY.md`'s documented boundary, not an oversight this catch hides. Keep "The catch only has to classify it." and keep it adjacent to the `isReadOnlyError` check it describes rather than stranded after a long argument — stay close to the original block's length. -- The unconditional claim reads as full coverage the route does not have.
- `src/lib/__tests__/task-consumer.test.ts` -- Rewrite the DW-647 rationale's forward-reference paragraph (`:110-115`): the conflicting comments have been corrected (DW-645), so it must no longer say they "still say" the wrong thing. Only claim what this pass actually corrected — the run route's JSDoc status contract AND its gate comment, plus `scan-route.test.ts` — and do not claim a correction that did not land. Keep "Read the CODE, not the prose, if the two disagree" and everything about what this case pins. Change no assertion. -- Landing the fix without this leaves a new false comment behind.
- `src/lib/__tests__/tasks-route.test.ts` -- Same treatment for the DW-646 "One prose conflict to know about" paragraph (`:1325-1331`). Change no assertion. -- Same reason.

**Acceptance Criteria:**
- Given the repo after this change, when every comment in the queue path — `src/app/api/tasks/**`, the three task/scan/consumer test files, and `workers/` — is read, then none asserts blanket 4xx terminality: each either scopes the ack set to `400/404/422` or is explicit that other 4xx are retried. Judge the CLAIM, not a fixed phrase list — a phrase grep is what let the JSDoc header's `ack + drop` wording survive the first attempt. Grep at minimum for `acks and drops`, `ack + drop`, `4xx`, `poison`, `terminal`, `discarded` and `replayable`, and read every hit. (Hits OUTSIDE the queue path that misstate where a poison message GOES rather than which statuses are poison are a different claim and a different defect — see frontmatter `deferred`.)
- Given `src/app/api/tasks/run/route.ts` read top to bottom, when the JSDoc status contract (`:142-147`) and the read-only gate comment (`:166-173`) are compared, then they agree with each other — no reader meets the poison-set rule stated two different ways in one file.
- Given every retry/DLQ claim in the corrected comments, when each is traced to its anchor, then the redelivery ceiling and the DLQ hop are attributed to `max_retries: 3` in `workers/task-consumer/wrangler.jsonc` and NOT to `MAX_DELIVERY_ATTEMPTS`, which is described only as the failure-receipt gate.
- Given the corrected agents comment, when its account of the un-gated fields is compared with `UpdateAgentOptions` (`src/lib/agents.ts:591-627`), then it covers all fifteen non-`addPages` fields rather than naming a subset that reads as exhaustive.
- Given `git diff --stat`, when the change is complete, then exactly the six distinct files named in Execution appear (`tasks/run/route.ts` carries two Execution entries but is one file), and `workers/task-consumer/index.ts`, `workers/task-consumer/wrangler.jsonc`, `src/lib/agents.ts` and `DEPLOY.md` do not.
- Given `git diff`, when reviewed, then every added and removed line is a comment line (`//`, `/*` or ` *`): no line of executable code — no `expect(`, no `return NextResponse`, no `if (` condition — is added, removed or reordered. Quoting such a fragment INSIDE a comment is expected and fine.
- Given the corrected comments, when each factual claim is checked against its Code Map anchor, then every claim matches the code — the poison set is 400/404/422, the retry ceiling is 4, the DLQ is `yopedia-tasks-dlq`, the scan arrives via `scheduled()` not the queue, and the agent kernel write is guarded by `addPages`.
- Given the corrected comments, when compared against `DEPLOY.md:574-580` and `DEPLOY.md:604-616`, then they agree with the operator doc rather than contradicting it.

## Spec Change Log

### 2026-09-02 — Iteration 1 (bad_spec loopback)

**Triggering findings.** All four review layers independently reported the same
defect: `src/app/api/tasks/run/route.ts:142-147` — the route's own JSDoc
"Status contract" — still reads `4xx → permanently-bad/poison task → ack + drop`.
That is the exact falsehood this bundle exists to retire, in the same file named
by DW-645, in the block the corrected gate comment points back at ("the status
contract above"), and it is the FIRST thing a consumer maintainer reads. Three
further findings: the new prose attributed the retry ceiling and DLQ parking to
`MAX_DELIVERY_ATTEMPTS = 4` (which in fact only gates the failure-receipt email —
`max_retries: 3` in `wrangler.jsonc` governs redelivery and parking); the agents
comment enumerated six field names as "every other edit" when
`UpdateAgentOptions` has fifteen non-`addPages` fields, several of them
tool-grant and autonomy switches; and the scan comment said the cron "only
`console.log`s the status" when it logs status plus 400 chars of body.

**What was amended (all outside `<intent-contract>`).** Code Map gained
`:142-147` as a WRONG site, a `wrangler.jsonc`-vs-`MAX_DELIVERY_ATTEMPTS`
truth-source split, the sixteen-field `UpdateAgentOptions` anchor, and the
cron's real log line. Execution split the run-route work into two entries (JSDoc
header + gate comment) and now forbids naming `MAX_DELIVERY_ATTEMPTS` as the
ceiling, forbids a name-list phrasing in the agents comment, and requires the
test-file paragraphs to claim only corrections that actually landed. Design
Notes' truth table was corrected on all three points.

**Known-bad state avoided.** The first attempt's acceptance criterion was a
grep for four fixed phrases — `acks and drops`, `4xx as terminal`,
`discarded rather than replayable`, `treats a 4xx`. The JSDoc header says
`ack + drop`, which matches none of them, so the criterion passed green with the
falsehood in place, and the two rewritten test paragraphs then asserted the
conflict was "resolved" and "both were corrected" — trading one wrong comment
for two. The AC is now claim-shaped, not phrase-shaped, and explicitly says why.

**KEEP — these worked and must survive re-derivation.**
1. The gate comment's structure: "THIS CHANGES QUEUE SEMANTICS … but it does NOT
   drop the message", the poison-set citation, "Queued work is replayable, not
   lost", the cost re-pointed at burned retries plus a final-attempt failure
   receipt to an email-origin submitter, and the closing drain/pause advice.
2. The scan route's insight that the door is not queue-delivered AT ALL — the
   consumer's `scheduled()` cron POSTs it — so consumer semantics are not merely
   misstated there, they are irrelevant. This went beyond the ledger and is the
   better correction.
3. The agents comment's "PARTIAL BY DESIGN" framing and its pointer to
   `DEPLOY.md` as the documented boundary rather than an oversight.
4. Rewriting both test-file forward references to past tense in the same pass,
   so landing the fix does not leave new false comments behind.
5. Comment-only discipline: no assertion, no status code, no runtime line moved.

### 2026-09-02 — Iteration 2 (AC scope correction, no code loopback)

**Triggering finding.** The verification-gap reviewer showed iteration 1's
amended AC1 was self-contradictory with AC5: AC1 demanded a repo-wide sweep of
every `4xx`/`poison` comment, which surfaces `src/lib/tasks.ts:326`, `:454` and
`prose-inventory-parity.test.ts:347`, while AC5 demands the diff touch exactly
the six Execution files. As written the change passed AC5 and failed AC1.

**What was amended.** AC1 is now scoped to the queue path this bundle owns, and
says explicitly that a comment misstating where a poison message GOES is a
different claim from which statuses are poison. That second defect is real and
is recorded in frontmatter `deferred` rather than silently absorbed.

**Known-bad state avoided.** Either shipping a spec with a knowingly-failing
acceptance criterion, or widening a comment-only bundle into three more files on
the authority of an over-broad AC I wrote myself rather than on the intent's.

**KEEP.** Everything in iteration 1's KEEP list still holds, plus: the JSDoc
status contract's explicit "discarded on the spot and never reaches the DLQ"
disposition clause — it is the anchor the deferred entry will cite.

## Review Triage Log

### 2026-09-02 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 9: (high 0, medium 2, low 7)
- addressed_findings:
  - `[medium]` `[patch]` Gate comment claimed the 403 is "retried exactly as the un-gated 500 would have been" — false for an ingest at `queueAttempt >= 3`, which `:957` answers with 422, a status the consumer ACKS AND DROPS. Corrected, and turned into the gate's strongest justification.
  - `[medium]` `[patch]` Both test-file paragraphs enumerated the corrected sites as a closed set and omitted `src/app/api/tasks/scan/route.ts`, which this same pass corrected — a reader auditing the fix would conclude that door was still wrong. Added to both.
  - `[low]` `[patch]` JSDoc "These three are the WHOLE set the consumer acks on" read as contradicting the `2xx → ack` line above it. Scoped to "WHOLE non-2xx set".
  - `[low]` `[patch]` The old JSDoc line's disposition clause was dropped in iteration 1; restored as "discarded on the spot and never reaches the DLQ", which is the contrast the retried-4xx line depends on.
  - `[low]` `[patch]` `route.ts:945` still said "poison (4xx)" where the branch returns 422 — the same loose equation the pass retires, in a file whose header now scopes it precisely. Now "poison (422)".
  - `[low]` `[patch]` Agents comment did not say the split is per REQUEST: a PUT carrying `addPages` alongside scalar edits refuses the whole request and loses those edits too. Clause added.

### 2026-09-02 — Review pass 1
- intent_gap: 0
- bad_spec: 4: (high 1, medium 3)
- patch: 1: (high 0, medium 0, low 1)
- defer: 0
- reject: 2: (high 0, medium 0, low 2)
- addressed_findings:
  - `[high]` `[bad_spec]` `src/app/api/tasks/run/route.ts:142-147` JSDoc status contract still asserts `4xx → ack + drop`, the same falsehood the bundle retires, in the block the corrected gate comment cites. Spec Code Map never adjudicated it. Amended Code Map + split Execution into two run-route entries; code reverted for re-derivation.
  - `[medium]` `[bad_spec]` The two rewritten test paragraphs claimed "both were corrected" / "now describe the retry" — false while `:144` stood. Execution now requires claiming only corrections that actually landed.
  - `[medium]` `[bad_spec]` Retry ceiling and DLQ parking misattributed to `MAX_DELIVERY_ATTEMPTS = 4`; `max_retries: 3` in `wrangler.jsonc` governs both, and the constant only gates the failure-receipt email. Code Map, Execution and Design Notes corrected.
  - `[medium]` `[bad_spec]` Agents comment named six fields as "every other edit"; `UpdateAgentOptions` has fifteen non-`addPages` fields including `enabled`, `allowedTools`, `approvalPolicy`. Execution now mandates "every field except `addPages`" phrasing.
  - `[low]` `[patch]` Scan comment said the cron "only `console.log`s the status"; it logs status plus 400 chars of body, so a log-matching monitor can catch the refusal sentence. Folded into the amended Execution entry.

## Design Notes

**The truth table the corrected comments must state.** Verified against the Code
Map anchors; this is reference for writing the prose, not new behaviour — every
row is how the code already works and how `DEPLOY.md` already documents it.

| Situation | What actually happens |
|---|---|
| `POST /api/tasks/run` 403s under `YOPEDIA_READONLY` | Consumer acks only on `400/404/422`, so the 403 takes the transient branch and `message.retry()`s — unconditionally. Redelivery and the DLQ hop are the QUEUE's job: `max_retries: 3` and `dead_letter_queue: "yopedia-tasks-dlq"` in `wrangler.jsonc`, i.e. four attempts total (1 delivery + 3 retries). `MAX_DELIVERY_ATTEMPTS = 4` gates ONLY the final failure-receipt email, not the retrying. Replayable, not lost; cost is burned retries plus one failure receipt to an email-origin submitter. |
| `POST /api/tasks/scan` 403s under `YOPEDIA_READONLY` | Not queue-delivered at all. The consumer's `scheduled()` cron POSTs it and logs status + the first 400 chars of body — no ack, no retry, no DLQ. Consumer poison-set semantics simply do not apply to this door; the refusal sentence does reach the log stream. |
| `PUT /api/agents/[id]` WITH `addPages`, read-only | `writeWikiPageWithSideEffects` → `assertWritable` throws before `registerAgent` runs, so nothing persists. Catch returns 403. |
| `PUT /api/agents/[id]` with ANY other field (all 15 of them) | Never reaches a kernel writer. `registerAgent` → bare `getStorage().writeFile`. Returns **200**; the profile is written — including `enabled`, `allowedTools` and `approvalPolicy`. `DEPLOY.md` records this as the flag's deliberate boundary. |

**Why no new tests.** The behaviour above is already pinned where it can be:
`task-consumer.test.ts` drives the 403-retries case (DW-647), `tasks-route.test.ts`
and `scan-route.test.ts` pin both route refusals (DW-646, DW-314). This bundle
corrects prose only, so it adds no assertion and changes no expectation — the
existing suites are the regression net, and they must stay green unchanged.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/scan-route.test.ts src/lib/__tests__/tasks-route.test.ts src/lib/__tests__/task-consumer.test.ts` -- expected: all pass, with the same case count as before (comment-only edits cannot change results)
- `pnpm exec tsc --noEmit` -- expected: no new errors
- `pnpm exec eslint src/app/api/tasks/run/route.ts src/app/api/tasks/scan/route.ts src/app/api/agents/[id]/route.ts src/lib/__tests__/scan-route.test.ts src/lib/__tests__/tasks-route.test.ts src/lib/__tests__/task-consumer.test.ts` -- expected: clean
- `git diff -U0 -- src workers | grep -E '^[+-]' | grep -v -E '^(\+\+\+|---)' | grep -vE '^[+-]\s*(//|\*|/\*)'` -- expected: no output, proving every changed line is a comment line
- `grep -rn -i -e 'acks and drops' -e 'ack + drop' -e '4xx' -e 'poison' -e 'terminal' -e 'discarded' -e 'replayable' src/ workers/` -- expected: every hit read by hand; each either scopes itself to `400/404/422` or states that other 4xx are retried. No hit asserts blanket 4xx terminality.

## Auto Run Result

Status: done
DW entries resolved: DW-645, DW-649

### Implemented change

Comment-only corrections to seven blocks across six files. No production logic,
no test assertion, no status code, no `DEPLOY.md` prose. Two falsehoods retired:
that the task consumer treats any 4xx as terminal (it acks only on
`400/404/422`; a read-only 403 is retried, then parked in the DLQ), and that
`updateAgent` always writes through the kernel before persisting (only the
`addPages` arm does).

### Files changed

- `src/app/api/tasks/run/route.ts` — JSDoc status contract: the blanket `4xx → ack + drop` line split into the real poison set (`400/404/422`, discarded on the spot, never reaching the DLQ) and every other 4xx (transient, retried, then parked). Read-only gate comment: says the 403 is NOT dropped, attributes redelivery and parking to `max_retries: 3` in `wrangler.jsonc` rather than to `MAX_DELIVERY_ATTEMPTS` (which gates only the failure-receipt email), and names the ingest-at-attempt-3+ 422 case the gate actually saves. `:945` loose "poison (4xx)" tightened to "poison (422)".
- `src/app/api/tasks/scan/route.ts` — stops borrowing consumer ack/retry semantics: this door is never queue-delivered; the consumer's `scheduled()` cron POSTs it and logs status plus 400 chars of body, so a monitor can match either the status or the refusal sentence.
- `src/app/api/agents/[id]/route.ts` — the read-only coverage is partial by design: only the `addPages` arm reaches a kernel writer; every other field of `UpdateAgentOptions` (fifteen, including `enabled`, `allowedTools`, `approvalPolicy`) returns 200 while read-only. Split is per request, not per field.
- `src/lib/__tests__/scan-route.test.ts` — `?dry=1` rationale now states the refusal decision the case actually pins.
- `src/lib/__tests__/task-consumer.test.ts`, `src/lib/__tests__/tasks-route.test.ts` — the two "correcting those comments is DW-645, tracked separately" forward references rewritten to past tense, listing all four corrected sites, so landing the fix left no new false comment behind.

### Review findings breakdown

Two review passes, four layers each (blind-hunter, edge-case-hunter,
verification-gap, intent-alignment).

- Pass 1: 4 bad_spec (1 high, 3 medium), 1 patch (low), 0 defer, 2 reject. All four layers independently found the same high finding — the route's own JSDoc header still said `4xx → ack + drop`, the same falsehood, in the same file, in the block the corrected gate comment cites. Root cause was the spec's Code Map never adjudicating that block, and an acceptance criterion written as a fixed-phrase grep that `ack + drop` did not match. Spec amended, code reverted and re-derived.
- Pass 2: 0 bad_spec, 5 patch (2 medium, 3 low), 1 defer (low), 9 reject. Patches applied to the re-derived code and re-verified.
- Deferred (1): three comments in `src/lib/tasks.ts` and `prose-inventory-parity.test.ts` say a poison task goes to the DLQ; poison messages are acked and dropped and never reach it. A different claim from DW-645 and outside the queue path this bundle owns — recorded in frontmatter `deferred`, not fixed here.

Follow-up review recommended: **false** — this pass's patched findings peak at
medium (2 medium, 3 low); no high-severity patch.

### Verification

- `pnpm vitest run` over the three named suites: 3 files, 96 tests, all pass — same count as baseline, as a comment-only change requires.
- Broader sweep (adding `read-only-copy-parity`, `read-only-door-coverage`, `read-only-kernel-gate`, `prose-inventory-parity`): 7 files, 168 tests, all pass.
- `pnpm exec tsc --noEmit`: clean.
- `pnpm exec eslint` on all six files: clean.
- Comment-only proof (`git diff -U0 -- src workers` filtered to non-comment lines): empty output — no executable line added, removed or reordered.
- `git diff --stat`: exactly the six Execution files. `workers/task-consumer/index.ts`, `workers/task-consumer/wrangler.jsonc`, `src/lib/agents.ts` and `DEPLOY.md` untouched, as the Never clause requires.
- Every added factual claim re-checked against its anchor: ack set `400 || 404 || 422` (`index.ts:114`), unconditional `message.retry()` (`:139`), `MAX_DELIVERY_ATTEMPTS = 4` only in the failure-receipt guards (`:88`, `:130`), `max_retries: 3` + `yopedia-tasks-dlq` (`wrangler.jsonc`), `scheduled()` logging status + `body.slice(0, 400)` (`:243-264`), `ingestRetriesExhausted` → 422 (`route.ts:878-879`, `:957`), the `addPages` guard (`agents.ts:773`) with unconditional `registerAgent` (`:853`) reaching a bare `getStorage().writeFile` (`:508`), and 16 `UpdateAgentOptions` fields (`:591-627`).
- Agreement with `DEPLOY.md:574-580` and `:604-616` confirmed rather than assumed.

### Residual risks

- **Nothing pins DW-649's claim.** No test drives `PUT /api/agents/[id]` under `YOPEDIA_READONLY` in either arm. The comment now asserts a 200 on a read-only deployment as intentional, resting entirely on a code read; adding `assertWritable` to `registerAgent` would falsify it with the suite green. Not filed as deferred work — it is a test-coverage gap adjacent to what this bundle fixed, not a door an owner can walk through wrongly. The queue half has its tripwire (`task-consumer.test.ts`'s 403-retry case); the agents half has none.
- The scan door's "never queue-delivered" claim and the DLQ parking claim are likewise unpinnable from vitest — the first has no test driving `scheduled()`, the second is Cloudflare-side configuration.
- `MAX_DELIVERY_ATTEMPTS = 4` and `max_retries: 3` must stay in step for "four attempts total" to hold. The comment says the constant is not the ceiling, but does not warn about the coupling; changing `max_retries` alone would move when the failure receipt fires.
