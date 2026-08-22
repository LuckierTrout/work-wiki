---
title: 'Email ingest: duplicate-path accounting and unobserved Worker branches'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The Worker reads its KV config outside any try/catch, so a binding or KV
      failure throws out of `email()` with no reply and no reject -- the sender
      gets silence.
    evidence: |-
      `workers/email-ingest/index.ts:224` calls
      `await env.YOPEDIA_CONFIG.get(CONFIG_KEY, "json")` as the handler's first
      statement, ahead of every `reply(...)` and `setReject(...)` path. Every
      other failure mode in the handler answers the sender; this one cannot,
      because nothing has been established yet to answer with. Pre-existing and
      untouched by this change.
    location: >-
      workers/email-ingest/index.ts:224
    severity: medium
  - summary: >-
      The Worker's two attachment-filename fallbacks diverge, so a nameless
      attachment inflates the route's locally derived skipped floor by one
      though nothing was skipped.
    evidence: |-
      `workers/email-ingest/index.ts` records names as
      `attachment.filename || "unnamed attachment"` but forwards the file part
      as `attachment.filename || `attachment-${index + 1}``. The route unions
      and deduplicates the two lists, so one nameless PDF yields two names and
      one file: `localSkipped` is 1 while the Worker honestly forwarded a
      `skippedAttachmentCount` of 0, and the floor wins. Pre-existing; the
      accounting expression this change hoisted is unmodified.
    location: >-
      workers/email-ingest/index.ts:317
    severity: medium
  - summary: >-
      A missing site URL answers the sender "Please try again in a few minutes",
      advice that can never work for a permanent misconfiguration.
    evidence: |-
      `workers/email-ingest/index.ts:326` throws inside the forwarding `try`
      rather than returning early beside the service-token check, so it inherits
      the transient-failure copy at :371. The token branch already demonstrates
      the better shape with its own explicit message. Now pinned as-is by
      `email-ingest-worker.test.ts`, so correcting the asymmetry later will read
      as a test regression unless done deliberately.
    location: >-
      workers/email-ingest/index.ts:326
    severity: low
  - summary: >-
      The raw-size refusal never says the body contributed, so a sender who
      shrinks only the attachment bounces again.
    evidence: |-
      The reply quotes one figure ("larger than 13.7 MB") against
      `message.rawSize`, but the bounce this bundle pins is caused by the
      document and the body together -- exactly the case where shrinking the
      obvious culprit does not help. DW-361 records the trade-off as accepted;
      the sender-facing copy was left out of that acceptance. Out of scope here:
      the intent was to prove the trade-off without moving any cap.
    location: >-
      workers/email-ingest/index.ts:248
    severity: low
baseline_revision: 'd62be20e1722d1fbc5284cb7f5e91d54598993b7'
---

<intent-contract>

## Intent

**Problem:** Three gaps on the email path (DW-357, DW-361, DW-364). The route's duplicate-Message-ID early return reports `supportedAttachmentCount` with no `skippedAttachmentCount` beside it, so a resend of an already-seen message answers with half the accounting contract the success path returns. The Worker's two misconfiguration early returns — missing `YOPEDIA_SERVICE_TOKEN` and missing `YOPEDIA_SITE_URL` — produce sender-visible replies that no test observes, so deleting either (and forwarding an unauthenticated request, or one to a relative URL) fails nothing. And the deliberate trade-off recorded in `MIME_ENVELOPE_HEADROOM_BYTES`' comment — that a full-size document plus a maximal body cannot both fit under the raw cap — is only a comment, enforced by nothing.

**Approach:** Hoist the existing `skippedAttachmentCount` computation above the duplicate branch and return it there too, then assert it in the duplicate test. Add one Worker test per missing binding asserting the sender-visible reply and that no forward happens. Add one Worker test pinning the documented cap interaction: a message sized as a full-size encoded document plus a maximal body bounces by design.

## Boundaries & Constraints

**Always:** Keep the derived-cap arithmetic exactly as it stands — the tests observe the caps, they do not move them. Compute the hoisted count from the same inputs it uses today (`attachmentNames`, `payload.attachments`, `attachments`, `payload.skippedAttachmentCount`) so the duplicate and success paths cannot report different figures for the same message. New tests assert the outermost surface: the JSON response body for the route, and `message.reply` text plus `env.YOPEDIA.fetch` call count for the Worker. Derive expected sizes from the exported constants and `base64PartWireSize`, never from hand-typed byte literals.

**Block If:** Pinning the cap interaction would require changing `MIME_ENVELOPE_HEADROOM_BYTES`, `MAX_RAW_EMAIL_BYTES`, or `MAX_EMAIL_CONTENT_CHARS` to make a test pass — that is a cap move, not a pin, and is out of scope for this bundle.

**Never:** Do not change any cap value or the raw-size gate's comparison. Do not alter what the duplicate branch already returns (`accepted`, `duplicate`, `jobId`, `status`, `slug`) or the success-path response shape. Do not add new Worker behavior — the misconfiguration branches are pinned as they are, not rewritten. Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Duplicate resend with a forwarded skip count | Multipart POST whose `messageId` already has an ingest job; 1 staged file, 1 unforwarded name, `skippedAttachmentCount: "3"` | 200 with `duplicate: true`, `supportedAttachmentCount: 1`, `skippedAttachmentCount: 4` (Worker's 3 + the route's own drop), and `enqueueOrInline` never called | No error expected |
| Duplicate resend with no forwarded count | JSON POST whose `messageId` already has a job; `attachmentNames: ["deck.pptx"]`, no files | 200 with `duplicate: true`, `supportedAttachmentCount: 0`, `skippedAttachmentCount: 1` (the local floor) | No error expected |
| Worker missing service token | Valid allowed-sender email, `YOPEDIA_SERVICE_TOKEN` absent | Reply says work-wiki could not queue the email because the ingest service is not configured; `env.YOPEDIA.fetch` not called | Branch is the error handling |
| Worker missing site URL | Valid allowed-sender email, `YOPEDIA_SITE_URL` absent | Reply says work-wiki could not queue this email and to try again in a few minutes; `env.YOPEDIA.fetch` not called | Throw caught by the surrounding try/catch |
| Full-size document plus a maximal body | `rawSize` = `base64PartWireSize(MAX_EMAIL_DOCUMENT_BYTES) + MAX_EMAIL_CONTENT_CHARS` | Exceeds `MAX_RAW_EMAIL_BYTES`; Worker replies "larger than <cap> MB" and does not forward | Bounce is the designed outcome |

</intent-contract>

## Code Map

- `src/app/api/email/ingest/route.ts` -- the duplicate early return is at :221-230 (`const existing = await getIngestJob(jobId)`), returning `supportedAttachmentCount` only. The `localSkipped` / `skippedAttachmentCount` computation lives at :276-289, *after* attachment staging and job creation; it depends only on `attachmentNames`, `payload.attachments`, `attachments` and `payload.skippedAttachmentCount`, all settled by :137. Hoist that block (comment included) to just above `const jobId = await emailJobId(messageId)` at :220 and spread the value into the duplicate response.
- `workers/email-ingest/index.ts` -- `MIME_ENVELOPE_HEADROOM_BYTES` :62 and its recorded trade-off; `MAX_RAW_EMAIL_BYTES` :78-80; `MAX_EMAIL_CONTENT_CHARS` :94; raw-size gate :246-254; missing-service-token early return :255-264; `YOPEDIA_SITE_URL` throw :325-326 inside the try whose catch at :366-374 replies "could not queue this email. Please try again in a few minutes."
- `src/lib/__tests__/email-ingest-route.test.ts` -- `multipartRequest()` :73-105 already supports `unforwardedNames` and `skippedAttachmentCount`; `mockedGetJob.mockResolvedValueOnce(...)` is the duplicate hook; the existing duplicate test is "returns an existing Message-ID job without re-enqueueing" :215-234. Extend it and add the counterpart case next to it.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- `message()` :107-119 and `env()` :121-133 are the fixture builders; `env()` supplies both bindings, which is why neither misconfiguration branch is reachable today. `describe("email-ingest raw message cap")` :584-696 is where the cap tests live and already imports `MAX_EMAIL_DOCUMENT_BYTES`, `MAX_RAW_EMAIL_BYTES` and `base64PartWireSize`. `MAX_EMAIL_CONTENT_CHARS` is exported by the Worker but not yet imported here.
- `src/lib/__tests__/email-ingest-wire.ts` -- `base64PartWireSize(byteLength)`, the shared RFC 2045 wire-size formula, already calibrated against a real fixture by the worker suite.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- read-only reference: :155-171 already pins `MAX_RAW_EMAIL_BYTES` against its derivation and asserts a full-size document alone fits. The new test is the complement (document *plus* body does not) and belongs in the worker suite, at the behavioral surface. Do not duplicate the derivation assertion.

## Tasks & Acceptance

**Execution:**
- `src/app/api/email/ingest/route.ts` -- move the `localSkipped` / `skippedAttachmentCount` block and its explanatory comment above the `getIngestJob` duplicate check, and add `skippedAttachmentCount` to the duplicate response body -- so a resend reports the same accounting pair as a first delivery.
- `src/lib/__tests__/email-ingest-route.test.ts` -- assert `supportedAttachmentCount` and `skippedAttachmentCount` on the duplicate path in both matrix duplicate rows -- the existing duplicate test asserts neither, so the omission shipped green.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- add a `describe` covering the two misconfiguration early returns (one test per missing binding: reply text and no forward), and add a raw-cap test for the document-plus-maximal-body bounce -- each branch is currently deletable without failing anything, and the cap trade-off is currently only a comment.

**Acceptance Criteria:**
- Given an inbound message whose `Message-ID` already has an ingest job, when the route answers on the duplicate path, then the response carries `skippedAttachmentCount` computed identically to the success path alongside `supportedAttachmentCount`, and no job is enqueued.
- Given the duplicate-path `skippedAttachmentCount` line is deleted or its value replaced with a constant, when the suite runs, then the route tests fail.
- Given either Worker misconfiguration early return is deleted, when the suite runs, then the worker tests fail because a forward happened and the configured reply did not.
- Given `MIME_ENVELOPE_HEADROOM_BYTES` were raised until a full-size document and a maximal body fit together, when the suite runs, then the new cap test fails — the recorded trade-off is enforced rather than merely commented.

## Design Notes

The hoist is a move, not a rewrite: every input the computation reads is already final at `payload` parse time, and nothing between the current site and the new one mutates them. Keep the comment with the code it explains.

The site-URL test asserts the *catch* reply, not a bespoke message — the throw at :325 is deliberately caught by the surrounding try/catch, and pinning the generic "could not queue this email" text is what proves that routing.

For the cap test, derive the fixture size from the exported terms so it tracks the constants:

```ts
const rawSize = base64PartWireSize(MAX_EMAIL_DOCUMENT_BYTES) + MAX_EMAIL_CONTENT_CHARS;
expect(rawSize).toBeGreaterThan(MAX_RAW_EMAIL_BYTES); // the recorded trade-off, stated
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- expected: all pass, including the new cases
- `pnpm lint` -- expected: no new errors or warnings

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** The route's attachment-loss accounting was hoisted above the duplicate-Message-ID early return and added to that response, so a resend of an already-seen message now reports the same `supportedAttachmentCount` / `skippedAttachmentCount` pair a first delivery does instead of half of it (DW-357). The computation itself is unchanged — every input it reads is settled at payload-parse time. No cap value, gate comparison, or Worker production line was touched: DW-361 and DW-364 are closed with tests only.

**Files changed.**
- `src/app/api/email/ingest/route.ts` — accounting block moved above the duplicate check; `skippedAttachmentCount` added to the duplicate response; comments record the DW-357 trail, why the hoist is safe, and that the counts deliberately describe the current request rather than the acknowledged job.
- `src/lib/__tests__/email-ingest-route.test.ts` — both duplicate tests now assert the accounting pair and that nothing was staged or recorded; a new test posts one identical payload down both paths and compares the responses to each other, pinning the same-figure invariant rather than two hand-computed numbers.
- `src/lib/__tests__/email-ingest-worker.test.ts` — a `misconfigured bindings` describe with one test per missing binding (reply text, no forward, and for the site URL the guard's own diagnostic); a raw-cap test proving a full-size document plus a maximal body exceeds the cap and bounces; header inventory updated.

**Review findings breakdown.** 7 patched (3 medium, 4 low), 4 deferred (2 medium, 2 low), 9 rejected. No intent gaps and no spec defects; the review loop ran once with no loopback.

Follow-up review recommended: **true** — patched this pass: high 0, medium 3, low 4; score `3×3 + 1×4 = 13`, at or above the threshold of 5.

**Verification.**
- `npx vitest run` on the three affected suites — 55 passed (route 21, worker 21, parity 13).
- Full suite — 274 files / 6191 tests passed.
- `npx eslint` — exit 0, no new findings (three pre-existing `jsx-ast-utils` notices).
- Mutation checks, run directly and with the source restored afterward: deleting the site-URL guard fails exactly the site-URL test (it failed nothing before the review patch); deleting the service-token early return fails its test; deleting the duplicate-path `skippedAttachmentCount` fails 3 route tests; diverging either path's expression alone fails the invariant test; raising `MIME_ENVELOPE_HEADROOM_BYTES` fails the new cap test and nothing else.

**Residual risks.**
- The spec's Design Note ("pinning the generic 'could not queue this email' text is what proves that routing") was not sufficient on its own — the generic reply is produced by any throw inside that `try`. The test now asserts the logged diagnostic as well. The note is left as written; this record supersedes it.
- The new cap test's `rawSize > MAX_RAW_EMAIL_BYTES` assertion is expected to fail when DW-358 or DW-362 is implemented. That is recorded in the test's own comment; a future implementer should re-derive the expectation there rather than read the failure as a regression guard.
- The route's `skippedAttachmentCount` has no in-repo consumer — the Worker builds its sender-facing acknowledgement from its own counts. What this restores is response-contract symmetry for direct API callers, not a different email. Pre-existing shape, not introduced here.
