---
title: 'DW-455: pay the maximal encoded body out of the aggregate document budget'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
baseline_revision: 'ababc29f27b98c830af660ec6eca65bd2819097b'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred:
  - summary: >-
      The envelope's new body term charges MAX_EMAIL_CONTENT_CHARS as if each UTF-16
      code unit were one byte, so it buys a maximal ASCII body only; a non-ASCII body
      of the same length is up to ~3x larger on the wire and is over the derivation.
    evidence: |-
      MIME_ENVELOPE_HEADROOM_BYTES adds Math.ceil(MAX_EMAIL_CONTENT_CHARS *
      WORST_CASE_TRANSFER_ENCODING_FACTOR) = 312,000, but MAX_EMAIL_CONTENT_CHARS
      bounds code units (rawContent.length / rawContent.slice at the Worker's
      truncation, content.length on the route). 100,000 non-ASCII BMP characters are
      up to ~300,000 decoded bytes and ~936,000 on the worst-case quoted-printable
      wire, against 312,000 bought plus 65,509 bytes of structural slack. 312,000 is
      the figure the recorded DW-455 decision named, so it was documented rather than
      re-derived. Inert today: since DW-449 the Math.min picks
      EMAIL_ROUTING_MAX_INBOUND_BYTES, so AGGREGATE_DERIVED_RAW_EMAIL_BYTES gates
      nothing -- it becomes live only if the platform ceiling rises above the
      derivation (the open DW-457 question).
    location: >-
      workers/email-ingest/index.ts (MIME_ENVELOPE_HEADROOM_BYTES)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `MIME_ENVELOPE_HEADROOM_BYTES = 64 KiB` (`workers/email-ingest/index.ts`) claims to cover "an ordinary text body", but a maximal body is `MAX_EMAIL_CONTENT_CHARS` (100,000) characters, which reaches `ceil(100_000 * QUOTED_PRINTABLE_EXPANSION_FACTOR) = 312,000` bytes on the worst-case wire — 4.8x the whole headroom. The envelope allowance is therefore dishonest about a body shape the Worker itself admits and truncates to.

**Approach:** Make the envelope honest without widening the raw cap (recorded human decision, option 1). Split the headroom into a structural term (`MIME_STRUCTURAL_HEADROOM_BYTES`, the existing 64 KiB for part headers, boundaries and the per-part ratio undercount) plus a derived worst-case encoded-body term, and pay for that body out of `AGGREGATE_DOCUMENT_AVERAGE_BYTES` — a nominal 2 MiB average less each attachment's share of `MAX_EMAIL_CONTENT_CHARS` decoded bytes. Because a decoded body byte and a decoded attachment byte cost the same on the wire, the freed decoded bytes buy exactly the wire bytes the body needs, and `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` stays at 65,496,679.

## Boundaries & Constraints

**Always:**
- `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` must not grow. Pin it against the pre-DW-455 nominal derivation (`ceil(MAX_EMAIL_ATTACHMENTS * AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES * WORST_CASE_TRANSFER_ENCODING_FACTOR) + MIME_STRUCTURAL_HEADROOM_BYTES`), never against a hand-typed snapshot.
- Every derived figure quoted in a comment, README line or test premise must be recomputed, not left stale.
- `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` keeps its `Math.max(MAX_EMAIL_DOCUMENT_BYTES, ...)` floor and stays an integer; the subtracted body share is rounded UP (against the budget), so the budget can never round in its own favour.
- `MAX_EMAIL_CONTENT_CHARS` keeps its value and its parity pin against `src/lib/email-ingest.ts`; only its declaration position moves.

**Block If:**
- Preserving `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` turns out to require changing `MAX_EMAIL_ATTACHMENTS`, `MAX_EMAIL_DOCUMENT_BYTES`, `MAX_EMAIL_CONTENT_CHARS`, `EMAIL_ROUTING_MAX_INBOUND_BYTES` or either expansion factor.

**Never:**
- Do not widen `MAX_RAW_EMAIL_BYTES`, re-derive the headroom upward, or touch the DW-449 platform clamp (that is DW-457's question, still open).
- Do not lower `MAX_EMAIL_DOCUMENT_BYTES`, `MAX_EMAIL_ATTACHMENTS` or `MAX_EMAIL_CONTENT_CHARS`.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.
- Do not change the selection-loop, parsing, allowlist or acknowledgement WORDING (the quoted budget figure moves only because it is derived).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Envelope covers a maximal body | ten parts of `AGGREGATE_DOCUMENT_AVERAGE_BYTES` plus a `MAX_EMAIL_CONTENT_CHARS` body, all quoted-printable at k=25 | Wire size 65,431,170 — under `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` (65,496,679), leaving 65,509 bytes for headers and boundaries | No error expected |
| Derivation did not widen | the constants as edited | `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` <= the nominal-average derivation with the old structural-only headroom | No error expected |
| Bounded limit still exists | same aggregate + maximal body wrapped at 72 columns (k=24) | 65,536,011 — over `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`; the known, recorded limit | Refused at the gate |
| Aggregate alone, narrower wraps | ten parts at k=24..k=22, no body | Now fit under the derivation (65,223,510 / 65,336,940 / 65,460,690); k=21 does not | No error expected |
| Quoted budget follows the constant | over-budget message arrives | Acknowledgement quotes `Math.floor(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES / 1024 / 1024)` = 19 MB, not 20 | Loss line unchanged in wording |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts` -- all constants. `MAX_EMAIL_ATTACHMENTS` :57; `AGGREGATE_DOCUMENT_AVERAGE_BYTES` :74 (declared BEFORE the encoding factors); `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` :117-120; `MAX_EMAIL_AGGREGATE_DOCUMENT_MB` :130-132 (feeds the reply line at :976); `BASE64_EXPANSION_FACTOR` :140; `QUOTED_PRINTABLE_EXPANSION_FACTOR` :175; `WORST_CASE_TRANSFER_ENCODING_FACTOR` :190-193; `MIME_ENVELOPE_HEADROOM_BYTES` :213; `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` :274-276; `EMAIL_ROUTING_MAX_INBOUND_BYTES` :291; `MAX_RAW_EMAIL_BYTES` :313-316; `MAX_EMAIL_CONTENT_CHARS` :330 (must move ABOVE `AGGREGATE_DOCUMENT_AVERAGE_BYTES` — module-scope `const` ordering).
- `src/lib/__tests__/email-ingest-wire.ts` -- `quotedPrintablePartWireSize(bytes, escapesPerLine = 25)` and `base64PartWireSize`. Read-only; the shared, calibrated wire formulas. Do not duplicate.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- imports at :11-25; aggregate-reach case at :233-271 (the k=24 bounded-limit assertion at :267-270 becomes reachable after this change and must be re-aimed); budget-floor case at :278-297.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- `AGGREGATE_BUDGET_MB` :739 (derived; comment at :733-738 claims 20 MiB is MiB-aligned, no longer true); aggregate-wire refusal case :2972-2996 (prose figure 65,431,170); **the trade-off case at :3060-3120 inverts** — a full aggregate plus a maximal body now fits under the derivation. All fixture arithmetic at :1825, :2278, :2353, :2539 is derived and stays valid (verified: 5,192,881 / 10,435,760 / 9,337,184, all integral and inside their ceilings).
- `workers/email-ingest/README.md` -- :21, :26, :56 quote "20 MB" and "ten 2 MiB parts"; must follow the constant.
- Read-only evidence: nothing outside these four files references `AGGREGATE_DOCUMENT_AVERAGE_BYTES`, `MIME_ENVELOPE_HEADROOM_BYTES`, `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` or `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` (verified by repo grep; only prior spec/ledger prose does).

## Tasks & Acceptance

**Execution:**
- `workers/email-ingest/index.ts` -- Move the `MAX_EMAIL_CONTENT_CHARS` doc block and declaration above `AGGREGATE_DOCUMENT_AVERAGE_BYTES`, noting it is now a term of the envelope derivation as well as a parity duplicate -- module-scope ordering forces it, and the move is what lets the body be paid for at the source.
- `workers/email-ingest/index.ts` -- Add `AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES = 2 * 1024 * 1024` (exported) and redefine `AGGREGATE_DOCUMENT_AVERAGE_BYTES` as that nominal less `Math.ceil(MAX_EMAIL_CONTENT_CHARS / MAX_EMAIL_ATTACHMENTS)` -- this is the "pay for the body out of the average" half of the decision; rounding the share UP keeps the budget integral and never in its own favour.
- `workers/email-ingest/index.ts` -- Add `MIME_STRUCTURAL_HEADROOM_BYTES = 64 * 1024` (exported) and redefine `MIME_ENVELOPE_HEADROOM_BYTES` as that plus `Math.ceil(MAX_EMAIL_CONTENT_CHARS * WORST_CASE_TRANSFER_ENCODING_FACTOR)` -- the honest-envelope half; both terms stay live and named, matching the `Math.max`/`Math.min` idiom used by the neighbouring constants.
- `workers/email-ingest/index.ts` -- Rewrite the affected doc comments (`AGGREGATE_DOCUMENT_AVERAGE_BYTES`, `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`, `QUOTED_PRINTABLE_EXPANSION_FACTOR`, `MIME_ENVELOPE_HEADROOM_BYTES`, `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`, `MAX_RAW_EMAIL_BYTES`) so every quoted figure is the recomputed one and the "not enough for a maximal body / both extremes do not fit" trade-off is replaced by what now holds -- the comment being wrong about the body is the defect itself.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- Re-aim the aggregate-reach case: assert the envelope now covers `MAX_EMAIL_CONTENT_CHARS` on the worst-case wire, re-point the bounded-limit assertion at aggregate-plus-body (k=25 fits, k=24 does not), and add the non-widening pin against the nominal derivation -- the allowlist-parity suite is the named home for every claim about the derivation.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- Invert the `bounces a full aggregate of documents carried alongside a maximal body` case into one that observes the aggregate-plus-maximal-body message fitting under the derivation and being refused ONLY by the DW-449 clamp, measuring the body on the quoted-printable wire rather than as a raw character count; refresh the stale 20 MiB / 65,431,170 prose in the neighbouring cases -- the old case pins the exact trade-off this change removes.
- `workers/email-ingest/README.md` -- Update the aggregate figure (20 MB -> 19 MB, three places) and the base64 reachability bullet's part size -- the README is the sender-facing record of the same constants.

**Acceptance Criteria:**
- Given the edited constants, when `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` is compared with `ceil(MAX_EMAIL_ATTACHMENTS * AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES * WORST_CASE_TRANSFER_ENCODING_FACTOR) + MIME_STRUCTURAL_HEADROOM_BYTES`, then it is not greater — the honest envelope costs the raw cap nothing.
- Given `MAX_RAW_EMAIL_BYTES`, when it is read after the change, then it is still `EMAIL_ROUTING_MAX_INBOUND_BYTES` (26,214,400) and no refusal figure quoted to a sender changes.
- Given the full suite, when `npx vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts` is run, then every case passes with no assertion left commented out or weakened to a tautology.
- Given `workers/email-ingest/index.ts` after the change, when its constant comments are read, then no sentence claims the headroom excludes a maximal body, and every byte figure in them matches the recomputed values.

## Spec Change Log

No bad_spec loopback occurred; the spec was not amended.

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[medium]` `[patch]` `MIME_ENVELOPE_HEADROOM_BYTES` claimed to buy "a maximal body" while charging `MAX_EMAIL_CONTENT_CHARS` code units as bytes — the claim was narrowed to a maximal ASCII body, the non-ASCII shortfall stated with its figures, and "both extremes at once are what this is sized for" replaced by the two shapes still over the derivation.
  - `[medium]` `[patch]` The payment's cost was unrecorded: the old budget was exactly `2 * MAX_EMAIL_DOCUMENT_BYTES`, so two documents at the advertised per-document ceiling used to fit and now do not. Stated in the `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` comment and the README, and pinned by a new derived parity case.
  - `[low]` `[patch]` The parity header/boundary margin charged ten parts against an eleven-part measured shape; now `MAX_EMAIL_ATTACHMENTS + 1`, since the body part pays for its own headers and boundary.
  - `[low]` `[patch]` The `ceil(...) + 377,536 === ceil(...) + 65,536` cancellation was stated as an identity; annotated as a property of today's divisible values, with the always-true "never wider" guarantee named as what the parity suite actually pins.
  - `[low]` `[patch]` README said both quoted figures "are themselves binary megabytes" (true only for 10 MB) and never said why the budget is 19; both fixed.

## Design Notes

The identity that makes option 1 exact: the body and the attachments are both charged at `WORST_CASE_TRANSFER_ENCODING_FACTOR`, so surrendering `MAX_EMAIL_CONTENT_CHARS` decoded bytes of aggregate budget buys precisely the `ceil(MAX_EMAIL_CONTENT_CHARS * f)` wire bytes the body needs.

```ts
const AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES = 2 * 1024 * 1024;              // 2,097,152
const AGGREGATE_DOCUMENT_AVERAGE_BYTES =                                        // 2,087,152
  AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES - Math.ceil(MAX_EMAIL_CONTENT_CHARS / MAX_EMAIL_ATTACHMENTS);
const MIME_ENVELOPE_HEADROOM_BYTES =                                            // 377,536
  MIME_STRUCTURAL_HEADROOM_BYTES + Math.ceil(MAX_EMAIL_CONTENT_CHARS * WORST_CASE_TRANSFER_ENCODING_FACTOR);
// ceil(20,871,520 * 3.12) + 377,536 === ceil(20,971,520 * 3.12) + 65,536 === 65,496,679
```

Recomputed figures to use in prose: aggregate on the wire 65,119,170 (was 65,431,170); ratio value at the budget 65,119,143; aggregate + maximal body 65,431,170 at k=25 (65,509 bytes of structural slack left) and 65,536,011 at k=24 (over — the bounded limit, which simply moved from the bare aggregate to the aggregate-with-body); quoted budget 19 MB (was 20).

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts` -- expected: all pass.
- `npx tsc --noEmit` -- expected: no new errors.
- `npx eslint workers/email-ingest/index.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** `MIME_ENVELOPE_HEADROOM_BYTES` no longer claims a flat 64 KiB covers "an ordinary text body". It is now `MIME_STRUCTURAL_HEADROOM_BYTES` (the same 64 KiB, for part headers, boundaries and the per-part ratio undercount) plus `Math.ceil(MAX_EMAIL_CONTENT_CHARS * WORST_CASE_TRANSFER_ENCODING_FACTOR)` = 312,000, and that body term is paid for out of `AGGREGATE_DOCUMENT_AVERAGE_BYTES`: a new `AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES` of 2 MiB less each attachment's share of `MAX_EMAIL_CONTENT_CHARS`, giving 2,087,152. Because body bytes and attachment bytes are charged the same factor the two edits cancel: `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` is unchanged at 65,496,679 and `MAX_RAW_EMAIL_BYTES` is still the 26,214,400 DW-449 clamp, so no figure quoted to a sender about the raw gate moved. The aggregate attachment budget falls 20,971,520 -> 20,871,520 and the acknowledgement's derived figure with it (20 MB -> 19 MB); the cost that carries — two documents at the advertised 10 MB per-document ceiling no longer both fit — is recorded in the constant, the README and a parity assertion.

**Files changed.**
- `workers/email-ingest/index.ts` — the derivation itself: `MAX_EMAIL_CONTENT_CHARS` moved above the constants that now read it, `AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES` and `MIME_STRUCTURAL_HEADROOM_BYTES` added, `AGGREGATE_DOCUMENT_AVERAGE_BYTES` and `MIME_ENVELOPE_HEADROOM_BYTES` redefined, and every affected doc comment rewritten with recomputed figures.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — aggregate-reach case re-aimed at aggregate-plus-body, the bounded quoted-printable wrap edge re-pinned on both sides (aggregate alone k=24 and k=22 fit, k=21 over; with a body k=25 fits, k=24 over), plus two new cases: non-widening against the recomputed nominal derivation, and the two-full-size-documents cost.
- `src/lib/__tests__/email-ingest-worker.test.ts` — the trade-off case inverted into an admission case measuring the body on the quoted-printable wire, with a structural-only counter-check so it cannot pass on slack; stale 20 MiB / 65,431,170 / ~27.4 MiB prose refreshed.
- `workers/email-ingest/README.md` — the sender-facing budget figure, why it is 19 rather than 20, the two-full-size-documents consequence, and the exact-vs-floored distinction between the two quoted megabyte figures.

**Review findings breakdown.** 5 patches applied (2 medium, 3 low), 1 item deferred (low), 7 rejected. 0 intent gaps, 0 bad-spec loopbacks.

**Follow-up review recommendation.** Patched findings this pass: high 0, medium 2, low 3. Score = 3 x 2 + 1 x 3 = 9, which is >= 5, so `followup_review_recommended: true`.

**Verification performed.**
- `npx vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts` — 103 passed, 0 failed.
- `npx vitest run` (whole repo) — 359 files, 8,733 passed, 1 skipped (the skip is pre-existing).
- `npx tsc --noEmit` — clean. `npx eslint` on both edited test files — clean (`workers/email-ingest/index.ts` sits inside a pre-existing eslint ignore pattern).
- Evaluated the edited module directly: `AVG 2,087,152 / AGG 20,871,520 / STRUCT 65,536 / HEAD 377,536 / DER 65,496,679 / MAX_RAW 26,214,400`, with `DER <= nominalDerivation` and `MAX_RAW === EMAIL_ROUTING_MAX_INBOUND_BYTES` both true.
- Matrix audit: all five I/O rows are covered by cases that ran and passed — rows 1 and 3 by the re-aimed parity case and the inverted worker case, row 2 by the new non-widening case, row 4 by the k=24/k=22/k=21 edge assertions, row 5 by the acknowledgement expectations built from the derived `AGGREGATE_BUDGET_MB`.

**Residual risks.**
- The body term charges `MAX_EMAIL_CONTENT_CHARS` code units as bytes, so it buys a maximal ASCII body only. Documented at the constant and carried in frontmatter `deferred`; inert while the DW-449 clamp binds.
- The advertised budget drops a full megabyte (20 -> 19) from a 0.48% real reduction, because `MAX_EMAIL_AGGREGATE_DOCUMENT_MB` floors to whole MiB while `MAX_RAW_EMAIL_MB` two constants away quotes one decimal. Rounding stays in the safe direction (never larger than enforced), and changing sender-facing copy was outside this intent, so it was left alone.
- Prettier was not run: these four files were already unformatted before this change, and formatting them would bury the diff.
