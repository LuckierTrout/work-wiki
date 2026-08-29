---
title: 'Inline MIME parts leave eligibility, so they spend no attachment slot and no aggregate budget'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A supported document a sending client labels `Content-Disposition: inline` is now
      dropped with no acknowledgement line at all, and some mainstream clients label
      genuinely-attached files inline.
    evidence: |-
      DW-446's recorded 2026-08-28 decision is "never forwarded", and this change implements
      it: an inline part leaves eligibility, so it is not forwarded, not named in
      `attachmentName`, and contributes to none of the four loss terms. A message whose only
      part is an inline `.md` is therefore answered with "work-wiki found no email text to
      ingest." — a document arrived and no sentence in the reply mentions it. Apple Mail and
      Outlook are reported to mark PDFs and images rendered in the message body as inline,
      so the false-positive population is not empty. Two readings were raised by review and
      both were rejected by the recorded decision rather than by evidence: forward-but-count
      (make the accounting honest instead of eligibility narrower), and drop-but-report (one
      "not queued" line naming inline documents). Revisiting means re-opening a decision a
      human already made, which is why it is deferred rather than patched.
    location: >-
      workers/email-ingest/index.ts (eligibleAttachments, and the acknowledgement's loss lines)
    severity: medium
  - summary: >-
      DW-450's recorded decision to widen `inlineAttachment` to trust `contentId` becomes a
      data-loss change once it lands on top of DW-446, not the cosmetic reply-line fix it was
      filed as.
    evidence: |-
      `inlineAttachment` reads `disposition` and nothing else, and DW-450 carries a
      2026-08-28 decision to treat a part with a `Content-ID` and no `Content-Disposition`
      as inline. Under DW-359 that predicate governed only which parts were COUNTED, so
      widening it could at worst suppress a reply sentence. After DW-446 the same predicate
      governs whether a part is forwarded at all, so widening it silently discards every
      supported document a client tags with a Content-ID. Neither entry records the
      interaction, and whichever lands second inherits a blast radius its own reason never
      described.
    location: >-
      workers/email-ingest/index.ts (inlineAttachment)
    severity: medium
  - summary: >-
      No real-MIME fixture omits `Content-Disposition` entirely, so the `null`-disposition
      branch — whose stakes this change raised — has only mocked coverage.
    evidence: |-
      `inlineAttachment`'s doc treats a `null` disposition as a deliberate decision: an
      unlabelled part is likelier to be a real attachment than a decoration, and "guessing
      wrong there would silently drop a file the sender really did send". After DW-446 that
      sentence is literal rather than figurative. `multipartEmail` in
      `src/lib/__tests__/email-ingest-worker.test.ts` always emits a `Content-Disposition`
      header — the `disposition` option replaces the derived line, it cannot remove it — so
      the real-parser suite cannot express a headerless part, and the only coverage is
      incidental, from mocked fixtures that leave the field undefined.
    location: >-
      src/lib/__tests__/email-ingest-worker.test.ts (multipartEmail)
    severity: low
baseline_revision: '3681f6cd64b3992aa15794f7e7a1e4c6914d4907'
---

<intent-contract>

## Intent

**Problem:** `eligibleAttachments` (`workers/email-ingest/index.ts:594-596`) filters only on `supportedAttachment`, so an inline part of a supported format enters the selection loop at `:642-658` and spends a `MAX_EMAIL_ATTACHMENTS` slot and `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` bytes — while DW-359's `countable()` filter at `:659-670` excludes it from every reported loss. A sender who embeds three inline `.md` previews beside nine real PDFs is therefore told "2 supported attachments were not queued because this email exceeds the 10-attachment limit" when they attached nine files, and an inline part that is forwarded but dropped for the budget is reported nowhere (DW-446).

**Approach:** Apply the recorded 2026-08-28 decision — exclude inline parts entirely. Filter inline parts out BEFORE eligibility so they never reach the selection loop, never consume a slot or budget bytes, and are never forwarded; every list downstream of `eligibleAttachments` is then inline-free by construction, so the `countable()` re-filtering collapses to plain `.length`. Pin that a message of inline parts plus real files reports counts matching what the sender actually attached.

## Boundaries & Constraints

**Always:**
- Inline stays defined by `inlineAttachment` alone — `disposition === "inline"`, nothing else. Widening to `contentId` is DW's separate open entry.
- DW-359's guarantees survive: no inline part in `attachmentNames`, in `skippedAttachmentCount`, or in any acknowledgement sentence; an inline-only message still gets "work-wiki found no email text to ingest." rather than the supported-formats list.
- The four loss terms stay disjoint and still sum to `skippedAttachmentCount`.
- Every comment that states the superseded rule ("changes ACCOUNTING, not eligibility") is rewritten to the new one; no comment may survive describing behaviour the code no longer has.
- Dead inline filtering is removed, not left in place as decoration — if a list is inline-free by construction, re-filtering it must go along with the comment that justified it.

**Block If:** Staying coherent would require changing `inlineAttachment`'s predicate itself, or touching `src/app/api/email/ingest/route.ts`.

**Never:**
- Never edit `_bmad-output/implementation-artifacts/deferred-work.md`.
- Never touch `src/app/api/email/ingest/route.ts`, the raw-size cap derivation, the per-document ceiling partition (DW-253), or the aggregate budget's own arithmetic — this entry moves which parts are eligible, nothing else.
- Never weaken the existing over-cap, over-budget, oversized or unsupported coverage; the combined-loss case must keep driving all four terms together.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Inline parts beside a full envelope | 3 inline `.md` parts + 9 real PDFs, body present | All 9 PDFs forwarded; `skippedAttachmentCount` `0`; NO "attachment limit" sentence; `attachmentName` is the 9 PDFs only | No error expected |
| Inline part spends no budget | inline `.pdf` at `MAX_EMAIL_DOCUMENT_BYTES` + two real PDFs summing over the remaining budget | Both real PDFs forwarded; no "total attachment budget" sentence; inline bytes never copied into `FormData` | No error expected |
| Inline part that is itself a supported document | one `disposition: "inline"` `.md`, empty body | NOT forwarded, NOT named, NOT counted as a loss; reply is "work-wiki found no email text to ingest." | No error expected |
| Inline logo beside a real attachment (DW-359, unchanged) | inline PNG + supported PDF + body | PDF queued; no "recorded but skipped" line; PNG absent from `attachmentName` | No error expected |
| Every loss at once (unchanged counts) | the existing combined fixture, inline logo + inline `.md` past the cap included | Same 1 unsupported + 2 over-budget + 3 over-cap totals as today | No error expected |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts` — the whole production change.
  - `inlineAttachment` :340-368 — predicate unchanged; its doc comment's closing paragraph ("This changes ACCOUNTING, not eligibility... still forwarded and still counted as queued") is now false and must be rewritten.
  - `replyLossNames` :432-459 — filters inline parts out of the names at :452. Its inputs (`overBudgetAttachments`, `oversizedAttachments`) become inline-free by construction, so the filter and the paragraph justifying it are dead; narrow the parameter type to `{ filename }` when removing it.
  - Accounting comment :579-593 — states inline parts remain "fully eligible to be forwarded (DW-359)". Rewrite to the exclusion.
  - `countableAttachments` :589-591 — keep; it is the denominator `unsupportedCount` measures against.
  - `countable()` helper :592-593 — becomes an identity on every list it is applied to once eligibility is inline-free; remove it and use `.length`.
  - `eligibleAttachments` :594-596 — the fix: filter `countableAttachments`, not `parsed.attachments`.
  - `sizedAttachments` / oversized partition :601-624, selection loop :642-658 — unchanged code, but now only ever see non-inline parts.
  - Loss counts :659-672 — `unsupportedCount` = `countableAttachments.length - eligibleAttachments.length`; `oversizedCount` / `overBudgetCount` / `overCapCount` all read `.length`.
  - No-content early return :704-737 — keyed on `unsupportedCount`; its DW-359 paragraph stays true (an inline-only message has no countable attachment) and needs no change.
  - `attachmentNames` :743-749 — already built from `countableAttachments`; unchanged.
- `src/lib/__tests__/email-ingest-worker.test.ts` — `describe("email-ingest inline parts")` :1006-1108. `INLINE_LOGO` :1020-1024 is reusable. The third case, "still forwards an inline part that is itself a supported document" :1081-1107, pins the behaviour this entry reverses and must be inverted, not deleted. Fixture builders: `multipartEmail(parts, {subject, messageId, body})` with per-part `{filename, mime, bytes?, disposition?}`, `partBytes`, `message()`, `env()`, `forwardedForm()`.
  - Combined-loss case :1399-1513 — behaviour and counts are unchanged, but the `notes.md` fixture comment (:1469-1471) and the describe-block rationale (:1385-1390) cite `countable(eligible)`, which this change deletes; restate them against the eligibility filter.
- `workers/email-ingest/README.md`, `src/app/api/email/ingest/route.ts` — read-only. Grepped: neither mentions inline parts, and the route's `localSkipped` floor reads `attachmentName` fields that already excluded them, so nothing downstream moves.

## Tasks & Acceptance

**Execution:**
- `workers/email-ingest/index.ts` — derive `eligibleAttachments` from `countableAttachments` so inline parts never reach sizing, the selection loop or `FormData`; drop the `countable()` helper and read `.length` on the now-inline-free lists; state in the comment that this is eligibility, not just accounting (DW-446).
- `workers/email-ingest/index.ts` — rewrite `inlineAttachment`'s closing doc paragraph and drop `replyLossNames`' inline filter with its justifying paragraph, narrowing the parameter type — a comment that describes the superseded rule is worse than no comment.
- `src/lib/__tests__/email-ingest-worker.test.ts` — invert the inline-supported-document case to assert it is neither forwarded, named, counted, nor reported, and that the reply is the plain no-text sentence.
- `src/lib/__tests__/email-ingest-worker.test.ts` — add the two cases this entry exists for: inline parts spend no attachment slot (3 inline `.md` + 9 PDFs → 9 queued, 0 skipped, no limit sentence) and spend no aggregate budget (inline part at the per-document ceiling + two real PDFs that would overflow with it → both queued, no budget sentence).
- `src/lib/__tests__/email-ingest-worker.test.ts` — restate the combined-loss comments that name `countable(eligible)`; assert the same totals so the case still proves the four terms disjoint.

**Acceptance Criteria:**
- Given the inline filter were removed from `eligibleAttachments`, when the suite runs, then a worker test fails because the sender was told a limit they never reached.
- Given any acknowledgement sentence or forwarded field, when a message mixes inline parts with real attachments, then every count and name it carries is computed only from parts the sender actually attached.
- Given `git status`, when the change is complete, then `src/app/api/email/ingest/route.ts` and `_bmad-output/implementation-artifacts/deferred-work.md` are unmodified.

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 1, low 7)
- defer: 3: (high 0, medium 2, low 1)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The reachable middle shape was unasserted in either direction — a body that ingests fine plus a lone inline supported `.md` — so both "the body was dropped with the part" and "the part was forwarded anyway" would have shipped green; added a case pinning the body forwarded, no attachment, and none of the five attachment sentences.
  - `[low]` `[patch]` `src/lib/__tests__/email-ingest-worker-normalization.test.ts` still described the deleted `countable()` helper and `replyLossNames`' deleted inline filter as the machinery under test, and its inline `banner.pdf` no longer reaches the ceiling partition at all — restated the premise against the eligibility filter. The Code Map had omitted this file even though Verification ran it.
  - `[low]` `[patch]` The test file's own table of contents (item 7) still summarised DW-359 only, so the file's index described half the behaviour of the block 1,200 lines below it.
  - `[low]` `[patch]` `workers/email-ingest/README.md` documents the forwarding contract and "the four losses" and never mentioned inline disposition; a supported document neither forwarded nor named nor counted is a fifth outcome, now stated.
  - `[low]` `[patch]` Both new fixtures depend on part ORDER and nothing said so: the selection loop consumes parts in order, so with the inline parts listed last the pre-fix code would have passed both cases. Stated that inline-parts-first is load-bearing.
  - `[low]` `[patch]` The new budget fixture carried no raw-gate guard, breaking the convention the sibling budget describe established — a constant change could have moved it under `MAX_RAW_EMAIL_BYTES` and turned it into a DW-358 door test with no diagnostic; added the assertion, plus the arithmetic behind the minimal overshoot and why this case earns a real MIME fixture against the recorded cost convention.
  - `[low]` `[patch]` The slot test's asserted plural rested on `MAX_EMAIL_ATTACHMENTS` incidentally exceeding 2; pinned it in the premise block, and added inline PNG logos so the ledger's own literal shape — inline logos plus real files — is pinned positively rather than only by the older DW-359 case.
  - `[low]` `[patch]` Deleting `replyLossNames`' inline filter left "every list reaching it is inline-free" as an argued invariant with nothing observing it; the combined-loss fixture already carries both inline parts, so the reply is now asserted to name neither.

## Design Notes

The ledger's worked example ("three inline logos and nine real PDFs") cannot reproduce the defect literally: `image/png` is not in `SUPPORTED_MIME_TYPES`, so a logo was never eligible and never spent a slot. The reachable shape is an inline part of a SUPPORTED format — an embedded `.md` preview or an inline `.pdf` — which is exactly the case the superseded test pinned as "still forwarded". Write the fixtures with supported inline parts; the logo cases stay as they are.

The whole fix is one line of ordering, and the value is in what it lets go:

```ts
const eligibleAttachments = countableAttachments.filter((attachment) =>
  supportedAttachment(attachment.filename, attachment.mimeType),
);
// ...so oversized/overBudget/supported are inline-free by construction:
const unsupportedCount = countableAttachments.length - eligibleAttachments.length;
```

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-route.test.ts` -- expected: all pass, including the inverted and new inline cases. (`pnpm vitest` fails here with "packages field missing or empty"; use `npx`.)
- `npx vitest run` -- expected: no new failures anywhere in the suite.
- `npx tsc --noEmit` -- expected: exit 0.
- `npx eslint` -- expected: exit 0 (pre-existing `jsx-ast-utils` notices only).
- `git status --porcelain src/app/api/email/ingest/route.ts _bmad-output/implementation-artifacts/deferred-work.md` -- expected: empty.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Inline MIME parts now leave ELIGIBILITY, not just the accounting. `eligibleAttachments` is derived from `countableAttachments` instead of `parsed.attachments`, so a `disposition: "inline"` part never reaches the sizing pass, the per-document ceiling partition, the selection loop or the outbound `FormData` — it can no longer spend a `MAX_EMAIL_ATTACHMENTS` slot or a byte of `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` that a real attachment then loses. This closes DW-446 under its recorded 2026-08-28 decision ("exclude inline parts entirely"): a sender who embeds inline previews beside real files is no longer told they exceeded a ten-attachment limit they never reached. Because every list downstream of `eligibleAttachments` is now inline-free by construction, DW-359's `countable()` re-filtering collapsed to plain `.length` on all four loss terms and `replyLossNames` lost both its inline filter and the `disposition` field from its parameter type. DW-359's guarantees are unchanged: no inline part in `attachmentName`, in `skippedAttachmentCount`, or in any acknowledgement sentence.

The ledger's worked example ("three inline logos and nine real PDFs") is not literally reachable — `image/png` is not in the allowlist, so a logo was never eligible and never spent a slot. The reachable shape, and the one the new tests drive, is an inline part of a SUPPORTED format: the `.md` preview the superseded test pinned as "still forwarded". The logo shape is pinned alongside it so the ledger's own sentence is observed too.

**Files changed.**
- [`workers/email-ingest/index.ts`](../../workers/email-ingest/index.ts) — eligibility derived from the countable list; `countable()` removed; `replyLossNames` narrowed; the two comments stating the superseded "accounting, not eligibility" rule rewritten.
- [`src/lib/__tests__/email-ingest-worker.test.ts`](../../src/lib/__tests__/email-ingest-worker.test.ts) — the inline-supported-document case inverted; three new cases (no slot spent, no budget bytes spent, body-plus-lone-inline-document); the combined-loss case's comments restated and its inline-free invariant asserted.
- [`src/lib/__tests__/email-ingest-worker-normalization.test.ts`](../../src/lib/__tests__/email-ingest-worker-normalization.test.ts) — the oversized-inline premise restated: an inline part is dropped at eligibility, one step before the ceiling partition.
- [`workers/email-ingest/README.md`](../../workers/email-ingest/README.md) — inline parts named as a fifth outcome beside the four reported losses.

**Review findings breakdown.** 8 patches applied (1 medium, 7 low), 3 items deferred (2 medium, 1 low), 11 rejected (all low). No intent gaps and no spec repairs; the review loop ran once with no loopback. The rejected findings were mostly proposals that contradict the recorded decision (an acknowledgement line naming inline parts), refactors of untouched code (helper extraction, renaming `countableAttachments`), or notes about orchestrator-owned bookkeeping.

**Follow-up review recommendation:** patched this pass high 0, medium 1, low 7 → `3×1 + 7 = 10` ≥ 5 → **true**.

**Verification.**
- `npx vitest run` over the four email-ingest suites — **117 passed** (was 116 before this story; +1 from the new body-plus-inline case).
- Mutation check of the first acceptance criterion: reverting `eligibleAttachments` to `parsed.attachments` fails **7** tests, including the combined-loss case with the exact diff `- 3 supported attachments were not queued because this email exceeds the 10-attachment limit / + 4 …`. Production file restored and diff-verified afterwards.
- `npx tsc --noEmit` → exit 0. `npx eslint` → exit 0 (pre-existing `jsx-ast-utils` notices only).
- `npx vitest run` (whole suite) → 13 files failing, all `src/components/workbench/__tests__/*` with `TypeError: Cannot read properties of undefined (reading 'clear')` on `window.localStorage`. Confirmed pre-existing: stashing this story's changes and re-running `workbench-split-wiring.test.tsx` at `3681f6cd` fails the same 29 tests.
- `git status --porcelain src/app/api/email/ingest/route.ts _bmad-output/implementation-artifacts/deferred-work.md` → empty.

**Residual risks.** The three deferred entries, of which two are decisions rather than defects: a supported document a client labels inline is now discarded with no sentence explaining it (the recorded decision's intended behaviour, but the false-positive population is not empty), and DW-450's recorded widening of `inlineAttachment` to trust `contentId` becomes a data-loss change once it lands on top of this one. The new budget fixture adds ~215 ms and ~29 MB of transient base64 to the worker suite; the case argues in-comment why a real MIME fixture is load-bearing there rather than the cheaper mocked parser.
