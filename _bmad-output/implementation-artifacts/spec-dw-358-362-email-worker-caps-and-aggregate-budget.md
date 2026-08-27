---
title: 'Email Worker caps derived from one aggregate budget, and inline parts out of the skip count'
type: 'bugfix'
created: '2026-08-26'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Inline parts still consume attachment-count slots and aggregate-budget bytes while
      being excluded from every countable loss, so the over-cap sentence can quote a limit
      the sender never reached and an eligible inline document can be dropped silently.
    evidence: |-
      DW-359 moved inline parts out of `unsupportedCount`, `overCapCount` and
      `overBudgetCount` but deliberately left eligibility alone, so the selection loop in
      `workers/email-ingest/index.ts` still spends `MAX_EMAIL_ATTACHMENTS` slots and
      `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` on them. A message with three inline logos and
      nine real PDFs can therefore be told "2 supported attachments were not queued because
      this email exceeds the 10-attachment limit" while the sender attached nine files. The
      converse is pinned by "reports over-budget, over-cap and unsupported losses in one
      scrubbed acknowledgement": an eligible inline `.md` past the cap is reported nowhere.
      Fixing it means deciding whether inline parts should be forwarded at all, which
      DW-359 explicitly did not ask for.
    location: >-
      workers/email-ingest/index.ts (selection loop and loss counts)
    severity: medium
  - summary: >-
      Raising the raw cap widens the band in which the Worker forwards a single attachment
      above the route's per-document ceiling, and the route answers that with a 400 that
      loses the body and every sibling attachment.
    evidence: |-
      The Worker enforces no per-document limit of its own — `MAX_EMAIL_DOCUMENT_BYTES`
      appears only in comments and in the `Math.max` floor — so anything from 10 MiB up to
      the 20 MiB aggregate budget now reaches `src/app/api/email/ingest/route.ts:221-225`,
      which rejects the WHOLE message with "<name> is larger than 10 MB". That band was
      roughly 10-10.5 MiB before this change. The Worker-side per-attachment size
      pre-filter that would drop the oversized part instead is DW-253's subject, still
      open and out of this bundle's scope.
    location: >-
      workers/email-ingest/index.ts (forwarding selection)
    severity: medium
  - summary: >-
      Nothing bounds the parse-time buffered peak, which this change roughly doubled by
      raising the raw cap.
    evidence: |-
      `PostalMime.parse(message.raw)` decodes the entire MIME tree before the selection
      loop runs, so the DW-360 budget governs only the `FormData` copies of SELECTED
      parts. The peak the ledger entry's `reason` also names — "the parsed MIME tree" —
      is bounded solely by `MAX_RAW_EMAIL_BYTES`, which this change took from 32,781,108
      to 65,496,679 bytes. The source comments now state this plainly rather than implying
      the budget bounds the whole payload, but nothing enforces it and no test observes a
      buffered peak.
    location: >-
      workers/email-ingest/index.ts (PostalMime.parse, ahead of the selection loop)
    severity: medium
  - summary: >-
      The 62.4 MB now quoted to senders may exceed Cloudflare Email Routing's own inbound
      message ceiling, making the widening unreachable in production.
    evidence: |-
      Email Routing is reported to enforce an inbound per-message limit of roughly 25 MiB.
      Nothing in `wrangler.jsonc`, `workers/email-ingest/README.md` or this repo records
      that figure, and it could not be verified offline, so nothing was clamped. If the
      premise holds, the shapes this derivation was widened to admit — ten byte-dense
      quoted-printable parts at 65,431,170 bytes — never reach the Worker at all, and the
      refusal copy invites a resend under a ceiling the transport rejects first.
    location: >-
      workers/email-ingest/index.ts (MAX_RAW_EMAIL_MB refusal copy)
    severity: low
  - summary: >-
      `inlineAttachment` reads only `disposition`, so a signature logo sent with a
      Content-ID but no Content-Disposition header still produces the phantom skipped-
      attachment line DW-359 exists to remove.
    evidence: |-
      The predicate is `attachment.disposition === "inline"`, and its comment records the
      deliberate choice to treat a `null` disposition as a real attachment rather than
      risk dropping a file the sender really sent. postal-mime also exposes `contentId`
      and a `related` flag, and DW-359's own text describes the noisy parts as having
      `disposition: "inline"` AND a `contentId`. A client that emits `Content-ID` without
      a disposition header therefore keeps the behaviour the entry was filed against.
      Widening the predicate is a separate decision about which signal to trust.
    location: >-
      workers/email-ingest/index.ts (inlineAttachment)
    severity: low
baseline_revision: '5a2051b82e0f96605e8e37a6ef818f8a05c00708'
---

<intent-contract>

## Intent

**Problem:** `workers/email-ingest/index.ts` derives `MAX_RAW_EMAIL_BYTES` from base64 expansion of exactly ONE `MAX_EMAIL_DOCUMENT_BYTES` document, so a quoted-printable `.csv` inside the advertised per-document ceiling is bounced (DW-358) and ten mid-size documents — the envelope `MAX_EMAIL_ATTACHMENTS = 10` advertises — are refused wholesale (DW-362); the 64 KiB `MIME_ENVELOPE_HEADROOM_BYTES` trade-off against `MAX_EMAIL_CONTENT_CHARS` is a comment nothing enforces (DW-361); nothing bounds the aggregate decoded bytes the forwarding loop copies into `FormData`, and widening the raw cap raises that peak (DW-360); and `supportedAttachment()`'s filter counts inline MIME parts — signature logos, embedded images — as unsupported attachments reported back to the sender (DW-359).

**Approach:** State ONE explicit aggregate decoded-attachment budget as an exported constant, derive `MAX_RAW_EMAIL_BYTES` from it through a worst-case transfer-encoding factor (`Math.max` of base64 and quoted-printable) plus the envelope headroom, and enforce that same budget after decoding so the bytes copied into `FormData` are bounded by the figure the cap is sized for. Exclude `disposition: "inline"` parts from the recorded names and from every loss count. Pin all of it with worker and parity tests, including the body/headroom trade-off at the ceiling that now binds.

**Recovery, not re-derivation:** commit `f2458e1844b0b2db7377b2b027f67a63431a0fc1` reverted already-shipped fixes for DW-358, DW-361 and DW-362 as collateral damage (16,429 deletions across 151 files). Those three are recovered verbatim from `43a54a6d259b1054eecf900485842205f09c51d7` (DW-358), `f89da9ad` (DW-362) and `c1e60ebc7b50afc8c3d02f9706d6e86ac5f38e17` (DW-361) rather than re-invented. DW-359 and DW-360 were never implemented and are new work.

## Boundaries & Constraints

**Always:**
- `MAX_RAW_EMAIL_BYTES` stays *derived* from exported terms — never a hand-typed literal, and never restated as a literal in a test.
- The aggregate budget never falls below `MAX_EMAIL_DOCUMENT_BYTES`: one full-size document stays admissible under both encodings (DW-104, DW-358). Express the floor in the source (`Math.max`) and pin it.
- Constants must be declared before use — `MAX_EMAIL_ATTACHMENTS` currently sits *below* the derivation and must move above it, comment intact (`const` TDZ).
- `MAX_RAW_EMAIL_MB` keeps rounding DOWN, so the figure quoted to a sender is never larger than the cap enforced.
- Every constant comment that states an arithmetic figure is restated to the new numbers.
- New Worker constants a parity test compares must be `export`ed.
- The post-decode aggregate gate bounds the bytes appended to `FormData`; it must not decode any attachment more times than the current code already does.
- Recovered hunks come from the named commits verbatim where they still apply; deviations are only for lines the recovery would otherwise clobber (the `xls` / `application/vnd.ms-excel` allowlist entries added by `7e8252f6`).

**Block If:** Staying coherent would require moving `MAX_EMAIL_DOCUMENT_BYTES`, `MAX_EMAIL_ATTACHMENTS`, `MAX_EMAIL_CONTENT_CHARS`, or `MAX_EMAIL_ATTACHMENT_NAMES_RECORDED` themselves — those are separate decisions.

**Never:**
- Never restore the DW-253 oversized-attachment pre-filter, the DW-364 misconfiguration tests, or the DW-357 route hoist — those entries belong to other bundles and are out of scope here. Touch `src/app/api/email/ingest/route.ts` not at all.
- Never re-derive `PREVIOUS_BASE64_ONLY_CAP_BYTES` in the parity suite — it is a frozen historical figure.
- Never edit `_bmad-output/implementation-artifacts/deferred-work.md`.
- Never weaken the existing admissions: base64 full-size document, quoted-printable full-size document, the 72-column wrap, the on-cap/one-byte-over pair.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Worst-case-encoded full-size document | `rawSize` = `quotedPrintablePartWireSize(MAX_EMAIL_DOCUMENT_BYTES)` | Under the cap; forwarded; reply contains no "larger than" | No error expected |
| Aggregate envelope on the worst-case wire | `rawSize` = `MAX_EMAIL_ATTACHMENTS × quotedPrintablePartWireSize(AGGREGATE_DOCUMENT_AVERAGE_BYTES)` | Under the cap; forwarded; no refusal | No error expected |
| Aggregate-full message plus a maximal body | that wire size + `MAX_EMAIL_CONTENT_CHARS` | Over the cap; refused with "larger than …"; nothing forwarded | Refusal quotes a figure ≤ the enforced cap |
| Exactly on / one byte over the cap | `MAX_RAW_EMAIL_BYTES` / `+1` | Forwarded / refused respectively (the gate is `>`) | Quoted MB rounded down |
| Decoded aggregate over budget | Supported parts whose decoded bytes exceed `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` (reachable under base64, the cheap encoding the cap is not derived from) | Only the leading parts that fit are appended to `FormData`; the rest are counted as skipped and named in a dedicated acknowledgement line | No error expected |
| Inline signature logo beside a real attachment | one `disposition: "inline"` PNG + one supported PDF + a body | PDF queued; reply reports 1 queued attachment and NO "unsupported … skipped" line; the inline part is not in `attachmentName` | No error expected |
| Only inline parts, no body | one `disposition: "inline"` PNG, empty text/html | Reply is "work-wiki found no email text to ingest." — not the supported-formats sentence | No error expected |
| Inline part that is itself a supported document | `disposition: "inline"` `.md` part | Still forwarded and counted as queued — inline changes accounting, not eligibility | No error expected |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts` — the whole production change.
  - Constants block :37-104. `MAX_EMAIL_DOCUMENT_BYTES` :46, `BASE64_EXPANSION_FACTOR` :54, `MIME_ENVELOPE_HEADROOM_BYTES` :62, `MAX_RAW_EMAIL_BYTES` :78-80, `MAX_RAW_EMAIL_MB` :85-87, `MAX_EMAIL_CONTENT_CHARS` :94, `MAX_EMAIL_ATTACHMENT_NAMES_RECORDED` :100.
  - `MAX_EMAIL_ATTACHMENTS` is declared at :161, *below* the derivation — hoist it (comment intact) above `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`.
  - `supportedAttachment()` :163-174 — read-only; eligibility is unchanged.
  - Raw-size gate :246-254 (`message.rawSize > MAX_RAW_EMAIL_BYTES`); nothing else reads the cap.
  - Accounting block :293-305 (`eligibleAttachments` / `supportedAttachments` / `unsupportedCount` / `overCapCount` / `skippedAttachmentCount`) and the no-content early return :306-315 that keys on `parsed.attachments.length`.
  - `attachmentNames` :321-323 — maps every parsed part, inline ones included; the route unions this list and derives a `localSkipped` FLOOR from it (`src/app/api/email/ingest/route.ts:426`), so inline names must be dropped here or DW-359 is undone downstream.
  - Forwarding loop :338-359 — decodes `attachment.content` into `source` then copies into `bytes`, appends a `Blob` per part. This is the loop DW-360 names.
  - Acknowledgement lines :396-411 — `overCapCount` and `unsupportedCount` sentences; the new over-budget line goes beside them.
- `node_modules/postal-mime/postal-mime.d.ts:33-43` — read-only evidence: `Attachment.disposition` is `"attachment" | "inline" | null`, `contentId?: string`, `content: ArrayBuffer | Uint8Array | string`. Default `attachmentEncoding` is arraybuffer, so the string branch is a fallback.
- `src/lib/__tests__/email-ingest-wire.ts` — has only `base64PartWireSize`. Append `quotedPrintablePartWireSize(byteLength, escapesPerLine = 25)` verbatim from `git show f89da9ad:src/lib/__tests__/email-ingest-wire.ts` (the file is otherwise identical at HEAD).
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — :149-172 holds the single-document admission whose derivation assertion must be re-pinned. Recover the four cap cases with `git show f89da9ad:src/lib/__tests__/email-ingest-allowlist-parity.test.ts` (this file differs from HEAD ONLY in those cases and their imports).
- `src/lib/__tests__/email-ingest-worker.test.ts` — fixture builders `partBytes`, `base64Lines`, `multipartEmail` (:337-370 at HEAD), `message()`, `env()`, `forwardedForm()`; `describe("email-ingest raw message cap")` holds the gate cases. Recover from `f89da9ad` ONLY: `quotedPrintableLines`, the `encoding` and `disposition` options on `multipartEmail`, the QP round-trip test, the QP calibration test, and the three cap cases. Do NOT recover the `email-ingest oversized attachments` describe (DW-253) or the `misconfigured bindings` describe (DW-364).
- `src/lib/__tests__/email-ingest-worker-normalization.test.ts` — read-only: mocks `postal-mime`, so it is the cheapest place to drive synthetic `disposition` values if a fixture-built inline part proves awkward. Prefer the real fixture in `email-ingest-worker.test.ts`.

## Tasks & Acceptance

**Execution:**
- `workers/email-ingest/index.ts` — hoist `MAX_EMAIL_ATTACHMENTS` above the derivation and add `QUOTED_PRINTABLE_EXPANSION_FACTOR`, `WORST_CASE_TRANSFER_ENCODING_FACTOR`, `AGGREGATE_DOCUMENT_AVERAGE_BYTES` and `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` (recovered verbatim from `43a54a6d` and `f89da9ad`), then re-derive `MAX_RAW_EMAIL_BYTES` from the aggregate budget × the worst-case factor + the headroom — the sender picks the encoding and the advertised attachment count has to be reachable (DW-358, DW-362).
- `workers/email-ingest/index.ts` — rewrite the `MIME_ENVELOPE_HEADROOM_BYTES` and `MAX_RAW_EMAIL_BYTES` comments to the new arithmetic, recovered from `f89da9ad`, minus the DW-456/DW-457/DW-458 cross-references (those ledger ids no longer exist) — the existing prose states single-document figures this change makes false.
- `workers/email-ingest/index.ts` — add an inline-part predicate and count `unsupportedCount` over non-inline parts only, drop inline parts from `attachmentNames`, and key the "no email text or supported document attachment" early return on the countable list rather than `parsed.attachments.length` — a branded signature is not an attachment the sender chose to send (DW-359).
- `workers/email-ingest/index.ts` — bound the forwarding selection by `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` using an allocation-free decoded-length helper, count the parts dropped for the budget, add them to `skippedAttachmentCount`, and add one acknowledgement line naming that loss — the same explicit budget the cap is derived from now also bounds what reaches `FormData` (DW-360).
- `src/lib/__tests__/email-ingest-wire.ts` — append `quotedPrintablePartWireSize` verbatim — both suites must measure the worst-case wire with one shared, calibrated formula.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — recover the four cap cases (worst-case admission with the frozen `PREVIOUS_BASE64_ONLY_CAP_BYTES`, the aggregate reach with its per-part headroom budget, the budget floor, the 72-column wrap, the worst-case `Math.max`) — the derivation and the reachability claim must be observed, not asserted in a comment.
- `src/lib/__tests__/email-ingest-worker.test.ts` — recover `quotedPrintableLines`, the `multipartEmail` `encoding`/`disposition` options, the QP round-trip and calibration tests, and the three cap cases (worst-case full-size document forwarded, whole aggregate budget forwarded, aggregate + maximal body bounced) — the gate is where a sender learns whether their message was refused (DW-358, DW-361, DW-362).
- `src/lib/__tests__/email-ingest-worker.test.ts` — add a `describe` for inline parts (queued-beside-inline, inline-only-no-body, inline-but-supported) and for the decoded aggregate bound (over-budget parts dropped, named in the reply, absent from `FormData`, and counted in the forwarded `skippedAttachmentCount`) — DW-359 and DW-360 have no coverage at all today.

**Acceptance Criteria:**
- Given `MAX_RAW_EMAIL_BYTES`, when read in a test, then it equals the aggregate formula computed from exported terms, and no test hand-types the cap.
- Given `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`, when compared with `MAX_EMAIL_DOCUMENT_BYTES`, then it is greater than or equal to it, and both single-document admissions still pass.
- Given the aggregate budget were removed from the forwarding selection, when the suite runs, then a worker test fails because over-budget bytes reached `FormData`.
- Given the inline predicate were deleted, when the suite runs, then a worker test fails because the sender was told an inline part was skipped.
- Given `MIME_ENVELOPE_HEADROOM_BYTES` were raised until the aggregate and a maximal body fit together, when the suite runs, then the trade-off test fails — the recorded trade-off is enforced rather than merely commented.
- Given `src/app/api/email/ingest/route.ts`, when the change is complete, then `git status` shows it unmodified.

## Spec Change Log

## Review Triage Log

### 2026-08-26 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 4, low 5)
- defer: 5: (high 0, medium 3, low 2)
- reject: 11: (high 0, medium 1, low 10)
- addressed_findings:
  - `[medium]` `[patch]` DW-360's new loss class made `supportedAttachments` empty for a message whose only part was a supported-but-over-budget document, so the no-body early return answered it with the supported-formats sentence and discarded the over-budget line entirely — the over-budget sentence is now built once and used at both exits, and the lead sentence is keyed on `unsupportedCount` so it only claims a format problem when a countable part really failed the allowlist.
  - `[medium]` `[patch]` The over-budget acknowledgement named every dropped part with no cap, so a budget exhausted early by two large files could put hundreds of 200-character names into one outbound reply — the named list is now capped at `MAX_EMAIL_ATTACHMENT_NAMES_RECORDED` with an "and N others" tail while the reported count stays the true total.
  - `[medium]` `[patch]` `overCapCount`'s three interacting terms were never driven together (over-budget cases yielded no over-cap loss and vice versa) — added a case with unsupported, over-budget, over-cap and two inline parts at once, one of them an eligible inline document past the count cap, which makes the `countable(...)` terms load-bearing.
  - `[medium]` `[patch]` `replyAttachmentName` was the first place this Worker interpolates an attacker-controlled MIME filename into an outbound email and nothing pinned it — added a case giving an over-budget part an RFC 2231 name carrying real CR/LF and another no name at all, asserting the line stays one line and renders `unnamed attachment`.
  - `[low]` `[patch]` The decoded budget had no boundary pin while the raw gate has an on-cap/one-byte-over pair — added a case landing exactly on `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` with a one-byte part behind it.
  - `[low]` `[patch]` `decodedByteLength`'s string branch is hand-written UTF-8 arithmetic with no coverage (every fixture parses as arraybuffer) — exported it and pinned it against `TextEncoder` across ASCII, 2-byte, 3-byte, astral, lone-high-surrogate, lone-low-surrogate, mixed and empty content in the mocked normalization suite.
  - `[low]` `[patch]` The over-budget assertion recomputed the quoted MB figure without production's `Math.floor`, agreeing only because 20 MiB is MiB-aligned today — the expectation now derives through the same floor and the round-down invariant is asserted directly.
  - `[low]` `[patch]` Comments claimed more than the code did: the aggregate budget was implied to bound the message's whole buffered payload when `PostalMime.parse` has already decoded the tree, and `inlineAttachment`'s comment cited `cid:`-referenced graphics though the predicate never reads `contentId` — both corrected.
  - `[low]` `[patch]` Formatting residue: a double blank line before the base64 cap test, and the blank line lost between `SUPPORTED_MIME_TYPES` and `supportedAttachment()` when `MAX_EMAIL_ATTACHMENTS` was hoisted.

## Design Notes

The five entries collapse into one budget. `AGGREGATE_DOCUMENT_AVERAGE_BYTES` (2 MiB, this module's reading of DW-362's own worked example of ten 2 MB documents) × `MAX_EMAIL_ATTACHMENTS`, floored at one full-size document:

```ts
export const MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES = Math.max(
  MAX_EMAIL_DOCUMENT_BYTES, // DW-104/DW-358: one full-size document stays admissible
  MAX_EMAIL_ATTACHMENTS * AGGREGATE_DOCUMENT_AVERAGE_BYTES,
); // 20 MiB decoded
export const MAX_RAW_EMAIL_BYTES =
  Math.ceil(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES * WORST_CASE_TRANSFER_ENCODING_FACTOR) +
  MIME_ENVELOPE_HEADROOM_BYTES; // 65,496,679 — quoted as 62.4 MB
```

The `Math.max` shape is deliberate on both constants: it keeps every term live and readable, so "worst case" and "at least one document" are computed rather than asserted in prose.

DW-360 is what makes the widening safe rather than merely wider. The cap is derived from the WORST encoding, so a sender using the cheap one (base64, ~1.37x) can slip ~47 MB of decoded bytes under a 62.4 MB raw gate. Enforcing the same 20 MiB budget on the decoded selection is what closes that, and it is why the two are one change and not two:

```ts
let aggregateBytes = 0;
for (const attachment of eligibleAttachments) {
  const size = decodedByteLength(attachment.content); // no copy — byteLength, or a UTF-8 scan
  if (selected.length >= MAX_EMAIL_ATTACHMENTS) break;   // count cap unchanged
  if (aggregateBytes + size > MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES) { overBudget.push(attachment); continue; }
  aggregateBytes += size;
  selected.push(attachment);
}
```

Measure aggregates PER PART in tests, never by scaling one measurement: ten separate 2 MiB parts cost more than one 20 MiB part (65,431,170 vs 65,431,143 bytes) because each pays its own short final line, a soft break and a CRLF — and it is the ten-part figure the 64 KiB headroom has to absorb.

DW-359 changes accounting, not eligibility: an inline part that is a supported document is still forwarded. Only the *denominator* moves.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts src/lib/__tests__/email-ingest-route.test.ts` -- expected: all pass, including the recovered and new cases. (`pnpm vitest` fails here with "packages field missing or empty"; use `npx`.)
- `npx vitest run` -- expected: no new failures anywhere in the suite.
- `npx tsc --noEmit` -- expected: exit 0.
- `npx eslint` -- expected: exit 0 (pre-existing `jsx-ast-utils` notices only).
- `git status --porcelain src/app/api/email/ingest/route.ts` -- expected: empty.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** The email Worker's caps now derive from ONE stated aggregate budget instead of from a single base64-encoded document. `AGGREGATE_DOCUMENT_AVERAGE_BYTES` (2 MiB) × `MAX_EMAIL_ATTACHMENTS`, floored at `MAX_EMAIL_DOCUMENT_BYTES`, gives `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` = 20 MiB decoded; `MAX_RAW_EMAIL_BYTES` = `ceil(that × WORST_CASE_TRANSFER_ENCODING_FACTOR) + MIME_ENVELOPE_HEADROOM_BYTES` = **65,496,679 bytes**, quoted to senders as 62.4 MB (was 14,414,471 / 13.7 MB). The worst-case factor is a `Math.max` over base64 (~1.37x) and quoted-printable (~3.12x), so the encoding the SENDER picks can no longer bounce a `.csv` inside the advertised per-document ceiling (DW-358), and the advertised ten-attachment envelope is now reachable through the gate (DW-362). The same budget is enforced AFTER decoding on the forwarding selection, so the bytes copied into the outbound `FormData` are bounded by the figure the cap is sized for rather than by the cheap encoding's slack (DW-360) — over-budget parts are counted and named in the acknowledgement. Inline MIME parts leave every loss count and the recorded name list while staying fully eligible to be forwarded, so a branded signature no longer reports itself back to its own sender as a skipped attachment (DW-359). The documented body/headroom trade-off is now enforced by a test at the ceiling that actually binds (DW-361).

DW-358, DW-361 and DW-362 were **recovered**, not re-invented: commit `f2458e1844b0b2db7377b2b027f67a63431a0fc1` reverted their shipped fixes as collateral damage, and the constants, comments and tests come back verbatim from `43a54a6d259b1054eecf900485842205f09c51d7`, `c1e60ebc7b50afc8c3d02f9706d6e86ac5f38e17` and `f89da9ad`, minus the DW-45x cross-references whose ledger ids no longer exist, and preserving the `xls` / `application/vnd.ms-excel` allowlist entries added by `7e8252f6` afterwards. DW-359 and DW-360 are new work. `src/app/api/email/ingest/route.ts` was not touched, and the DW-253, DW-357 and DW-364 recoveries that share those commits were deliberately left out — they belong to other bundles.

**Files changed.**
- [`workers/email-ingest/index.ts`](../../workers/email-ingest/index.ts) — the aggregate budget and the re-derived cap; the worst-case encoding factor; `inlineAttachment`, `decodedByteLength` and `replyAttachmentName`; the bounded forwarding selection and its acknowledgement line; every constant comment whose arithmetic the change invalidated.
- [`src/lib/__tests__/email-ingest-wire.ts`](../../src/lib/__tests__/email-ingest-wire.ts) — `quotedPrintablePartWireSize`, the shared worst-case wire formula both suites measure with.
- [`src/lib/__tests__/email-ingest-allowlist-parity.test.ts`](../../src/lib/__tests__/email-ingest-allowlist-parity.test.ts) — derivation re-pinned to the aggregate formula; the aggregate reach with its per-part headroom budget; the budget floor; the 72-column and k=1 wraps; the worst-case `Math.max`.
- [`src/lib/__tests__/email-ingest-worker.test.ts`](../../src/lib/__tests__/email-ingest-worker.test.ts) — the quoted-printable fixture encoder and round trip, the wire calibration, the three cap cases, three inline cases, and the aggregate-budget cases including the exact boundary, the combined loss case and the filename-scrubbing case.
- [`src/lib/__tests__/email-ingest-worker-normalization.test.ts`](../../src/lib/__tests__/email-ingest-worker-normalization.test.ts) — `decodedByteLength` pinned against `TextEncoder` across the UTF-8 branches its hand-written arithmetic covers.

**Review findings breakdown.** 9 patches applied (4 medium, 5 low), 5 items deferred (3 medium, 2 low), 11 rejected (1 medium, 10 low). No intent gaps and no spec repairs; the review loop ran once with no loopback. The rejected medium was a claim that a forwarded inline document reaches the route nameless — disproved by `src/app/api/email/ingest/route.ts:191-194`, which unions the staged file names into `attachmentNames`.

**Follow-up review recommendation:** patched this pass high 0, medium 4, low 5 → `3×4 + 5 = 17` ≥ 5 → **true**.

**Verification.**
- `npx vitest run` on the four email suites — 86 passed (worker 32, parity 17, normalization 17, route 20).
- `npx vitest run` — 325 files, 7375 passed, 1 skipped, 0 failures.
- `npx tsc --noEmit` — exit 0. `npx eslint` — exit 0, zero output lines other than the three pre-existing `jsx-ast-utils` notices.
- `git status --porcelain` on `src/app/api/email/ingest/route.ts` and on `deferred-work.md` — both empty.
- Matrix audit: all eight I/O rows are covered by tests that ran and passed — worst-case full-size document and whole-aggregate admissions and the aggregate-plus-maximal-body bounce in `email-ingest raw message cap`; the on-cap / one-byte-over pair beside them; the decoded-budget drop, its exact boundary and its combined-loss case in `email-ingest aggregate decoded budget`; and the three `email-ingest inline parts` cases.
- Mutation checks, source restored afterward: removing the budget check from the selection loop fails 5 tests; deleting `inlineAttachment` fails 4; raising `MIME_ENVELOPE_HEADROOM_BYTES` fails the trade-off test and the parity aggregate case; flipping the budget gate's `>` to `>=` fails the boundary case; replacing `replyAttachmentName` with the raw filename fails the scrubbing case.
- One unrelated flake was seen on the first full run (`src/components/__tests__/workspace-purpose-settings.test.tsx` > "abandons a recheck that was already in flight when the owner saved") and did not recur; that file passes 3/3 in isolation and shares no code with this change.

**Residual risks.** All five are recorded in frontmatter `deferred`. The three medium ones are worth naming here: inline parts still spend attachment-count slots and budget bytes while being excluded from every countable loss, so the over-cap sentence can quote a limit the sender never reached; the widened raw cap enlarges the band in which a single over-ceiling attachment reaches the route and 400s the whole message, which DW-253's Worker-side pre-filter would fix; and the parse-time buffered peak is still bounded only by `MAX_RAW_EMAIL_BYTES`, which this change roughly doubled — the source comments now say so plainly rather than implying the budget bounds it.
