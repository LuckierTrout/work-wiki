---
title: 'Skip an oversized email attachment instead of refusing the whole message'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
baseline_revision: '08d7a11f587d75aa90574ea92a2c0d539ab08ca2'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The Worker's raw-message gate bounces the whole email for any attachment more than
      ~50 KB above MAX_EMAIL_DOCUMENT_BYTES, so the new per-file oversize skip only ever
      fires in a narrow band just above the ceiling.
    evidence: |-
      MAX_RAW_EMAIL_BYTES is ceil(10 MiB x BASE64_EXPANSION_FACTOR) + 64 KiB, checked on
      message.rawSize before the MIME parse. An attachment of size S reaches the wire at
      about 1.368 x S, so a document more than roughly 47 KB over the 10 MB ceiling pushes
      rawSize past that gate and the sender gets the "larger than 13.7 MB" whole-message
      refusal -- body and every other attachment lost -- without ever reaching the new
      oversizedAttachments filter. The two "too big" replies also quote two different
      ceilings (10 MB vs 13.7 MB) depending on which gate catches the message. Pre-existing
      (the gate is DW-104's), surfaced by DW-253: it materially bounds how often the
      per-file skip can help, and the acknowledgement copy implies a broader guarantee.
    location: >-
      workers/email-ingest/index.ts:271
    severity: medium
---

<intent-contract>

## Intent

**Problem:** A single attachment over `MAX_DOCUMENT_SIZE` makes `/api/email/ingest` 400 the *whole* email (`src/app/api/email/ingest/route.ts:164-170`), so the body and every other attachment are lost; the inbound Worker has no per-document byte pre-filter, so it forwards the oversized part and pays for that bounce. Separately, the body-plus-all-unsupported-attachments case — "queued" line omitted, "skipped" line fired, zero-attachment form forwarded — has no end-to-end test on either side.

**Approach:** Replace the route's oversize 400 with a per-file skip: the oversized file is dropped, folded into `skippedAttachmentCount`, and named back to the caller; the body and remaining attachments ingest normally. Add a matching per-document byte pre-filter to the Worker's `supportedAttachments` selection so an oversized part is never forwarded, counted into its own skipped total, and named in the acknowledgement alongside the existing skipped-attachment sentence. Add the missing body-plus-all-unsupported case to both suites.

## Boundaries & Constraints

**Always:**
- The oversize ceiling stays `MAX_DOCUMENT_SIZE` (route) / `MAX_EMAIL_DOCUMENT_BYTES` (Worker); the two remain equal and stay pinned by `src/lib/__tests__/email-ingest-allowlist-parity.test.ts`.
- Losses stay disjoint and additive: the Worker reports what it never forwarded; the route adds what it dropped from what *was* forwarded. `skippedAttachmentCount` never drops below the locally-derivable floor.
- Every attachment name still reaches `attachmentNames` / job metadata, whether or not its bytes were forwarded or staged.
- Oversized parts are excluded *before* `MAX_EMAIL_ATTACHMENTS` / `MAX_EMAIL_DOCUMENTS` slicing, so an oversized file never consumes a cap slot.
- The Worker cannot import from `src/lib`; any shared constant stays a pinned duplicate.

**Block If:** none — the human decision (2026-08-20, option 1: skip and account the oversized file) settles the only open question.

**Never:**
- Do not change `MAX_DOCUMENT_SIZE`, `MAX_EMAIL_DOCUMENTS`, `MAX_EMAIL_ATTACHMENTS`, `MAX_RAW_EMAIL_BYTES`, or the raw-message gate.
- Do not truncate, chunk, or re-encode an oversized attachment to make it fit.
- Do not touch `/api/ingest/document` or `bulk-document-import`, which keep their own oversize refusals.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Route: oversized among good | multipart: body + `big.pdf` (> `MAX_DOCUMENT_SIZE`) + `report.pdf` (small) | 200 `accepted:true`; only `report.pdf` staged/forwarded; `supportedAttachmentCount:1`; `skippedAttachmentCount` includes the drop; response names `big.pdf` | No error expected |
| Route: oversized only, with body | multipart: body + `big.pdf` only | 200 `accepted:true`; zero attachments staged; `supportedAttachmentCount:0`; `skippedAttachmentCount:1`; `big.pdf` named | No error expected |
| Route: oversized only, no body | multipart: no content, `big.pdf` only | 400 naming `big.pdf` and the MB ceiling — nothing is left to ingest | 400, nothing staged, no job created |
| Route: oversized + Worker count | multipart with `skippedAttachmentCount:"3"` plus one oversized part | Worker total and the route's own drop are summed | No error expected |
| Route: body + all unsupported | multipart: body + `program.exe` + `clip.mov` | 200 `accepted:true`; `supportedAttachmentCount:0`; `skippedAttachmentCount:2`; both names in job metadata; task carries no `attachments` | No error expected |
| Worker: oversized part | parsed attachment over `MAX_EMAIL_DOCUMENT_BYTES` | Not forwarded; counted into `skippedAttachmentCount`; reply names the file and quotes the MB ceiling | No error expected |
| Worker: oversized does not eat a cap slot | 10 small supported + 1 oversized supported | All 10 small ones forwarded; no over-cap line; oversized line fires | No error expected |
| Worker: body + all unsupported | body + only unsupported parts | Zero-attachment form forwarded; no "queued for ingestion" line; unsupported line fires; `skippedAttachmentCount` = unsupported count | No error expected |

</intent-contract>

## Code Map

- `src/app/api/email/ingest/route.ts` -- the 400 to replace is at `:164-170` (`const oversized = attachments.find(...)`). `attachments` is built at `:129-131` by `isSupportedDocument`; `attachmentNames` at `:132-135` is the union of recorded names and forwarded file names. The loss accounting lives at `:229-237` (`localSkipped`, `skippedAttachmentCount`) and is deliberately hoisted above the duplicate check at `:240-256` so both exits report the same pair. Both response bodies (`:250-255` duplicate, `:328-333` success) must carry the new field.
- `workers/email-ingest/index.ts` -- `MAX_EMAIL_DOCUMENT_BYTES` at `:46` (already a pinned duplicate of `MAX_DOCUMENT_SIZE`, currently unused for filtering). Selection at `:297-303`: `eligibleAttachments` → `supportedAttachments = eligible.slice(0, MAX_EMAIL_ATTACHMENTS)`, `unsupportedCount`, `overCapCount`, `skippedAttachmentCount`. The byte-copy/`Blob` build is inline in the forwarding loop at `:337-357`. Acknowledgement lines at `:389-407`; `attachmentNames` (20-capped) at `:319-321`.
- `src/lib/constants.ts:22` -- `MAX_DOCUMENT_SIZE = 10 * 1024 * 1024`.
- `src/lib/document-extract.ts:780` -- `extractDocumentTextAsync` throws `ClientInputError` above `MAX_DOCUMENT_SIZE`; the route's pre-filter is what keeps that unreachable from this path.
- `src/lib/__tests__/email-ingest-route.test.ts` -- `multipartRequest` helper at `:71-105` (`files`, `unforwardedNames`, `skippedAttachmentCount`); accounting suite at `:436-570`; cap suite at `:590-660`.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- `multipartEmail`/`partBytes` builders at `:329-370`, `forwardedForm` at `:396-411`, acknowledgement-count suite at `:480-553`, forwarded-count suite at `:557-583`. Note `:727`/`:744` assert `not.toContain("larger than")` on fixtures whose attachment is 256 bytes — they stay green.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts:143` -- pins `MAX_EMAIL_DOCUMENT_BYTES === MAX_DOCUMENT_SIZE`. Read-only for this change.

## Tasks & Acceptance

**Execution:**
- `src/app/api/email/ingest/route.ts` -- split the supported set into within-size and oversized instead of 400ing; delete the `:164-170` block; expose the dropped names on both response bodies (duplicate and success) as `oversizedAttachmentNames`, omitted when empty; when nothing is left to ingest, make the existing "no text body or supported document" 400 name the oversized files and the MB ceiling -- the body and the surviving attachments must not be lost to one bad file.
- `workers/email-ingest/index.ts` -- decode each eligible attachment's bytes once, drop those over `MAX_EMAIL_DOCUMENT_BYTES` before the `MAX_EMAIL_ATTACHMENTS` slice, add the count to `skippedAttachmentCount`, and add an acknowledgement line naming the dropped files and the ceiling -- so an oversized part is never forwarded and the sender learns which file was left behind.
- `src/lib/__tests__/email-ingest-route.test.ts` -- add route-side matrix cases: oversized-among-good, oversized-only-with-body, oversized-only-no-body, oversized summed with a forwarded count, and body-plus-all-unsupported.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- add Worker-side matrix cases: oversized part not forwarded and named in the reply, oversized not consuming a cap slot, and body-plus-all-unsupported (zero-attachment form, no "queued" line).

**Acceptance Criteria:**
- Given an email carrying a body, one attachment over the size ceiling and one under it, when it is ingested end to end, then the body and the under-ceiling attachment are ingested and only the oversized one is reported as skipped.
- Given the Worker parses an attachment over `MAX_EMAIL_DOCUMENT_BYTES`, when it forwards the message, then that attachment's bytes are absent from the forwarded form and the `skippedAttachmentCount` it sends accounts for it.
- Given an oversized attachment is dropped on either side, when the sender reads the acknowledgement, then the dropped file is named there alongside the existing skipped-attachment sentence.
- Given `pnpm exec vitest run` over the email suites, when the change is complete, then every pre-existing assertion still passes unchanged.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 5, low 5)
- defer: 1: (high 0, medium 1, low 0)
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[medium]` `[patch]` Worker's no-body early return claimed "no supported document attachment" while naming a supported-but-oversized PDF two paragraphs later — lead sentence now keyed on `unsupportedCount`, and the branch gained a direct `worker.email` test asserting the reply and the absent forward.
  - `[medium]` `[patch]` Worker's `oversizedLine` interpolated attacker-controlled MIME filenames unscrubbed into an outbound reply — added `replyAttachmentName()` (collapse CR/LF/TAB, trim, cap 200, never empty), pinned with an RFC 2231 encoded-name fixture that really carries CRLF.
  - `[medium]` `[patch]` "an oversized file never consumes a `MAX_EMAIL_DOCUMENTS` slot" was unpinned on the route side (mutating the cap check to `supportedFiles.length` left the suite green) — added a cap-suite case posting the cap in within-size files plus one oversized.
  - `[medium]` `[patch]` `oversizedAttachmentNames` on the duplicate-job exit was unasserted (deleting the spread left the suite green) — the cross-path equality test's fixture gained an oversized file and now compares the field across both exits.
  - `[medium]` `[patch]` The three loss sentences were never observed in one reply, so "alongside the existing skipped-attachment sentence" was only asserted negatively — added a Worker case with 2 oversized (one nameless), 2 unsupported and 11 within-size supported parts, pinning all three sentences, both plurals, and the three-way sum.
  - `[low]` `[patch]` Route's oversize 400 could read "The attachment are larger than 10 MB" and omit the field while the condition fired — noun and verb now both derive from `oversizedAttachmentNames`, and every oversized file contributes a usable name.
  - `[low]` `[patch]` Route's oversize 400 replaced rather than joined the supported-formats sentence, so a body-less email with one 11 MB PDF and one `.exe` never heard about the `.exe` — the two sentences are now joined.
  - `[low]` `[patch]` Worker's byte decode moved out of the try/catch that replies on failure, so a throw would have escaped `email()` with the sender hearing nothing — decode re-guarded with the existing retry reply.
  - `[low]` `[patch]` Route comment claimed "the Worker can relay it verbatim" — the Worker reads only `error`/`jobId`/`slug`, and its own pre-filter means the field can never be populated on that path; reworded to name direct service-principal callers.
  - `[low]` `[patch]` Stray double blank line in `email-ingest-route.test.ts` removed.

## Design Notes

Route: partition once, at the same place the allowlist filter already runs.

```ts
const supported = payload.attachments.filter((f) => isSupportedDocument(f.name, f.type));
const oversizedAttachments = supported.filter((f) => f.size > MAX_DOCUMENT_SIZE);
const attachments = supported.filter((f) => f.size <= MAX_DOCUMENT_SIZE);
```

`skippedAttachmentCount` needs no new arithmetic: it already adds
`payload.attachments.length - attachments.length`, which now covers the oversized drop too.

Worker: `attachment.content` is `string | ArrayBuffer | ArrayBufferView`, so byte length is only
knowable after decoding. Decode once into a `{ attachment, bytes }` list, filter on
`bytes.byteLength`, then reuse those bytes in the forwarding loop. Keep the `attachment-<n>`
fallback numbered by position among the *forwarded* attachments — `email-ingest-worker.test.ts`
pins `attachment-5` for the sixth supported part.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest.test.ts` -- expected: all pass, including the new matrix cases.
- `pnpm exec tsc --noEmit` -- expected: no new type errors.
- `pnpm exec eslint src/app/api/email/ingest/route.ts workers/email-ingest/index.ts src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-worker.test.ts` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** An attachment over `MAX_DOCUMENT_SIZE` no longer refuses the whole email. `/api/email/ingest` partitions its supported files into within-size and oversized at the same place the allowlist filter runs, drops the oversized ones, folds them into `skippedAttachmentCount` (no new arithmetic — they were already inside `payload.attachments.length - attachments.length`), and names them back to the caller as `oversizedAttachmentNames` on all three exits. The body and every surviving attachment ingest normally. The inbound Worker gained the matching per-document byte pre-filter, applied before the `MAX_EMAIL_ATTACHMENTS` slice so an oversized part never consumes a cap slot, counted into its own `skippedAttachmentCount`, and named in the acknowledgement alongside the existing skipped-attachment sentences. The body-plus-all-unsupported case is now covered end to end on both sides.

**Files changed.**
- `src/app/api/email/ingest/route.ts` — oversize is a per-file skip, not a per-message 400; `oversizedAttachmentNames` on the success, duplicate and refusal bodies; the residual "nothing to ingest" 400 now names the oversized files and the ceiling and joins rather than replaces the supported-formats sentence.
- `workers/email-ingest/index.ts` — attachments decoded once (guarded, so a decode failure still replies); per-document byte filter ahead of the cap slice; `oversizedLine` in both reply exits; `replyAttachmentName()` scrubs filenames before they reach an outbound email; `MAX_EMAIL_DOCUMENT_MB` so both sides quote one figure.
- `src/lib/__tests__/email-ingest-route.test.ts` — 21 → 30 tests: the oversize matrix rows, the cap-slot invariant, the duplicate-exit field, the degenerate-name refusal, and body-plus-all-unsupported.
- `src/lib/__tests__/email-ingest-worker.test.ts` — 21 → 26 tests: oversize never forwarded and named, oversize does not eat a cap slot, all three losses in one reply, the body-less oversize refusal, and body-plus-all-unsupported.

**Review findings.** 10 patches applied (5 medium, 5 low — see the Review Triage Log), 1 deferred (medium: the raw-message gate bounds how often the per-file skip is reachable), 5 rejected (eager byte copy for parts about to be discarded — bounded by `MAX_RAW_EMAIL_BYTES`; oversized-name dedup/20-cap; two comment-precision nits; the `MAX_EMAIL_DOCUMENT_MB` rounding convention, latent only if the ceiling stops being a MiB multiple).

**Follow-up review recommended:** true. Patched findings this pass: 0 high, 5 medium, 5 low → score `3 × 5 + 1 × 5 = 20`, at or above the threshold of 5.

**Verification.**
- `npx vitest run` over the five email suites — 80 passed / 5 files.
- `npx vitest run` (full) — 6294 passed / 275 files.
- `npx tsc --noEmit` — exit 0.
- `npx eslint` on the changed source and test files — clean (`workers/` is in the repo's eslint ignore pattern, pre-existing).
- Matrix test audit: all eight I/O rows are covered by named tests that ran and passed. Each patched behaviour was additionally mutation-checked — reverting the sentence key, deleting the filename scrub, changing the cap check to `supportedFiles.length`, deleting the duplicate-path spread, removing the name fallback, and swapping the join back to a replace each fail their intended test.

**Residual risks.**
- The Worker decode guard has no test: forcing a throw inside `attachmentBytes` would need a mocked `postal-mime`, which would contaminate the rest of that file. Verified by inspection only.
- The plural oversize path is unreachable over real mail — two 10 MB parts cannot coexist under `MAX_RAW_EMAIL_BYTES` — so its test overrides `rawSize`, the pattern the existing raw-cap tests already use. This is the same ceiling interaction recorded in the deferred item.
- The oversized reply line names every dropped file with no list cap. `MAX_EMAIL_ATTACHMENTS` bounds realistic mail, but a pathological sender would get a long sentence.
