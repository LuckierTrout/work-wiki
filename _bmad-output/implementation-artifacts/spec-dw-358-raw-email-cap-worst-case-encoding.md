---
title: 'Derive the raw email cap from the worst-case transfer encoding'
type: 'bugfix'
created: '2026-08-22'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The MIME envelope headroom was never re-derived for a quoted-printable
      BODY, only for the attachment, although DW-358's own reason names
      non-ASCII bodies as a carrier.
    evidence: |-
      MIME_ENVELOPE_HEADROOM_BYTES is still 64 KiB and its comment still frames
      the body as "an ordinary text body". MAX_EMAIL_CONTENT_CHARS is 100,000,
      so a non-ASCII body sent quoted-printable reaches the wire at up to
      ~312 KB -- roughly five times the headroom that is meant to cover part
      headers, boundaries AND the body. The document half of DW-358 is fixed;
      the body half is not, and the pair's recorded trade-off ("only has to be
      simultaneously satisfiable for realistic mail") predates the encoding
      this change is about. Whether to re-derive the headroom from
      MAX_EMAIL_CONTENT_CHARS x WORST_CASE_TRANSFER_ENCODING_FACTOR is a cap
      decision, not a patch.
    location: >-
      workers/email-ingest/index.ts (MIME_ENVELOPE_HEADROOM_BYTES)
    severity: medium
  - summary: >-
      Widening the raw cap 2.27x roughly doubles the peak decoded-attachment
      memory the Worker buffers, which is exactly the exposure DW-360 records
      and nothing bounds it.
    evidence: |-
      DW-360's own recorded reason is "Nothing bounds the aggregate size of the
      attachments the Worker copies into the forwarded FormData, and raising
      the raw cap raises that peak." MAX_RAW_EMAIL_BYTES just moved from
      14,414,471 to 32,781,108, so the base64-carried payload a message may
      deliver rises from ~10.5 MB to ~23.9 MB of decoded bytes, and
      attachmentBytes copies each part again on top of the parsed MIME tree,
      inside a Cloudflare Worker isolate. An aggregate budget is DW-362's
      subject and was out of scope for this bundle, so no guard was added --
      but the exposure is measurably larger than when DW-360 was filed.
    location: >-
      workers/email-ingest/index.ts (attachmentBytes / forwarded FormData)
    severity: medium
  - summary: >-
      The widened cap (31.2 MB quoted to senders) may now exceed Cloudflare
      Email Routing's own inbound message-size limit, making the gate
      unreachable and the quoted figure unachievable.
    evidence: |-
      Two independent reviewers flagged that Email Routing enforces a platform
      inbound ceiling (reported as 25 MiB, unverified offline and recorded
      nowhere in this repo). If that holds, messages between the platform limit
      and 32,781,108 bytes are rejected upstream and never reach the Worker, so
      the refusal copy invites a sender to resend under a ceiling that will
      also fail -- and the very scenario DW-358 names (a byte-dense 10 MB .csv
      sent quoted-printable, 32,715,573 bytes on the wire) could still never
      arrive. Clamping MAX_RAW_EMAIL_MB to a recorded transport bound is a
      different decision from "widen for worst-case encoding" and needs its own.
    location: >-
      workers/email-ingest/index.ts (MAX_RAW_EMAIL_MB refusal copy)
    severity: medium
  - summary: >-
      Three open ledger entries now carry reasons that are stale or false
      against the widened cap and will be read as current by the next sweep.
    evidence: |-
      DW-361's trade-off ("a full-size document plus a maximal body is
      refused") no longer binds for base64: 14,448,938 now fits under
      32,781,108, and only the quoted-printable measurement still bounces.
      DW-362's premise ("ten 2 MB documents encode to roughly 27 MB and are
      bounced by MAX_RAW_EMAIL_BYTES (14.4 MB)") is now false -- 27 MB fits.
      DW-453's band ("a document more than roughly 47 KB over the 10 MB
      ceiling pushes rawSize past that gate") widens by more than two orders of
      magnitude, and its quoted "larger than 13.7 MB" copy is now "31.2 MB".
      This session was forbidden to edit the ledger, so the re-verification is
      recorded here instead.
    location: >-
      _bmad-output/implementation-artifacts/deferred-work.md (DW-361, DW-362, DW-453)
    severity: low
baseline_revision: '0750be7fc2e593e5ef253cfbb06db6d562ccc0cb'
---

<intent-contract>

## Intent

**Problem:** `MAX_RAW_EMAIL_BYTES` is derived from base64 expansion alone (~1.37x), but
`message.rawSize` is measured before decoding and mail clients routinely send `text/*`
attachments and non-ASCII bodies as quoted-printable, which expands byte-dense content
up to ~3.12x. A `.csv` or `.txt` attachment well under the advertised 10 MB per-document
ceiling can therefore still be bounced at the door with a whole-message size refusal --
the same defect DW-104 fixed for base64, unfixed for the other encoding.

**Approach:** Per the human's 2026-08-21 "Widen for worst-case encoding" decision, add a
named quoted-printable expansion factor, derive `MAX_RAW_EMAIL_BYTES` from the worst of
the transfer encodings a client may pick rather than from base64 alone, record that
derivation beside the constant, and re-pin the parity test at the message surface so the
admitted document is measured as quoted-printable rather than base64.

## Boundaries & Constraints

**Always:** Keep `MAX_RAW_EMAIL_BYTES` *derived* from exported terms, never restated as a
literal. Keep every constant this Worker duplicates from `src/lib` pinned by
`email-ingest-allowlist-parity.test.ts`. Keep the refusal copy quoting the cap rounded
DOWN. Keep the base64 case admitted -- widening must not regress DW-104. Any wire-size
formula added must be calibrated against a real fixture, the way `base64PartWireSize`
already is.

**Block If:** Admitting a worst-case quoted-printable full-size document would require
changing `MAX_EMAIL_DOCUMENT_BYTES`/`MAX_DOCUMENT_SIZE`, `MAX_EMAIL_CONTENT_CHARS`, or
moving the gate off `message.rawSize` onto decoded size -- the human's decision was to
widen the raw cap, not to move the gate or shrink the document ceiling.

**Never:** Do not implement DW-362 (an aggregate multi-document budget for
`MAX_EMAIL_ATTACHMENTS` documents) -- it is a separate open item with its own decision.
Do not change `MAX_DOCUMENT_SIZE`, `MAX_EMAIL_ATTACHMENTS`, `MAX_EMAIL_DOCUMENTS`, the
per-attachment oversize skip, or the acknowledgement copy. Do not edit
`_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Worst-case QP full-size document | `rawSize` = worst-case quoted-printable wire size of a `MAX_EMAIL_DOCUMENT_BYTES` payload | Under the cap: forwarded, no "larger than" in the reply | No error expected |
| Base64 full-size document (DW-104 regression) | `rawSize` = `base64PartWireSize(MAX_EMAIL_DOCUMENT_BYTES)` | Still forwarded | No error expected |
| Exactly on the new cap | `rawSize` = `MAX_RAW_EMAIL_BYTES` | Forwarded -- the gate is `>` | No error expected |
| One byte over | `rawSize` = `MAX_RAW_EMAIL_BYTES + 1` | Refused, reply quotes the new cap rounded down; quoted MB never exceeds the enforced cap | Size bounce reply |
| Worst-case QP document plus a maximal body | `rawSize` = QP wire size + `MAX_EMAIL_CONTENT_CHARS` | Refused -- the recorded envelope trade-off still holds at the widened cap | Size bounce reply |
| Quoted-printable attachment end to end | A `text/csv` part with `Content-Transfer-Encoding: quoted-printable` | PostalMime decodes it; forwarded bytes are byte-identical to the source | No error expected |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts` -- the whole production change surface. `:44`
  `MAX_EMAIL_DOCUMENT_BYTES`; `:52-58` `BASE64_EXPANSION_FACTOR = (4 / 3) * (78 / 76)`
  with the doc-comment shape to copy for the new factor; `:60-67`
  `MIME_ENVELOPE_HEADROOM_BYTES = 64 * 1024` whose comment names a now-stale "65,533
  bytes" slack figure; `:69-86` `MAX_RAW_EMAIL_BYTES` and its comment, whose entire
  second paragraph ("~13.75 MiB", "about 13.4 MB", the 2026-08-19 arithmetic) is
  superseded; `:88-93` `MAX_RAW_EMAIL_MB`, rounded down for the refusal copy; `:288-295`
  the `message.rawSize > MAX_RAW_EMAIL_BYTES` gate and its reply -- **behavior unchanged,
  only the constant it compares against moves**.
- `src/lib/__tests__/email-ingest-wire.ts` -- shared, deliberately not a `*.test.ts` so
  vitest does not collect it. Holds `base64PartWireSize`. The quoted-printable
  counterpart belongs here for the same reason: two suites need it and a second copy
  could drift.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- `:145-171` is the raw-cap
  pin to re-derive (currently measures `base64PartWireSize(MAX_DOCUMENT_SIZE)` and pins
  the base64-only derivation). `:14-25` is the import block from the Worker. Every other
  test in the file is read-only.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- `:79-86` `base64Lines`; `:336-340`
  `partBytes`; `:342-386` `multipartEmail`, which hardcodes
  `"Content-Transfer-Encoding: base64"` at `:378`; `:951-1009` the base64 calibration
  test, the pattern to mirror (it extracts encoded blocks back out of a real fixture
  rather than rebuilding them); `:1064-1099` "bounces a full-size document carried
  alongside a maximal body", whose `expect(rawSize).toBeGreaterThan(MAX_RAW_EMAIL_BYTES)`
  is expected to fail under the widened cap -- its own comment names DW-358 and directs
  the implementer to re-derive it here rather than read the failure as a regression.
- Read-only evidence: no doc, route, or other test hardcodes the old cap figure --
  `grep` for `13.7`, `13,981`, `14,348,938` finds only the Worker comments above.
  `CEILING_MB` in the worker suite is `MAX_EMAIL_DOCUMENT_BYTES`-derived (10 MB), a
  different ceiling, and must not move.

## Tasks & Acceptance

**Execution:**
- `workers/email-ingest/index.ts` -- export a `QUOTED_PRINTABLE_EXPANSION_FACTOR` and a
  `WORST_CASE_TRANSFER_ENCODING_FACTOR = Math.max(...)` over it and
  `BASE64_EXPANSION_FACTOR`, derive `MAX_RAW_EMAIL_BYTES` from the latter, and rewrite
  the `MAX_RAW_EMAIL_BYTES` and `MIME_ENVELOPE_HEADROOM_BYTES` comments to record the new
  derivation and the true new slack figure -- so the cap admits whichever encoding the
  sender's client picks, and the recorded reasoning is not left describing base64.
- `src/lib/__tests__/email-ingest-wire.ts` -- add `quotedPrintablePartWireSize`, the
  exact worst-case (every octet escaped) wire size, with the line-budget arithmetic in
  its comment -- shared for the same reason `base64PartWireSize` is.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- re-pin the raw-cap test on
  the quoted-printable measurement, keep the base64 admission as a DW-104 regression
  guard, pin the derivation against the exported terms, and pin that the worst-case
  factor really is the worst of the named encodings.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- teach `multipartEmail` to emit a
  quoted-printable part, calibrate `quotedPrintablePartWireSize` against that real
  fixture the way the base64 formula is calibrated, add an end-to-end forwarding case for
  a quoted-printable attachment, and re-derive the maximal-body bounce test on the
  quoted-printable wire size (replacing its DW-358 note with the resolved reasoning).

**Acceptance Criteria:**
- Given `MAX_DOCUMENT_SIZE` is 10 MB, when a MIME part carrying that many bytes is
  quoted-printable-encoded at worst case (every octet escaped, lines filled to the RFC
  2045 limit), then its wire size is strictly below `MAX_RAW_EMAIL_BYTES` with at least
  1024 bytes of slack.
- Given the previous base64-only derivation, when the same worst-case quoted-printable
  wire size is compared against it, then it exceeds that older cap -- the defect DW-358
  reported is pinned as fixed, not merely as changed.
- Given `MAX_RAW_EMAIL_BYTES`, when it is compared against
  `Math.ceil(MAX_EMAIL_DOCUMENT_BYTES * WORST_CASE_TRANSFER_ENCODING_FACTOR) +
  MIME_ENVELOPE_HEADROOM_BYTES`, then it is equal -- the cap is derived, not restated.
- Given `WORST_CASE_TRANSFER_ENCODING_FACTOR`, when compared against the two named
  encoding factors, then it is greater than or equal to both and equal to the
  quoted-printable one -- so "worst case" is a claim the suite checks rather than a label.
- Given a fixture built with a quoted-printable attachment part, when the encoded region
  is read back out of the message, then `quotedPrintablePartWireSize` predicts its byte
  length exactly -- the formula cannot drift from how mail is really written.
- Given the whole suite, when `pnpm vitest run src/lib/__tests__/email-ingest-*` runs,
  then every test passes with no test asserting the old cap figure.

## Spec Change Log

- **2026-08-22 — quoted-printable wire-size formula corrected during implementation.**
  The Design Notes' formula assumed "a final line that exactly fills the budget
  carries no soft break" (`fullLines * 78 - 1` / `+ remainder * 3 + 2`). Building
  the fixture that way and decoding it through PostalMime — the calibration the
  Boundaries section makes mandatory, and the "byte-identical" acceptance
  criterion — showed the assumption is false at the Worker's real decoder: the
  CRLF preceding the MIME boundary is a *hard* line break, so PostalMime returned
  the payload plus a stray `\n`. Every line therefore ends in a `=` soft break,
  last included, and the part body sits flush against the boundary with no blank
  line. That costs exactly one byte more per part:
  `remainder === 0 ? fullLines * 78 : fullLines * 78 + remainder * 3 + 3`. No
  acceptance criterion changes sign — a full-size document still measures
  32,715,573 bytes against a 32,781,108-byte cap (65,535 bytes of slack), still
  exceeds the old base64-only derivation, and the maximal-body case still bounces.

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 4: (high 0, medium 3, low 1)
- reject: 5: (high 0, medium 1, low 4)
- addressed_findings:
  - `[medium]` `[patch]` `QUOTED_PRINTABLE_EXPANSION_FACTOR` was named and documented as the worst case, but `3 * (78 / 75)` is only the worst case among encoders that fill lines to the RFC 2045 76-character budget; a conforming encoder wrapping narrower costs `(3k + 3) / k` per byte and expands more. The comment now states the line-fill assumption as an assumption and records the residual with figures (32,715,573 at k=25 with 65,535 slack; 32,768,001 at k=24 with 13,107 slack; 32,824,989 at k=23, over the cap), naming the sub-72-column case as a bounded known limit.
  - `[medium]` `[patch]` The 72-column claim was prose only. `quotedPrintablePartWireSize` took an optional `escapesPerLine` (default 25, no call site changed) and the parity suite now pins that k=24 still fits, that k=24 costs more than k=25, and that k=23 is over the cap.
  - `[medium]` `[patch]` A doc comment in `email-ingest-worker.test.ts` was left factually false by the widening — it justified a `rawSize` override with "two 10 MB parts cannot coexist under `MAX_RAW_EMAIL_BYTES`", but two `MAX_EMAIL_DOCUMENT_BYTES + 1` parts base64-encode to 28,697,876 bytes, which now fits. Rationale corrected.
  - `[low]` `[patch]` The comments read as if the expansion ratio were exact; it can under-count the exact per-message formula (32,715,572 against 32,715,573 at a full-size document). Recorded, with the envelope headroom named as what absorbs it.
  - `[low]` `[patch]` The "pinned as FIXED, not merely as changed" assertion reconstructed the old base64-only cap from two live constants and would have drifted if `MIME_ENVELOPE_HEADROOM_BYTES` moved. Frozen as `PREVIOUS_BASE64_ONLY_CAP_BYTES = 14_414_471` with a never-re-derive comment.
  - `[low]` `[patch]` The new quoted-printable end-to-end test's closing `not.toContain("larger than")` was labelled as evidence for the widened cap, but its ~1 KB fixture cleared the old cap too. Re-labelled as a plain sanity check; the dead `byteLength === 0` guard in `quotedPrintablePartWireSize` was also removed.

## Design Notes

**Where 3.12 comes from.** RFC 2045 §6.7 lets any octet be written `=XX` (3 characters),
and caps a line at 76 characters. A `=XX` escape may not be split across lines, so a line
holds at most 25 escapes (75 characters) before the `=` soft line break, then CRLF: 78
wire bytes per 25 payload bytes. Hence `3 * (78 / 75)`, written in the same
`ratio * lineOverhead` shape as `BASE64_EXPANSION_FACTOR = (4 / 3) * (78 / 76)`.

**Take the max, do not swap.** The decision says derive from the *worst-case* transfer
encoding. Expressing that as `Math.max(BASE64_EXPANSION_FACTOR,
QUOTED_PRINTABLE_EXPANSION_FACTOR)` keeps the base64 term live and meaningful, makes the
"worst case" claim readable at the constant, and keeps the cap tracking whichever factor
is worse if either is ever corrected -- where a bare swap would leave a dead export and a
comment asserting a maximum nothing computes.

**The exact formula, not the factor, is what the test measures.** The factor is a
per-byte ratio and rounds; the helper must be exact so it can be calibrated:

```ts
// 25 escapes (75 chars) + "=" soft break + CRLF = 78 bytes per 25 payload bytes.
// A final line that exactly fills the budget carries no soft break: 75 chars + CRLF.
if (byteLength === 0) return 0;
const fullLines = Math.floor(byteLength / 25);
const remainder = byteLength % 25;
return remainder === 0 ? fullLines * 78 - 1 : fullLines * 78 + remainder * 3 + 2;
```

**Why the end-to-end quoted-printable case earns its place.** `base64Lines` is trusted
because it delegates to a real encoder (`Buffer.toString("base64")`); a hand-written
worst-case quoted-printable encoder has no such anchor. Letting PostalMime decode the
fixture back to `partBytes` is that anchor -- and it is also the DW-358 scenario itself, a
`text/csv` attachment sent quoted-printable, observed at the Worker surface.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts` -- expected: all pass
- `pnpm vitest run src/lib/__tests__/email-ingest-route.test.ts` -- expected: all pass, unaffected
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm exec eslint workers/email-ingest/index.ts src/lib/__tests__/email-ingest-wire.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts` -- expected: clean

## Auto Run Result

Status: done

**Implemented change.** `MAX_RAW_EMAIL_BYTES` is now derived from the worst of the transfer
encodings a sending client may pick rather than from base64 alone, per the human's
2026-08-21 "Widen for worst-case encoding" decision on DW-358. The cap moves from
14,414,471 to 32,781,108 bytes (~31.26 MiB), and the refusal copy — derived, rounded down —
now quotes 31.2 MB. The `message.rawSize` gate, `MAX_DOCUMENT_SIZE`,
`MAX_EMAIL_ATTACHMENTS`, `MAX_EMAIL_CONTENT_CHARS` and every acknowledgement line are
unchanged; only the constant the gate compares against moved.

**Files changed.**
- `workers/email-ingest/index.ts` — added `QUOTED_PRINTABLE_EXPANSION_FACTOR` (`3 * (78 / 75)`, with its RFC 2045 §6.7 derivation and its stated line-fill assumption) and `WORST_CASE_TRANSFER_ENCODING_FACTOR` (a `Math.max` over the two named encodings, so "worst case" is computed rather than asserted); re-derived `MAX_RAW_EMAIL_BYTES` from it and rewrote both its comment and the stale slack figure in `MIME_ENVELOPE_HEADROOM_BYTES`.
- `src/lib/__tests__/email-ingest-wire.ts` — added `quotedPrintablePartWireSize`, the exact worst-case wire size, with an optional `escapesPerLine` so a narrower sender wrap can be measured.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — re-pinned the raw cap on the quoted-printable measurement, kept the base64 admission as a DW-104 regression guard, froze the historical base64-only cap, and added pins for the worst-case-factor composition and the 72-column sender wrap.
- `src/lib/__tests__/email-ingest-worker.test.ts` — `multipartEmail` can emit a quoted-printable part; added a PostalMime round-trip that anchors the hand-written encoder, a three-branch calibration of the new formula against a real fixture, a gate test for a worst-case quoted-printable full-size document, and re-derived the maximal-body bounce test.

**Review findings.** 6 patches applied (2 medium, 4 low — see the Review Triage Log),
4 deferred (3 medium, 1 low — recorded in frontmatter `deferred`), 5 rejected (the
gate tests' synthesized `rawSize` and base64 fixture, which is the file's pre-existing and
deliberate pattern; a request for a realistic mixed-literal quoted-printable fixture, which
would test PostalMime rather than this change; negative-path quoted-printable coverage
already carried by the encoding-agnostic gate tests; the parity file's derivation
assertions being "tautologies", which is the pin's stated purpose; and a zero-length
fixture disagreement that no fixture can reach).

**Follow-up review recommended:** true. Patched findings: 0 high, 2 medium, 4 low →
3 × 2 + 1 × 4 = 10, at or above the threshold of 5.

**Verification.**
- `./node_modules/.bin/vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-route.test.ts` — 74 passed, 3 files, 0 failures.
- `./node_modules/.bin/vitest run --project node` — 231 files, 5667 tests, all passing; no collateral anywhere in the suite.
- `./node_modules/.bin/tsc --noEmit` — clean.
- `eslint` on the three changed test files — clean (`workers/email-ingest/index.ts` matches a pre-existing eslint ignore pattern).
- `pnpm vitest` cannot run in this environment (a stray empty `~/pnpm-workspace.yaml` makes pnpm fail with "packages field missing or empty"), so the local `vitest` binary was used — the same runner `pnpm test` invokes. This is an environment fault, not a repository one.
- Every I/O matrix row is covered by a test that ran and passed: the quoted-printable and base64 full-size admissions, the exactly-on-cap and one-over gate cases, the document-plus-maximal-body bounce, and the end-to-end quoted-printable forward.

**Residual risks.**
- The factor models a sender that wraps at the RFC 2045 76-character maximum. A conforming encoder wrapping narrower than 72 columns can still bounce a maximally-escaped full-size document. This is now stated at the constant and pinned in the parity suite, but it is a real, bounded limit rather than a closed one.
- The three medium deferrals above — the quoted-printable body against the envelope headroom, the enlarged aggregate-memory exposure DW-360 records, and the possible Cloudflare Email Routing inbound ceiling below the new cap — are all consequences of the widening that were outside this bundle's decision and need their own.
- Real-world impact is smaller than the worst case suggests: a conforming encoder leaves printable ASCII literal, so an ordinary `.csv` expands nearer 1.0–1.1x. The cap now admits the pathological case as well, which is what the decision asked for.
