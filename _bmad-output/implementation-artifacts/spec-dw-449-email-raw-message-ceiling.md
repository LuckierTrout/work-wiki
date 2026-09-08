---
title: 'Clamp the raw-email cap to Cloudflare Email Routing''s verified inbound ceiling'
type: 'bugfix'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The 20 MB aggregate attachment budget quoted to accepted senders is itself
      unreachable over Email Routing, so the same defect DW-449 fixed for the
      refusal copy survives at the acknowledgement.
    evidence: |-
      `MAX_EMAIL_AGGREGATE_DOCUMENT_MB` is quoted in the over-budget
      acknowledgement (`workers/email-ingest/index.ts`, "the 20 MB total
      attachment budget"), but 20 MiB of decoded payload is ~27.4 MiB of base64
      and ~62 MiB of quoted-printable — both above the 25 MiB inbound ceiling
      this bundle just recorded. It is reachable only from a client sending
      unencoded (`7bit`/`8bit`) parts, which is not a shape any mainstream client
      emits for the PDF/DOCX/XLSX formats the Worker advertises. `README.md`
      records the arithmetic honestly, but the sender-facing sentence still names
      a budget no real message can spend, and the DW-360 selection loop it
      guards is correspondingly unreachable in the field — the suite now has to
      build synthetic `7bit` PDF fixtures to exercise it at all. Out of scope
      here: the recorded decision named only `MAX_RAW_EMAIL_BYTES`, and lowering
      the budget moves constants this spec's Block If holds back.
    location: >-
      workers/email-ingest/index.ts (MAX_EMAIL_AGGREGATE_DOCUMENT_MB acknowledgement copy)
    severity: low
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

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 1, low 8)
- defer: 1: (high 0, medium 0, low 1)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[medium]` `[patch]` `expectResendableRefusal` bounded the quoted figure only from ABOVE, so a regression shrinking `MAX_RAW_EMAIL_MB` to "0.0 MB" or "18.2 MB" passed every refusal case — the exact DW-449 defect inverted, and silently contradicting the 25.0 MB the README documents. The helper now pins the figure to within one displayed step (0.1 MB) of the enforced cap, so it says "the figure IS the cap, rounded down".
  - `[low]` `[patch]` The helper's `/larger than ([\d.]+) MB/` matched the first such phrase anywhere in the reply and could drift onto the Worker's per-document `larger than 10 MB` sentence — anchored to the raw-gate sentence.
  - `[low]` `[patch]` `PART_LINE_CHARS = 76` was wrong twice: `asciiPartBytes` marks lines at 75 payload characters, and the "and for base64" claim was false since `base64Lines` never reads it — renamed `ASCII_PART_LINE_STRIDE` and re-documented.
  - `[low]` `[patch]` `literalLines`' tail branch was unreachable and would have decoded one byte short if reached, and its `String.fromCharCode(...)` spread is only safe because markers cap chunks at 75 — branch dropped, both preconditions asserted and documented.
  - `[low]` `[patch]` README mixed decimal MB and MiB across one bullet list and misdescribed the operator-facing symptom as a "silent bounce" — units committed to MiB and labelled, figures corrected (~13.7 MiB, ~27.4 MiB), and the real symptom stated: an SMTP-time rejection whose delivery-failure notice comes from the sender's own provider, with nothing logged by work-wiki.
  - `[low]` `[patch]` The aggregate-budget suite's doc explained why base64 stopped working but not that the surviving `7bit` printable-ASCII PDF shape is synthetic — recorded, so the suite is not read as evidence the budget is reachable in the field.
  - `[low]` `[patch]` `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` gates nothing today, leaving `WORST_CASE_TRANSFER_ENCODING_FACTOR` and `MIME_ENVELOPE_HEADROOM_BYTES` as unreachable arithmetic — its comment now says so plainly and states what would make it bind again.
  - `[low]` `[patch]` Two renamed parity cases asserted a refusal their titles did not mention — titles now cover both halves.
  - `[low]` `[patch]` Inverting the two quoted-printable gate cases left no POSITIVE quoted-printable coverage at a gate-relevant size — added a forward case derived through `quotedPrintablePartWireSize`, pinning the ~8 MiB of QP payload the clamp still admits.

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

## Auto Run Result

Status: done

**Implemented change.** Cloudflare Email Routing's inbound per-message ceiling was verified at **25 MiB** against two independent Cloudflare doc pages — the Email Routing limits page ("Inbound message size: 25 MiB. Messages larger than this are rejected.") and the Email Workers guide, whose own size-check example reads `message.rawSize > 25 * 1024 * 1024`. That figure is now an exported constant, and the enforced raw cap is `Math.min` of it and the aggregate derivation, so the refusal quotes 25.0 MB instead of a 62.4 MB the transport had already rejected.

**Files changed**
- `workers/email-ingest/index.ts` — added `EMAIL_ROUTING_MAX_INBOUND_BYTES`, renamed the derivation to `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`, clamped `MAX_RAW_EMAIL_BYTES` with `Math.min`, and corrected every comment that stated 62.4 MB / 65,496,679 as the enforced gate.
- `workers/email-ingest/README.md` — records the 25 MiB ceiling, its source URL and verification date, the per-encoding consequence for each advertised figure, and the operator-facing symptom of an upstream rejection.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — derivation assertions re-pointed at the derived constant; new case pinning the clamp itself.
- `src/lib/__tests__/email-ingest-worker.test.ts` — the two quoted-printable gate cases inverted to refusals with a shared `expectResendableRefusal`, a positive QP case added, and the over-budget fixtures moved to unencoded (`7bit`) parts so DW-360's bound stays reachable under a 25 MiB gate.

**Review findings.** 9 patched (1 medium, 8 low), 1 deferred (low), 7 rejected. Follow-up review recommended: **true** — score 11 (3 x 1 medium + 1 x 8 low), at or above the threshold of 5.

**Verification**
- `npx vitest run` on the three email-ingest suites: 101 passed.
- Full suite: 357 files / 8556 passed, 1 skipped, 0 failed. (An earlier full run showed 82 failures — all 5s timeouts and `ENOTEMPTY` temp-dir races from a concurrent session; that run took 275s against this one's 139s, and the failures did not recur.)
- `npx tsc --noEmit` clean; `npx eslint` clean on the touched test files.
- Mutation A — `Math.min` replaced by the derived term alone: 5 failures, including `expected 65431142.4 to be less than or equal to 26214400`. The clamp is load-bearing.
- Mutation B — a stray `/1024` in `MAX_RAW_EMAIL_MB`: 3 failures on the new lower bound, which the pre-review helper passed.
- Forbidden files (`src/app/api/email/ingest/route.ts`, `workers/email-ingest/wrangler.jsonc`, `deferred-work.md`) unmodified.

**Residual risks**
- The 25 MiB figure is documentation-sourced, not probed against a live Email Routing address. The constant and the README both name the source so it can be re-verified.
- Clamping to exactly the platform ceiling makes the Worker's own gate effectively unreachable in production: anything above 25 MiB is refused upstream, so the corrected refusal copy is defence-in-depth rather than a message senders will routinely see. Keeping a band below the ceiling in which the Worker could refuse and explain was not what the recorded decision asked for.
- DW-360's decoded-budget selection loop is now exercised only through synthetic unencoded (`7bit`) `application/pdf` fixtures — the only shape that can carry an over-budget payload through a 25 MiB gate. The suite records this; the underlying reachability question is the deferred finding above.
- A concurrent `bmad-loop` session shares this working copy. It rewrote history and absorbed this run's first-pass commit into its own sweep commit; its in-flight files (`src/lib/ingest.ts`, `src/lib/__tests__/ingest.test.ts`, `src/lib/__tests__/tasks-route.test.ts`, `spec-dw-427-ingest-fresh-merge-bases.md`) were left untouched and uncommitted by this session.
