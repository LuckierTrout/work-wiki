---
title: 'Email-ingest budget copy and ledger citations (DW-697, DW-706)'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
baseline_revision: 'ccd301bbdae4255a3cd8b76715a941c445c57336'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The over-budget acknowledgement quotes `MAX_EMAIL_AGGREGATE_DOCUMENT_MB` (19 MB) as the total attachment budget, but 20,671,520 decoded bytes is ~27.9 MiB of base64 and ~61.5 MiB of quoted-printable — both above the 26,214,400-byte `MAX_RAW_EMAIL_BYTES` gate — so the figure is spendable only by an unencoded `7bit`/`8bit` sender, a shape no mainstream client emits for the PDF/DOCX/XLSX formats this Worker advertises, and the DW-360 selection loop it guards is reachable only through synthetic `7bit` fixtures (DW-697). Separately, twelve email-ingest code and test sites cite `DW-457` for the inbound-ceiling provenance decision, but the ledger entry under that id is an unrelated, already-closed MCP `missing-concept-page` slug-parity defect that three MCP sites legitimately cite (DW-706).

**Approach:** Add a clamp above the aggregate derivation — a new exported term for what `MAX_RAW_EMAIL_BYTES` can actually carry as decoded attachment bytes under base64, and a new exported enforced budget that is the lower of the derivation and that carrying capacity (still floored at one full-size document) — then point the selection loop, the quoted MB and the README arithmetic at the enforced figure and repoint the DW-360 fixtures at base64 so they exercise a budget a real message can spend. Independently, rewrite the twelve email-ingest `DW-457` citations to `DW-706`, leaving every MCP citation untouched.

## Boundaries & Constraints

**Always:**
- `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`, `AGGREGATE_DOCUMENT_AVERAGE_BYTES`, `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`, `MIME_ENVELOPE_HEADROOM_BYTES`, `WORST_CASE_TRANSFER_ENCODING_FACTOR`, `EMAIL_ROUTING_MAX_INBOUND_BYTES` and `MAX_RAW_EMAIL_BYTES` keep their current values and their current expressions. The clamp sits ABOVE the derivation, exactly as the DW-449 clamp sits above `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`; it must not feed back into any term of it (that would be circular).
- The new enforced budget keeps the `Math.max(MAX_EMAIL_DOCUMENT_BYTES, …)` floor, so one full-size document is still admissible (DW-104/DW-358), and both terms of every new `Math.min`/`Math.max` stay named and exported — this module's stated idiom.
- The quoted MB is still `Math.floor(bytes / 1024 / 1024)`: a sender is never told the budget is larger than the one enforced.
- Every figure this change moves is derived from exported constants in code and in tests, never hand-typed — except figures the existing comments mark as HISTORICAL, which stay frozen.
- The refusal copy's `25.0 MB` and `MAX_RAW_EMAIL_BYTES` are unchanged: the clamped budget's own derivation (`ceil(enforced × worst-case) + headroom`) still exceeds `EMAIL_ROUTING_MAX_INBOUND_BYTES`, so the `Math.min` in `MAX_RAW_EMAIL_BYTES` still selects the platform term. Verify this rather than assume it.
- Citation edits are text-only: no `DW-457` → `DW-706` rewrite may change an expression, an assertion or a value.

**Block If:**
- The clamped budget would drop to the `MAX_EMAIL_DOCUMENT_BYTES` floor (i.e. the base64 carrying capacity computes below 10,485,760), which would collapse the aggregate budget onto the per-document ceiling and retire DW-362 wholesale — a product decision, not a copy fix.
- `MAX_RAW_EMAIL_BYTES` or the quoted `25.0 MB` refusal figure moves as a consequence of the clamp.

**Never:**
- Do not touch `src/mcp.ts:1283`, `src/mcp.ts:2633`, `src/lib/mcp-http.ts:718`, or the `DW-457` citations in `src/lib/__tests__/mcp.test.ts` and `src/lib/__tests__/mcp-http.test.ts` — those name the real DW-457 entry.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`, `deferred-work-archive.md`, or any existing spec under `_bmad-output/` (historical `DW-457` mentions there are the record, not citations to fix).
- Do not widen `MAX_RAW_EMAIL_BYTES`, re-derive the headroom, mint a new ledger id, or change the per-document ceiling, the attachment count cap, the inline/eligibility rules or any loss-accounting term.
- Do not delete the derivation constants the clamp now bounds — they stay as the record of what the budget NEEDS the door to be, the way `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` is kept while dormant.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Base64 sender spends the whole budget | Supported attachments totalling exactly the enforced budget, base64, message under the raw gate | All parts forwarded; no over-budget sentence | No error expected |
| Base64 sender exceeds the budget | Attachments totalling more than the enforced budget while the wire size stays under `MAX_RAW_EMAIL_BYTES` | The over-budget parts are skipped (`continue`, not `break`), named and counted; acknowledgement quotes the NEW MB figure | No error expected |
| Boundary | Selection landing exactly on the enforced budget, next part one byte | Selection forwarded whole; the one-byte part refused (`>` not `>=`) | No error expected |
| Single part above the budget | One supported part larger than the enforced budget | Refused as OVERSIZED by the per-document ceiling first (floor keeps budget ≥ one document); reply says "larger than 10 MB", never "total attachment budget" | No error expected |
| Message above the raw gate | Wire size over `MAX_RAW_EMAIL_BYTES` | Unchanged: refused at the door quoting `25.0 MB` | Existing refusal path |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts` — the whole of DW-697.
  - `:46` `MAX_EMAIL_DOCUMENT_BYTES` = 10,485,760; `:52` `MAX_EMAIL_DOCUMENT_MB` = 10. `:58` `MAX_EMAIL_ATTACHMENTS` = 10.
  - `:163-165` `AGGREGATE_DOCUMENT_AVERAGE_BYTES` = 2,067,152. `:245-249` `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` = `Math.max(MAX_EMAIL_DOCUMENT_BYTES, 10 × avg)` = 20,671,520 — READ-ONLY, the derivation record.
  - `:254-256` `MAX_EMAIL_AGGREGATE_DOCUMENT_MB` = `Math.floor(… / 1024 / 1024)` = 19 — the quoted figure; must move BELOW the new enforced constant and derive from it.
  - `:262` `BASE64_EXPANSION_FACTOR` = `(4/3) × (78/76)` ≈ 1.368421; `:285` `QUOTED_PRINTABLE_EXPANSION_FACTOR` = 3.12; `:311` the DW-457 citation in its comment.
  - `:347` `MIME_STRUCTURAL_HEADROOM_BYTES` = 65,536; `:420-422` `MIME_ENVELOPE_HEADROOM_BYTES` = 1,001,536. `:501-503` `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` = 65,496,679; `:493` DW-457 citation.
  - `:531` `EMAIL_ROUTING_MAX_INBOUND_BYTES` = 26,214,400; `:512` DW-457 citation. `:564-567` `MAX_RAW_EMAIL_BYTES` = `Math.min(…)` = 26,214,400; `:551` DW-457 citation. `:571-575` `MAX_RAW_EMAIL_MB` = "25.0".
  - `:1101-1146` the selection loop and its comments; `:1146` is the enforced gate `aggregateBytes + size > MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`.
  - `:1218-1224` `overBudgetLine`, the sender-facing sentence quoting `MAX_EMAIL_AGGREGATE_DOCUMENT_MB`.
  - Comments stating the old figures that this change falsifies: `:167-168` ("20,671,520 … quoted to senders as 19 MB"), `:232-234` ("~19 MB under the 25 MiB figure the DW-449 clamp actually enforces"), `:1124-1136`.
- `workers/email-ingest/README.md` — the sender-facing arithmetic. `:26` ("the 19 MB total attachment budget"), `:69-80` (the "10 MB"/"19 MB" paragraph, the `~19.71 MiB rounded DOWN to 19` sentence, and the three wire-size bullets including "ten ~1.97 MiB parts are ~27.0 MiB encoded"), `:30-33` (two full-size documents no longer both fit — still true, re-check the wording).
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — pins the DERIVATION. `:180-224`, `:255-380`, `:389-400`, `:428-446`, `:487-520` all assert against `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` / `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`, which do not move: these must keep passing verbatim. This is where the NEW constants' invariants belong.
- `src/lib/__tests__/email-ingest-worker.test.ts` — the DW-360 behavioural suite.
  - `:504-533` `asciiPartBytes` (the `7bit` payload generator) and `:535-560` `literalLines`; `:600`,`:642-643`,`:670` the builder's `encoding` switch (`base64` | `quoted-printable` | `7bit`).
  - `:731-738` `AGGREGATE_BUDGET_MB`; `:740-751` `PART_BYTES` = 7 MiB; `:753-780` `overBudgetFixture` (three `7bit` parts + tail).
  - `:970-980` the refusal-suite reuse of that fixture; `:2247-2270` the suite docblock declaring the fixture SYNTHETIC and unreachable in the field — the prose DW-697 retires.
  - `:2271-2330` "stops appending parts once the decoded budget is spent"; `:2331-2340` "clears the raw gate"; `:2353-2412` `ON_BUDGET_HALF` / `onBudgetFixture` and the exact-boundary case; `:2413-2441` the name-cap case; `:2443-2500` the no-body-exit case (`MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES + 1`); `:2523-2670` the all-losses-at-once case (`LEAD_PART_BYTES` / `SECOND_LEAD_BYTES` / `OVER_BUDGET_PART_BYTES` / `HEADROOM`).
  - DW-457 citations at `:759`, `:2754`, `:2771`, `:2938`, `:2986`.
- DW-706 citation sites (12, all email): `workers/email-ingest/index.ts:312,493,512,551`; `src/lib/__tests__/email-ingest-allowlist-parity.test.ts:174,487,506`; `src/lib/__tests__/email-ingest-worker.test.ts:759,2754,2771,2938,2986`.
- READ-ONLY DW-457 sites (leave alone): `src/mcp.ts:1283,2633`; `src/lib/mcp-http.ts:718`; `src/lib/__tests__/mcp.test.ts:3110,3228,3309`; `src/lib/__tests__/mcp-http.test.ts:2158`.

## Tasks & Acceptance

**Execution:**
1. `workers/email-ingest/index.ts` — after `MAX_RAW_EMAIL_BYTES`, add exported `RAW_CARRIED_AGGREGATE_DOCUMENT_BYTES` = `Math.floor((MAX_RAW_EMAIL_BYTES - MIME_ENVELOPE_HEADROOM_BYTES) / BASE64_EXPANSION_FACTOR)` (= 18,424,785) and exported `ENFORCED_AGGREGATE_DOCUMENT_BYTES` = `Math.max(MAX_EMAIL_DOCUMENT_BYTES, Math.min(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES, RAW_CARRIED_AGGREGATE_DOCUMENT_BYTES))` (= 18,424,785), documented in this module's voice: why base64 and not the worst case (no admissible budget is quoted-printable-reachable — the floor alone is 10 MiB and QP carries ~7.7 MiB — so "reachable" can only mean reachable by the cheapest encoding a real client emits for the advertised formats), what the clamp costs (2,246,735 decoded bytes that only an unencoded sender could ever have spent, so no base64 or quoted-printable message changes outcome), and that it sits above the derivation and feeds back into no term of it. — DW-697: the quoted budget must be one a real message can spend.
2. `workers/email-ingest/index.ts` — move `MAX_EMAIL_AGGREGATE_DOCUMENT_MB` below the new constants and derive it from `ENFORCED_AGGREGATE_DOCUMENT_BYTES`; point the selection gate at `:1146` at `ENFORCED_AGGREGATE_DOCUMENT_BYTES`. — the sentence and the gate must name the same budget.
3. `workers/email-ingest/index.ts` — correct every comment this falsifies (`:167-168`, `:232-234`, `:1101-1136`, and the aggregate constant's own docblock) so no comment states 19 MB / 20,671,520 as the enforced or quoted budget, and the derivation constants are described as the record the clamp bounds. — comments here are the module's primary documentation.
4. `workers/email-ingest/README.md` — restate the arithmetic: the quoted total is now the clamped figure, the "not reachable in base64" bullet becomes the statement that the budget IS now reachable in base64 (with what a full-budget message costs on the wire against the 25 MiB ceiling), and the quoted-printable bullet keeps its ~8 MiB figure. Every number recomputed, none copied. — the README is where the arithmetic is recorded honestly.
5. `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — add cases pinning the NEW constants: the clamp is the lower of the derivation and the carrying capacity; a message spending the whole enforced budget fits under `MAX_RAW_EMAIL_BYTES` on the base64 wire (measured through the existing `base64PartWireSize` helper, not restated); the enforced budget is at or above `MAX_EMAIL_DOCUMENT_BYTES`; `MAX_RAW_EMAIL_BYTES` is unchanged by the clamp (the clamped budget's own derivation still exceeds `EMAIL_ROUTING_MAX_INBOUND_BYTES`). Leave every existing case untouched. — the derivation-vs-enforced distinction is exactly what this suite exists to hold.
6. `src/lib/__tests__/email-ingest-worker.test.ts` — repoint the DW-360 suite: `AGGREGATE_BUDGET_MB` and every budget assertion move to `ENFORCED_AGGREGATE_DOCUMENT_BYTES`; `overBudgetFixture` and `onBudgetFixture` become `base64` with part sizes chosen so the whole message clears the raw gate (assert that, do not assume it) while the decoded total exceeds the budget; `ON_BUDGET_HALF` splits an odd budget as floor/ceil so the pair still lands EXACTLY on it; the all-losses case's `LEAD`/`SECOND_LEAD`/`OVER_BUDGET` arithmetic and the no-body-exit fixture re-derive from the enforced figure; rewrite the suite docblock at `:2247-2270` — the fixtures are no longer synthetic-only and the "unreachable in the field" claim is what this change retires. — DW-697's second half: the tests must exercise a reachable budget.
7. `workers/email-ingest/index.ts`, `src/lib/__tests__/email-ingest-allowlist-parity.test.ts`, `src/lib/__tests__/email-ingest-worker.test.ts` — rewrite the twelve `DW-457` citations listed in the Code Map to `DW-706`, text only. — DW-706: the id must resolve to the entry that records the email inbound-ceiling provenance.

**Acceptance Criteria:**
- Given the module's exported constants, when `ENFORCED_AGGREGATE_DOCUMENT_BYTES` is computed, then it is strictly below `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`, at or above `MAX_EMAIL_DOCUMENT_BYTES`, and a message carrying it as base64 attachments fits under `MAX_RAW_EMAIL_BYTES`.
- Given the clamp is in place, when `MAX_RAW_EMAIL_BYTES` and the over-size refusal are read, then both are unchanged (26,214,400 and "25.0 MB").
- Given a base64 message whose supported attachments exceed the enforced budget while its wire size stays under the raw gate, when the Worker handles it, then the over-budget parts are skipped and named, later smaller parts still fit, and the acknowledgement quotes `Math.floor(ENFORCED_AGGREGATE_DOCUMENT_BYTES / 1024 / 1024)` MB.
- Given `grep -rn "DW-457"` over `workers/` and `src/`, when the results are read, then no email-ingest site remains and `src/mcp.ts`, `src/lib/mcp-http.ts`, `src/lib/__tests__/mcp.test.ts` and `src/lib/__tests__/mcp-http.test.ts` are byte-for-byte unchanged.
- Given `workers/email-ingest/README.md`, when its size arithmetic is read, then no "19 MB"/"~19.71 MiB" budget figure survives and the stated wire sizes recompute correctly from the constants.

## Design Notes

Why a second constant rather than lowering `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` in place: `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` is `ceil(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES × worst-case) + headroom` and `MAX_RAW_EMAIL_BYTES` is the `Math.min` over it, so a budget derived from `MAX_RAW_EMAIL_BYTES` cannot also feed it. Splitting the derivation record from the enforced figure is the same shape DW-449 used one level up, and it leaves the parity suite's derivation pins intact.

```ts
export const RAW_CARRIED_AGGREGATE_DOCUMENT_BYTES = Math.floor(
  (MAX_RAW_EMAIL_BYTES - MIME_ENVELOPE_HEADROOM_BYTES) / BASE64_EXPANSION_FACTOR,
);
export const ENFORCED_AGGREGATE_DOCUMENT_BYTES = Math.max(
  MAX_EMAIL_DOCUMENT_BYTES,
  Math.min(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES, RAW_CARRIED_AGGREGATE_DOCUMENT_BYTES),
);
```

Working figures (recompute, do not trust): carried = `floor((26,214,400 − 1,001,536) / 1.3684210…)` = 18,424,785 (~17.57 MiB, quoted as **17 MB**); the clamp gives up 2,246,735 decoded bytes; `ceil(18,424,785 × 3.12) + 1,001,536` = 58,486,866 > 26,214,400, so `MAX_RAW_EMAIL_BYTES` is untouched. A three-part fixture of 6 MiB each totals 18,874,368 decoded (over budget by 449,583) and 25,828,083 wire bytes (~24.6 MiB) of base64 — under the raw gate, which is the reachability DW-697 asks for.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- expected: all pass, including every pre-existing derivation case unchanged.
- `pnpm vitest run src/lib/__tests__/mcp.test.ts src/lib/__tests__/mcp-http.test.ts` -- expected: all pass (the MCP DW-457 sites are untouched).
- `pnpm test` -- expected: full suite green.
- `pnpm lint` -- expected: clean.
- `grep -rn "DW-457" workers/ src/` -- expected: only the seven MCP sites listed in the Code Map.
- `git diff --stat -- src/mcp.ts src/lib/mcp-http.ts` -- expected: empty.

## Spec Change Log

_No loopback occurred; nothing amended._

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 0
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[medium]` `[patch]` The `ENFORCED_AGGREGATE_DOCUMENT_BYTES` docblock's "WHAT IT COSTS" paragraph claimed "no message that arrives today changes outcome" while the paragraph below it described the base64 band that now loses its last part, and it omitted the unencoded `7bit`/`8bit` narrowing in (18,424,785, 20,671,520] entirely — rewritten per encoding, recording the unencoded narrowing as an accepted cost.
  - `[medium]` `[patch]` The `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` docblock still named `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` as the post-decode bound and still listed `MIME_ENVELOPE_HEADROOM_BYTES` among terms "no message is ever measured against", though it now sets the enforced budget — both corrected, and `MIME_ENVELOPE_HEADROOM_BYTES`' own docblock gained a paragraph naming its second consumer.
  - `[low]` `[patch]` The DW-705 cost paragraph still described the band (20,671,520, 20,871,520] as one a sender meets; it now sits entirely above the enforced budget — corrected while kept as the derivation's record.
  - `[low]` `[patch]` 19,156,674 (the band's upper edge) was hand-typed in four prose sites and pinned by nothing — a new parity case now walks the edge through `base64PartWireSize`, pins both sides of it and the band's width, and names the prose sites that owe an update if it drifts.
  - `[low]` `[patch]` `src/lib/__tests__/email-ingest-worker.test.ts:979` still described the shared fixture as "three 7 MB parts" after it became three base64 parts of 6 MiB — corrected.
  - `[low]` `[patch]` Rewrapped the 141-character line introduced in `workers/email-ingest/README.md` and the orphaned short line left in `workers/email-ingest/index.ts`.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Two defects from bundle `email-ingest-copy-and-citations`.

DW-697 — the over-budget acknowledgement quoted a total attachment budget (19 MB / 20,671,520 decoded bytes) that only an unencoded `7bit`/`8bit` sender could ever spend: the same payload is ~27.0 MiB of base64 and ~61.5 MiB of quoted-printable, both far above the 26,214,400-byte `MAX_RAW_EMAIL_BYTES` gate. Two exported constants now sit ABOVE the derivation, never inside it: `RAW_CARRIED_AGGREGATE_DOCUMENT_BYTES` = `floor((MAX_RAW_EMAIL_BYTES − MIME_ENVELOPE_HEADROOM_BYTES) / BASE64_EXPANSION_FACTOR)` = 18,424,785, and `ENFORCED_AGGREGATE_DOCUMENT_BYTES` = `max(MAX_EMAIL_DOCUMENT_BYTES, min(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES, RAW_CARRIED_…))` = 18,424,785 (~17.57 MiB, quoted as 17 MB). The selection gate and the quoted MB both read the enforced figure, so the sentence and the gate name one budget. Every derivation constant keeps its value and its expression; `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` stays exported as the record of what the budget needs the door to be, the way `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` is kept while dormant. `MAX_RAW_EMAIL_BYTES` and the 25.0 MB refusal are unchanged and pinned as unchanged.

Deviation worth recording: the decision reads "what `MAX_RAW_EMAIL_BYTES` can actually carry under base64 **and** quoted-printable". Read conjunctively that yields ~7.71 MiB — below the `MAX_EMAIL_DOCUMENT_BYTES` floor, so the aggregate would collapse onto the per-document ceiling and retire DW-362 by side effect, and the quoted figure would still be quoted-printable-unreachable. No admissible budget is quoted-printable-reachable at all. The clamp therefore derives from base64 — the encoding mainstream clients emit for the PDF/DOCX/XLSX formats this Worker advertises — with quoted-printable's shorter reach recorded at the constant and pinned by a parity case that asserts the quoted-printable carry falls below the floor.

DW-706 — twelve email-ingest `DW-457` citations repointed to `DW-706`; the seven MCP citations of the real DW-457 entry are byte-for-byte untouched.

**Files changed**
- `workers/email-ingest/index.ts` — the two new constants and their derivation record; `ENFORCED_AGGREGATE_DOCUMENT_MB` replaces `MAX_EMAIL_AGGREGATE_DOCUMENT_MB`; the selection gate; every comment the clamp falsified; four DW-457 → DW-706 citations.
- `workers/email-ingest/README.md` — the sender-facing arithmetic restated end to end: 17 MB, the derived-then-clamped explanation, and the former "not reachable in base64" bullet replaced by the reachability statement.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — four new cases pinning the clamp, base64 reachability, the untouched raw gate and the band's upper edge; three DW-457 → DW-706 citations. Every pre-existing derivation case untouched.
- `src/lib/__tests__/email-ingest-worker.test.ts` — the DW-360 suite repointed at the enforced budget with base64 fixtures that each assert their own raw-gate clearance; five DW-457 → DW-706 citations.

**Review findings breakdown:** 6 patches applied (2 medium, 4 low), 0 deferred, 7 rejected. Rejected: updating the deferred-work ledger and `.bmad-loop/decisions.json` (orchestrator-owned, forbidden to this run — the DW-706 resolution note about the original misfiling onto DW-457 is recorded here instead); pinning the literal "17" in the acknowledgement assertions (the module's convention is derived, never hand-typed, and the parity suite pins the constant's reachability); four edge-case suggestions already satisfied by existing assertions or by the docblock (`MIME_STRUCTURAL_HEADROOM_BYTES` per-part cost, band narrowing as the body grows, the exact `Content-Transfer-Encoding: 7bit` guard, and the `SECOND_LEAD_BYTES > 0` premise).

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 2, low 4. Score: no high-severity patch, so no further pass is recommended.

**Verification performed**
- `npx vitest run src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — 89 passed (parity 25, worker 64).
- `npx vitest run` — 396 files, 9909 passed, 1 skipped.
- `npx tsc --noEmit` — exit 0. `npx eslint` — exit 0 (three pre-existing `jsx-ast-utils` warnings, unchanged from baseline).
- `grep -rn "DW-457" workers/ src/` — 7 hits, all MCP slug-parity sites.
- `git diff --stat -- src/mcp.ts src/lib/mcp-http.ts src/lib/__tests__/mcp.test.ts src/lib/__tests__/mcp-http.test.ts` — empty.
- Matrix audit: all five I/O rows are covered by tests that ran and passed — the exact-boundary case, "stops appending parts once the decoded budget is spent", "clears the raw gate", "cannot strand a sender at the no-body exit with an over-budget loss", and "refuses a genuinely oversized message and quotes a cap it really enforces".

**Residual risks**
- A real narrowing for unencoded `7bit`/`8bit` senders: a supported-attachment total in (18,424,785, 20,671,520] arrives, used to forward whole, and now loses its trailing parts. No base64 or quoted-printable message changes outcome. Recorded as an accepted cost at the constant rather than left undiscovered — it is the promise the old quoted figure should never have made.
- The over-budget band the clamp opens is ~0.70 MiB wide and narrows as the body grows, since the body spends the same wire bytes. That is a property of clamping to the carrying capacity, and it is stated at the constant and in the README rather than left implicit.
- The band's upper edge (19,156,674) is restated as prose in four places; the new parity case pins the derived value and names those sites, so a drift fails there rather than silently.
