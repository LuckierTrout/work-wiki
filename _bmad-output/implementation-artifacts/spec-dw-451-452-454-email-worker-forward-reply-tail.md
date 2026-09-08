---
title: 'Email Worker forward-and-reply tail: one site const, loss-carrying failure reply, shared attachment naming'
type: 'refactor'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
baseline_revision: '484128227ef7963ba2b382f8c6032ea00f0dab0c'
deferred:
  - summary: >-
      The email-ingest route dedups recorded attachment names BEFORE sanitizing
      them, so any part whose recorded name and forwarded file name differ only
      after scrubbing inflates `attachmentNames` and reports a phantom skipped
      attachment.
    evidence: |-
      `src/app/api/email/ingest/route.ts:236` builds
      `sanitizeAttachmentNames(Array.from(new Set([...payload.attachmentNames,
      ...payload.attachments.map((file) => file.name)])))` -- the `Set` collapses
      RAW strings, and `sanitizeAttachmentNames` scrubs afterwards, so two raw
      names that scrub to the same string survive as duplicates. `localSkipped`
      (route.ts:372-376) then takes `attachmentNames.length - attachments.length`
      as a floor and reports a skip that did not happen.

      Reachable at HEAD, before and independently of this change, by the most
      ordinary case: a supported part with no filename at all. The Worker records
      it as `unnamed attachment` and forwards the Blob as `attachment-1`, so the
      `Set` holds two entries for one file and the floor is 1 -- a message whose
      single unnamed attachment ingested cleanly is reported as having skipped
      one. Verified by evaluating the route's own expression against those two
      inputs.

      This change shifts WHICH malformed name trips it rather than creating the
      class: routing `attachmentNames` through `replyAttachmentName` (DW-454)
      makes a CR/LF-smuggled name (`filename*=utf-8''a%0D%0Ab.pdf`) newly
      divergent from the still-raw Blob name, so that input now trips it too,
      while a whitespace-only name stops tripping the adjacent `.filter(Boolean)`
      drop. The Worker cannot settle it alone -- the forwarded Blob filename's
      `attachment-<n>` fallback is load-bearing for `intakeSourceSlug(file.name)`
      distinctness across several unnamed parts, so making the two Worker
      surfaces byte-identical is not available. The fix belongs at route.ts:236:
      sanitize before deduplicating.
    location: >-
      src/app/api/email/ingest/route.ts:236
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three defects sit in the tail of `workers/email-ingest/index.ts`'s `email` handler. The trimmed site URL is computed twice (`:1017` inside the forward `try`, `:1078` for the acknowledgement links) so the two copies can drift; the `!response.ok` exit (`:1073`) replies with `safeError(result)` alone, discarding every loss sentence the handler already built, so a route refusal hides which attachments were dropped; and the recorded `attachmentNames` list (`:1011-1013`) uses a bare `attachment.filename || "unnamed attachment"` with no scrub or trim, while `replyAttachmentName` (`:565`) scrubs and trims — so a whitespace-named part is called "unnamed attachment" in the reply but forwarded as whitespace, which the route's `sanitizeAttachmentNames` then drops.

**Approach:** Hoist a single `const site` above the forward `try` (leaving `if (!site) throw` inside it), hoist the acknowledgement's over-cap and unsupported sentences into consts beside the existing loss-line consts, carry all five loss sentences into the `!response.ok` reply after `safeError(result)`, and build `attachmentNames` through the existing `replyAttachmentName` helper.

## Boundaries & Constraints

**Always:**
- `if (!site) throw new Error("YOPEDIA_SITE_URL is missing")` stays *inside* the forward `try`, so the missing-URL throw is still caught, logged as `"email-ingest: service binding request failed"` and answered with the generic retry reply. Only the `.replace(/\/+$/, "")` computation moves.
- The no-content exit's sentence set is unchanged: no-text/format sentence, `oversizedLine`, `overBudgetLine`, `inlineDroppedLine` — and specifically NOT the over-cap or unsupported sentences.
- The acknowledgement's sentence text, order and set are byte-identical to today's after the over-cap and unsupported sentences are hoisted into consts.
- Loss sentences carried into the `!response.ok` reply are the same strings the acknowledgement uses — no new copy is authored anywhere in this change.
- `attachmentNames` keeps its membership (`countableAttachments`) and its `MAX_EMAIL_ATTACHMENT_NAMES_RECORDED` slice. Only the per-name expression changes.
- Comments explaining each site keep the codebase's existing depth and cite the DW ids they settle.

**Block If:**
- Routing `attachmentNames` through `replyAttachmentName` would change the recorded list's *length* for any input (it must not — the helper always returns a non-empty string).

**Never:**
- Do not change the forwarded `Blob` filename fallback (the `attachment-<n>` positional fallback in the forwarding loop) — that is a deliberate positional fallback, not a display name.
- Do not add inline-dropped names to `attachmentNames` (the route derives a `localSkipped` floor from `attachmentNames.length - attachments.length`; a phantom name re-creates DW-359).
- Do not touch `src/app/api/email/ingest/route.ts` or `src/lib/email-ingest.ts`.
- Do not alter `safeError`, `reply`, or the raw-message cap / eligibility / budget logic.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Route refuses with an error body | Forward returns `{ status: 400, body: { error: "wiki is read-only" } }`, message also had 1 oversized and 1 unsupported part | Reply text opens with the route's own `error` string, then carries the oversized sentence and the unsupported sentence, joined by blank lines | No error expected |
| Route refuses with no usable body | Forward returns `{ status: 500 }` with non-JSON body, no losses | Reply is exactly `work-wiki could not accept this email.` — no trailing blank lines | No error expected |
| Route refuses after over-cap loss | 11+ supported parts, forward returns `{ status: 503, body: { error: "queue unavailable" } }` | Reply carries the route error plus the `${MAX_EMAIL_ATTACHMENTS}-attachment limit` sentence | No error expected |
| Whitespace-named countable part | A supported part whose `filename` is `"   "` | Forwarded `attachmentName` field for that part is `unnamed attachment`, matching what the reply calls it | No error expected |
| CR/LF-named countable part | A supported part whose `filename` is `"a\r\nb.pdf"` | Forwarded `attachmentName` is `a b.pdf` | No error expected |
| Site URL missing | `env.YOPEDIA_SITE_URL` absent | No forward; reply is `work-wiki could not queue this email. Please try again in a few minutes.`; `console.error("email-ingest: service binding request failed", …)` logged with message `YOPEDIA_SITE_URL is missing` | Caught by the existing forward `try/catch` |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts` — the only production file changed. Anchors (current line numbers):
  - `:565-570` `replyAttachmentName(filename: string | null): string` — scrub `[\r\n\t]+`→space, `trim()`, `slice(0, 200)`, fallback `"unnamed attachment"`. Reuse target for DW-454.
  - `:593-604` `replyLossNames` — already routes through `replyAttachmentName`; the surface the recorded list currently disagrees with.
  - `:643-649` `safeError(value)` — unchanged; produces the first sentence of the `!response.ok` reply.
  - `:903-941` `overBudgetLine`, `oversizedLine`, `inlineDroppedLine` consts — the existing hoisted-loss-sentence pattern to follow.
  - `:942-990` no-content exit — must keep its exact sentence set; do not add over-cap/unsupported here.
  - `:1011-1013` `attachmentNames` build — DW-454 target (`.map((attachment) => attachment.filename || "unnamed attachment")`).
  - `:1015-1018` forward `try` opening + first `site` computation + `if (!site) throw` — DW-451 target A.
  - `:1073-1076` `if (!response.ok) { await reply(message, subject, safeError(result)); return; }` — DW-452 target.
  - `:1078` second `site` computation — DW-451 target B (delete; use the hoisted const).
  - `:1096-1101` over-cap and unsupported sentences, inline in the acknowledgement `lines` array — hoist into consts for DW-452.
- `src/lib/__tests__/email-ingest-worker.test.ts` (2572 lines) — the worker suite. Read-only reuse points: `env(response)` helper builds bindings around a canned `Response`; `message()` builds a `ForwardableEmailMessage` double; `multipartEmail(parts, opts)` builds fixtures; `forwardedForm(...)` (`:596-609`) returns `{ form, reply }`. `describe("email-ingest misconfigured bindings")` (`:2226`) pins the missing-site-URL behaviour that must stay green. `describe("email-ingest multi-attachment forwarding")` (`:611`) pins the recorded-name list, including an existing `"unnamed attachment"` entry at `:645`.
- `src/lib/email-ingest.ts:147-152` `sanitizeAttachmentNames` — READ-ONLY evidence for DW-454: it scrubs, trims, slices to 200 and `.filter(Boolean)`, so a whitespace name is dropped route-side.
- `src/app/api/email/ingest/route.ts:372-376` `localSkipped` — READ-ONLY evidence: the `attachmentNames.length - attachments.length` floor is why the recorded list's length must not change.
- `src/lib/__tests__/prose-inventory-parity.test.ts:226` — READ-ONLY: pins the single `Supported attachments: …` sentence in the worker. This change authors no new prose, so it stays green.

## Tasks & Acceptance

**Execution:**
- `workers/email-ingest/index.ts` — DW-451: hoist `const site = (env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "");` to just above `let response: Response;`, keep `if (!site) throw new Error("YOPEDIA_SITE_URL is missing");` as the first statement inside the `try`, and delete the second computation at `:1078`. — one definition means the two consumers cannot drift.
- `workers/email-ingest/index.ts` — DW-452: hoist the over-cap and unsupported sentences into `overCapLine` and `unsupportedLine` consts beside `inlineDroppedLine`, reference those consts from the acknowledgement `lines` array in place of the inline ternaries, and change the `!response.ok` exit to reply with `[safeError(result), oversizedLine, overBudgetLine, inlineDroppedLine, overCapLine, unsupportedLine].filter(Boolean).join("\n\n")`. — a route refusal must still name what was dropped.
- `workers/email-ingest/index.ts` — DW-454: build `attachmentNames` with `.map((attachment) => replyAttachmentName(attachment.filename))`. — the recorded list and the sender's reply then name the same part identically, and a whitespace name survives `sanitizeAttachmentNames`.
- `workers/email-ingest/index.ts` — update the comments at each of the three sites to record why (single `site` definition; the loss sentences the refusal exit carries; why the recorded names route through the shared helper and why doing so cannot change the list length).
- `src/lib/__tests__/email-ingest-worker.test.ts` — add a `describe("email-ingest route refusal")` block covering the I/O matrix's refusal rows, plus recorded-name cases for a whitespace filename and a CR/LF filename. — none of these paths has any coverage today.

**Acceptance Criteria:**
- Given the handler source, when `(env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "")` is searched for in `workers/email-ingest/index.ts`, then exactly one occurrence is found, and `if (!site) throw` still appears inside the forward `try`.
- Given a message whose forward is answered with a non-`ok` response, when the handler finishes, then `message.reply` is called exactly once and every loss sentence the same message would have produced on the acknowledgement path appears in that reply.
- Given a message with no losses whose forward is answered non-`ok`, when the handler finishes, then the reply text is exactly the `safeError` string with no leading or trailing blank lines.
- Given the whole suite, when `pnpm test src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/prose-inventory-parity.test.ts` runs, then every test passes, including the pre-existing missing-site-URL and recorded-name assertions, unmodified.

## Spec Change Log

## Review Triage Log

## Design Notes

The hoisted-loss-sentence pattern already exists in this handler and is the shape to follow — `overBudgetLine`, `oversizedLine` and `inlineDroppedLine` are consts built once and consumed by two exits. DW-452 finishes that pattern by giving the last two sentences the same treatment and adding the refusal exit as a third consumer:

```ts
const overCapLine = overCapCount
  ? `${overCapCount} supported attachment${…} not queued because this email exceeds the ${MAX_EMAIL_ATTACHMENTS}-attachment limit.`
  : "";
…
if (!response.ok) {
  await reply(message, subject, [
    safeError(result), oversizedLine, overBudgetLine,
    inlineDroppedLine, overCapLine, unsupportedLine,
  ].filter(Boolean).join("\n\n"));
  return;
}
```

`.filter(Boolean)` is what keeps the no-loss refusal a single bare sentence.

## Verification

**Commands:**
- `pnpm test src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/prose-inventory-parity.test.ts` — expected: all pass.
- `pnpm lint` — expected: no new errors or warnings.
- `npx tsc --noEmit` — expected: no new type errors.
- `grep -c 'YOPEDIA_SITE_URL || ""' workers/email-ingest/index.ts` — expected: `1`.

## Auto Run Result

Status: done
Baseline revision: 484128227ef7963ba2b382f8c6032ea00f0dab0c

**Summary.** Tidied the forward-and-reply tail of the Worker's `email` handler for
DW-451, DW-452 and DW-454. The trimmed site URL now has one definition read by
both consumers, with the `if (!site) throw` guard still inside the forward `try`;
the acknowledgement's over-cap and unsupported sentences are hoisted into consts
beside the three existing loss lines and all five are now carried into the
`!response.ok` refusal reply beneath the route's own error; and the recorded
`attachmentNames` list is built through the shared `replyAttachmentName` helper
so the recorded name and the sentence the sender reads name the same part
identically.

**Files changed.**
- `workers/email-ingest/index.ts` — one hoisted `site` const, `overCapLine` and
  `unsupportedLine` hoisted, the refusal exit rebuilt to carry the five loss
  sentences, and `attachmentNames` routed through `replyAttachmentName`.
- `src/lib/__tests__/email-ingest-worker.test.ts` — new `describe("email-ingest
  route refusal")` (five cases: combined losses, bare fallback on an unparseable
  body, over-cap, over-budget, inline-dropped) and `describe("email-ingest
  recorded attachment names")` (whitespace-only and CR/LF filenames); two stale
  comments about the deleted duplicate rewritten; shared fixture consts lifted to
  module scope.

**Review findings.** 7 patches applied (1 medium, 6 low), 1 item deferred (low),
11 rejected. No intent gaps and no spec repairs.

**Follow-up review recommendation.** true. Patched this pass: high 0, medium 1,
low 6 — score `3 × 1 + 1 × 6 = 9`, at or above the threshold of 5.

**Verification.**
- `npx vitest run` over the five suites named in `## Verification`: 5 files, 153
  tests, all passing (the worker suite grew from 53 to 60). The pre-existing
  missing-`YOPEDIA_SITE_URL` assertions, the recorded-name list, the two
  acknowledgement link assertions and the prose-inventory parity anchor all stayed
  green unmodified.
- Mutation check: deleting each of the five loss entries from the refusal array in
  turn fails exactly one test and no more.
- `npx tsc --noEmit` — exit 0.
- `pnpm lint` — no errors or warnings (three pre-existing `jsx-ast-utils`
  `TSNonNullExpression` notices from unrelated JSX files).
- `grep -c 'YOPEDIA_SITE_URL || ""' workers/email-ingest/index.ts` → 1.

**Residual risks.**
- The deferred route-side finding above is a phantom skip count that already
  exists at HEAD for any unnamed attachment; this change alters which malformed
  filename trips it and cannot settle it from the Worker alone.
- The two RFC 2231 fixtures depend on `postal-mime` preserving decoded filename
  bytes (leading spaces, CR/LF). The suite already carried that dependency via
  the existing DW-450 oversize case, so it is not new exposure, but a
  `postal-mime` upgrade that normalises filenames would fail all three together.
- The working tree was reset by a concurrent session partway through the review;
  the diff was restored verbatim from a saved patch and re-verified from scratch.
  Other sessions' edits to `src/app/api/wiki/**`, `src/mcp.ts` and their tests were
  present in the tree and were deliberately left untouched and uncommitted.
