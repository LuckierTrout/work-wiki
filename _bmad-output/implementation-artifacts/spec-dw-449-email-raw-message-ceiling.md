---
title: 'Clamp the raw-email cap to Cloudflare Email Routing''s verified inbound ceiling'
type: 'bugfix'
created: '2026-08-31'
status: 'in-progress'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
baseline_revision: '7cfc9d0b562a88be600e4b67e6063fb2512b8f85'
---

<intent-contract>

## Intent

**Problem:** `MAX_RAW_EMAIL_BYTES` is derived purely from the aggregate-document budget — 65,496,679 bytes, quoted to senders as "larger than 62.4 MB" (`workers/email-ingest/index.ts:248`, `:256`, `:682`). Cloudflare Email Routing rejects any inbound message above **25 MiB** before the Worker ever runs, so that refusal invites a resend under a ceiling the transport has already refused, and nothing in the repo records the platform figure the Worker actually lives under (DW-449).

**Approach:** Record the verified Email Routing ceiling as a named exported constant beside the derivation, keep the aggregate derivation as its own exported constant, and clamp the enforced cap with `Math.min` over the two — the same both-terms-stay-live idiom `WORST_CASE_TRANSFER_ENCODING_FACTOR` and `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` already use. Record the figure and its source in `workers/email-ingest/README.md`, and re-point the derivation tests at the derived constant so the reachability claims stay observed while new cases pin the clamp.

## Boundaries & Constraints

**Always:**
- The platform figure is `25 * 1024 * 1024`, written as that expression and sourced in a comment. Verified 2026-08-31 against `https://developers.cloudflare.com/email-routing/limits/` ("Inbound message size: 25 MiB. Messages larger than this are rejected."), corroborated by the Email Workers guide's own `message.rawSize > 25 * 1024 * 1024` example.
- The enforced cap is `Math.min(<derived>, EMAIL_ROUTING_MAX_INBOUND_BYTES)` — never a hand-typed literal, never a swap to the smaller term. Both terms stay exported and live.
- The aggregate derivation survives as its own exported constant with its existing comment; every assertion that was about the DERIVATION is re-pointed at it rather than deleted.
- `MAX_RAW_EMAIL_MB` keeps rounding DOWN and now quotes `25.0`.
- Every comment stating `62.4 MB` or `65,496,679` as the ENFORCED gate is corrected to name the derived constant or the enforced figure, whichever it actually means.
- The base64 full-size-document admission (DW-104) must still hold against the ENFORCED cap: 14,348,938 < 26,214,400.

**Block If:** Staying coherent would require moving `MAX_EMAIL_DOCUMENT_BYTES`, `MAX_EMAIL_ATTACHMENTS`, `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`, `AGGREGATE_DOCUMENT_AVERAGE_BYTES`, `MIME_ENVELOPE_HEADROOM_BYTES` or `MAX_EMAIL_CONTENT_CHARS` themselves — the clamp is a ceiling on the raw gate, not a re-sizing of the budget those constants state.

**Never:**
- Never edit `src/app/api/email/ingest/route.ts`, `workers/email-ingest/wrangler.jsonc`, or `_bmad-output/implementation-artifacts/deferred-work.md`.
- Never re-derive `PREVIOUS_BASE64_ONLY_CAP_BYTES` — it stays a frozen historical literal.
- Never delete a derivation assertion to make it pass; re-point it and state what now binds.
- Never touch the post-decode aggregate bound (DW-360), `inlineAttachment` (DW-359), or the truncation/forwarding paths.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Base64 full-size document | `rawSize` = `base64PartWireSize(MAX_EMAIL_DOCUMENT_BYTES)` = 14,348,938 | Under the enforced cap; forwarded; reply contains no "larger than" | No error expected |
| Worst-case quoted-printable full-size document | `rawSize` = `quotedPrintablePartWireSize(MAX_EMAIL_DOCUMENT_BYTES)` = 32,715,573 | Over the enforced cap; refused; quotes 25.0 MB — a figure Email Routing would itself have rejected first | Quoted figure ≤ enforced cap |
| Whole aggregate budget on the worst-case wire | `MAX_EMAIL_ATTACHMENTS × quotedPrintablePartWireSize(AGGREGATE_DOCUMENT_AVERAGE_BYTES)` = 65,431,170 | Over the enforced cap; refused; under the DERIVED cap, so the derivation claim stays observable | Quoted figure ≤ enforced cap |
| Exactly on / one byte over the enforced cap | `MAX_RAW_EMAIL_BYTES` / `+1` | Forwarded / refused respectively (the gate is `>`) | Quoted MB rounded down |
| Aggregate plus a maximal body | that wire size + `MAX_EMAIL_CONTENT_CHARS` | Over the DERIVED cap too, so the headroom trade-off stays pinned; refused | No error expected |
| Clamp read directly | `MAX_RAW_EMAIL_BYTES` | Equals `Math.min` of the two exported terms, and equals `EMAIL_ROUTING_MAX_INBOUND_BYTES` today | No error expected |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts` — the whole production change.
  - `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` comment :107 says "under a 62.4 MB raw gate" — that figure is now the derived one, not the gate.
  - `QUOTED_PRINTABLE_EXPANSION_FACTOR` comment :156-158 calls 65,496,679 "the `MAX_RAW_EMAIL_BYTES` the aggregate budget now yields" and :165-171 states the k=25/k=24 aggregate band — all derivation figures; re-point at the derived constant and add what the clamp now binds first.
  - `MIME_ENVELOPE_HEADROOM_BYTES` :191-201 — the body/headroom trade-off is a property of the DERIVED cap; the clamp does not change it.
  - `MAX_RAW_EMAIL_BYTES` :202-250 — the long comment ends "That lands the cap at 65,496,679 bytes (~62.46 MiB), quoted to senders as 62.4 MB" (:239-241). The derivation expression is :248-250.
  - `MAX_RAW_EMAIL_MB` :251-257 — unchanged code, new output (`25.0`).
  - Raw-size gate :678-684 — the only reader of the cap; refusal copy at :682.
  - Forwarding-loop comment :808 and :813 ("under a 62.4 MB raw gate") — restate against the enforced figure.
- `workers/email-ingest/README.md` — the Worker's operator doc; the "carries at most ten supported documents…" paragraph (:18-24) is where the platform ceiling belongs, plus a sourced line in the deploy notes.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — imports at :22; the four cap cases at :149-305. `PREVIOUS_BASE64_ONLY_CAP_BYTES` :175 is frozen.
- `src/lib/__tests__/email-ingest-worker.test.ts` — `describe("email-ingest raw message cap")`; the three gate cases at :2731-2782 (QP full-size, base64 full-size) and :2762-2782 (aggregate), the on-cap/one-over pair :2784-2818, and the headroom trade-off :2820-2870 whose inner `expect(aggregateWireSize).toBeLessThan(MAX_RAW_EMAIL_BYTES)` (:2861) is a derivation claim.
- `src/lib/__tests__/email-ingest-wire.ts` — read-only. `base64PartWireSize` / `quotedPrintablePartWireSize` are the shared, fixture-calibrated formulas; measure with them, never hand-type a wire size.
- `_bmad-output/implementation-artifacts/deferred-work-archive.md:3854` — read-only evidence: a misfiled duplicate of this decision naming exactly this shape (named constant, `Math.min`, README source, parity test).

## Tasks & Acceptance

**Execution:**
- `workers/email-ingest/index.ts` — add exported `EMAIL_ROUTING_MAX_INBOUND_BYTES = 25 * 1024 * 1024` with the two-source citation and verification date, rename the existing derivation to exported `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` keeping its comment, and define `MAX_RAW_EMAIL_BYTES` as `Math.min` of the two — a sender must never be quoted a size the transport refuses first (DW-449).
- `workers/email-ingest/index.ts` — correct every comment that states 62.4 MB / 65,496,679 as the ENFORCED gate (:107, :156, :239-241, :813) to name the derived constant, and state at the clamp which term binds today and what that costs: the worst-case-QP full-size document and the whole aggregate no longer reach the Worker.
- `workers/email-ingest/README.md` — record the 25 MiB Email Routing inbound ceiling, its source URL, and the consequence for the advertised per-document and aggregate figures — the refusal copy and the ceiling must stay tied together in one operator-readable place.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — re-point the derivation, aggregate-reach and 72-column assertions at `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`, keep the base64 admission against the enforced cap, and add a case pinning the clamp itself — the derivation claims must stay observed rather than deleted.
- `src/lib/__tests__/email-ingest-worker.test.ts` — rewrite the worst-case-QP and whole-aggregate gate cases as refusals that quote a reachable figure, re-point the headroom trade-off's inner claim at the derived constant, and assert the quoted figure never exceeds the platform ceiling — the gate is where a sender learns what to resend.

**Acceptance Criteria:**
- Given `MAX_RAW_EMAIL_BYTES`, when read in a test, then it equals `Math.min(AGGREGATE_DERIVED_RAW_EMAIL_BYTES, EMAIL_ROUTING_MAX_INBOUND_BYTES)` and no test hand-types either figure.
- Given the refusal reply, when a message exceeds the cap, then the quoted MB figure is ≤ both the enforced cap and `EMAIL_ROUTING_MAX_INBOUND_BYTES`.
- Given the `Math.min` were replaced by the derived term alone, when the suite runs, then a test fails because the Worker quoted a size Email Routing rejects.
- Given `workers/email-ingest/README.md`, when read, then it states 25 MiB, its source, and that the advertised aggregate is bounded by it.
- Given `src/app/api/email/ingest/route.ts` and `workers/email-ingest/wrangler.jsonc`, when the change is complete, then `git status` shows them unmodified.

## Spec Change Log

## Review Triage Log

## Design Notes

The clamp is a ceiling, not a re-derivation. Both terms stay exported so each keeps its own tests:

```ts
export const EMAIL_ROUTING_MAX_INBOUND_BYTES = 25 * 1024 * 1024; // 26,214,400
export const AGGREGATE_DERIVED_RAW_EMAIL_BYTES =
  Math.ceil(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES * WORST_CASE_TRANSFER_ENCODING_FACTOR) +
  MIME_ENVELOPE_HEADROOM_BYTES; // 65,496,679
export const MAX_RAW_EMAIL_BYTES = Math.min(
  AGGREGATE_DERIVED_RAW_EMAIL_BYTES,
  EMAIL_ROUTING_MAX_INBOUND_BYTES,
); // 26,214,400 today — the platform term binds
```

What the clamp costs, stated rather than discovered later: a maximally-escaped quoted-printable full-size document is 32,715,573 bytes on the wire and the whole aggregate is 65,431,170 — both above 25 MiB, so neither reaches the Worker under Email Routing at all. The surviving reachable admissions are base64 (a full-size document at 14,348,938 fits with 11.8 MB to spare) and roughly 8.0 MiB decoded under worst-case quoted-printable. That is a transport fact the clamp reports; it is not a narrowing this change chose.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts` -- expected: all pass
- `pnpm test` -- expected: no new failures against the pre-change baseline
- `pnpm lint` -- expected: clean
- `git status --porcelain src/app/api/email/ingest/route.ts workers/email-ingest/wrangler.jsonc` -- expected: empty
