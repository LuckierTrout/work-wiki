---
title: 'Email Worker body-truncation boundary and headerless-part fidelity (DW-453, DW-567)'
type: 'chore'
created: '2026-08-31'
status: 'in-review'
baseline_revision: '9b7364fc7dda04449423a9b07f60b20856159591'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      A truncated body may reach `/api/email/ingest` at `MAX_EMAIL_CONTENT_CHARS + 2`
      and 400, if `workerd`'s multipart serializer normalizes lone LFs the way
      Node's does.
    evidence: |-
      The Worker truncates to exactly `MAX_EMAIL_CONTENT_CHARS` (now pinned at
      the `form.append("content", ...)` call by the new "email-ingest body
      truncation" suite). But the multipart/form-data encoding algorithm
      normalizes every lone LF and CR in an entry value to CRLF, so the value
      read back off the wire is longer than the string the Worker computed.
      Measured under Node/undici in this repo: a `MAX + 1` single-line body
      appends at 100000 and `formData()` reads back at 100002 — the marker's
      `"\n\n"` arriving as `"\r\n\r\n"` — plus one more character per newline in
      the sender's own text. The route's gate is
      `content.length > MAX_EMAIL_CONTENT_CHARS` (`src/app/api/email/ingest/route.ts:292`),
      so if `workerd` serializes the same way, every truncated email 400s in
      production and the sender loses their body AND every attachment on the
      message. This bundle is test fidelity only and deliberately did NOT change
      the Worker on the strength of a Node-side observation: the open question is
      what `workerd` actually does. Answering it needs a `workerd`/Miniflare
      measurement, not another Node test. If it normalizes, the fix is a
      Worker-side budget for the expansion or a route-side gate that measures the
      pre-normalization length — a decision this bundle does not make.
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
  `TRUNCATION_MARKER` (line 271, `"\n\n[Email body truncated]"`, 25 chars) is **not exported** — the test spells
  the literal. `MAX_EMAIL_CONTENT_CHARS` (line 264) **is** exported and already imported by the suite.
  `rawContent` is `parsed.text?.trim() || htmlToText(parsed.html || "")` (line 715). READ-ONLY this run.
- `workers/email-ingest/index.ts:1097` -- `if (content) form.append("content", content)`: the append call the
  new test observes.
- `src/app/api/email/ingest/route.ts:292` -- the paired gate `content.length > MAX_EMAIL_CONTENT_CHARS → 400`,
  reading `value("content").trim()` off `request.formData()` (line 128, 141). This is the pairing DW-453 calls
  load-bearing. READ-ONLY.
- `src/lib/__tests__/email-ingest-route.test.ts:997-1040` -- the route half already pinned by DW-366:
  `MAX + 1` 400s, `MAX` passes. The new Worker test is the other half of that pair.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- the target file. Reuse points:
  `multipartEmail` (line 479, `options.body`), `message`/`env` (162, 176), `forwardedForm` (609).
  `MAX_EMAIL_CONTENT_CHARS` is already imported (line 7). Existing `form.get("content")` assertions
  (1144, 1389, 1790) are all short single-line bodies, which is why the CRLF rewrite has never surfaced here.
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
  `form.append("content", …)` is exactly `MAX_EMAIL_CONTENT_CHARS` characters — so the route's
  `> MAX_EMAIL_CONTENT_CHARS` 400 cannot fire on the Worker's own output.
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
`workerd`'s serializer normalizes the same way, and therefore whether the route really does receive
`MAX + 2` and 400 the message in production. Record it as deferred work; do not change the Worker here on the
strength of a Node-side observation.

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
