---
title: 'Derive the raw email cap from a stated aggregate attachment budget (DW-362)'
type: 'bugfix'
created: '2026-08-22'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The aggregate attachment budget is the raw cap's derivation only; nothing
      bounds the decoded bytes a single message actually buffers.
    evidence: |-
      `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` widens `MAX_RAW_EMAIL_BYTES` from one
      document to ten, so a message may now legitimately carry up to 20 MiB of
      decoded attachments (and, since the only post-decode gates are the
      per-document `MAX_EMAIL_DOCUMENT_BYTES` filter and the
      `MAX_EMAIL_ATTACHMENTS` slice, roughly 47 MB decoded if the sender picks
      base64 -- the cheap encoding the cap is NOT derived from -- rather than the
      worst-case one it is). The
      Worker decodes every eligible part into a `Uint8Array` up front in
      `eligibleAttachments`, so that is buffered in the isolate at once, and
      `src/app/api/email/ingest/route.ts` then buffers the same forwarded payload
      again with `await request.formData()`. Adding a
      post-decode aggregate gate, a skip reason, or sender-visible copy was
      explicitly out of scope for DW-362 (Never: "The stated budget is only the
      cap's derivation here"); bounding buffered decoded bytes is DW-360/DW-456's
      subject.
    location: >-
      workers/email-ingest/index.ts
    severity: medium
  - summary: >-
      The cap now quoted to senders (62.4 MB) is roughly 2.5x the inbound
      message-size ceiling DW-457 reports Cloudflare Email Routing enforcing, so
      the widening DW-362 bought may be unreachable in production.
    evidence: |-
      DW-457 (open) records a reported 25 MiB Email Routing inbound limit,
      unverified offline and recorded nowhere in this repo, against the then-new
      31.2 MB figure. This change takes `MAX_RAW_EMAIL_MB` to 62.4 MB, and the
      scenario the change exists to admit -- ten 2 MiB parts, 65,431,170 bytes on
      the worst-case wire -- sits about 2.6x that reported ceiling. If DW-457's
      premise holds, the refusal copy at `workers/email-ingest/index.ts` invites a
      resend under a ceiling the transport rejects first. Clamping the cap to a
      recorded transport bound is DW-457's own decision, not DW-362's, so nothing
      was clamped here -- but DW-457's magnitude doubled and its entry does not
      say so.
    location: >-
      workers/email-ingest/index.ts (MAX_RAW_EMAIL_MB refusal copy)
    severity: medium
  - summary: >-
      Six open ledger entries now quote cap figures this change invalidates, the
      same staleness DW-458 was filed for and which nothing has yet corrected.
    evidence: |-
      DW-361, DW-362, DW-453, DW-456, DW-457 and DW-458 itself all quote
      32,781,108 bytes / 31.2 MB / 23.9 MB decoded. `MAX_RAW_EMAIL_BYTES` is now
      65,496,679 (62.4 MB quoted) and the base64-carried decoded payload rises
      from ~23.9 MB to ~47.8 MB. DW-458 exists precisely because the DW-358
      session was forbidden to edit the ledger and recorded the staleness in its
      spec instead; this session is under the same prohibition, so the
      re-verification is recorded here rather than in the entries.
    location: >-
      _bmad-output/implementation-artifacts/deferred-work.md (DW-361, DW-362, DW-453, DW-456, DW-457, DW-458)
    severity: low
  - summary: >-
      Ten documents above the stated 2 MiB average but under the advertised 10 MB
      per-document ceiling are still refused wholesale -- the accepted residual of
      choosing an explicit total over the full advertised envelope.
    evidence: |-
      The human decision offered "up to `MAX_EMAIL_ATTACHMENTS` documents, or an
      explicit total" and this change took the explicit total (20 MiB), because the
      full envelope -- 10 x `MAX_EMAIL_DOCUMENT_BYTES` -- is ~312 MB on the
      worst-case wire. So the shape DW-362 describes ("several mid-size supported
      documents refused wholesale even though every per-document and per-count
      limit is respected") still occurs above ~1.91 MiB per document at ten
      attachments under worst-case encoding (~4.34 MB under base64); the threshold
      moved rather than disappeared. Nothing sender-visible advertises the 2 MiB
      average, while the 10 MB per-document ceiling is still quoted back to senders
      in the oversized-attachment line.
    location: >-
      workers/email-ingest/index.ts (MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES)
    severity: low
  - summary: >-
      `MAX_RAW_EMAIL_MB` computes in MiB and quotes the result to senders as "MB",
      and the widening grows that mislabelling from ~1 MB to ~3 MB.
    evidence: |-
      `(MAX_RAW_EMAIL_BYTES / 1024 / 1024)` floored to one decimal yields 62.4 and
      is written as "larger than 62.4 MB"; 65,496,679 bytes is 65.5 decimal MB.
      Pre-existing and shared with `MAX_EMAIL_DOCUMENT_MB` and the route's own "10
      MB" copy, so correcting it is a copy decision across both surfaces, not a
      local fix -- but the absolute gap is now large enough for a sender to act on
      it, and this is the same figure DW-457 says may be unachievable.
    location: >-
      workers/email-ingest/index.ts (MAX_RAW_EMAIL_MB)
    severity: low
baseline_revision: '43a54a6d259b1054eecf900485842205f09c51d7'
---

<intent-contract>

## Intent

**Problem:** `MAX_RAW_EMAIL_BYTES` is derived from exactly ONE `MAX_EMAIL_DOCUMENT_BYTES` document, while the Worker advertises up to `MAX_EMAIL_ATTACHMENTS` (10) supported attachments per email — so several mid-size documents (DW-362's own example: ten 2 MiB files, ~65 MB on the wire under the very encoding the cap is derived from) are refused wholesale although every per-document and per-count limit is respected, and the over-cap acknowledgement line is unreachable for anything but small files.

**Approach:** State the aggregate decoded-attachment budget as its own exported constant — `MAX_EMAIL_ATTACHMENTS` documents at a stated average, floored at one full-size document — and derive `MAX_RAW_EMAIL_BYTES` from that budget through the existing `WORST_CASE_TRANSFER_ENCODING_FACTOR` and `MIME_ENVELOPE_HEADROOM_BYTES`. Re-pin the parity test's derivation, add a multi-document aggregate case, and re-derive the worker suite's DW-361 trade-off assertion at its new binding point.

## Boundaries & Constraints

**Always:**
- `MAX_RAW_EMAIL_BYTES` stays *derived* from exported terms — never a hand-typed literal, and never restated as a literal in a test.
- The aggregate budget never falls below `MAX_EMAIL_DOCUMENT_BYTES`: one full-size document must stay admissible under both encodings (DW-104, DW-358). Express that floor in the source (a `Math.max`, the way `WORST_CASE_TRANSFER_ENCODING_FACTOR` keeps both its terms live) and pin it.
- Constants must be declared before use: `MAX_EMAIL_ATTACHMENTS` currently sits *below* the derivation and has to move above it, comment intact (`const` TDZ — a reference from above throws at module load).
- `MAX_RAW_EMAIL_MB` keeps rounding DOWN, so the figure quoted to a sender is never larger than the cap enforced.
- Every constant comment that states an arithmetic figure is re-stated to the new numbers, including the DW-358 residual/headroom prose it invalidates.

**Block If:**
- Staying coherent would require moving `MAX_EMAIL_DOCUMENT_BYTES`, `MAX_EMAIL_ATTACHMENTS`, `MAX_EMAIL_CONTENT_CHARS`, or the sender-visible refusal wording — those are separate decisions, not this one.

**Never:**
- Never add a post-decode aggregate enforcement gate, a new skip reason, or new sender-visible copy. The stated budget is only the cap's derivation here; bounding buffered decoded bytes is DW-360/DW-456's subject and is out of scope. Record it as deferred instead.
- Never edit `_bmad-output/implementation-artifacts/deferred-work.md`.
- Never re-derive `PREVIOUS_BASE64_ONLY_CAP_BYTES` in the parity suite — it is a frozen historical figure and its comment says so.
- Never weaken the existing admissions: the base64 full-size document, the quoted-printable full-size document, and the 72-column-wrap case must all still pass.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Aggregate envelope, worst-case encoding | `rawSize` = `MAX_EMAIL_ATTACHMENTS` × `quotedPrintablePartWireSize(2 MiB)` | Under the cap; message forwarded, reply contains no "larger than" | No error expected |
| One full-size document (both encodings) | `rawSize` = quoted-printable / base64 wire size of `MAX_EMAIL_DOCUMENT_BYTES` | Still under the cap — DW-104/DW-358 admissions unchanged | No error expected |
| Aggregate-full message plus a maximal body | aggregate wire size + `MAX_EMAIL_CONTENT_CHARS` | Over the cap; refused with "larger than …" — the DW-361 trade-off, relocated to the ceiling that now binds | Refusal quotes a figure ≤ the enforced cap |
| Exactly on / one byte over the cap | `MAX_RAW_EMAIL_BYTES` / `+ 1` | Forwarded / refused respectively (the gate is `>`) | Quoted MB rounded down |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts` -- the whole change. Constants block :38-152: `MAX_EMAIL_DOCUMENT_BYTES` :44, `BASE64_EXPANSION_FACTOR` :56, `QUOTED_PRINTABLE_EXPANSION_FACTOR` :82, `WORST_CASE_TRANSFER_ENCODING_FACTOR` :95, `MIME_ENVELOPE_HEADROOM_BYTES` :110, `MAX_RAW_EMAIL_BYTES` :143, `MAX_RAW_EMAIL_MB` :150. `MAX_EMAIL_ATTACHMENTS` is declared far below at :410 and must be hoisted above the derivation. The gate it feeds is :347; nothing else in the file reads the cap.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- the pins. :151-193 "admits a full-size document under the worst-case transfer encoding" holds the derivation assertion at :187 that must be re-pinned to the new formula, plus the frozen `PREVIOUS_BASE64_ONLY_CAP_BYTES` at :175 and the ≥1024-byte slack check at :192. :196-221 pins the 72-column wrap; :224-235 pins the worst-case `Math.max`. New aggregate cases belong in this suite (arithmetic + wire size, no large fixtures).
- `src/lib/__tests__/email-ingest-worker.test.ts` -- :1242-1282 "bounces a full-size document carried alongside a maximal body" fails as written once the cap moves, and its own comment names DW-362 as the change expected to move it ("Re-derive the expectation there"). :1171-1218 are the admission cases at the gate; :1203 sits exactly on the cap.
- `src/lib/__tests__/email-ingest-wire.ts` -- `base64PartWireSize` / `quotedPrintablePartWireSize`, the shared formulas both suites measure with. Calibrated against real fixtures at worker test :1041 and :1100. Reuse them; do not restate the arithmetic.

## Tasks & Acceptance

**Execution:**
- `workers/email-ingest/index.ts` -- move `MAX_EMAIL_ATTACHMENTS` (with its comment) above the cap derivation, add the exported aggregate budget (a stated per-document average × `MAX_EMAIL_ATTACHMENTS`, floored at `MAX_EMAIL_DOCUMENT_BYTES`), and re-derive `MAX_RAW_EMAIL_BYTES` from it -- the advertised attachment count has to be reachable through the gate.
- `workers/email-ingest/index.ts` -- rewrite the `MAX_RAW_EMAIL_BYTES` / `MIME_ENVELOPE_HEADROOM_BYTES` comments to the new figures and to what the headroom now absorbs (per-part headers and boundaries for up to ten parts, plus the per-part remainder the ratio under-counts) -- the existing prose states single-document arithmetic that this change makes false.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- re-pin the derivation to the aggregate formula, pin the budget's floor against `MAX_EMAIL_DOCUMENT_BYTES` and its reach across `MAX_EMAIL_ATTACHMENTS` documents, and add the multi-document aggregate wire case with its remaining slack -- the reachability claim must be observed, not asserted in a comment.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- re-derive the DW-361 trade-off case at the aggregate ceiling (aggregate wire size + `MAX_EMAIL_CONTENT_CHARS` still bounces) and update its comment -- the trade-off is unchanged in kind, only in where it binds.

**Acceptance Criteria:**
- Given ten 2 MiB documents encoded at the worst case the cap is derived from, when their combined wire size is measured against `MAX_RAW_EMAIL_BYTES`, then it is under the cap with the envelope headroom still positive.
- Given the Worker's gate, when a message of that size arrives, then it is forwarded and the reply contains no "larger than" refusal.
- Given the aggregate budget, when compared with `MAX_EMAIL_DOCUMENT_BYTES`, then it is greater than or equal to it, and the single-document admissions for both encodings still pass.
- Given `MAX_RAW_EMAIL_BYTES`, when read in a test, then it equals the aggregate formula computed from exported terms, and no test hand-types the cap.
- Given a message at the full aggregate carrying a `MAX_EMAIL_CONTENT_CHARS` body, when the gate runs, then it is refused and the quoted MB figure is ≤ the enforced cap.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 4: (high 0, medium 1, low 3)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[medium]` `[patch]` The aggregate case asserted a flat `>= 1024` bytes of remaining headroom while the rewritten `MIME_ENVELOPE_HEADROOM_BYTES` comment claims the headroom covers per-part headers and boundaries for up to ten parts — threshold re-derived as `MAX_EMAIL_ATTACHMENTS * PART_HEADER_AND_BOUNDARY_BUDGET_BYTES` (512 B/part, itemised in the comment).
  - `[low]` `[patch]` `AGGREGATE_DOCUMENT_AVERAGE_BYTES` presented 2 MiB as a figure the decision named; the decision names no size and the ledger's example is decimal 2 MB — comment now states it as this module's reading of that example.
  - `[low]` `[patch]` The `MAX_RAW_EMAIL_BYTES` comment argued from the ledger's base64 example, which has fitted since DW-358 — now states the residual failure this change fixes is the same aggregate under the worst-case encoding, cross-referencing DW-458.
  - `[low]` `[patch]` Reflow artifact (orphan line) in the `QUOTED_PRINTABLE_EXPANSION_FACTOR` paragraph.
  - `[low]` `[patch]` Two comments claimed the over-cap acknowledgement line was unreachable "for anything but small attachments" in the past tense — now stated once as the band it is actually reachable in (~1.82 MiB/part worst case, ~4.15 MiB base64, at eleven-plus attachments), cross-referenced from the second site.
  - `[low]` `[patch]` A parity assertion restated the `Math.max` source expression character-for-character; removed as a change-detector, keeping the floor inequality and the advertised-count reach.

## Design Notes

The budget is stated, not multiplied out from the advertised maximum: `MAX_EMAIL_ATTACHMENTS × MAX_EMAIL_DOCUMENT_BYTES` is 100 MiB decoded, ~312 MB on the worst-case wire — a shape no mail transport carries and a direct worsening of the buffered-bytes exposure DW-360/DW-456 record. The average that DW-362 itself names (ten 2 MiB documents) is the traceable middle: 20 MiB decoded, `ceil(20 MiB × 3.12) + 64 KiB` = 65,496,679 bytes (~62.4 MiB) at the gate.

```ts
export const AGGREGATE_DOCUMENT_AVERAGE_BYTES = 2 * 1024 * 1024;
export const MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES = Math.max(
  MAX_EMAIL_DOCUMENT_BYTES, // one full-size document stays admissible (DW-104, DW-358)
  MAX_EMAIL_ATTACHMENTS * AGGREGATE_DOCUMENT_AVERAGE_BYTES,
);
```

Ten separate 2 MiB parts cost slightly MORE than one 20 MiB part (each part pays its own short final line: 65,431,170 vs 65,431,143 bytes), which is why the aggregate case must be measured per part through `quotedPrintablePartWireSize` rather than by scaling one measurement — the difference, and ten sets of part headers, come out of the same 64 KiB headroom.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts` -- expected: all pass, including the new aggregate cases. (`pnpm vitest` fails here with "packages field missing or empty"; use `npx`.)
- `npx vitest run` -- expected: no new failures anywhere in the suite.
- `npx eslint` -- expected: exit 0 (pre-existing `jsx-ast-utils` notices only).
- `npx tsc --noEmit` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** `MAX_RAW_EMAIL_BYTES` is no longer derived from one `MAX_EMAIL_DOCUMENT_BYTES` document. Two new exported constants state the aggregate the Worker is sized for — `AGGREGATE_DOCUMENT_AVERAGE_BYTES` (2 MiB) and `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` = `Math.max(MAX_EMAIL_DOCUMENT_BYTES, MAX_EMAIL_ATTACHMENTS * AGGREGATE_DOCUMENT_AVERAGE_BYTES)` = 20 MiB — and the cap derives from that budget through the unchanged `WORST_CASE_TRANSFER_ENCODING_FACTOR` and `MIME_ENVELOPE_HEADROOM_BYTES`: 32,781,108 → **65,496,679 bytes**, quoted to senders as 62.4 MB. `MAX_EMAIL_ATTACHMENTS` moved above the derivation (`const` TDZ). No gate, no reply copy, and no other cap changed; nothing new is enforced after decoding.

**Files changed.**
- `../../workers/email-ingest/index.ts` — the aggregate budget, the re-derived cap, and every constant comment whose arithmetic the change invalidated.
- `../../src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — derivation re-pinned to the aggregate formula; new cases for the ten-part aggregate wire size (with scaled headroom) and for the budget's floor and reach; the single-document wrap case re-pinned at k=1 now that every conforming wrap fits.
- `../../src/lib/__tests__/email-ingest-worker.test.ts` — new gate case forwarding a message at the whole aggregate budget; the DW-361 body/headroom trade-off re-derived at the aggregate ceiling, with an attachments-alone assertion keeping it honest.

**Review findings.** 6 patches applied (1 medium, 5 low), 4 items deferred (1 medium, 3 low) plus one amended, 9 rejected. No intent gaps and no spec repairs.

**Follow-up review recommendation:** patched counts high 0, medium 1, low 5 → 3×1 + 5 = 8 ≥ 5 → **true**.

**Verification.**
- `npx vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts` — 47 passed (17 parity + 30 worker).
- `npx vitest run` — 275 files / 6309 tests passed, no failures.
- `npx eslint` — exit 0 (pre-existing `jsx-ast-utils` notices only). `npx tsc --noEmit` — exit 0.
- Matrix audit: all four I/O rows are covered by tests that ran and passed — aggregate envelope (parity aggregate case + worker "forwards a message carrying the whole aggregate attachment budget"), single full-size document under both encodings (existing gate cases + parity), aggregate plus maximal body (re-derived trade-off case), and on-cap/over-cap (existing pair).

**Residual risks.** The cap doubled, so the decoded bytes one message may buffer roughly doubles with it (~47.8 MB under base64) and nothing bounds the aggregate after decoding — deferred to DW-360/DW-456. The 62.4 MB quoted to senders is roughly 2.5× the inbound ceiling DW-457 reports for Cloudflare Email Routing, so the widening may be unreachable in production; clamping is DW-457's own decision. Ten documents above the stated 2 MiB average are still refused wholesale — the accepted residual of taking the explicit-total branch of the decision rather than the full advertised envelope. All three are recorded in frontmatter `deferred`.
