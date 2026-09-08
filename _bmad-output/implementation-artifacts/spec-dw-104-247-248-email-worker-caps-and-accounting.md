---
title: 'Email Worker caps derived from the app ceilings, and an honest attachment acknowledgement'
type: 'bugfix'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The duplicate-Message-ID early return omits skippedAttachmentCount entirely, so a
      resend of an already-seen message reports supportedAttachmentCount with no skipped
      figure at all.
    evidence: |-
      `src/app/api/email/ingest/route.ts` returns `{ accepted, duplicate, ... ,
      supportedAttachmentCount }` on the duplicate path without `skippedAttachmentCount`,
      while the success path returns both. Pre-dates this change, but it is the same
      response contract the change corrects. The only test on that path asserts
      accepted/duplicate/status/slug and nothing about attachment counts.
    location: >-
      src/app/api/email/ingest/route.ts:202
    severity: medium
  - summary: >-
      Quoted-printable transfer encoding is unaccounted for in the raw-size cap, which is
      derived from base64 expansion alone.
    evidence: |-
      Many clients send text/* attachments and non-ASCII bodies as quoted-printable, which
      expands up to roughly 3x for byte-dense content — far beyond base64's 4/3. A large
      .csv or .txt attachment can therefore still be refused below the advertised
      per-document ceiling, for the same reason DW-104 described for base64.
    location: >-
      workers/email-ingest/index.ts
    severity: medium
  - summary: >-
      Inline MIME parts (signature logos, embedded images) are counted as unsupported
      attachments and reported to the sender as skipped.
    evidence: |-
      `parsed.attachments` from postal-mime includes parts with `disposition: "inline"` and
      a `contentId`. Every ordinary email with a branded signature therefore produces an
      "N unsupported attachments were recorded but skipped" line. Pre-existing — the old
      subtraction counted them too — so this is not a regression, but the corrected
      accounting makes the noise more visible.
    location: >-
      workers/email-ingest/index.ts
    severity: low
  - summary: >-
      Nothing bounds the aggregate size of the attachments the Worker copies into the
      forwarded FormData, and raising the raw cap raises that peak.
    evidence: |-
      The forwarding loop copies each attachment twice (source view, then a fresh
      Uint8Array) on top of the parsed MIME tree, inside a Cloudflare Worker's memory
      budget. The cap governs one raw message, not the sum of decoded attachment bytes
      plus copies. No test or guard covers the aggregate.
    location: >-
      workers/email-ingest/index.ts
    severity: low
  - summary: >-
      A full-size document and a maximal email body cannot both fit under the derived raw
      cap, because the 64 KiB envelope allowance is far smaller than MAX_EMAIL_CONTENT_CHARS.
    evidence: |-
      `MAX_RAW_EMAIL_BYTES` leaves 65,533 bytes of slack above the 14,348,938-byte wire size
      of a base64-encoded `MAX_DOCUMENT_SIZE` document, while the Worker's own
      `MAX_EMAIL_CONTENT_CHARS` is 100,000 and the body is truncated only *after* the
      `rawSize` gate. An email carrying a 10 MB attachment plus a body anywhere near the
      accepted length is refused with a size bounce although every individual limit is
      respected. Not a regression -- the old 10 MB cap refused that message too -- and the
      constant's comment now says so, but no test covers the interaction of the two caps.
    location: >-
      workers/email-ingest/index.ts:59
    severity: medium
  - summary: >-
      The raw cap bounds one full-size document, so several mid-size supported documents are
      refused wholesale even though every per-document and per-count limit is respected.
    evidence: |-
      `MAX_EMAIL_ATTACHMENTS` is 10 and `MAX_DOCUMENT_SIZE` is 10 MB, so the advertised
      envelope is up to ten documents; ten 2 MB documents encode to roughly 27 MB and are
      bounced by `MAX_RAW_EMAIL_BYTES` (14.4 MB) with "larger than 13.7 MB". The per-message
      cap and the per-email attachment cap describe incompatible envelopes, which also makes
      the new over-cap acknowledgement line unreachable for anything but small files.
      Pre-existing and worse before this change (the cap was 10 MB); distinct from the
      aggregate-memory item above, which is about the forwarding copies rather than the gate.
    location: >-
      workers/email-ingest/index.ts:59
    severity: medium
baseline_revision: '4bdad6201d2152ee4bf53cc74019360c82f2dd8a'
---

<intent-contract>

## Intent

**Problem:** `workers/email-ingest/index.ts` caps a raw message at 10 MB measured *before* MIME decoding, so base64's ~4/3 expansion puts the route's 10 MB `MAX_DOCUMENT_SIZE` out of reach over email (DW-104); the acknowledgement computes skipped attachments as `attachmentNames.length - supportedAttachments.length` across a 20-capped names list and a 10-capped supported list, so a supported attachment dropped by the cap is reported to the sender as "unsupported" and past 20 attachments the loss is understated, with `src/app/api/email/ingest/route.ts` repeating the same subtraction (DW-247); and three forced cross-module duplicate constants in the Worker are still unpinned (DW-248).

**Approach:** Derive `MAX_RAW_EMAIL_BYTES` from a Worker-local copy of `MAX_DOCUMENT_SIZE` times a named base64 expansion factor (~13.4 MB) per the human's 2026-08-19 "Raise the raw cap" decision; compute the acknowledgement counts from the full parsed attachment list so unsupported and over-cap losses are reported separately and truthfully, and forward the true skipped count so the route stops re-deriving it from truncated lists; and extend `email-ingest-allowlist-parity.test.ts` — already the pin for this class of forced duplication — to cover the raw-bytes cap, the recorded-names cap, and the body-character cap.

## Boundaries & Constraints

**Always:** The Worker cannot import from `src/lib` (it is bundled for Cloudflare), so every shared value stays a duplicated literal pinned by a test that compares both sides. The Worker's forwarding cap must remain equal to `MAX_EMAIL_DOCUMENTS` (already pinned). New Worker constants that a parity test compares must be `export`ed. The route must keep working when a caller supplies no explicit skipped count (the JSON body path and any direct multipart POST).

**Block If:** The base64 expansion factor or the derived raw cap would have to contradict the recorded 2026-08-19 decision (raise to about 13.4 MB, derived from `MAX_DOCUMENT_SIZE`, expansion factor named in a comment).

**Never:** Do not change `MAX_DOCUMENT_SIZE`, `MAX_EMAIL_DOCUMENTS`, `MAX_EMAIL_ATTACHMENTS_RECORDED`, or `MAX_EMAIL_CONTENT_CHARS` themselves — only how the Worker derives and pins its copies. Do not add a new user-facing settings surface, do not change what gets forwarded or staged, and do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full-size document over email | Email whose `rawSize` is a base64-expanded 10 MB attachment (≈13.9 MB) | Worker forwards it; the route's `MAX_DOCUMENT_SIZE` gate is reachable | No error expected |
| Genuinely oversized message | `rawSize` above the derived raw cap | Worker replies with a size refusal quoting the derived cap, forwards nothing | Reply only; no service call |
| Cap-truncated supported attachment | 13 parts, 11 supported (fixture `MIXED_PARTS`) | 10 queued; reply reports 1 supported attachment not queued because of the per-email limit **and** 2 unsupported skipped — never 3 unsupported | No error expected |
| More parts than the names cap | 24 parts, 12 supported, 12 unsupported | Names list still truncated to 20, but the reply reports 2 over-cap supported and 12 unsupported — the true totals, not `20 - 10` | No error expected |
| Only unsupported attachments | 1 supported + 1 unsupported (fixture `SINGLE_SKIP_PARTS`) | Reply keeps the singular "1 unsupported attachment was recorded but skipped." and adds no over-cap line | No error expected |
| No attachments at all | Plain-text email | Reply mentions neither queued nor skipped attachments | No error expected |
| Route without a forwarded count | JSON body or multipart with no `skippedAttachmentCount` field | `skippedAttachmentCount` falls back to today's `attachmentNames.length - attachments.length` subtraction | Non-numeric/negative value ignored as absent |
| Route with a forwarded count | Multipart carrying `skippedAttachmentCount=14` | Response reports 14, not the locally derivable minimum | No error expected |
| Constants drift apart | Someone edits `MAX_DOCUMENT_SIZE`, `MAX_EMAIL_ATTACHMENTS_RECORDED`, or `MAX_EMAIL_CONTENT_CHARS` alone | `email-ingest-allowlist-parity.test.ts` fails | Test failure is the signal |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts` -- the whole change surface on the Worker side. `:39-40` holds `MAX_RAW_EMAIL_BYTES = 10 * 1024 * 1024` and `MAX_EMAIL_CONTENT_CHARS = 100_000` (both module-private today; `MAX_EMAIL_CONTENT_CHARS` must become an export). `:99` `MAX_EMAIL_ATTACHMENTS = 10` is the already-exported, already-pinned precedent to copy — note its doc-comment shape. `:186-192` is the `rawSize` gate and its "larger than 10 MB" reply copy. `:232-234` builds `supportedAttachments` with `.filter(supportedAttachment).slice(0, MAX_EMAIL_ATTACHMENTS)` — split this into an uncapped filtered list plus the capped slice so both losses are countable. `:250-252` builds `attachmentNames` with a bare `.slice(0, 20)` literal. `:264` is the `for (const name of attachmentNames) form.append("attachmentName", name)` loop — append the skipped count to the same `FormData`. `:317-333` is the `lines` array whose last two entries are the queued/skipped acknowledgement copy.
- `src/lib/constants.ts:22` -- `MAX_DOCUMENT_SIZE = 10 * 1024 * 1024`, the ceiling the raw cap must be derived from. Read-only.
- `src/lib/email-ingest.ts:6-14` -- `MAX_EMAIL_CONTENT_CHARS`, `MAX_EMAIL_ATTACHMENTS_RECORDED = 20`, `MAX_EMAIL_DOCUMENTS = 10`; `:130-135` `sanitizeAttachmentNames` applies the 20 cap on the route side. Read-only.
- `src/app/api/email/ingest/route.ts` -- `:36-41` the `EmailPayload` interface; `:43-79` `parsePayload` (multipart branch reads strings via the local `value()` helper, JSON branch reads `body.*`); `:106-111` supported filter + deduped `attachmentNames`; `:283-284` the `supportedAttachmentCount`/`skippedAttachmentCount` response fields.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- the designated pin for forced Worker/app duplication; its final `it("caps forwarded attachments...")` is the exact shape the three new pins should follow. Both modules export a `MAX_EMAIL_CONTENT_CHARS`, so the Worker's must be imported under an alias.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- `:262-291` the reusable `multipartEmail(parts, options)` fixture builder and `:250-258` `partBytes`; `:170-247` `MIXED_PARTS` (13 parts, 11 supported); `:377-411` the acknowledgement-count assertions that currently pin "3 unsupported attachments were recorded but skipped." and must be updated.
- `src/lib/__tests__/email-ingest-route.test.ts` -- `:302-332` the only assertion on `skippedAttachmentCount`; `multipartRequest`/`mixedAttachmentRequest` helpers build the form.
- `workers/email-ingest/README.md:8-10` -- operator-facing description of what is forwarded and what is "reported as skipped"; the sentence predates the unsupported/over-cap split.

## Tasks & Acceptance

**Execution:**
- `workers/email-ingest/index.ts` -- export a `MAX_EMAIL_DOCUMENT_BYTES` duplicate of `MAX_DOCUMENT_SIZE`, an exported expansion factor that carries base64's 4/3 **and** RFC 2045's 76-character line wrap, an exported MIME envelope allowance, and derive+export `MAX_RAW_EMAIL_BYTES` from them with a doc comment naming each term and why a pre-decode measurement needs them (see Design Notes) -- so a full-size document actually survives encoding instead of being bounced at ~7.5 MB, or at 13.3 MB by a naive 4/3 cap.
- `workers/email-ingest/index.ts` -- update the size-refusal reply copy to quote the derived cap rather than the hardcoded "10 MB", rounding **down** to the displayed precision -- so the quoted number is never larger than the limit actually enforced.
- `workers/email-ingest/index.ts` -- export `MAX_EMAIL_CONTENT_CHARS`, add an exported `MAX_EMAIL_ATTACHMENT_NAMES_RECORDED = 20`, and replace the bare `.slice(0, 20)` with it -- so the parity test's pin actually binds the code, not a coincidentally-equal literal.
- `workers/email-ingest/index.ts` -- split the supported-attachment computation into an uncapped filtered list and the capped forwarded slice, derive `unsupportedCount` and `overCapCount` from `parsed.attachments`, and emit them as separate acknowledgement lines -- so a supported file dropped by the cap is never called "unsupported" and neither count depends on the 20-capped names list.
- `workers/email-ingest/index.ts` -- append the true total skipped count (`unsupportedCount + overCapCount`) to the forwarded `FormData` -- so the route reports the real loss instead of re-deriving it from truncated lists.
- `src/app/api/email/ingest/route.ts` -- read an optional numeric skipped count on both `parsePayload` branches, carry it on `EmailPayload`, and compose it with the route's own drops per Design Notes (never reporting below the locally derivable subtraction), falling back to the existing subtraction when no count arrives -- so the route stops understating without breaking callers that send no count.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- add pins for the three remaining forced duplicates: the Worker's document-byte copy against `MAX_DOCUMENT_SIZE` plus the derived raw cap measured against the true wire size of a base64-encoded full-size document (not against a bare `* 4 / 3`), the names cap against `MAX_EMAIL_ATTACHMENTS_RECORDED`, and the Worker body cap against `src/lib/email-ingest.ts`'s `MAX_EMAIL_CONTENT_CHARS` -- so all four cross-module constants fail loudly on drift.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- update the `MIXED_PARTS` acknowledgement assertions to the corrected split counts, add an over-the-names-cap fixture built with `multipartEmail`, assert the forwarded `skippedAttachmentCount` field, and calibrate the wire-size helper against a real `multipartEmail` fixture's actual byte length -- covering the I/O matrix rows for cap truncation, for more parts than the names cap, and for a full-size document clearing the raw gate.
- `src/lib/__tests__/email-ingest-route.test.ts` -- assert the route honours a forwarded `skippedAttachmentCount` on **both** payload branches (multipart and JSON body, each with a value present and with it absent) and still falls back to the subtraction otherwise -- covering both route rows of the I/O matrix; a JSON-arm assertion that only omits the field does not pin the JSON parse.
- `workers/email-ingest/README.md` -- correct the sentence describing skipped attachments so it covers the over-cap case as well as the unsupported one -- so the operator-facing doc matches the acknowledgement it describes.

**Acceptance Criteria:**
- Given `MAX_DOCUMENT_SIZE` is 10 MB, when a MIME part carrying that many bytes is base64-encoded and line-wrapped the way RFC 2045 and the test fixtures encode it, then its wire size is strictly below `MAX_RAW_EMAIL_BYTES`, and `MAX_RAW_EMAIL_BYTES` is computed from the exported factor and envelope allowance rather than restated as a literal.
- Given the test helper that predicts a base64 part's wire size, when it is applied to a real fixture built by `multipartEmail`, then its prediction equals that fixture's actual encoded byte length.
- Given any one of `MAX_DOCUMENT_SIZE`, `MAX_EMAIL_ATTACHMENTS_RECORDED`, or `MAX_EMAIL_CONTENT_CHARS` is changed on the app side alone, when the suite runs, then `email-ingest-allowlist-parity.test.ts` fails.
- Given an email whose supported attachments exceed the per-email cap, when the sender receives the acknowledgement, then the over-cap supported attachments are reported as not queued because of the limit and are excluded from the unsupported count.
- Given the acknowledgement reports zero of either kind, when the reply is assembled, then that line is omitted entirely rather than printed with a zero.
- Given the existing suite, when `npx vitest run`, `npx eslint`, and `npx tsc --noEmit -p tsconfig.json` run, then all pass with no new failures or warnings.

## Spec Change Log

### 2026-08-20 — Repair after review pass 1

**Triggering finding (high).** The derived raw cap `Math.ceil(MAX_DOCUMENT_SIZE * 4 / 3)` = 13,981,014 bytes still bounces a full-size document: RFC 2045 wraps base64 at 76 characters with CRLF, so 10,485,760 bytes arrive as 14,348,938 bytes on the wire — 2.6% above the cap, before part headers, boundaries and the text body. DW-104's operative goal ("so a `MAX_DOCUMENT_SIZE` attachment survives base64 expansion") was therefore unmet, and nothing in the suite noticed because both new gate tests inject `rawSize` and the parity pin compares constants to constants.

**Amended.** Design Notes replaced: the expansion factor now carries the line wrap (`4/3 × 78/76`) plus a named MIME envelope allowance, and the pin moves to the message surface — a wire-size helper asserted against the cap, with the helper itself calibrated against a real `multipartEmail` fixture. Tasks and Acceptance Criteria updated to match; the route-composition rule, the round-down rule for the refusal copy, the JSON-arm test requirement, and the README sentence were folded in at the same time.

**Known-bad state avoided.** A cap that is derived, documented, and tested — and still rejects exactly the document the ledger says it must admit — with a green suite and DW-104 recorded as resolved.

**KEEP.** These survived review and must survive re-derivation: (1) the `eligibleAttachments` / `supportedAttachments` split with `unsupportedCount` and `overCapCount` derived from `parsed.attachments`, and the two separate acknowledgement lines, each omitted at zero — reviewers confirmed this lands on the surface the intent names; (2) the 24-part `OVER_NAME_CAP_PARTS` fixture and its assertions, including the negative pins `not.toContain("3 unsupported")` and `not.toContain("10 unsupported")` that name the exact wrong numbers the old subtraction produced; (3) the corrected `MIXED_PARTS` expectations (10 queued, 1 over-cap, 2 unsupported); (4) `MAX_EMAIL_ATTACHMENT_NAMES_RECORDED` replacing the bare `.slice(0, 20)`, and exporting `MAX_EMAIL_CONTENT_CHARS`, so the parity pins bind real code; (5) `parseSkippedCount`'s treatment of missing / non-numeric / negative values as absent; (6) the doc comments on each duplicated constant naming its counterpart and the parity test.

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 4: (high 1, medium 1, low 2)
- patch: 0
- defer: 4: (high 0, medium 2, low 2)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[high]` `[bad_spec]` Derived raw cap omits base64 line-wrapping and MIME envelope overhead, so a `MAX_DOCUMENT_SIZE` document still exceeds it; both gate tests inject `rawSize` and the parity pin compares constants, so nothing measures a real encoded message. Design Notes, tasks and ACs amended; code reverted for re-derivation.
  - `[medium]` `[bad_spec]` The JSON arm of the new forwarded-count contract was unpinned — deleting the JSON `parseSkippedCount` call left the suite green because the only JSON test omits the field. Test task now requires a value-present assertion on both branches.
  - `[low]` `[bad_spec]` Route composed the forwarded count with `Math.max` against a local floor that also absorbs route-side rejections, so a route-rejected forwarded file vanishes from the total. Design Notes now specify summing the disjoint losses.
  - `[low]` `[bad_spec]` Refusal copy used `toFixed(1)` (round-to-nearest, can overstate the enforced cap) and `workers/email-ingest/README.md:10` still described skipping as unsupported-only. Both folded into the task list.

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 0, low 7)
- defer: 2: (high 0, medium 2, low 0)
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[low]` `[patch]` `EmailPayload.skippedAttachmentCount`'s doc comment still named the JSON body path as a case where the count is absent, although that branch now parses it. Comment corrected to name only genuine absence.
  - `[low]` `[patch]` The route's `Math.max(localSkipped, ...)` floor was unpinned — replacing it with the bare sum left all tests green. Added a case where the forwarded sum is strictly below the name-derived minimum (one supported file, two unforwarded names, forwarded count `0` → 2).
  - `[low]` `[patch]` Neither guard in `parseSkippedCount` was individually pinned; dropping `Number.isFinite` let `"Infinity"` reach the response as `null`, and dropping `>= 0` stayed green. Guards collapsed into one shared expression so the two branches cannot diverge, plus an `"Infinity"` pin and a negative-count pin built on four identically-named parts (the only fixture shape where the floor cannot mask a negative).
  - `[low]` `[patch]` The raw gate was tested below the cap and at `cap + 1` but never at equality, so flipping `>` to `>=` would have falsified the quoted-cap contract silently. Added an equality case.
  - `[low]` `[patch]` The wire-size calibration ran only on a 96-byte payload — a multiple of 3 with a short final line — so neither base64 padding nor the exact-76-character line boundary the 10 MB measurement sits on was exercised. Widened to a three-part fixture at 96, 100 (padded) and 114 bytes (exact multiple of 57), with assertions that those lengths really are awkward.
  - `[low]` `[patch]` `workers/email-ingest/README.md` claimed "the names of everything it leaves behind stay in activity history", which is false past `MAX_EMAIL_ATTACHMENT_NAMES_RECORDED`. Corrected to state the twenty-name limit.
  - `[low]` `[patch]` Two Worker constant comments overclaimed: `MIME_ENVELOPE_HEADROOM_BYTES` said the plain-text body rides along (65,533 bytes of slack against a 100,000-character body cap), and `MAX_RAW_EMAIL_BYTES` did not record that the derived 13.75 MiB deliberately exceeds the 2026-08-19 decision's "about 13.4 MB" estimate. Both comments now state the real figures and why.

## Design Notes

**The expansion factor is not 4/3.** `message.rawSize` is the on-the-wire RFC 822 byte count, and MIME does not write base64 as a bare 4/3 blob: RFC 2045 wraps it at 76 characters with a CRLF after each line. A 10 MiB document therefore arrives as `ceil(n/3)*4` characters **plus two bytes per wrapped line** — 14,348,938 bytes for `MAX_DOCUMENT_SIZE`, which a naive `ceil(n * 4/3)` cap of 13,981,014 still bounces. On top of that sit the part headers, the boundary markers and the text body part. So the factor must carry the line wrap (`4/3 × 78/76`), and the cap must add a fixed envelope allowance on top:

```ts
export const MAX_EMAIL_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** Base64 writes 4 chars per 3 bytes, wrapped at 76 chars with a CRLF (RFC 2045). */
export const BASE64_EXPANSION_FACTOR = (4 / 3) * (78 / 76);
/** Part headers, boundary markers and the text body ride along with it. */
export const MIME_ENVELOPE_HEADROOM_BYTES = 64 * 1024;
export const MAX_RAW_EMAIL_BYTES =
  Math.ceil(MAX_EMAIL_DOCUMENT_BYTES * BASE64_EXPANSION_FACTOR) + MIME_ENVELOPE_HEADROOM_BYTES;
```

That lands at ~13.75 MiB. The 2026-08-19 decision's "about 13.4 MB" is the naive-4/3 figure; its operative clause is "so a `MAX_DOCUMENT_SIZE` attachment survives base64 expansion", and 13.4 MB cannot deliver that. Compute the factor correctly and note the difference in the run result — do not clamp back to 13.4 MB.

**Pin it at the message surface, not just the constant surface.** A test that compares `MAX_RAW_EMAIL_BYTES` against `MAX_DOCUMENT_SIZE * 4 / 3` cannot observe encoding, and a test that injects `rawSize` exercises only the `>` branch. The raw-cap pin needs a helper that computes the true wire size of a base64 part (`ceil(n/3)*4 + 2 * ceil(chars/76)`), asserted against `MAX_RAW_EMAIL_BYTES`; and that helper must itself be calibrated against a real fixture — build a small multipart message with the existing `multipartEmail` builder and assert the helper's prediction equals its actual encoded byte length, so the formula cannot drift away from how the fixtures (and real mail) are encoded.

**Route composition.** The Worker's total and the route's own drops are disjoint losses: the Worker reports what it never forwarded, and the route can additionally reject a forwarded file. Compose them as `forwarded + (payload.attachments.length - attachments.length)` when a forwarded count is present, falling back to today's `attachmentNames.length - attachments.length` subtraction when it is not, and never report below that local subtraction.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts` -- expected: all pass
- `npx vitest run` -- expected: no new failures against the pre-change baseline
- `npx tsc --noEmit -p tsconfig.json` -- expected: exit 0
- `npx eslint` -- expected: exit 0 apart from pre-existing warnings

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** The email-ingest Worker's pre-decode size cap is now derived from a Worker-local
copy of `MAX_DOCUMENT_SIZE` rather than restated as a flat 10 MB, so a full-size document
actually survives base64 encoding and the route's own `MAX_DOCUMENT_SIZE` gate becomes
reachable over email (DW-104). The acknowledgement no longer computes skipped attachments by
subtracting a 10-capped list from a 20-capped one: unsupported parts and supported parts
dropped at the per-email cap are counted independently from the full parsed attachment list
and reported on separate lines, and the true total is forwarded so the route stops
re-deriving it from truncated lists (DW-247). The three remaining forced cross-module
duplicate constants are pinned by `email-ingest-allowlist-parity.test.ts`, the file that
already pinned the attachment cap (DW-248).

**Cap figure — deviation from the recorded decision.** The 2026-08-19 human decision
estimated "about 13.4 MB". That figure comes from a bare 4/3 factor and cannot satisfy the
decision's own operative clause: RFC 2045 wraps base64 at 76 characters with a CRLF, so a
`MAX_DOCUMENT_SIZE` document arrives as 14,348,938 bytes on the wire, above a naive cap of
13,981,014. The implemented cap is 14,414,471 bytes (13.75 MiB) — `MAX_DOCUMENT_SIZE` times a
factor of `(4/3) × (78/76)` plus a 64 KiB MIME envelope allowance. The direction of the
decision (raise, derive, name the factor in a comment) is honoured; only its arithmetic
estimate is exceeded, by 3.1%. This is recorded at the constant itself, in the parity test,
and here.

**Files changed:**
- `workers/email-ingest/index.ts` -- derived and exported `MAX_EMAIL_DOCUMENT_BYTES`, `BASE64_EXPANSION_FACTOR`, `MIME_ENVELOPE_HEADROOM_BYTES`, `MAX_RAW_EMAIL_BYTES`, `MAX_EMAIL_CONTENT_CHARS` and `MAX_EMAIL_ATTACHMENT_NAMES_RECORDED`; refusal copy quotes the derived cap rounded down; supported-attachment computation split into an uncapped eligible list and the capped forwarded slice; separate over-cap and unsupported acknowledgement lines, each omitted at zero; true skipped total appended to the forwarded `FormData`.
- `src/app/api/email/ingest/route.ts` -- `parseSkippedCount` on both payload branches (missing, non-numeric, non-finite and negative all treated as absent), carried on `EmailPayload`, composed with the route's own rejections and floored at the locally derivable subtraction.
- `src/lib/__tests__/email-ingest-wire.ts` -- new shared `base64PartWireSize` helper (deliberately not a `*.test.ts`, so vitest does not collect it).
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- four new pins: the document-byte copy, the raw cap measured at the message surface, the names cap, the body-character cap.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- corrected `MIXED_PARTS` counts, a 24-part `OVER_NAME_CAP_PARTS` fixture, forwarded-count assertions, the widened wire-size calibration, and all three raw-gate directions (below, equal, above).
- `src/lib/__tests__/email-ingest-route.test.ts` -- forwarded-count assertions on both branches with the value present and absent, route-side composition, the floor, and the parser's guards.
- `workers/email-ingest/README.md` -- the skipped-attachment sentence now covers both losses and states the twenty-name recording limit.

**Review findings breakdown.** 7 patches applied (all low); 2 items deferred (both medium);
15 rejected. No intent gap and no spec repair: review pass 1 had already repaired the spec,
and pass 2 found no finding whose root cause lay in the spec.

**Follow-up review recommendation:** `true`. Patched this pass: high 0, medium 0, low 7 —
score `3 × 0 + 1 × 7 = 7`, at or above the threshold of 5.

**Verification performed.**
- `npx vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts` -- 52 passed.
- `npx vitest run` -- 259 files, 5621 tests, all passing.
- `npx tsc --noEmit -p tsconfig.json` -- exit 0.
- `npx eslint` -- exit 0 (three pre-existing `jsx-ast-utils` notices, unchanged).
- Every new pin was mutation-tested individually and fails only its intended test: the naive 4/3 cap, the names cap, the Worker body cap, the Worker's forwarded-count append, both route parse branches, the route floor, both parser guards, the gate's `>` boundary, and both wire-size formula terms. App-side edits to `MAX_DOCUMENT_SIZE`, `MAX_EMAIL_ATTACHMENTS_RECORDED` and `MAX_EMAIL_CONTENT_CHARS` alone each fail the parity suite.
- Matrix audit: all nine I/O matrix rows are covered by named tests that ran and passed.

**Residual risks.**
- The two ceilings are not satisfiable at both extremes at once: a maximal document plus a maximal body still bounces (deferred, medium), and several mid-size documents can exceed the per-message cap although each is well within the per-document and per-count limits (deferred, medium).
- Raising the cap raises the peak size of the multipart body posted over the service binding by roughly 44% (to ~14.4 MB). That is well under Cloudflare's request-body limits, but nothing bounds the aggregate of decoded attachment bytes plus the forwarding copies inside the Worker's memory budget (already deferred).
- The raw-gate tests inject `rawSize` onto a small fixture rather than building a real ~14 MB message; the calibration test is what tethers the injected figure to how mail is actually encoded.
