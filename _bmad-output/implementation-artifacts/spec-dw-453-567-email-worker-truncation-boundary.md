---
title: 'Email Worker body-truncation boundary and headerless-part fidelity (DW-453, DW-567)'
type: 'chore'
created: '2026-08-31'
status: 'done'
baseline_revision: '9b7364fc7dda04449423a9b07f60b20856159591'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred:
  - summary: >-
      Multipart transport inflates the forwarded body by one character per
      newline, so a body the Worker considers within the cap can still trip
      `/api/email/ingest`'s `> MAX_EMAIL_CONTENT_CHARS` gate — truncated or not.
    evidence: |-
      The multipart/form-data encoding algorithm normalizes every lone LF and CR
      in an entry value to CRLF, so the `content` the route reads is longer than
      the string the Worker computed. Measured under Node/undici in this repo:

        - a `MAX + 1` single-line body appends at 100000 and reads back at
          100002 (the marker's `"\n\n"` arriving as `"\r\n\r\n"`);
        - an UNTRUNCATED 98,599-character body carrying 3,398 newlines reads
          back at 101,997.

      The second measurement is the one that reframes this. The problem is NOT
      confined to truncated bodies and is therefore NOT fixed by a Worker-side
      truncation budget: any body whose character count plus newline count
      exceeds `MAX_EMAIL_CONTENT_CHARS` trips the route's gate at
      `src/app/api/email/ingest/route.ts:292`, and the Worker's own `>` test at
      `workers/email-ingest/index.ts:1029` never fires on it. The sender then
      loses their body AND every attachment: the route's 400 sends the Worker
      down `if (!response.ok)` (`workers/email-ingest/index.ts:1142`), which
      replies and returns.

      The Worker's truncation arithmetic itself is correct and is now pinned
      pre-serialization by the "email-ingest body truncation" suite; this entry
      is about the seam BELOW it. Neither existing half observes that seam: the
      route half (`email-ingest-route.test.ts`, "body length ceiling", DW-366)
      posts JSON, not multipart, with newline-free bodies, and the Worker half
      stops at the `form.append` call.

      Open question first, fix second: whether `workerd`'s serializer normalizes
      the way Node's does. This repo cannot measure that — it needs a
      `workerd`/Miniflare harness, not another Node test — and this bundle was
      test fidelity only, so it deliberately did not change production code on a
      Node-side observation. If `workerd` does normalize, the candidate fixes are
      a Worker-side budget measured on the POST-normalization length, or a
      route-side gate that measures the pre-normalization length; picking between
      them is a decision this bundle does not make.
    location: >-
      workers/email-ingest/index.ts:1029-1031, src/app/api/email/ingest/route.ts:292
    severity: high
---

<intent-contract>

## Intent

**Problem:** Nothing observes the Worker's body truncation, so an off-by-one in
`rawContent.slice(0, MAX_EMAIL_CONTENT_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER`
(`workers/email-ingest/index.ts:1029`) would ship green while the route's `content.length > MAX_EMAIL_CONTENT_CHARS`
gate 400s every long email (DW-453). DW-567 asks the real-MIME fixture builder to be able to omit
`Content-Disposition` entirely — which the DW-450/565/566 sweep already delivered.

**Approach:** Add a real-MIME truncation suite to `src/lib/__tests__/email-ingest-worker.test.ts` that
pins the truncated body at exactly `MAX_EMAIL_CONTENT_CHARS`, pins the untruncated boundary one
character below it, and pins what survives the cut. Observe the value at the
`form.append("content", …)` call, not off the wire: multipart serialization rewrites every lone LF
into CRLF, so the wire read of a truncated body is longer than the string the Worker computed and
cannot express this arithmetic. DW-567 is verified as already resolved at HEAD, not re-implemented.

## Boundaries & Constraints

**Always:** Derive every expectation from the exported `MAX_EMAIL_CONTENT_CHARS`, never from `100_000`.
Use the existing `multipartEmail` builder and the real `postal-mime` parser (this suite does not mock it).
Restore any `FormData.prototype.append` spy in a `finally`, and snapshot `spy.mock.calls` **before**
`mockRestore()` — the precedent and the reason are in `appendedAttachmentBlobs`
(`email-ingest-worker-normalization.test.ts`).

**Block If:** The append-surface truncated length is anything other than `MAX_EMAIL_CONTENT_CHARS`
— that is a live production defect, not a test to write around.

**Never:** Do not change `workers/email-ingest/index.ts` — its arithmetic is correct and this bundle
is test fidelity only. Do not assert the wire-read length of a truncated body (that pins a transport
artifact, see Design Notes). Do not touch the `multipartEmail` builder for DW-567. Do not edit
`deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Body one character over the cap | `multipartEmail` body of `MAX_EMAIL_CONTENT_CHARS + 1` characters | Appended `content` is exactly `MAX_EMAIL_CONTENT_CHARS` long, ends with `"\n\n[Email body truncated]"`, and opens with the body's own leading characters | No error expected |
| Body exactly at the cap | body of `MAX_EMAIL_CONTENT_CHARS` characters | Appended `content` is the body verbatim — no marker, length unchanged | No error expected |
| Multi-line body over the cap | body of many short LF-terminated lines totalling well over the cap | Same exact-cap length and marker tail as the single-line case | No error expected |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts:1029-1031` -- the truncation under test:
  `rawContent.length > MAX_EMAIL_CONTENT_CHARS ? rawContent.slice(0, MAX - TRUNCATION_MARKER.length) + TRUNCATION_MARKER : rawContent`.
  `TRUNCATION_MARKER` (line 271, `"\n\n[Email body truncated]"`, 24 chars) is **not exported** — the test spells
  the literal. `MAX_EMAIL_CONTENT_CHARS` (line 264) **is** exported and already imported by the suite.
  `rawContent` is `parsed.text?.trim() || htmlToText(parsed.html || "")` (line 715). READ-ONLY this run.
- `workers/email-ingest/index.ts:1098` -- `if (content) form.append("content", content)`: the append call the
  new test observes.
- `src/app/api/email/ingest/route.ts:292` -- the paired gate `content.length > MAX_EMAIL_CONTENT_CHARS → 400`,
  reading `value("content").trim()` off `request.formData()` (line 128, 141). This is the pairing DW-453 calls
  load-bearing. READ-ONLY.
- `src/lib/__tests__/email-ingest-route.test.ts:997-1040` -- the route half already pinned by DW-366:
  `MAX + 1` 400s, `MAX` passes. It posts JSON, not multipart, with newline-free bodies — so it and the new
  Worker case sit on either side of the serializer without meeting at it. See the `deferred` entry.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- the target file. Reuse points, **as line-numbered before
  this change** (the new header entry shifts everything below it down by ~19 lines — anchor on the symbol
  names, not these numbers): `multipartEmail` (479, `options.body`), `message`/`env` (162, 176),
  `forwardedForm` (609). `MAX_EMAIL_CONTENT_CHARS` is already imported (line 7). The existing
  `form.get("content")` assertions (1144, 1389, 1790) are all short single-line bodies, which is why the CRLF
  rewrite has never surfaced here.
- `src/lib/__tests__/email-ingest-worker-normalization.test.ts:117-140` -- `appendedAttachmentBlobs`: the
  existing "spy on `FormData.prototype.append` because the wire erases the distinction" precedent, including
  the snapshot-before-`mockRestore` trap. Copy the shape, not the file (that suite mocks `postal-mime`).
- **DW-567 evidence (already resolved at HEAD, no work required):** `multipartEmail`'s `disposition` option is
  `string | null | undefined` (496) — `undefined` derives the header, a string replaces it, and
  `null` **omits** it (`if (disposition !== null) lines.push(disposition)`, line 570), guarded by the throw at
  556 that redirects the part name onto `Content-Type name=`. Real-MIME headerless fixtures exist and run
  against the real parser: `CID_LOGO` (1840-1846) and the Content-ID suite at 1839-2110, which exercises both
  the counted-as-real-attachment branch ("treats an UNREFERENCED Content-ID as a real attachment", 1932) and
  the still-forwarded branch ("still forwards a Content-ID-only document the body references", 1878). Landed
  by commit `0d2008293741120b3814c40a65bfaf88f204cd36` (`sweep dw-email-inline-part-eligibility: DW-450, DW-565, DW-566`), after DW-567 was
  written against `spec-dw-446-email-inline-part-eligibility.md`.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/email-ingest-worker.test.ts` -- add a `describe("email-ingest body truncation", …)` suite
  with an `appendedContent(raw, subject, slug)` helper (spy on `FormData.prototype.append`, snapshot calls,
  restore in `finally`, return the `content` entry) covering the three I/O Matrix rows -- DW-453: the Worker's
  truncation arithmetic and its pairing with the route's 400 gate are currently unobserved.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- extend the file's top-of-file surface list with the
  truncation entry -- the list is that suite's index of what it pins, and a section absent from it reads as
  unpinned.

**Acceptance Criteria:**
- Given a real-MIME message whose body exceeds the cap, when the Worker forwards it, then the string handed to
  `form.append("content", …)` is exactly `MAX_EMAIL_CONTENT_CHARS` characters — the Worker's own arithmetic,
  pinned pre-serialization. It does **not** follow that the route's `> MAX_EMAIL_CONTENT_CHARS` gate cannot
  fire: the serializer between them inflates the value (see `deferred`), and the tests must not claim it does.
- Given the new suite, when `MAX_EMAIL_CONTENT_CHARS - TRUNCATION_MARKER.length` is changed by one in either
  direction, or the truncation ternary's `>` is flipped to `>=`, then at least one new test fails.
- Given `workers/email-ingest/index.ts` and `multipartEmail`, when the change is complete, then neither has
  been modified.

## Spec Change Log

## Design Notes

**Why the append call, not `form.get("content")`.** The multipart/form-data encoding algorithm normalizes every
lone LF and CR in an entry value to CRLF, so reading a truncated body back off the wire returns
`MAX_EMAIL_CONTENT_CHARS + 2` (the marker's `"\n\n"` becomes `"\r\n\r\n"`), plus one more character per newline
in the sender's own text. Measured, not assumed: a `MAX + 1` single-line body appends at 100000 and reads back
at 100002. That divergence is a property of the serializer, not of the Worker, and asserting it would pin the
transport instead of the arithmetic DW-453 names. The append call is the outermost surface where the Worker's
own number is still visible — the same reasoning, and the same spy shape, as `appendedAttachmentBlobs` next
door.

That measurement also raises a question this bundle does not answer and must not silently absorb: whether
`workerd`'s serializer normalizes the same way, and therefore whether the route really does 400 these messages
in production. Review widened it — an *untruncated* 98,599-character body with 3,398 newlines reads back at
101,997, so the exposure is not confined to truncated bodies. Record it as deferred work with that framing; do
not change the Worker here on the strength of a Node-side observation, and do not let the tests or their
docstrings claim the route accepts what the Worker sends.

**Fixture shape.** `multipartEmail`'s `options.body` is written into the `text/plain` part verbatim, and
`parsed.text.trim()` returns it unchanged, so a `"x".repeat(MAX_EMAIL_CONTENT_CHARS + 1)` body arrives as
exactly `MAX + 1` characters of `rawContent` — verified. Keep the multi-line case as short LF-terminated lines
so the truncation cut lands mid-text rather than on a line boundary.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/email-ingest-worker.test.ts` -- expected: all tests pass, including the
  three new truncation cases.
- `pnpm lint` -- expected: no new errors.
- `git diff --stat` -- expected: `src/lib/__tests__/email-ingest-worker.test.ts` only.

## Review Triage Log

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 2, low 1)
- defer: 0
- reject: 14
- addressed_findings:
  - `[medium]` `[patch]` The suite docstring, the file's surface-list entry 11, and the spec's headline
    acceptance criterion all claimed the pinned length means "the route's `> MAX_EMAIL_CONTENT_CHARS` 400
    cannot fire on the Worker's own output". Measured false. Reworded all three to say exactly what is
    pinned (the Worker's pre-serialization arithmetic) and to name the wire divergence, with the measured
    numbers, as an open question rather than a settled one.
  - `[medium]` `[patch]` The `deferred` entry framed the transport inflation as a truncated-body problem
    fixable by a Worker-side truncation budget. Review measured an *untruncated* 98,599-character body with
    3,398 newlines reading back at 101,997 — over the route's gate, with the Worker's `>` test never firing.
    Rewrote the entry: any body whose character count plus newline count exceeds the cap is exposed, a
    truncation budget alone does not fix it, and the route's 400 costs the sender body and attachments both.
    Reproduced independently before rewriting.
  - `[low]` `[patch]` Code Map factual errors: `TRUNCATION_MARKER` is 24 characters, not 25; the `content`
    append is `workers/email-ingest/index.ts:1098`, not 1097; the target-file line anchors were captured
    pre-change and are now shifted. Corrected, and the shifted anchors labelled as pre-change with a note to
    anchor on symbol names.

Rejected, for the record, the recurring suggestion to add a wire-read assertion (`form.get("content")`
against the cap) as the "missing" pairing test: it fails today, and committing a red test in place of the
recorded deferred finding would trade an honest open item for a broken suite. Also rejected as outside this
bundle's intent, which is the truncation *boundary*: HTML-branch truncation coverage, surrogate-pair
splitting at the cut, trim/cap interaction, an attachment-bearing over-cap fixture, extracting a helper
shared with `email-ingest-worker-normalization.test.ts`, and assorted cosmetic items.

## Auto Run Result

Status: done

**Implemented change.** Added a real-MIME `describe("email-ingest body truncation")` suite to the Worker test
file, pinning that an over-cap body is cut to exactly `MAX_EMAIL_CONTENT_CHARS` (marker included, correct end
kept), that a body sitting on the cap passes through verbatim, and that a multi-line body truncates the same
way with the cut landing mid-line. The value is read at the `form.append("content", …)` call — the outermost
surface at which the Worker's own arithmetic survives, since multipart serialization rewrites lone LFs.
DW-567 required no work: the DW-450/565/566 sweep (`0d2008293741120b3814c40a65bfaf88f204cd36`) already gave
`multipartEmail` a `disposition: null` that omits the header, and real-MIME headerless fixtures already run
against the real parser in `describe("email-ingest Content-ID parts")`. Verified rather than reimplemented.

**Files changed.**
- `src/lib/__tests__/email-ingest-worker.test.ts` — new truncation suite, an `appendedContent` helper, and a
  new entry 11 in the file's surface list.

`workers/email-ingest/index.ts` and the `multipartEmail` builder are byte-identical to baseline.

**Review findings.** 3 patches applied (2 medium, 1 low), 0 deferred this pass (the one `deferred` item was
recorded during implementation and rewritten by a patch above), 14 rejected, 0 intent gaps, 0 spec repairs.

**Follow-up review recommended: true.** Patched findings: high 0, medium 2, low 1 → 3×2 + 1×1 = 7, which is
at or above 5.

**Verification.**
- `pnpm vitest run` over `email-ingest-worker.test.ts`, `email-ingest-route.test.ts`, and
  `email-ingest-worker-normalization.test.ts` — 119 passed, including the 3 new cases. No spy leakage.
- Mutation-checked the acceptance criterion against `workers/email-ingest/index.ts:1029-1030` (slice ±1,
  subtraction dropped, `>` → `>=`); each mutation fails at least one new case. Worker restored byte-identical.
- `pnpm lint` — exit 0 (three pre-existing `jsx-ast-utils` notices, present on a clean baseline too).
- The wire divergence was measured, not assumed, both during planning and again during review.
- I/O matrix audit: all three rows have a covering test, and all three ran and passed.

**Residual risks.**
1. The `deferred` item is the real one, and it is severity high: if `workerd`'s multipart serializer
   normalizes lone LFs the way Node's does, `/api/email/ingest` 400s any email whose body character count
   plus newline count exceeds `MAX_EMAIL_CONTENT_CHARS` — truncated or not — and the sender loses their body
   and every attachment. Nothing in this repo can measure `workerd`, so it is recorded, not fixed. The new
   tests are careful not to imply otherwise.
2. Neither half of the Worker/route pairing exercises multipart transport: the route half posts JSON, this
   half stops before serialization. That seam stays unobserved until the item above is resolved.
3. A concurrent session in this same working copy rewrote the baseline commit mid-run and swept the first
   version of these two files into its own commit (`446e85bf`). The content is intact and
   `workers/email-ingest/index.ts` is unchanged between the original baseline and current HEAD, but this
   run's `baseline_revision` (`9b7364fc7dda04449423a9b07f60b20856159591`) is no longer reachable from HEAD.
