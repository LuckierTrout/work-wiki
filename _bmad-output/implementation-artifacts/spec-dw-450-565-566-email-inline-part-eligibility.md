---
title: 'Split the inline predicate: Content-ID governs counting, disposition governs forwarding, and an inline document is reported'
type: 'bugfix'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
baseline_revision: 'ffc99a2f2b50f1d2d09be5fbecd854bfb1561f46'
---

<intent-contract>

## Intent

**Problem:** One predicate, `inlineAttachment` (`workers/email-ingest/index.ts:370`), governs both what is COUNTED (`:591`) and — since DW-446 — what is FORWARDED (`:606`). DW-450's recorded decision widens it to trust `Content-ID`, which under that fusion would silently discard every supported document a client tags with a Content-ID (DW-566). Separately, a supported document a client labels `Content-Disposition: inline` now leaves eligibility and contributes to none of the four loss terms, so a message whose only part is an inline `.md` is answered "work-wiki found no email text to ingest." — a document arrived and no sentence mentions it (DW-565).

**Approach:** Apply both recorded 2026-08-29 decisions. Split the predicate in two: a FORWARDING predicate reading `disposition === "inline"` and nothing else, and a COUNTING predicate that additionally treats a part whose `Content-Disposition` is absent but whose `Content-ID` the HTML body references as a decoration. Then add a fifth, disjoint loss term for supported documents dropped because they were labelled inline, named in both the no-content exit and the acknowledgement.

## Boundaries & Constraints

**Always:**
- Two predicates, two names, and a comment at EACH call site recording that the other one exists and why they differ. No call site may read a predicate whose name does not say which of the two jobs it does.
- The forwarding predicate reads `disposition` alone. A `Content-ID` never removes a part from eligibility, so no document is dropped on a Content-ID alone (DW-566).
- The counting predicate widens ONLY where `disposition` is absent (`null`): `disposition === "inline"`, or (`disposition === null` AND a `contentId` the HTML body references via `cid:`). An explicit `disposition: "attachment"` and a bare `null` with no referenced `contentId` both stay real attachments (DW-450).
- DW-359 survives: a signature logo — whether labelled inline or carrying only a referenced Content-ID — appears in no count, no `attachmentName`, and no acknowledgement sentence, and an unsupported-decoration-only message still gets the plain no-text sentence rather than the supported-formats list.
- `attachmentNames` stays free of parts that were not forwarded because they were labelled inline: the route derives a `localSkipped` FLOOR from `attachmentNames.length - attachments.length`, and the true total already travels in `skippedAttachmentCount`. Their names reach the SENDER, in the new reply line, not the recorded name list.
- The five loss terms are pairwise disjoint and sum exactly to `skippedAttachmentCount`.
- Every comment stating the superseded single-predicate rule is rewritten. In particular `replyLossNames`' "every list that reaches here is inline-free by construction" is now false and must go.
- New Worker behaviour is pinned through REAL PostalMime fixtures, not the mocked parser: whether a `Content-ID` header with no `Content-Disposition` arrives as `contentId` set and `disposition === null` is a fact about the parser, and a stub would assume the half that can fail.

**Block If:**
- PostalMime 2.7.5 does not surface `contentId` for a part carrying `Content-ID` with no `Content-Disposition`, or cannot be made to populate `parsed.html` from a fixture — the recorded decision is unimplementable as written.

**Never:**
- Do not revisit DW-446: an inline-by-disposition part is still never forwarded.
- Do not reshape the existing four loss terms to absorb the new one.
- Do not use postal-mime's `related` flag as the widening signal; the recorded decision names `contentId` plus a body reference.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Content-ID-only logo | `logo.png`, no `Content-Disposition`, `Content-ID: <logo@x>` referenced by the HTML body, beside `report.pdf` | Only `report.pdf` forwarded and named; `skippedAttachmentCount` `0`; no "recorded but skipped" sentence | No error expected |
| Content-ID-only document | `notes.md`, no `Content-Disposition`, referenced `Content-ID`, plus a body | Forwarded, named in `attachmentName`, "1 supported attachment was queued for ingestion."; `skippedAttachmentCount` `0` | No error expected |
| Unreferenced Content-ID | `logo.png`, no `Content-Disposition`, `Content-ID` the body never references | Treated as a real attachment: "1 unsupported attachment was recorded but skipped."; `skippedAttachmentCount` `1` | No error expected |
| Inline supported document, no body | only part is `notes.md` with `Content-Disposition: inline`, empty body | No forward. Reply is "work-wiki found no email text to ingest." followed by "1 supported attachment was not queued because it was marked inline by the sending client: notes.md." | No error expected |
| Inline document beside a body | `preview.md` inline, body has text | Forward carries the body and no attachment; `skippedAttachmentCount` `1`; acknowledgement carries the inline-loss line naming `preview.md` | No error expected |
| All five losses at once | unsupported + oversized/over-budget + over-cap + inline supported part | Five disjoint sentences; `skippedAttachmentCount` equals their sum | No error expected |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts:339-372` -- `inlineAttachment` doc + body. Split into a forwarding predicate (`disposition` only) and a counting predicate (`disposition`, or absent-disposition + referenced `contentId`); add a `cid:` reference-set helper beside them.
- `workers/email-ingest/index.ts:436-461` -- `replyLossNames`. Its doc asserts every list handed to it is inline-free; the new loss list is not. Rewrite.
- `workers/email-ingest/index.ts:582-608` -- `countableAttachments` / `eligibleAttachments`. Derive both from `parsed.attachments` through the split predicates; eligible = not-inline-by-disposition ∧ supported; countable = eligible ⊎ (not-inline ∧ unsupported ∧ not-decorative), built by one order-preserving filter so `countable.length - eligible.length` stays a valid `unsupportedCount`.
- `workers/email-ingest/index.ts:668-681` -- the four loss counts + `skippedAttachmentCount`; add the fifth term.
- `workers/email-ingest/index.ts:694-716` -- `overBudgetLine` / `oversizedLine`; build the new line in the same shape (count + reason + `replyLossNames`).
- `workers/email-ingest/index.ts:716-746` -- no-content exit list; append the new line after `overBudgetLine`.
- `workers/email-ingest/index.ts:751-760` -- `attachmentNames` from `countableAttachments`; its comment must record why an inline-dropped document is counted but not named here.
- `workers/email-ingest/index.ts:824-848` -- acknowledgement `lines`; insert the new line after `overBudgetLine`.
- `src/app/api/email/ingest/route.ts:372-384` (read-only) -- `localSkipped = Math.max(0, attachmentNames.length - attachments.length, ...)`, then `Math.max(localSkipped, payload.skippedAttachmentCount + ...)`. Proof that naming a non-forwarded part downstream re-creates a phantom skip, and that a larger worker total is safe.
- `node_modules/postal-mime/postal-mime.d.ts:33-43` (read-only) -- `Attachment` carries `disposition: "attachment" | "inline" | null`, optional `contentId?: string`, optional `related?: boolean`.
- `src/lib/__tests__/email-ingest-worker.test.ts:466-524` -- `multipartEmail`. `disposition` can only REPLACE the derived header, never omit it, and no part can carry extra headers; both are needed for a Content-ID-only fixture. There is also no way to give the message an HTML body.
- `src/lib/__tests__/email-ingest-worker.test.ts:1004-1310` -- `describe("email-ingest inline parts")`, the four DW-359/DW-446 cases; three of them assert `skippedAttachmentCount === "0"` and that an inline `.md` is named nowhere.
- `src/lib/__tests__/email-ingest-worker.test.ts:884-960` and `:1648-1730` -- the two "every loss at once" fixtures; the second carries an inline `notes.md` whose absence from the count and the reply is asserted.
- `src/lib/__tests__/email-ingest-worker-normalization.test.ts:23-33, 293-378` -- `FakeAttachment` and `describe("email-ingest oversized inline parts")`; both cases use an inline supported `banner.pdf`, so both totals move by one.

## Tasks & Acceptance

**Execution:**
- `workers/email-ingest/index.ts` -- Replace `inlineAttachment` with two named predicates plus a `cid:` reference-set helper; rewrite the doc comments so each states its own job, the other predicate's job, and why the two differ (DW-566). -- One predicate cannot both trust Content-ID and be safe to drop documents on.
- `workers/email-ingest/index.ts` -- Rebuild `countableAttachments` / `eligibleAttachments` from the split predicates, keeping `unsupportedCount` a subtraction over lists that remain in parse order and remain a superset/subset pair. -- Counting and forwarding no longer partition `parsed.attachments` the same way.
- `workers/email-ingest/index.ts` -- Add the fifth loss list, count, and reply line; include it in `skippedAttachmentCount`, the no-content exit and the acknowledgement. -- DW-565: a document must never arrive and go unmentioned.
- `workers/email-ingest/index.ts` -- Rewrite `replyLossNames`' doc and the `attachmentNames` comment. -- Both state invariants this change breaks.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- Extend `multipartEmail`: `disposition: null` omits the header, a `headers` list adds verbatim part headers, and an `html` option adds a `text/html` body part; add the three Content-ID cases and the inline-loss reply pin from the I/O matrix; update the existing inline and every-loss cases for the fifth term. -- Real-parser coverage is required for the new signals.
- `src/lib/__tests__/email-ingest-worker-normalization.test.ts` -- Update the two oversized-inline cases for the fifth term (`banner.pdf` is a supported document). -- Their totals and reply assertions change.

**Acceptance Criteria:**
- Given the Worker source, when the two predicates are read, then the forwarding one references only `disposition` and both call sites carry a comment naming the other predicate and the interaction (DW-566).
- Given any message, when the acknowledgement is built, then the five loss counts are pairwise disjoint and sum to the `skippedAttachmentCount` sent on the wire.
- Given a message with an inline-labelled supported document, when the reply is sent, then exactly one sentence names that document as not queued, at both the no-content exit and the acknowledgement.
- Given `pnpm vitest run` over the email suites, when the change is complete, then every case passes and no assertion asserting removed behaviour survives.

## Spec Change Log

_No bad_spec loopback occurred; nothing amended._

## Review Triage Log

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 1, low 8)
- defer: 0
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[medium]` `[patch]` The no-content exit could answer "found no email text or supported document attachment" plus the allowlist two paragraphs above a sentence naming an inline-labelled supported document. Keyed the format branch on `unsupportedCount && !inlineDroppedCount`, matching the DW-360/DW-253 precedent the branch's own comment records, and pinned the shape (`program.exe` + inline `notes.md`, empty body).
  - `[low]` `[patch]` `decorativePart` used a strict `!== null`, so an `undefined` disposition could never reach the Content-ID branch while `inlineByDisposition` treated `undefined` and `null` alike. Replaced with a truthy check; scoped the normalization suite's `FakeAttachment` doc, which claimed the equivalence module-wide.
  - `[low]` `[patch]` `htmlCidReferences` scanned raw HTML, so a `cid:` token in a script, style block, comment or quoted prose could delete a real unlabelled attachment from the accounting. Now strips script/style/comments and reads only URL-bearing positions (`src`/`href`/`background`/`poster`, CSS `url(`), in all three attribute spellings.
  - `[low]` `[patch]` The reference `Set` was unbounded against a body that may be tens of MB. Capped at `MAX_HTML_CID_REFERENCES`, with the cost of hitting it recorded.
  - `[low]` `[patch]` `normalizeCid`'s doc claimed the only cost of an over-eager match is an uncounted decoration; it also silences every sentence about an unsupported file the sender really attached. Named that.
  - `[low]` `[patch]` `replyLossNames`' rewritten doc asserted more than the code does (no over-cap or unsupported list is ever passed to it). Corrected.
  - `[low]` `[patch]` Content-ID case folding was a no-op in every fixture — mutation-confirmed that deleting `.toLowerCase()` or the `/i` flag left the suite green. Added a mixed-case case varying both sides.
  - `[low]` `[patch]` Only double-quoted `cid:` references were pinned; a single-quoted one was unobserved. Added that spelling, plus a case pinning that a non-URL `cid:` mention is ignored.
  - `[low]` `[patch]` No test reached the no-content exit with a Content-ID-only decoration as the only part — the exit where the DW-359 lie was loudest. Added it (HTML-only body reducing to empty `rawContent`).
  - `[low]` `[patch]` Test hygiene: a no-interpolation template literal in the normalization suite, and `multipartEmail` silently discarding a `filename` passed beside `disposition: null` (now throws).

## Design Notes

Predicate split, in shape:

```ts
// FORWARDING (eligibility). Never widened: a Content-ID must not drop a file.
const inlineByDisposition = (a) => a.disposition === "inline";
// COUNTING (names + loss terms). Widened only where the header is ABSENT.
const decorativePart = (a, cids) =>
  inlineByDisposition(a) ||
  (a.disposition === null && !!a.contentId && cids.has(normalizeCid(a.contentId)));
```

`contentId` arrives angle-bracketed (`<logo@x>`); the body references it as `cid:logo@x`. Normalize both to lower-case, bracket-free strings before comparing. Collect the body's references with one scan of `parsed.html` for `cid:` tokens.

Parser behaviour, probed against the installed `postal-mime@2.7.5` (so the Block If is
already cleared): a part carrying `Content-ID: <logo@example.com>` and NO
`Content-Disposition` arrives as `disposition: null`, `contentId: "<logo@example.com>"`,
`filename: null`. A `text/html` sibling part populates `parsed.html` (postal-mime also
folds the `text/plain` sibling into it), so a `cid:` reference is reachable from a real
fixture. Give such a part a name through its own `Content-Type` (`image/png; name="logo.png"`),
since the filename normally comes from the `Content-Disposition` line the fixture omits.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- expected: all pass.
- `pnpm vitest run` -- expected: no new failures against the pre-change baseline.
- `npx tsc --noEmit` -- expected: clean.
- `pnpm lint` -- expected: no new findings.

## Auto Run Result

Status: done

**Implemented change.** Split the single `inlineAttachment` predicate into `inlineByDisposition` (FORWARDING/eligibility — `disposition === "inline"`, never widened) and `decorativePart` (COUNTING — also a `Content-ID` the HTML body references, but only where the disposition header is absent), with the interaction recorded at both call sites. Added a fifth loss term for supported documents eligibility dropped because the client labelled them inline: counted into `skippedAttachmentCount` and named to the sender in both the no-content exit and the acknowledgement, while deliberately staying out of `attachmentNames` so the route's `localSkipped` floor does not double-count it.

**Files changed.**
- `../../workers/email-ingest/index.ts` — the two predicates plus `normalizeCid` / `htmlCidReferences` / `MAX_HTML_CID_REFERENCES`; `countableAttachments` rebuilt as one order-preserving pass; the fifth loss list, count and reply line; the no-content-exit headline gate; four stale comments rewritten.
- `../../src/lib/__tests__/email-ingest-worker.test.ts` — `multipartEmail` gained header omission, verbatim extra headers and an HTML sibling body; new `describe("email-ingest Content-ID parts")` (8 cases); the inline suite and both "every loss at once" fixtures updated for the fifth term.
- `../../src/lib/__tests__/email-ingest-worker-normalization.test.ts` — the two oversized-inline cases now assert `banner.pdf` is reported under the inline reason rather than vanishing.

**Review findings breakdown.** 9 patches applied (1 medium, 8 low); 0 deferred; 15 rejected. Follow-up review recommended: `true` — patched severities high 0 / medium 1 / low 8, score `3x1 + 1x8 = 11` (>= 5).

**Verification.**
- `pnpm vitest run` over the four email suites — 126 passed (121 before the change).
- Full `pnpm vitest run` at this change alone (baseline `ffc99a2f` plus these three files, run in isolation) — 356 files, 8569 passed, 1 skipped, 0 failed.
- `npx tsc --noEmit` — no error in any file this change touches.
- `npx eslint` over the changed test files — clean (`workers/` is eslint-ignored by project config, pre-existing).
- Mutation-checked: reverting the headline gate, the case fold, the `/i` flag, the single-quote spelling, the script/style/comment strip, or the URL-position narrowing is each caught by exactly one new test.

**Residual risks.**
- `htmlCidReferences` errs toward under-matching by design (an HTML-entity-encoded or percent-encoded `cid:` reference will not match). The cost is the phantom "recorded but skipped" line DW-450 is about, never a lost file.
- `decorativePart`'s truthy disposition guard is defensive only: real PostalMime always yields `null`, and pinning `undefined` would require the mocked parser, which this spec's Always list rules out for new Worker behaviour.
- `skippedAttachmentCount` on the worker-to-route wire can now exceed anything the route can derive locally. Safe by the route's existing `Math.max` (`src/app/api/email/ingest/route.ts:372-384`), which is pinned by `email-ingest-route.test.ts`.
- A concurrent process edited unrelated files in this working copy during the run (`src/lib/wikis.ts`, `workspace-*.ts`, `workbench-preview.ts`, the DW-58 spec and others, still changing at finalize time). Those files carry 11 `tsc` errors and failing suites of their own; none are in or reachable from this change, and this run neither touched nor committed them.
