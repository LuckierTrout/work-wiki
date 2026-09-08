---
title: 'Email intake accounting: name de-duplication and byte-derived envelope headroom'
type: 'bugfix'
created: '2026-09-03'
baseline_revision: '85f2d40c830640a2d3f9fbd7813eff8da9ba8f5a'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized, multiple-goals]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Two counting errors in the email intake path. (DW-690) `src/app/api/email/ingest/route.ts` de-duplicates recorded attachment names with a `Set` over RAW strings and sanitizes afterwards, so two names that scrub to the same string both survive; the same union also folds in the names of files that DID arrive, so the `localSkipped` floor reports a skip that never happened — reachable by the most ordinary case, a supported part with no filename, which the Worker records as `unnamed attachment` and forwards as `attachment-1`. (DW-705) `MIME_ENVELOPE_HEADROOM_BYTES` charges `MAX_EMAIL_CONTENT_CHARS` as if each UTF-16 code unit were one byte, so it buys a maximal ASCII body only; 100,000 non-ASCII BMP characters are up to 3x larger decoded and are over the derivation.

**Approach:** Sanitize each name before de-duplicating, so the recorded list collapses names that are equal as recorded; and read the skip floor off the caller's recorded names alone, since a forwarded file's own filename is evidence the file arrived, never that one was skipped. Separately, introduce a byte figure for the body cap (3 UTF-8 bytes per UTF-16 code unit is the maximum) and derive both halves of the DW-455 trade from it — the envelope's body term and the per-attachment share the aggregate average surrenders — so the trade stays exact and `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` does not widen.

## Boundaries & Constraints

**Always:**
- `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` must stay at 65,496,679 — the byte-derived body term is paid for out of `AGGREGATE_DOCUMENT_AVERAGE_BYTES`, exactly as DW-455 paid for the char-derived one. The parity suite's non-widening pin must pass unchanged in form.
- Every narrated arithmetic figure in a comment that moves must be recomputed and rewritten; no stale number may remain.
- `localSkipped` stays a floor: `Math.max(0, ...)` over two independently-derived terms, never a single computed count.
- `sanitizeAttachmentNames` keeps its current semantics for its existing callers — de-duplication is a NEW, separately named helper, because `oversizedAttachmentNames` derives `unnamedOversized` from its length and collapsing two same-named oversized files there would invent a phantom unnamed file.

**Block If:**
- Keeping `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` unchanged turns out to be impossible without widening the raw cap or dropping a live parity pin.

**Never:**
- Do not change `MAX_EMAIL_CONTENT_CHARS` itself, the truncation it governs, `MIME_STRUCTURAL_HEADROOM_BYTES`, `MAX_RAW_EMAIL_BYTES`, `EMAIL_ROUTING_MAX_INBOUND_BYTES`, or either expansion factor.
- Do not change what `email.attachmentNames` is composed of (recorded names unioned with forwarded file names) — only how that union is de-duplicated.
- Do not touch the deferred-work ledger.
- Do not re-derive `PREVIOUS_BASE64_ONLY_CAP_BYTES`; it is a frozen historical literal.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unnamed supported part | Multipart POST: `attachmentName=unnamed attachment`, one supported file named `attachment-1` | `skippedAttachmentCount` is 0 | No error expected |
| Names differing only after scrubbing | `attachmentName=report.pdf`, one supported file named `report.pdf\r\n` | `email.attachmentNames` records `report.pdf` once; `skippedAttachmentCount` is 0 | No error expected |
| Genuinely unforwarded name | `attachmentName` for a file with no file part beside two forwarded supported files | `skippedAttachmentCount` is 1; all three names recorded | No error expected |
| Route-dropped file | Two forwarded files, one unsupported by extension and MIME | `skippedAttachmentCount` is 1 via the file-count floor even when the name list cannot show it | No error expected |
| JSON caller, names only | `{"attachmentNames":["a.pdf","b.pdf"]}`, no files | `skippedAttachmentCount` is 2 | No error expected |
| Byte-derived envelope | Worker constants evaluated | `AGGREGATE_DERIVED_RAW_EMAIL_BYTES === 65_496_679`; `MIME_ENVELOPE_HEADROOM_BYTES === 1_001_536`; `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES === 20_671_520` | No error expected |

</intent-contract>

## Code Map

- `src/lib/email-ingest.ts:147` -- `sanitizeAttachmentNames(values)`: `replace(/[\r\n\t]+/g," ").trim().slice(0,200)` per name, `filter(Boolean)`, `slice(0, MAX_EMAIL_ATTACHMENTS_RECORDED)` (20). No de-duplication today. Callers: route lines 142, 157 (parse time), 216 (`oversizedAttachmentNames`), 236 (the union). Add the new unique variant here beside it and factor the per-name scrub into one shared internal function so the two cannot drift.
- `src/app/api/email/ingest/route.ts:236` -- the defective expression: `sanitizeAttachmentNames(Array.from(new Set([...payload.attachmentNames, ...payload.attachments.map((file) => file.name)])))`. `payload.attachmentNames` is ALREADY sanitized at parse (lines 142/157); only the file names are raw. The cap must be applied AFTER the de-duplication, so the new helper must scrub → dedupe → cap in that order.
- `src/app/api/email/ingest/route.ts:372-376` -- `localSkipped = Math.max(0, attachmentNames.length - attachments.length, payload.attachments.length - attachments.length)`. Change only the FIRST term's minuend to `payload.attachmentNames.length`. The long comment above it (lines 353-371) explains both floors and must be extended with why forwarded file names are excluded.
- `src/app/api/email/ingest/route.ts:428` -- `email.attachmentNames` is the recorded list; its composition is unchanged.
- `workers/email-ingest/index.ts:72` -- `MAX_EMAIL_CONTENT_CHARS = 100_000`, declared high because it is a term of the size derivation. The new byte constant belongs immediately after it (module-scope const order matters).
- `workers/email-ingest/index.ts:120` -- `AGGREGATE_DOCUMENT_AVERAGE_BYTES = NOMINAL - Math.ceil(MAX_EMAIL_CONTENT_CHARS / MAX_EMAIL_ATTACHMENTS)`; becomes the byte figure. 2,087,152 → 2,067,152.
- `workers/email-ingest/index.ts:343` -- `MIME_ENVELOPE_HEADROOM_BYTES = MIME_STRUCTURAL_HEADROOM_BYTES + Math.ceil(MAX_EMAIL_CONTENT_CHARS * WORST_CASE_TRANSFER_ENCODING_FACTOR)`; becomes the byte figure. 377,536 → 1,001,536.
- `workers/email-ingest/index.ts:186` -- `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` (derived, 20,871,520 → 20,671,520; `Math.floor(.../1024/1024)` stays 19).
- `workers/email-ingest/index.ts:796` -- `replyAttachmentName` is the Worker's `unnamed attachment` fallback; read-only evidence for the DW-690 case, do not change.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts:267,308,348,352,360,426` -- every pin that measures the body must move from `WORKER_MAX_EMAIL_CONTENT_CHARS` to the new byte export. Lines 317-321 pin the bare-aggregate wrap edge at k=22 fits / k=21 over; the edge MOVES to k=18 fits / k=17 over.
- `src/lib/__tests__/email-ingest-wire.ts` -- `quotedPrintablePartWireSize(byteLength, escapesPerLine = 25)`; the shared helper those pins use. Read-only.
- `src/lib/__tests__/email-ingest-route.test.ts:475-515` -- the existing `attachmentName` handoff case (3 recorded names, 2 forwarded, 1 skipped) is the shape the new DW-690 cases sit beside; reuse its fixture style.
- `src/lib/__tests__/email-ingest-worker.test.ts:738` -- `AGGREGATE_BUDGET_MB` is derived from the constant, so it needs no edit.

## Tasks & Acceptance

**Execution:**
- `src/lib/email-ingest.ts` -- factor the per-name scrub into one internal function and add an exported `sanitizeAttachmentNamesUnique` that scrubs, de-duplicates the SCRUBBED values, then caps at `MAX_EMAIL_ATTACHMENTS_RECORDED` -- one source of truth for the scrub; a separate export because de-duplicating inside `sanitizeAttachmentNames` would corrupt the `unnamedOversized` arithmetic.
- `src/app/api/email/ingest/route.ts` -- build `attachmentNames` with the new helper, and change the recorded-name floor's minuend to `payload.attachmentNames.length`; extend the two-floors comment with why a forwarded file's own name can never evidence a skip -- fixes both the inflated record and the phantom skip.
- `workers/email-ingest/index.ts` -- add `MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT` (3) and `MAX_EMAIL_CONTENT_BYTES`, exported, and use the byte figure in BOTH `AGGREGATE_DOCUMENT_AVERAGE_BYTES` and `MIME_ENVELOPE_HEADROOM_BYTES` -- the trade must stay exact so the derived raw cap does not move.
- `workers/email-ingest/index.ts` -- rewrite every narrated figure that moves in the comments on `MAX_EMAIL_CONTENT_CHARS`, `AGGREGATE_DOCUMENT_AVERAGE_BYTES`, `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`, `QUOTED_PRINTABLE_EXPANSION_FACTOR`, `MIME_STRUCTURAL_HEADROOM_BYTES`, `MIME_ENVELOPE_HEADROOM_BYTES` and `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`, and replace the "known, bounded gap" paragraph with what now holds -- a stale number is the same defect DW-705 recorded.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- re-aim the body pins at the byte export, add a pin that the byte figure is the code-unit cap times the UTF-8 maximum, and move the bare-aggregate wrap-edge pins to the new edge -- the suite is what makes the trade observable rather than narrated.
- `src/lib/__tests__/email-ingest-route.test.ts` -- add cases for the unnamed-part and scrub-collision rows of the I/O matrix, asserting `skippedAttachmentCount` and the recorded `email.attachmentNames` -- these are the two shapes nothing in the repo currently observes.

**Acceptance Criteria:**
- Given a multipart POST recording `unnamed attachment` and forwarding one supported file named `attachment-1`, when the route responds, then `skippedAttachmentCount` is 0.
- Given a multipart POST whose recorded name and forwarded file name scrub to the same string, when the route responds, then that name appears exactly once in `email.attachmentNames` and `skippedAttachmentCount` is 0.
- Given the existing suites, when `pnpm vitest run` is executed, then every email-ingest case passes with no assertion re-aimed away from a claim it still makes.
- Given the Worker constants after the change, when `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` is evaluated, then it is 65,496,679 and the parity suite's non-widening pin passes.

## Design Notes

Why 3 bytes per code unit is the maximum: a BMP character is one UTF-16 code unit and at most 3 UTF-8 bytes; a supplementary character is two code units and 4 UTF-8 bytes, i.e. 2 bytes per code unit. So `MAX_EMAIL_CONTENT_CHARS * 3` bounds the decoded body for every input.

Why the trade stays exact. Both halves scale with the same body figure, and 300,000 still divides evenly by `MAX_EMAIL_ATTACHMENTS`:

```
ceil(20,671,520 * 3.12) + (65,536 + 936,000) === 64,495,143 + 1,001,536 === 65,496,679
ceil(20,971,520 * 3.12) +  65,536            === 65,431,143 +    65,536 === 65,496,679
```

Recomputed figures the comments must carry: average 2,067,152; aggregate 20,671,520 (~19.71 MiB, quoted 19 MB); envelope 1,001,536; ten worst-case parts 64,495,170 against the ratio's 64,495,143; aggregate + maximal body 65,431,170 at k=25 with 65,509 bytes of slack (both unchanged); 65,536,020 at k=24 and over; the bare aggregate now fits down to k=18 (64,598,520 / 64,710,870 / 64,833,420 / 64,967,640 / 65,115,300 / 65,278,500 / 65,459,820) and is over at k=17 (65,662,500); eleven average parts reach 70,944,687.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-worker.test.ts` -- expected: all pass
- `pnpm vitest run` -- expected: no new failures
- `pnpm lint` -- expected: clean
- `pnpm exec tsc --noEmit` -- expected: clean

## Spec Change Log

_No bad_spec loopback occurred._

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 1, low 6)
- defer: 0
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[medium]` `[patch]` `sanitizeAttachmentNamesUnique`'s cap-after-collapse ordering was narrated but unpinned — moving the `.slice` inside the `Set` left the whole suite green. Added a direct unit test in `src/lib/__tests__/email-ingest.test.ts` (15 distinct names each recorded twice, interleaved, plus whitespace-only entries) and mutation-verified that it fails with the cap applied first.
  - `[low]` `[patch]` Three comments in `src/lib/__tests__/email-ingest-worker.test.ts` still quoted the pre-change aggregate budget (`~19.9 MiB` / `~27.2 MiB`); rewritten to `~19.71 MiB` / `~27.0 MiB`, matching the README updated in the same change.
  - `[low]` `[patch]` Three comments in `workers/email-ingest/index.ts` quoted the route's first floor as `attachmentNames.length - attachments.length`, an expression the change deleted; rewritten to `payload.attachmentNames.length`, stating the invariant they defend as strengthened rather than weakened.
  - `[low]` `[patch]` The route suite's "recorded names collapse" fixture no longer created the condition it exists to create (both floors answered 4 once the minuend stopped reading the deduped union); re-aimed to one recorded name against four forwarded parts and both narrations rewritten.
  - `[low]` `[patch]` `MIME_ENVELOPE_HEADROOM_BYTES` forwarded to a cost record at `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` that was never written; added the DW-705 narrowing (a further 200,000 decoded bytes, band `(20,671,520, 20,871,520]`) and named the parity assertion that pins it.
  - `[low]` `[patch]` "There is no residual body shape left outside the derivation" over-claimed: `MAX_EMAIL_CONTENT_CHARS` is a truncation point, not a refusal, so an over-long body passes every body limit and is still over the derivation. Qualified to what the term budgets for, with the excess attributed to `MAX_RAW_EMAIL_BYTES`.
  - `[low]` `[patch]` The first floor's load-bearing premise (the Worker posts exactly one recorded name per countable part, and never names a part it did not forward) was unstated; recorded at the floor along with the accepted cost for a caller that does not honour it.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Two counting corrections in the email intake path.

**DW-690.** `src/app/api/email/ingest/route.ts` built its recorded attachment-name list by de-duplicating RAW strings with a `Set` and scrubbing afterwards, so two names that scrub to the same recorded string both survived. The union it de-duplicates also folds in the names of files that ARRIVED, and its length was the minuend of the `localSkipped` floor — so a forwarded file's own filename inflated the floor and the route reported a skip that never happened. The ordinary case reached it: the Worker records an unnamed part as `unnamed attachment` and forwards it as `attachment-1`, one file under two names. Now the union is de-duplicated on the scrubbed form (cap applied after the collapse), and the floor reads the caller's recorded names alone.

**DW-705.** `MIME_ENVELOPE_HEADROOM_BYTES` charged `MAX_EMAIL_CONTENT_CHARS` as if each UTF-16 code unit were one byte, buying a maximal ASCII body only; 100,000 non-ASCII BMP characters are up to 300,000 decoded bytes and 936,000 on the worst-case wire, which was over the derivation. A new `MAX_EMAIL_CONTENT_BYTES` (the cap at `MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT = 3`) is now spent on BOTH halves of the DW-455 trade, so the trade stays exact: `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` is unchanged at 65,496,679 and the raw cap did not widen. The payment lands on `AGGREGATE_DOCUMENT_AVERAGE_BYTES` (2,087,152 → 2,067,152) and therefore on the enforced aggregate attachment budget (20,871,520 → 20,671,520; still quoted to senders as 19 MB).

### Files changed

- `src/lib/email-ingest.ts` — factored the per-name scrub into `scrubAttachmentName`; added exported `sanitizeAttachmentNamesUnique` (scrub → de-duplicate → cap).
- `src/app/api/email/ingest/route.ts` — recorded list built with the new helper; `localSkipped`'s first floor now reads `payload.attachmentNames.length`; the premise and the accepted cost recorded at the floor.
- `workers/email-ingest/index.ts` — added `MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT` and `MAX_EMAIL_CONTENT_BYTES`; both halves of the DW-455 trade derived from bytes; every moved figure recomputed, the DW-705 cost recorded, and three stale quotations of the route's floor rewritten.
- `workers/email-ingest/README.md` — aggregate budget figures refreshed.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` — body pins re-aimed at the byte export; wrap-edge pins moved (k=22/21 → k=18/17); new case pinning the byte figure against real `TextEncoder` output.
- `src/lib/__tests__/email-ingest-route.test.ts` — `recordedNames` fixture option; three new cases (unnamed part, scrub collision, route-dropped file with no recorded name); the "recorded names collapse" case re-aimed and both its narrations rewritten; the JSON branch extended to two names.
- `src/lib/__tests__/email-ingest.test.ts` — first direct unit tests of `sanitizeAttachmentNamesUnique`, pinning cap-after-collapse.
- `src/lib/__tests__/email-ingest-worker.test.ts` — stale aggregate-budget figures refreshed.

### Review findings breakdown

Patches applied: 7 (1 medium, 6 low). Items deferred: 0. Items rejected: 3 — two recorded-list collapses that are the intended behaviour of de-duplicating "as recorded" (two files whose names scrub alike; two names differing only past character 200), and one reproduction of the intent's literal wording that requires a caller violating the Worker's one-name-per-countable-part protocol, under which the reported count is correct.

Follow-up review recommendation: `false` — patched severities were 0 high, 1 medium, 6 low.

### Verification performed

- `pnpm vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-worker.test.ts` — all pass.
- `pnpm vitest run` — 374 files, 9353 passed, 1 skipped, 0 failed.
- `pnpm exec tsc --noEmit` — clean. `pnpm lint` — clean (only the pre-existing `jsx-ast-utils` plugin notices).
- Mutation checks: reverting either route change fails both new DW-690 cases; applying the cap before the collapse fails the new unique-helper test; removing the second floor fails the re-aimed collapse case.
- Constants evaluated directly: `MAX_EMAIL_CONTENT_BYTES` 300,000; `AGGREGATE_DOCUMENT_AVERAGE_BYTES` 2,067,152; `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` 20,671,520; `MIME_ENVELOPE_HEADROOM_BYTES` 1,001,536; `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` 65,496,679 (unchanged).

Matrix coverage: rows 1-5 are each covered by a named route case that ran and passed. Row 6's three constant values are pinned by composition rather than as literals — the parity suite asserts the envelope's body term, the average's surrendered share, the aggregate as ten averages, and the derived cap as `ceil(aggregate × f) + envelope`, which together determine those exact figures from the module's inputs. A hand-typed literal was deliberately not added: the suite documents at length why the derived cap is never restated as a snapshot, and a literal would fail on any legitimate future retune while verifying nothing the formula pins does not.

### Residual risks

- Real behavioural cost of DW-705, accepted and now narrated at the constant: a supported-attachment total in `(20,671,520, 20,871,520]` loses its last part to the over-budget line where it previously fitted. Reachable only from clients sending parts unencoded under the 25 MiB inbound clamp.
- Accepted cost of the DW-690 floor change, narrated at the floor: a hand-rolled direct caller that records names ONLY for files it did not forward floors at 0 where the union answered 1. Not fixable by name matching — that re-creates the phantom skip — and such a caller's own `skippedAttachmentCount` is the honest channel. The Worker never produces this shape.
- The scrub-collision route fixture relies on Node/undici preserving `\r\n` in a multipart filename round-trip; verified empirically. A runtime that percent-escaped filenames would make that fixture pass vacuously.
