---
title: 'Email ingest route contract gaps and unpinned Worker replies (DW-253, DW-357, DW-363, DW-364, DW-366, DW-367)'
type: 'bugfix'
created: '2026-08-26'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The Worker computes the trimmed site URL twice, so the two copies can still drift;
      hoisting one const would remove the drift class the new link tests guard against.
    evidence: |-
      `(env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "")` appears at workers/email-ingest/index.ts:752
      (forwarded request) and again at :813 (acknowledgement links). DW-363 exists only because the
      second copy was unpinned. Both are now pinned, but a single `const site` hoisted above the
      `try` -- keeping `if (!site) throw` inside it -- would make drift structurally impossible.
      Pre-existing duplication; this change pinned it rather than removing it.
    location: >-
      workers/email-ingest/index.ts:752
    severity: low
  - summary: >-
      The Worker's `!response.ok` exit replies with the route's error alone, discarding every
      loss sentence, so a route refusal hides which attachments were dropped.
    evidence: |-
      `if (!response.ok) { await reply(message, subject, safeError(result)); return; }` at
      workers/email-ingest/index.ts:808 drops `oversizedLine`, `overBudgetLine` and the over-cap
      and unsupported sentences. Pre-existing shape -- this change adds a fourth sentence to the
      set that exit already discarded.
    location: >-
      workers/email-ingest/index.ts:808
    severity: low
  - summary: >-
      Nothing asserts that the Worker's body truncation lands exactly on MAX_EMAIL_CONTENT_CHARS,
      so an off-by-one there would 400 every long email with the route's new gate test green.
    evidence: |-
      `rawContent.slice(0, MAX_EMAIL_CONTENT_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER`
      at workers/email-ingest/index.ts:739 is untouched by this change and unobserved. DW-366 now
      pins the route's `content.length > MAX_EMAIL_CONTENT_CHARS` 400, which makes the pairing
      load-bearing: the Worker must truncate to a length the route accepts.
    location: >-
      workers/email-ingest/index.ts:739
    severity: low
  - summary: >-
      The Worker's forwarded `attachmentNames` uses a bare `|| "unnamed attachment"` with no trim,
      so a whitespace-named part is called "unnamed attachment" in the reply but forwarded as
      whitespace, which the route then drops entirely.
    evidence: |-
      workers/email-ingest/index.ts:747 builds the recorded names with `attachment.filename ||
      "unnamed attachment"`, while `replyAttachmentName` (:429) scrubs and trims before falling
      back. `sanitizeAttachmentNames` in src/lib/email-ingest.ts then drops the whitespace name,
      so the recorded list and the sender's reply disagree about the same part. Pre-existing;
      routing that build through `replyAttachmentName` would settle it.
    location: >-
      workers/email-ingest/index.ts:747
    severity: low
baseline_revision: 'cc5756ca2d22bcd8594987f416e0ab7483ec93aa'
---

<intent-contract>

## Intent

**Problem:** `/api/email/ingest` 400s a whole email — body and every other attachment — on the first attachment over `MAX_DOCUMENT_SIZE`, and its duplicate-Message-ID early return omits `skippedAttachmentCount` while the success path returns it; the Worker forwards oversized parts it should never send. Five sender-visible or caller-visible surfaces are pinned by nothing: the two route 400 copies (`MAX_EMAIL_CONTENT_CHARS`, "no text body or supported document attachment"), both Worker misconfiguration early-returns, and the second site-URL trim that builds the acknowledgement links.

**Approach:** Make oversize a per-file loss in the route (skip the file, name it back, fold it into `skippedAttachmentCount`) and add the matching per-document byte pre-filter in the Worker so an oversized part is never forwarded; hoist the route's loss accounting above the duplicate check so both exits report the same pair; then add the missing tests that observe each unpinned refusal, reply, and link. Commits `d99bb49e` (DW-253) and `c1e60ebc` (DW-357/DW-364) already shipped most of this before `f2458e18` reverted it — recover from those diffs and adapt to today's Worker, which has since gained the DW-359 inline-part accounting and the DW-360 aggregate byte budget.

## Boundaries & Constraints

**Always:** Quote ceilings from the exported constants, never hand-typed numbers; scrub attacker-controlled filenames before they reach an outbound reply; keep the route's `oversizedAttachmentNames` field omitted when empty, so its presence alone means a file was dropped for size; keep the route's and Worker's duplicated ceilings in sync (`email-ingest-allowlist-parity.test.ts` enforces it).

**Block If:** the recovered behaviour cannot be reconciled with today's aggregate byte budget without changing which losses `skippedAttachmentCount` counts.

**Never:** change `MAX_DOCUMENT_SIZE`, `MAX_EMAIL_DOCUMENTS`, `MAX_EMAIL_CONTENT_CHARS`, `MAX_RAW_EMAIL_BYTES` or the aggregate budget; never edit the deferred-work ledger; never rename frozen `YOPEDIA_*` identifiers; never widen inline-part handling (DW-359) or re-derive the raw cap (DW-358/DW-362).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Oversized among good | Route: body + one file over `MAX_DOCUMENT_SIZE` + one under | 200; only the small file staged (key `1-<name>`); `supportedAttachmentCount: 1`, `skippedAttachmentCount: 1`, `oversizedAttachmentNames: ["big.pdf"]`; both names in job metadata | No error expected |
| Oversized only, no body | Route: single over-ceiling PDF, no content | 400 naming the file and `larger than 10 MB`, with `oversizedAttachmentNames`; lead sentence drops the "or supported document attachment" clause; nothing staged/created/enqueued | 400, no irreversible work |
| Oversized + unsupported, no body | Route: over-ceiling PDF + `.exe`, no content | 400 carrying BOTH sentences — the allowlist one and the oversize one | 400 |
| Oversized past the cap | Route: `MAX_EMAIL_DOCUMENTS` CSVs + one over-ceiling PDF | 200, not a cap refusal: the oversize partition runs before the cap comparison | No error expected |
| Blank oversized name | Route: two over-ceiling files whose names scrub to nothing | `oversizedAttachmentNames: ["unnamed attachment","unnamed attachment"]` and the plural verb | 400 |
| Duplicate Message-ID | Route: resend of a recorded message with attachments | 200 `duplicate: true` carrying the SAME `supportedAttachmentCount` / `skippedAttachmentCount` / `oversizedAttachmentNames` the first delivery reported; nothing staged, created or enqueued | No error expected |
| Over-long body | Route: content above `MAX_EMAIL_CONTENT_CHARS` | 400 `Email body exceeds 100,000 characters` verbatim; a body exactly at the cap is accepted | 400, no irreversible work |
| Attachment-only unsupported | Route: single `.exe`, no content | 400 `The email has no text body or supported document attachment to ingest` verbatim | 400 |
| Worker oversized part | Worker: over-ceiling supported part + small supported part + body | Oversized part never appended to the form; its name still recorded; counted in `skippedAttachmentCount`; the acknowledgement names it with its own sentence, and does not call it over-cap or unsupported | No error expected |
| Worker misconfigured | Worker: `YOPEDIA_SERVICE_TOKEN` absent / `YOPEDIA_SITE_URL` absent | No forward; sender gets "…the ingest service is not configured." / the generic retry reply plus a `YOPEDIA_SITE_URL is missing` diagnostic | Reply, not throw |
| Trailing-slash site | Worker: `YOPEDIA_SITE_URL` ending in `///`, response with and without a slug | Reply links read `https://host/u/yopedia/<slug>` and `https://host/ingest` — never `///` | No error expected |

</intent-contract>

## Code Map

- `src/app/api/email/ingest/route.ts` -- the door. `:205` no-body/no-supported 400 (DW-367); `:209-214` `MAX_EMAIL_CONTENT_CHARS` 400 (DW-366); `:216-227` cap 400 then the oversize 400 to be REPLACED by a partition (DW-253); `:280-288` duplicate early return missing the count (DW-357); `:420-430` `localSkipped`/`skippedAttachmentCount` block to be HOISTED above the duplicate check; `:469-470` success-path response fields.
- `workers/email-ingest/index.ts` -- `MAX_EMAIL_DOCUMENT_BYTES` (`:46`, needs a sibling `MAX_EMAIL_DOCUMENT_MB`); `replyAttachmentName` (`:410`) and `decodedByteLength` (`:381`) both already exist and are exactly what the pre-filter needs; `:257-266` missing-token early return; `:669-670` site trim + `YOPEDIA_SITE_URL is missing` throw; the selection loop `:580-601` (cap + aggregate budget) that the per-document filter must run BEFORE; `:730` the second trim feeding the reply links (DW-363); reply line arrays at `:625-650` (no-body exit) and `:733-756`.
- `src/lib/__tests__/email-ingest-route.test.ts` -- helpers `request()` (JSON), `multipartRequest()`, `mixedAttachmentRequest()`, `FIRST_BYTES`/`SECOND_BYTES` (`:262-279`) all in scope inside the single top-level describe. `:226` duplicate test to extend; `:583` `supported-document cap` describe; `:656` unsupported-only test to pin verbatim.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- helpers `message()`, `env()`, `multipartEmail()` (already supports `disposition` and `bytes`), `partBytes()`, `forwardedForm()`; `forwardedRequest(siteUrl)` local to the `forwarded transport` describe (`:289`) currently discards `msg.reply`.
- Read-only evidence: `git show d99bb49e` and `git show c1e60ebc` carry the reverted implementations and tests nearly verbatim — reuse their comments and assertions rather than re-deriving. `f2458e18` is the revert. `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` pins the duplicated ceilings; do not break it.

## Tasks & Acceptance

**Execution:**
- `src/app/api/email/ingest/route.ts` -- recover `d99bb49e`'s oversize partition: split `payload.attachments` into supported / oversized / within-ceiling, build `oversizedAttachmentNames` with an `"unnamed attachment"` fallback, delete the `oversized` 400, and join the oversize sentence onto the no-body 400 -- oversize must cost one file, not the whole email.
- `src/app/api/email/ingest/route.ts` -- recover `c1e60ebc`'s hoist: move the `localSkipped` / `skippedAttachmentCount` computation above `emailJobId`, and add `skippedAttachmentCount` plus the conditional `oversizedAttachmentNames` to the duplicate early return -- both exits owe the same accounting.
- `workers/email-ingest/index.ts` -- add `MAX_EMAIL_DOCUMENT_MB` and partition eligible parts on `decodedByteLength(...) > MAX_EMAIL_DOCUMENT_BYTES` BEFORE the cap/aggregate selection loop; add `oversizedCount` to `skippedAttachmentCount`, build an `oversizedLine` with `replyAttachmentName` (capped at `MAX_EMAIL_ATTACHMENT_NAMES_RECORDED` with a counted tail, as `overBudgetLine` is), and emit it from both the no-body exit and the acknowledgement -- an oversized part must never reach the route, and the sender must be told which one.
- `src/lib/__tests__/email-ingest-route.test.ts` -- recover `d99bb49e`'s `oversized attachments` describe and the all-unsupported-with-body case, `c1e60ebc`'s two duplicate-path cases (extended to compare `oversizedAttachmentNames` across both exits), and add DW-366's over-cap/at-cap body pair and DW-367's verbatim-copy assertion -- every I/O row above needs an observer.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- recover `d99bb49e`'s oversized-attachment describe (adapted to today's inline/aggregate accounting) and `c1e60ebc`'s `misconfigured bindings` describe; widen `forwardedRequest` to also expose the reply so a trailing-slash site pins the `Page:` and `Track it under Recent ingests:` links -- deleting either trim or either guard must fail.

**Acceptance Criteria:**
- Given the route's oversize partition, when the `attachments.length > MAX_EMAIL_DOCUMENTS` comparison runs, then oversized files have already been removed, so they cannot turn a legal message into a cap refusal.
- Given any response the route returns with `accepted: true`, when the same message is resent and answered on the duplicate path, then `supportedAttachmentCount`, `skippedAttachmentCount` and `oversizedAttachmentNames` are identical on both responses.
- Given the Worker's per-document pre-filter, when a supported part exceeds `MAX_EMAIL_DOCUMENT_BYTES`, then it consumes neither a `MAX_EMAIL_ATTACHMENTS` slot nor any of the aggregate byte budget, and the over-cap and over-budget sentences stay silent about it.
- Given each of the three route refusals and the two Worker misconfiguration replies, when its copy is reworded or its guard deleted, then at least one test fails naming that surface.

## Spec Change Log

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 2, low 6)
- defer: 4: (high 0, medium 0, low 4)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[medium]` `[patch]` A blank-named oversized file was named in `oversizedAttachmentNames` but not counted, because `localSkipped` came only from the sanitized name list — the response contradicted itself. Floored `localSkipped` on the route's own drop count as well, and pinned the accepting path.
  - `[medium]` `[patch]` The per-document ceiling was expressed as two independent complementary predicates with no fixture at exactly `MAX_DOCUMENT_SIZE`; shifting both, or only one, left the suite green. Collapsed to a single-pass partition and added an exact-ceiling case.
  - `[low]` `[patch]` `oversizedCount` came from the 20-truncated name list, so 21+ oversized files under-reported the loss and mis-derived the verb. Count and verb now come from the true total, with a `, and N others` tail matching `replyLossNames`.
  - `[low]` `[patch]` `countable(oversizedAttachments)` and `replyLossNames`' inline filter were unobserved for the oversize path. Added inline-oversized cases to the mocked-parser normalization suite.
  - `[low]` `[patch]` Dropping an oversized attachment was silent server-side where the old 400 was loud. Added a `logger.warn` naming the dropped files and the ceiling.
  - `[low]` `[patch]` The missing-service-token case silenced `console.error` without asserting it, so the diagnostic was deletable. Asserted it, symmetric with the site-URL case.
  - `[low]` `[patch]` `workers/email-ingest/README.md` described two losses; there are four, and the per-document ceiling was stated nowhere. Updated.
  - `[low]` `[patch]` The new oversize fixture shared the subject and slug "Every loss at once" with the aggregate-budget fixture. Renamed to "Too big and too many".

## Design Notes

The two Worker byte bounds answer different questions and must not be merged: `MAX_EMAIL_DOCUMENT_BYTES` is a per-FILE ceiling mirroring the route's `MAX_DOCUMENT_SIZE`, while `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` (DW-360) bounds what the forwarding loop copies in total. Run the per-file partition first, over `eligibleAttachments`, so an oversized part is never charged against the aggregate budget or a cap slot — then feed only the within-ceiling parts to the existing selection loop. Reuse the sizes already computed by `decodedByteLength` rather than decoding twice.

`skippedAttachmentCount` gains a third disjoint term. Keep the existing `countable(...)` treatment so an inline signature logo that happens to be oversized is still excluded from every reported loss (DW-359).

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest.test.ts` -- expected: all pass.
- `pnpm lint` -- expected: no new errors.
- `pnpm vitest run` -- expected: no regressions elsewhere (notably `brand-copy.test.ts`).

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Oversize is now a per-FILE loss on both sides of the email door. `/api/email/ingest` partitions supported attachments on `MAX_DOCUMENT_SIZE` instead of 400ing the whole message, names the dropped files back to the caller in `oversizedAttachmentNames`, and folds them into `skippedAttachmentCount`; the Worker filters the same ceiling before its cap/aggregate selection loop, so an oversized part is never forwarded and never consumes a slot or a byte of the budget. The route's loss accounting is hoisted above the duplicate-Message-ID check, so a resend reports the same counts a first delivery does. Five previously unobserved surfaces are now pinned: the `MAX_EMAIL_CONTENT_CHARS` 400, the "no text body or supported document attachment" 400 (verbatim), both Worker misconfiguration early-returns, and the second site-URL trim that builds the sender-visible acknowledgement links.

### Files changed

- `src/app/api/email/ingest/route.ts` — oversize partition replaces the oversize 400; `oversizedAttachmentNames` on all three exits; loss accounting hoisted above the duplicate check; `logger.warn` on drop.
- `workers/email-ingest/index.ts` — `MAX_EMAIL_DOCUMENT_MB`, sizes measured once, per-document ceiling partition ahead of the selection loop, four disjoint loss terms, shared `replyLossNames`, `oversizedLine` on both exits.
- `src/lib/__tests__/email-ingest-route.test.ts` — oversize suite, exact-ceiling and blank-name cases, duplicate-path accounting, body-length ceiling pair, verbatim no-body copy.
- `src/lib/__tests__/email-ingest-worker.test.ts` — oversize suite, all-unsupported-with-body, misconfiguration replies, trimmed-site link cases.
- `src/lib/__tests__/email-ingest-worker-normalization.test.ts` — inline-oversized exclusion via the mocked parser.
- `workers/email-ingest/README.md` — four losses and the per-document ceiling.

### Review findings

Patches applied: 8 (medium 2, low 6). Deferred: 4 (all low, recorded in frontmatter `deferred`). Rejected: 9 — chiefly the documented-unreachable `overBudgetLine` at the Worker's no-body exit, the `oversizedLine` wording (recovered verbatim from `d99bb49e` per the intent), and an unbounded-oversized-files concern whose buffering is unchanged by this diff.

Follow-up review recommended: **true** — patched counts high 0, medium 2, low 6; score `3 × 2 + 1 × 6 = 12` (threshold 5).

### Verification

- `pnpm vitest run` on the five email-ingest suites — 117 passed.
- `pnpm lint` — clean (only the pre-existing `jsx-ast-utils` notices).
- `pnpm vitest run` (full) — 325 files, 7403 passed / 1 skipped (pre-existing skip).
- `npx tsc --noEmit` — clean.
- Matrix audit: every I/O row has at least one covering test that ran and passed.

### Residual risks

- The route's `oversizedAttachmentNames` field has no consumer in the repo: the Worker reads only `error`, `jobId` and `slug`, and its own pre-filter means no emailed message can reach the route with an oversized attachment. The route oversize cases therefore exercise a contract only a direct service-principal caller can reach.
- `overBudgetLine` at the Worker's no-body exit is now unreachable — the per-document ceiling partition runs first and the aggregate budget is floored at that ceiling. It is retained with a comment; the previously behavioural DW-360 test at that exit is now a constants assertion plus an end-to-end pin of what the sender actually receives.
- `parseSkippedCount`'s negative-value guard is no longer observable from the response: with the drop-count floor in place, a negative forwarded count and an absent one produce identical output. The guard is retained as defence; the test that claimed to pin it was rewritten to assert what the route now actually answers.
