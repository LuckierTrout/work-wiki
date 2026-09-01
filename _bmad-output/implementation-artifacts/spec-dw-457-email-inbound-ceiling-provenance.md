---
title: 'Record the 25 MiB email inbound ceiling as an unverified conservative bound'
type: 'chore'
created: '2026-09-01'
status: 'done'
baseline_revision: '7eed54d6fa6545fcce2b78ffdd26271797ba0368'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: []
deferred:
  - summary: >-
      Nine code and test sites now cite DW-457 for the email inbound-ceiling
      decision, but the ledger entry under that id is an unrelated, already-closed
      MCP `missing-concept-page` slug-parity defect.
    evidence: |-
      `_bmad-output/implementation-artifacts/deferred-work.md:3386` reads
      "### DW-457: `missing-concept-page` is effectively unreachable over both MCP
      transports", status done 2026-08-29, and `src/mcp.ts` already cites DW-457
      for that. The email-ceiling decision reached this work only through a
      `decision:` line misfiled onto that archived entry -- a misfiling
      `spec-dw-395-455-456-457-mcp-rest-door-parity.md:214` already flagged as
      "worth correcting in the ledger". A maintainer grepping DW-457 after this
      change now gets two unrelated defects and no way to tell which citation
      belongs to which. Fixing it means correcting the ledger, which this run was
      forbidden to touch.
    location: >-
      workers/email-ingest/index.ts (EMAIL_ROUTING_MAX_INBOUND_BYTES, MAX_RAW_EMAIL_BYTES)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `EMAIL_ROUTING_MAX_INBOUND_BYTES` (`workers/email-ingest/index.ts:419-426`) records its 25 MiB value as "Verified 2026-08-31 against https://developers.cloudflare.com/email-routing/limits/", quotes a sentence from that page, and claims corroboration from a second Cloudflare guide; `workers/email-ingest/README.md:45-47,91-95` repeats the quotation, the URL and "verified 2026-08-31". No such fetch was possible in the offline run that wrote them — DW-449's own ledger reason says the figure "could not be verified offline" — so the strongest provenance claim in this Worker is the one thing in it nobody checked. The human decision on DW-457 keeps the clamp but records the source as unverified-but-conservative, which also retires the "transport fact this constant reports, not a narrowing it chose" framing at `MAX_RAW_EMAIL_BYTES:437-446`: if the bound is chosen rather than observed, DW-362's ten-part worst case is unreachable **by design**.

**Approach:** Rewrite the provenance of the constant, the README paragraph and the parity test's "checkable claim" comment so 25 MiB reads as a deliberately conservative bound adopted without verification against a live source, name what re-verification would look like and which way it may move, and restate the ten-part / full-size quoted-printable consequence as a chosen narrowing this repo accepts. Values, arithmetic and quoted sender-facing figures do not move.

## Boundaries & Constraints

**Always:** `EMAIL_ROUTING_MAX_INBOUND_BYTES` stays `25 * 1024 * 1024`; `MAX_RAW_EMAIL_BYTES` stays the `Math.min` of it and `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`; the refusal keeps quoting 25.0 MB. Every statement that survives about the source must be one this repo can stand behind offline — no quoted documentation sentence presented as read, no verification date, no corroboration claim.

**Block If:** the honest wording would require changing a constant, a derivation term, or any figure quoted to a sender.

**Never:** re-derive or widen any cap; touch `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`, the encoding factors, the envelope headroom, or the aggregate budget; edit `_bmad-output/implementation-artifacts/deferred-work.md`; add a network fetch or a runtime check of the platform limit; delete the URL itself (it stays as the place to look, just not as a citation of something read).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clamp value unchanged | `EMAIL_ROUTING_MAX_INBOUND_BYTES` read in a test | Still `25 * 1024 * 1024`; `MAX_RAW_EMAIL_BYTES` still equals it | No error expected |
| Oversize refusal | `message.rawSize` one byte over `MAX_RAW_EMAIL_BYTES` | Refusal still quotes 25.0 MB | No error expected |
| Full-size base64 document | One `MAX_DOCUMENT_SIZE` part, base64 | Still forwarded — 14,348,938 wire bytes, inside the cap | No error expected |
| Ten-part quoted-printable aggregate | `MAX_EMAIL_ATTACHMENTS` parts filling the aggregate budget, QP | Still refused at 65,119,170 wire bytes, now recorded as a chosen narrowing rather than an observed transport fact | Refusal copy unchanged |

</intent-contract>

## Code Map

The governing distinction for every site below, because getting it wrong produces hedge-soup: a sentence about **`MAX_RAW_EMAIL_BYTES`, the gate this Worker enforces** states a fact and needs no hedge — the Worker really does refuse above 26,214,400. A sentence that attributes rejection or delivery to **Cloudflare Email Routing / "the transport"** asserts the unverified figure as observed behaviour, and is the defect. Sites are grouped by which side they fall on.

**Provenance declaration sites (rewrite):**
- `workers/email-ingest/index.ts:412-426` -- `EMAIL_ROUTING_MAX_INBOUND_BYTES` and its doc comment. `:419-422` is the core defect: the verification date, the quoted docs sentence, and the "corroborated by Cloudflare's own Email Workers guide" claim. `:423-425`'s rationale for spelling the value `25 * 1024 * 1024` is independent of provenance and stays. The value on `:426` is read-only.
- `workers/email-ingest/index.ts:427-451` -- `MAX_RAW_EMAIL_BYTES`. The `Math.min` (`:448-451`) and the both-terms-stay-live paragraph are read-only. `:437-446` is the cost paragraph; its closing "That is a transport fact this constant reports, not a narrowing it chose" is the DW-362 by-design sentence, and the wire figures it names (32,715,573 / 65,119,170 / 14,348,938 / ~8.0 MiB) are read-only data.
- `workers/email-ingest/README.md:43-53` -- the operator-facing ceiling paragraph carrying the quotation, URL and "verified 2026-08-31".

**Transport-attributing siblings in the same files (hedge — what the first pass missed):**
- `workers/email-ingest/index.ts:245-249` (inside `QUOTED_PRINTABLE_EXPANSION_FACTOR`) -- "Cloudflare Email Routing rejects those messages before this Worker runs at all ... carries roughly 8.0 MiB of decoded payload in practice". Verbatim the framing the declaration sites retire, fifteen lines above them.
- `workers/email-ingest/index.ts:398-406` -- `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`'s "READ THIS BEFORE THE ARITHMETIC ABOVE" paragraph, which says the derivation "binds again the moment the platform ceiling rises above it". Post-decision the live case is not a rise but a discovery: the published limit may already be higher, making the dormancy self-imposed.
- `workers/email-ingest/README.md:54-56` -- "the over-size refusal quotes 25.0 MB — a size a sender can actually resend under". Resendability is precisely what an unverified bound cannot promise.
- `workers/email-ingest/README.md:70-72` -- "ten ~1.99 MiB parts are ~27.2 MiB encoded and are rejected by Email Routing", and the ~8.0 MiB quoted-printable bullet: the DW-362 losses attributed to the platform.
- `workers/email-ingest/README.md:90` -- "Nothing in steps 1-3 raises the 25 MiB inbound ceiling." The SMTP-time mechanism in that paragraph is sound and stays; only the bare figure needs the caveat.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts:168-174` -- "clamps it to the 25 MiB Cloudflare Email Routing will deliver".
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts:232-238` -- the aggregate "does not reach the Worker over Cloudflare Email Routing at all".
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts:465-473` -- the clamp docblock's "a message the transport had already rejected at 25 MiB".
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts:485-489` -- the "checkable claim" comment, which restates the unread source sentence as the source's own words.
- `src/lib/__tests__/email-ingest-worker.test.ts:762-766` -- fixture rationale citing "Email Routing's 25 MiB inbound ceiling" as the premise for its encoding choice.
- `src/lib/__tests__/email-ingest-worker.test.ts:2756-2760` -- "the platform term states what Email Routing will actually deliver".
- `src/lib/__tests__/email-ingest-worker.test.ts:2933-2937` and `:2979-2983` -- "above the 25 MiB Email Routing" and "a half times what Email Routing delivers".

**Read-only (name the enforced gate, not the transport — leave alone):** `index.ts:139`, `:174`, `:182`, `:1027`, `:1033`; parity test `:400`; worker test `:513`, `:602`, `:1389`, `:1816`, `:2262`, `:2570`, `:2961`, `:3109`. Each says "the 25 MiB raw gate" or names the DW-449 clamp as an event — true regardless of the platform figure.

**Read-only assertions:** every `expect(...)` in both test files, and `expectResendableRefusal` at `src/lib/__tests__/email-ingest-worker.test.ts:2791-2800`.

## Tasks & Acceptance

**Execution:**
- `workers/email-ingest/index.ts` -- rewrite the `EMAIL_ROUTING_MAX_INBOUND_BYTES` provenance paragraph: drop the verification date, the quoted sentence and the corroboration claim; state that 25 MiB is a conservative bound adopted from a reported figure and never checked against a live source from this repository; keep the URL as where to look; give it a **recording date and the origin of the number** (recorded 2026-08-31 under DW-449, whose own record says the figure could not be verified offline) so the assumption has an age and a trail; name what re-verification would settle and that a real limit could be higher (a self-imposed narrowing) or lower (the clamp insufficient). Value and spelling rationale untouched.
- `workers/email-ingest/index.ts` -- amend the `MAX_RAW_EMAIL_BYTES` cost paragraph so the ten-part aggregate and quoted-printable full-size losses read as accepted by decision under an unverified bound, replacing the "transport fact this constant reports" sentence; keep every wire figure and the surviving-admissions sentence.
- `workers/email-ingest/index.ts` -- hedge the two transport-attributing siblings (`QUOTED_PRINTABLE_EXPANSION_FACTOR` `:245-249`, `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` `:398-406`) so neither asserts platform rejection as observed, and so the second records that the derivation may already be dormant by choice rather than only until a future rise. Point both at `EMAIL_ROUTING_MAX_INBOUND_BYTES` instead of restating the caveat in full.
- `workers/email-ingest/README.md` -- rewrite the ceiling paragraph (no quotation, no verification date, the figure named as an unverified conservative bound with the URL as where an operator confirms it and what to do with either answer), hedge the resendability promise, the two wire-size bullets and the steps-1-3 sentence, and update the deploy postscript's closing sentence. Rewrap every touched paragraph to the file's existing fill width. All other prose, including the remaining bullets and the MB/MiB reconciliation, stays.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- hedge the three transport-attributing comments (`:168-174`, `:232-238`, `:465-473`) and replace the "checkable claim" comment so it pins the MiB as the recorded conservative bound without restating an unread source sentence. Use the constant's "chosen, not observed" framing, never a "believed about the transport" one. Assertions unchanged.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- hedge the four transport-attributing comments (`:762-766`, `:2756-2760`, `:2933-2937`, `:2979-2983`) the same way. Assertions unchanged.

**Acceptance Criteria:**
- Given the repository after the change, when `workers/` and `src/lib/__tests__/` are searched for `verified 2026-08-31`, a quoted Cloudflare limits sentence, or a corroboration claim about the Email Workers guide, then none is found, while `https://developers.cloudflare.com/email-routing/limits/` still appears in both `workers/email-ingest/index.ts` and `workers/email-ingest/README.md`.
- Given any sentence in the email-ingest surface that attributes rejecting or delivering a message to Cloudflare Email Routing at a named size, when read after the change, then it is qualified as the bound this repo records rather than one it has observed — while sentences naming the Worker's own enforced raw gate are left unqualified.
- Given the `EMAIL_ROUTING_MAX_INBOUND_BYTES` comment, when read, then it carries a recording date and names DW-449 as where the number entered this repository, and makes no claim that any source was read.
- Given the `MAX_RAW_EMAIL_BYTES` comment, when read, then it records that the DW-362 aggregate worst case is out of reach by this repo's choice rather than by observed transport behaviour.
- Given the full test suite for the email-ingest surface, when it runs, then it passes with no assertion edited.

## Spec Change Log

### 2026-09-01 — Pass 1 review loopback (bad_spec)

**Triggering finding:** three of four review layers independently found that the first implementation hedged only the two constants that DECLARE the ceiling, while a dozen sentences in the same four files still narrate 25 MiB as observed Cloudflare Email Routing behaviour — `workers/email-ingest/index.ts:247` ("Cloudflare Email Routing rejects those messages before this Worker runs at all") fifteen lines above the rewritten constant, `README.md:70-72` attributing the DW-362 losses to the platform, and comments in both test files. The corpus contradicted itself and a reader's first hit decided which story they got, which is the same defect the change exists to remove.

**Root cause in the spec:** the previous Code Map listed those sites as "read-only evidence ... must not be re-explained", and the Execution tasks named only two constants, one README paragraph and one test comment. The scope was drawn at the declaration surface rather than at the claim.

**What was amended (outside the intent-contract):** the Code Map now leads with the enforced-gate vs transport-attribution split, enumerates every site on each side by line, and adds `src/lib/__tests__/email-ingest-worker.test.ts` as a fourth change file; Execution gains three tasks (index.ts siblings, the broader README pass, the worker test); Acceptance gains the transport-attribution criterion, the recording-date/DW-449-origin criterion and the by-design criterion; Design Notes records the failure mode. The intent-contract is untouched.

**Known-bad state avoided:** shipping a repository that hedges the figure in two doc comments and asserts it as fact in a dozen neighbouring ones — a worse record than the uniform (if false) verification claim it replaced, because it reads as an oversight rather than a position.

**KEEP — must survive re-derivation** (pass-1 wording preserved at `/private/tmp/claude-501/dw457-pass1-keep.diff`):
- The `EMAIL_ROUTING_MAX_INBOUND_BYTES` higher/lower asymmetry paragraph, ending on why an unchecked figure is adopted low rather than not adopted at all. It is the argument that makes "conservative" load-bearing rather than a hedge.
- "That URL stays as the place to look, not as a citation of something read."
- The `MAX_RAW_EMAIL_BYTES` "Those losses are ACCEPTED BY DECISION, not observed (DW-457)" paragraph, including the sentence naming which branch surrenders the bytes.
- Keeping the `25 * 1024 * 1024` spelling rationale while dropping its "the MiB the docs state" clause.
- The parity test comment's surviving reason for pinning the MiB rather than a byte count ("a byte count restated here would agree with the constant however wrong both were").
- The README's two-direction instruction to the operator (higher published limit = self-imposed narrowing; lower = ceiling too generous).

**KEEP — do not repeat:** the pass-1 parity-test docblock wording "the transport is believed to reject at 25 MiB ... a ceiling that may not exist". Belief-about-the-transport is the framing this change retires; use the constant's chosen-not-observed framing instead.

## Review Triage Log

### 2026-09-01 — Review pass 2

- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 0, medium 4, low 9)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` conflated two thresholds — it implied the derivation goes live as soon as the real ceiling exceeds 25 MiB, when it binds only at or above its own 65,496,679 bytes (~62.46 MiB). The two are now separated, with the in-between case (a real 30 MiB ceiling: narrowing self-imposed, clamp still binding, derivation still dormant) stated, and the tie handled by `Math.min`.
  - `[medium]` `[patch]` "adopted deliberately low" attributed a conservative intent to DW-449 that its own record contradicts — a fresh unsupported provenance claim inside a provenance fix. Both the constant and the README now say the figure was adopted under DW-449 as if verified, that the verification cannot have happened, and that it is retained now because it is conservative.
  - `[medium]` `[patch]` "no fetch ... has ever happened from this repository" was an unknowable absolute negative that would silently go false; replaced with "this repository records no fetch ..., then or since".
  - `[medium]` `[patch]` The `MAX_RAW_EMAIL_BYTES` cost paragraph collapsed "at or below 25 MiB" into one harmless branch, contradicting the constant above it; split into three (exactly / below / above) with what each costs.
  - `[low]` `[patch]` Four transport-attributing sentences the pass missed under the spec's own AC2 — `index.ts:448` ("what the transport will carry"), parity `:486` ("a size the transport will not deliver"), the `expectResendableRefusal` docblock (the one place a live assertion leans on the constant as a transport fact), and the README's missing enforced-gate-vs-platform-ceiling distinction for operators — all hedged.
  - `[low]` `[patch]` Prose defects: "observed" used in two senses three lines apart in the parity docblock; a counterfactual stated in the past indicative ("the transport refused it first"); "over the ceiling the enforced cap records" for what is simply the enforced cap; a doubly-nested `--` aside; and ragged rewrapping left at three worker-test blocks.

### 2026-09-01 — Review pass

- intent_gap: 0
- bad_spec: 2: (high 0, medium 1, low 1)
- patch: 1: (high 0, medium 0, low 1)
- defer: 1: (high 0, medium 0, low 1)
- reject: 13: (high 0, medium 0, low 13)
- addressed_findings:
  - `[medium]` `[bad_spec]` The hedge landed only at the two constants that declare the ceiling while a dozen sibling sentences in the same four files still asserted 25 MiB as observed Cloudflare Email Routing behaviour (`index.ts:247`, `README.md:70-72` and `:90`, and comments in both test files), leaving the corpus self-contradictory — Code Map rewritten around an enforced-gate vs transport-attribution split that enumerates every site, Execution gained three tasks and a fourth change file, Acceptance gained the transport-attribution criterion; code reverted and re-derived.
  - `[low]` `[bad_spec]` Dropping "verified 2026-08-31" left the assumption with no age, no owner and no trail back to where the number entered the repo — spec now requires a recording date and a DW-449 origin citation at the constant, plus an operator instruction in the README saying what to do with either answer.

## Design Notes

The honest asymmetry is worth stating in the constant, because it is what makes "conservative" the right word rather than a hedge: if the real platform ceiling is **higher** than 25 MiB the clamp costs reach the transport would have carried, and everything DW-362 widened for stays unreachable by our own choice; if it is **lower**, the clamp is not conservative at all and the refusal still over-promises. Only the first is safe by default, which is why an unverified figure is adopted low rather than not adopted.

Nothing here is a numeric change, so the suite's role is negative: it must pass untouched. An assertion that needs editing means a value moved, which the Block If forbids.

The failure mode this spec is written against, learned from pass 1: hedging only the two constants that DECLARE the figure leaves a dozen sentences in the same files narrating it as observed transport behaviour, so the corpus contradicts itself. The fix is the enforced-gate / transport-attribution split at the top of the Code Map — apply it site by site, and keep each hedge short by pointing at `EMAIL_ROUTING_MAX_INBOUND_BYTES` rather than restating the argument.

## Verification

**Commands:**
- `pnpm test src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts` -- expected: all pass, with no assertion line changed by this spec.
- `pnpm lint` -- expected: clean.
- `git diff --stat` -- expected: only `workers/email-ingest/index.ts`, `workers/email-ingest/README.md`, `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` and `src/lib/__tests__/email-ingest-worker.test.ts`.
- `git diff -U0 | grep -E '^[+-][^+-]' | grep -E 'export const|expect\(|Math\.min|Math\.max'` -- expected: no output, proving no constant or assertion line moved.

## Auto Run Result

Status: done

**Implemented change.** The 25 MiB Cloudflare Email Routing inbound ceiling is now recorded across the email-ingest surface as an unverified conservative bound this repository chose, rather than a figure it read and verified. Nothing enforced moved: `EMAIL_ROUTING_MAX_INBOUND_BYTES` is still `25 * 1024 * 1024`, `MAX_RAW_EMAIL_BYTES` is still the `Math.min` against the aggregate derivation, and the refusal still quotes 25.0 MB. The clamp itself already existed (DW-449, commit `484161f4`); what the human decision on DW-457 left outstanding was how the figure is recorded, and the "transport fact this constant reports, not a narrowing it chose" framing that an unverified bound cannot support. DW-362's ten-part quoted-printable worst case (65,119,170 wire bytes) and the maximally-escaped full-size document (32,715,573) are now recorded as out of reach **by this repo's choice**, with the three branches — a real ceiling exactly at, below, or above 25 MiB — and what each costs stated at the constant.

**Files changed**
- `workers/email-ingest/index.ts` — provenance of `EMAIL_ROUTING_MAX_INBOUND_BYTES` rewritten (no verification date, no quoted docs sentence, no corroboration claim; recording date and DW-449 origin added; URL kept as where to look); `MAX_RAW_EMAIL_BYTES` cost paragraph reframed as accepted-by-decision with three branches; the two transport-attributing siblings (`QUOTED_PRINTABLE_EXPANSION_FACTOR`, `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`) hedged, the second also correcting a threshold confusion between 25 MiB and the derivation's own ~62.46 MiB.
- `workers/email-ingest/README.md` — operator-facing ceiling paragraph rewritten, the enforced-gate-vs-platform-ceiling distinction added, resendability promise and wire-size bullets hedged, deploy postscript updated, touched paragraphs rewrapped.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — five comment blocks hedged, including the "checkable claim" comment that restated an unread source sentence. Assertions untouched.
- `src/lib/__tests__/email-ingest-worker.test.ts` — six comment blocks hedged, including the `expectResendableRefusal` docblock over the one live assertion that leans on the constant as a transport fact. Assertions untouched.

**Review findings breakdown**
- Pass 1: 2 bad_spec (1 medium, 1 low) — the hedge landed only at declaration sites while a dozen sibling sentences still asserted the ceiling as observed; code reverted, spec rewritten around an enforced-gate vs transport-attribution split, re-derived. 1 patch and 1 defer moot under the loopback; 13 rejected.
- Pass 2: 0 intent_gap, 0 bad_spec, 13 patches applied (4 medium, 9 low), 1 deferred (low), 8 rejected.
- Follow-up review recommended: **true**. Patched this pass: high 0, medium 4, low 9 → 3x4 + 9 = 21, at or above the threshold of 5.

**Verification**
- `pnpm test src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts` — 2 files, 84/84 tests pass.
- `pnpm lint` — exit 0 (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- Non-comment changed lines in each of the three TypeScript files: **0**, computed by stripping comment-prefixed lines from `git diff -U0`. No constant value, expression or `expect(...)` moved; `README.md` is the only file with non-comment changes, as expected for Markdown.
- Acceptance greps: `verified 2026-08-31`, the quoted limits sentence, the Email Workers corroboration claim, `deliberately low` and `has ever happened from` return nothing across `workers/` and `src/lib/__tests__/`; the limits URL still appears once in each of `index.ts` and `README.md`.
- Matrix audit: all four I/O rows are covered by tests that ran and passed — the clamp identity and the base64 full-size admission by `it("enforces the lower of the aggregate derivation and the platform inbound ceiling")`, the refusal figure by `expectResendableRefusal` in the worker suite, and the ten-part quoted-printable aggregate by `it("derives room for MAX_EMAIL_ATTACHMENTS mid-size documents beside a maximal body, which the enforced cap then refuses")`.

**Residual risks**
- The change is prose-only, so the suite cannot enforce it: a future edit could restore a verification claim with every test green. The acceptance criteria are greps, deliberately — a test asserting a doc comment lacks a date was judged disproportionate machinery.
- The central new claim ("this repository records no fetch of the limits page") rests on DW-449's own ledger record, not on anything executable. It replaces one unverifiable provenance claim with a more conservative one on the same footing; that is the honest ceiling of what this change can do offline.
- The DW-457 citation added to nine sites resolves in the ledger to an unrelated, already-closed MCP defect. Recorded in `deferred` rather than fixed, since correcting the ledger was out of bounds for this run.
- `workers/email-ingest/index.ts:312` (inside `MIME_ENVELOPE_HEADROOM_BYTES`) still says "re-open it before the platform ceiling ever rises above that derivation". It is an instruction about a future event rather than a claim that 25 MiB was observed, so it was left alone under the Never clause protecting the envelope headroom — but it is the last sentence in the file using the rise-only framing.
