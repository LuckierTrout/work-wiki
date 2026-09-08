---
title: 'Guard the headerless fetch doors, and bound the server work the client deadline wraps'
type: 'bugfix'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      The Workbench Activity retry and embed-rebuild doors still run a full
      inline `ingest()` under the same client deadline this story bounded at the
      intake door.
    evidence: |-
      DW-700's shape at a door the bundle did not name.
      `src/app/api/workbench/activity/route.ts:123` (embed rebuild) and `:184`
      (ingest retry) both call `enqueueOrInline(...)` with no `inlineBudgetMs`,
      so where `enqueueTask` returns false the FULL `ingest()` -- LLM map/reduce,
      retries, embeddings, image downloads -- runs inside the request.
      `src/components/workbench/ActivityDock.tsx:143` and `:193` reach that route
      through `send(ACTIVITY_ROUTE, ...)`, which arms the same
      `REQUEST_TIMEOUT_MS` deadline. The client aborts first, `unconfirmedCause`
      classifies the `TimeoutError` as unconfirmed, and the owner is told the
      outcome is unknown about work that is still running. Pre-existing and not
      caused by this change: the opt-in budget added here leaves every other
      `enqueueOrInline` caller byte-for-byte as it was. Out of scope because the
      bundle's intent names only `src/app/api/workbench/intake/route.ts:640`.
      Now named in the `inlineBudgetMs` docblock rather than denied by it.
    location: src/app/api/workbench/activity/route.ts:123 / :184
    severity: low
baseline_revision: '9ceb9aba2b664332e5a8eec171c5e8cf46f53c85'
---

<intent-contract>

## Intent

**Problem:** Two open axes on the shared server fetch path. (1) DW-441: `fetchUrlContent` and `fetchPdfBytes` both guard with `if (mimeType && …)`, so a response that omits `Content-Type` skips the allowlist entirely and whatever arrived is ingested unchecked. (2) DW-700: the DW-439 ordering bounds only the server's single fetch deadline, and two paths still outlast any fixed client margin — `fetchFollowingRedirects` arms `AbortSignal.timeout(FETCH_TIMEOUT_MS)` INSIDE its hop loop (up to six fetches, ~90 s), and `storeAndQueue`'s `enqueueOrInline` runs the FULL `ingest()` inline off-Workers after the Source is already stored. In both the client aborts first and the owner is told "the outcome is unknown" about a Source that landed.

**Approach:** (1) When `Content-Type` is absent, sniff the body's leading bytes against the caller's allowlist and refuse only what does not match — applied at both doors, pinned with byte fixtures. (2) Arm the URL fetch's `FETCH_TIMEOUT_MS` ONCE as a TOTAL budget for the whole redirect chain and the body read that follows, and give the intake route a request-scoped answer deadline whose remainder bounds the inline ingest: when it elapses the route answers `{ queued: true, jobId, path }` — the shape the client already polls — instead of letting the client's deadline fire on work that is still running.

## Boundaries & Constraints

**Always:**
- A sniffed type is subject to the SAME `allowedContentTypes` the caller passed. Sniffing decides what the bytes are; the caller's door still decides what it takes.
- A declared `Content-Type` still wins outright — sniffing runs ONLY when the header is absent or blank. No declared type is ever second-guessed.
- Refusals from the sniff path throw `ClientInputError` in the existing `Unsupported content type` wording family, so the routes above keep answering 400 rather than 500.
- The headerless body is read ONCE and that same buffer feeds the PDF branch and the text branch — never a second read of a consumed body.
- `FETCH_TIMEOUT_MS` becomes a TOTAL: one signal created before the hop loop, passed to every hop, still named `AbortSignal.timeout(FETCH_TIMEOUT_MS)` inside `fetchFollowingRedirects` so the existing DW-439 scan pin keeps observing it.
- The budget ladder `FETCH_TIMEOUT_MS < INTAKE_ANSWER_BUDGET_MS < REQUEST_TIMEOUT_MS` is enforced by an executable assertion, not by a comment.
- The inline-budget race NEVER abandons the job record: the still-running inline continuation keeps marking the job `done`/`failed` exactly as today, and its rejection is caught and logged so it cannot surface as an unhandled rejection.
- Docblocks on `FETCH_TIMEOUT_MS` and `REQUEST_TIMEOUT_MS` that currently state the per-hop 90 s reach and the unbounded inline path must be rewritten to what is then true — those comments are the DW-439 record and must not be left lying.

**Block If:** Nothing here needs a human decision.

**Never:**
- Do not widen the sniff into a guess: bytes matching nothing on the allowlist are refused, not defaulted to `text/html`.
- Do not touch `MAX_RESPONSE_SIZE`, `MAX_PDF_SIZE`, `MAX_CONTENT_LENGTH`, `ALLOWED_CONTENT_TYPES`, `INTAKE_ALLOWED_CONTENT_TYPES`, or `REQUEST_TIMEOUT_MS`.
- Do not change the image-download budget (`FETCH_TIMEOUT_MS` in `downloadImages` / `fetchImageBytes`): those run inside queued ingest, with no client deadline waiting.
- Do not give the inline budget to any other `enqueueOrInline` caller (`/api/ingest*`, agents, email, activity, extract-dispatch): it is opt-in, and only `storeAndQueue`'s call site passes it.
- Do not roll back or delete a stored Source when the inline budget elapses, and do not change `enqueueExtract`'s path at `route.ts:172`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Declared type, allowed | `content-type: text/html` | Unchanged Readability path; no sniff runs | No error expected |
| Declared type, refused | `content-type: image/png` | Unchanged refusal | `ClientInputError` `Unsupported content type: image/png…` |
| Headerless HTML | No `Content-Type`; body opens `<!DOCTYPE html>` | Sniffed `text/html`; title/content returned | No error expected |
| Headerless plain text | No `Content-Type`; printable text, no markup | Sniffed `text/plain`; body returned verbatim | No error expected |
| Headerless PDF, default list | No `Content-Type`; body starts `%PDF-` | Sniffed `application/pdf`; `unpdf` extraction runs | No error expected |
| Headerless PDF, Intake list | Same bytes, `INTAKE_ALLOWED_CONTENT_TYPES` | Refused; `unpdf` never called | `ClientInputError` naming `application/pdf` |
| Headerless binary | No `Content-Type`; PNG magic / NUL bytes | Refused before any parse | `ClientInputError` `Unsupported content type` |
| Headerless empty body | No `Content-Type`; zero bytes | Refused | `ClientInputError` `Unsupported content type` |
| PDF door, headerless PDF | `fetchPdfBytes`, no header, `%PDF-` body | Bytes returned | No error expected |
| PDF door, headerless non-PDF | `fetchPdfBytes`, no header, no `%PDF-`, `.pdf` URL leaf | Refused — the URL leaf alone does not satisfy it | `ClientInputError` `…Only PDF is accepted at this door.` |
| Redirect chain budget | 3 hops | ONE signal instance is passed to every `fetch` call; the clock is not restarted per hop | Chain aborts as a whole → route answers 400 |
| Inline ingest within budget | Queue absent; `ingest()` resolves before the remaining budget | Unchanged: job marked `done`, response carries `slug` | Inline throw still marks the job `failed` and rethrows |
| Inline ingest past budget | Queue absent; `ingest()` still running at the deadline | Route answers `{ queued: true, jobId, path }` immediately; the continuation still marks the job | A later inline throw is caught and logged, not unhandled |

</intent-contract>

## Code Map

- `src/lib/fetch.ts` -- both defective doors and the redirect loop. `responseMimeType` (l.216) returns `null` for a missing/blank header. `fetchPdfBytes` guard l.257 (`mimeType && mimeType !== "application/pdf" && !(octet-stream && looksPdf)`) and `fetchUrlContent` guard l.290 (`mimeType && !allowedContentTypes.includes(mimeType)`) both skip on `null`. `fetchFollowingRedirects` (l.163) arms `AbortSignal.timeout(FETCH_TIMEOUT_MS)` at l.175 INSIDE `for (let hop = 0; hop <= MAX_REDIRECTS; hop++)` with `MAX_REDIRECTS = 5` (l.169). `readPdfBuffer` (l.221) already caps at `MAX_PDF_SIZE` and is the reuse point for the headerless buffered read. Streaming text read is l.324-351; `mimeType` is re-read at l.301 (PDF branch), l.357 (`text/plain`/`text/markdown`) and l.393 (image salvage), so a sniffed value must be assigned into that SAME variable.
- `src/lib/constants.ts` -- `MAX_RESPONSE_SIZE` (l.11), `MAX_PDF_SIZE` (l.19), `FETCH_TIMEOUT_MS = 15_000` (l.44) whose docblock (l.28-43) currently states the per-hop 90 s reach and "does NOT bound the route's total work". New `INTAKE_ANSWER_BUDGET_MS` belongs beside it.
- `src/lib/workbench-request.ts` -- `REQUEST_TIMEOUT_MS = 20_000` (l.62); its docblock (l.42-47) names both DW-700 paths as still-open and must be rewritten. Client-safe module (no `node:` imports).
- `src/lib/ingest-async.ts` -- `enqueueOrInline` (l.36): enqueue branch l.41-49, inline run l.53-58, then skipped/`dispatchMeetingTodoExtract`/`enqueueReviewAfterIngest`/`updateIngestJob("done")` composition l.59-150. The whole post-enqueue body is what must move behind one promise so the budget can race it. `markFailed` (l.20) is the existing failure marker.
- `src/app/api/workbench/intake/route.ts` -- `POST` (l.92) dispatches to `intakeFile` (l.133) / `intakeUrl` (l.320); both end in `storeAndQueue` (l.465) at l.241, l.349, l.380. `storeAndQueue` calls `enqueueOrInline(jobId, task, () => ingest(...))` at l.640 inside the post-store `try` whose `catch` already answers 202 with the stored path. `intakeUrl` calls `fetchUrlContent` at l.365 and maps any throw to 400 (l.371-374) — no change needed there.
- `src/lib/workbench-intake.ts` -- `INTAKE_ALLOWED_CONTENT_TYPES` (l.349) is READ-ONLY here; it is what makes a sniffed `application/pdf` refuse at that door.
- `src/lib/workbench-intake-client.ts` -- `body.queued === false` → `not_queued` (l.92); `queued: true` → disposition `queued` (l.70) → "Ingest is queued." copy. No client change is needed for the budget answer.
- `src/lib/__tests__/fetch.test.ts` (1015 l.) -- `mockResponse` (l.27) forces the `response.text()` fallback with `body: null` and stubs `arrayBuffer` to an EMPTY buffer, so headerless fixtures need a bytes-backed sibling helper. `vi.mock("unpdf")` (l.17) is how "the extractor was never reached" is asserted.
- `src/lib/__tests__/workbench-request.test.ts` -- existing DW-439 pins at l.320-330 (strict `>` plus a 5 s floor) and the source scan at l.332-345 that reads `fetchFollowingRedirects`'s body for `AbortSignal.timeout(FETCH_TIMEOUT_MS)`; the ladder assertion belongs beside them.
- `src/lib/__tests__/ingest-async.test.ts` (226 l.) -- mocks `@/lib/tasks`, `@/lib/ingest-jobs`, `@/lib/todo-dispatch`, `@/lib/review-queue`, `@/lib/ingest-analysis`; `enqueueTask` mocked false is how the inline path is driven. Budget cases belong here.

## Tasks & Acceptance

**Execution:**
- `src/lib/constants.ts` -- add `INTAKE_ANSWER_BUDGET_MS = 17_000`, documented as the deadline for the WHOLE workbench intake request measured from route entry, sitting strictly between `FETCH_TIMEOUT_MS` and the client's `REQUEST_TIMEOUT_MS`; rewrite the `FETCH_TIMEOUT_MS` docblock so it states the budget is now TOTAL across the redirect chain rather than per hop -- the comment is the DW-439 record and must stop describing a 90 s reach that no longer exists.
- `src/lib/fetch.ts` -- export `sniffContentType(prefix: Uint8Array): string | null` over a 512-byte window: `%PDF-` magic → `application/pdf`; any NUL or non-whitespace C0 control byte → `null`; otherwise decode UTF-8 and return `application/xml` for a leading `<?xml`, `text/html` for a recognisable HTML tag at or near the start, `text/plain` for anything else printable; empty input → `null` -- conservative by construction so `null` refuses rather than guesses.
- `src/lib/fetch.ts` -- in `fetchUrlContent`, when `responseMimeType` is `null`, read the body ONCE via `readPdfBuffer`, sniff it, assign the result into the existing `mimeType` local, and refuse when the sniff yields `null` or a type outside `allowedContentTypes`; reuse that buffer for the PDF branch and decode it for the text branch so the body is never read twice -- closes DW-441 at the text door with the declared-type path untouched.
- `src/lib/fetch.ts` -- in `fetchPdfBytes`, when `responseMimeType` is `null`, read the buffer first and require the `%PDF-` sniff before returning; refuse otherwise with the existing door sentence. A `.pdf`-looking URL leaf must NOT satisfy it -- closes DW-441 at the PDF door.
- `src/lib/fetch.ts` -- in `fetchFollowingRedirects`, create ONE `AbortSignal.timeout(FETCH_TIMEOUT_MS)` before the hop loop and pass that same signal to every hop, so the budget covers the whole chain and the body read that follows -- closes DW-700's redirect half and bounds the chain at 15 s instead of 90 s.
- `src/lib/ingest-async.ts` -- give `enqueueOrInline` an optional fourth argument `{ inlineBudgetMs?: number }`; extract everything after the enqueue branch into one promise, and when a budget is supplied race it against a timer: if the timer wins, attach a rejection handler to the still-running promise (which already marks the job `failed` itself) and return `NextResponse.json({ queued: true, jobId })`; clear the timer when the run wins -- so an inline ingest can no longer outlast the caller's deadline. Omitting the option leaves every existing caller byte-for-byte unchanged.
- `src/app/api/workbench/intake/route.ts` -- capture `const answerBy = Date.now() + INTAKE_ANSWER_BUDGET_MS` in `POST` and thread it through `intakeFile`/`intakeUrl` into `storeAndQueue`, which passes `{ inlineBudgetMs: Math.max(0, answerBy - Date.now()) }` at the `enqueueOrInline` call site -- a fixed budget cannot bound total work, so the remainder must be measured from request entry, after whatever the fetch and the store already spent.
- `src/lib/__tests__/fetch.test.ts` -- add a bytes-backed response fixture beside `mockResponse` and cover every headerless row of the I/O matrix at both doors plus a direct `sniffContentType` block; assert the `unpdf` mocks are never called on the Intake-list PDF refusal, and assert one and the same signal instance reaches every `fetch` call across a redirect chain -- the fixtures the DW-441 decision asks for, and the behavioural pin for the total budget.
- `src/lib/__tests__/ingest-async.test.ts` -- cover the two budget rows: an inline run that finishes inside the budget behaves exactly as today, and one still running at the deadline returns `{ queued: true, jobId }` while the continuation still reaches `updateIngestJob`; assert no unhandled rejection when the abandoned run later throws -- pins the inline half of DW-700.
- `src/lib/__tests__/workbench-request.test.ts` -- assert the ladder `FETCH_TIMEOUT_MS < INTAKE_ANSWER_BUDGET_MS < REQUEST_TIMEOUT_MS` with a usable gap at each rung, and scan `src/app/api/workbench/intake/route.ts` for the `inlineBudgetMs` wiring so the route cannot quietly stop passing it -- the ordering pin that stops the ladder collapsing again.

**Acceptance Criteria:**
- Given a response that declares a `Content-Type`, when either door validates it, then no sniff runs and behaviour is what it was before this change.
- Given a headerless response whose sniffed type is outside the caller's `allowedContentTypes`, when either door validates it, then a `ClientInputError` is thrown before any parsing or extraction and no Source is stored.
- Given the constants as shipped, when the ladder test runs, then making any two adjacent rungs equal fails the suite.
- Given the queue is absent and `ingest()` outlasts the remaining request budget, when the intake route answers, then the owner sees a stored Source with `queued: true` rather than a `writeFailure` reporting an unknown outcome.

## Spec Change Log

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 3, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[medium]` `[patch]` The headerless read went through `response.arrayBuffer()`, unbounded DURING the read, losing the incremental `MAX_RESPONSE_SIZE` cancel for exactly the servers that omit `Content-Length`; and an oversized headerless HTML body was refused with the `PDF too large` sentence. Added `readCappedBytes`, which streams and cancels at the cap, with a type-neutral `Content too large` sentence on the text door.
  - `[medium]` `[patch]` `sniffContentType` answered `application/xml` for a headerless XHTML page, which `INTAKE_ALLOWED_CONTENT_TYPES` refuses although it allows `application/xhtml+xml`. An XML declaration carrying an HTML doctype or `<html` tag now answers `application/xhtml+xml`.
  - `[medium]` `[patch]` The route's budget wiring was pinned only by a source-text scan that survives moving the `answerBy` capture into `storeAndQueue` — the exact DW-700 failure, suite green. Added an executable remainder pin in `workbench-intake.test.ts` asserting `inlineBudgetMs` is strictly below `INTAKE_ANSWER_BUDGET_MS` after a stalled fetch.
  - `[low]` `[patch]` `MAX_RESPONSE_SIZE` was measured in bytes on the headerless path and UTF-16 code units on the declared path, so multibyte content was refused at a size the declared door accepts. Both paths now measure the decoded string.
  - `[low]` `[patch]` The `fetchPdfBytes` docblock claimed the `.pdf` leaf never stands in for evidence while the `application/octet-stream && looksPdf` branch below still trusts it. Claim scoped to the headerless case; that branch named and left unchanged.
  - `[low]` `[patch]` The `inlineBudgetMs` docblock asserted the intake door is the only one under a client deadline. Corrected, naming the Activity retry and embed-rebuild paths that still carry the shape.
  - `[low]` `[patch]` `INTAKE_ANSWER_BUDGET_MS` called itself the deadline for the whole request, but is consulted at exactly one point. Both its docblock and `workbench-request.ts` now say it is the budget the inline compile's remainder is taken from, naming the undeadlined steps that spend it.

## Design Notes

The sniff window is the first 512 bytes — enough for `%PDF-` at offset 0 and for any leading markup, and the same window browsers use for the equivalent job.

`mimeType` must be a reassignable local in `fetchUrlContent`, not a second variable: the PDF branch, the `text/plain`/`text/markdown` branch and the image-salvage guard all re-read it, and a sniffed type has to steer all three exactly as a declared one does.

Reading the headerless body through `readPdfBuffer` caps it at `MAX_PDF_SIZE` before the type is known, then the ordinary `MAX_RESPONSE_SIZE` check applies once the sniff says it is not a PDF. That order is deliberate: capping at `MAX_RESPONSE_SIZE` first would refuse a headerless PDF that a header-declared one is allowed to be.

Budget ladder arithmetic: 15 s for the whole URL fetch, 17 s for the whole intake request, 20 s before the client gives up. Every rung leaves the next one room to answer, and the inline race consumes only what the earlier rungs left over — which is the point DW-700 makes about a *fixed* margin.

`{ queued: true, jobId }` is the honest body for an abandoned budget: the Source is stored, a job record exists, work is in flight, and `workbench-intake-client.ts` already turns that shape into "Ingest is queued." with a `jobId` to poll. Returning while a promise runs is safe here precisely because this branch only exists off-Workers.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/fetch.test.ts src/lib/__tests__/ingest-async.test.ts src/lib/__tests__/workbench-request.test.ts` -- expected: all pass, including the new headerless, budget and ladder cases
- `pnpm exec tsc --noEmit` -- expected: no new type errors
- `pnpm exec eslint src/lib/fetch.ts src/lib/constants.ts src/lib/ingest-async.ts src/lib/workbench-request.ts src/app/api/workbench/intake/route.ts` -- expected: clean
- `pnpm test` -- expected: the whole suite stays green (no existing content-type, intake or ingest assertion regresses)

## Auto Run Result

Status: done

### Implemented change

Closed both open axes of the shared server fetch path. **DW-441:** a response that omits `Content-Type` no longer skips the allowlist — the leading 512 bytes are sniffed and the ANSWER is put through the caller's own `allowedContentTypes`, at both `fetchUrlContent` and `fetchPdfBytes`. A declared type is never second-guessed; an unrecognisable body is refused with a `ClientInputError` so the routes above keep answering 400. **DW-700:** the URL fetch's `FETCH_TIMEOUT_MS` is now armed ONCE for the whole redirect chain (15 s total, not up to 90 s), and the Workbench intake route captures an answer deadline at entry and hands `enqueueOrInline` the REMAINDER as an opt-in `inlineBudgetMs` — when it elapses the route answers `{ queued: true, jobId, path }`, the shape the client already polls, instead of letting the client's deadline fire on a Source that landed.

### Files changed

- `src/lib/fetch.ts` — `sniffContentType` (exported), the headerless branch at both doors, `readCappedBytes` / `readSniffBuffer` / `decodeCappedText` / `readTextBody`, and one chain-wide abort signal in `fetchFollowingRedirects`.
- `src/lib/constants.ts` — new `INTAKE_ANSWER_BUDGET_MS = 17_000`; `FETCH_TIMEOUT_MS` docblock rewritten to state the budget is total, not per hop.
- `src/lib/ingest-async.ts` — `EnqueueOrInlineOptions.inlineBudgetMs`, the inline half extracted into `runInline`, and the budget race that abandons without cancelling.
- `src/app/api/workbench/intake/route.ts` — `answerBy` captured at `POST` entry, threaded through `intakeFile`/`intakeUrl` into `storeAndQueue`, spent as a remainder at the `enqueueOrInline` call.
- `src/lib/workbench-request.ts` — `REQUEST_TIMEOUT_MS` docblock rewritten: the two DW-700 paths, and what the three-rung ladder does and does not bound.
- `src/lib/__tests__/fetch.test.ts` — bytes-backed fixture, the `sniffContentType` block, every headerless matrix row at both doors, the size-cap cases, and the one-signal redirect pin.
- `src/lib/__tests__/ingest-async.test.ts` — the two budget rows plus the abandoned-rejection case.
- `src/lib/__tests__/workbench-intake.test.ts` — the executable remainder pin on the route's `inlineBudgetMs`.
- `src/lib/__tests__/workbench-request.test.ts` — the ladder assertion and the route wiring scan.
- `src/lib/__tests__/ingest.test.ts`, `src/lib/__tests__/ingest-youtube.test.ts` — headerless fixtures gained real bytes so they exercise the sniff; two cases that test the declared-type size guards now declare a type.

### Review findings

7 patches applied (0 high, 3 medium, 4 low), 1 item deferred (low), 7 rejected. Full detail in the Review Triage Log above.

### Follow-up review recommendation

`false`. Patched findings by severity: high 0, medium 3, low 4. The score is driven only by patched HIGH findings, of which there were none.

### Verification performed

- `pnpm exec tsc --noEmit` — clean.
- `pnpm exec eslint` over all 11 touched files — clean.
- `pnpm exec vitest run` on `fetch.test.ts`, `ingest-async.test.ts`, `workbench-request.test.ts`, `workbench-intake.test.ts` — 216 passed, 0 failed.
- `pnpm test` — 372 files, 9326 passed, 1 skipped, 0 failed.
- Matrix audit: every row of the I/O & Edge-Case Matrix has a named covering test that ran and passed.
- Mutation checks: a per-hop signal fails the one-signal pin; `INTAKE_ANSWER_BUDGET_MS = 15_000` fails the ladder; moving the `answerBy` capture into `storeAndQueue` fails the remainder pin.

### Residual risks

- The Workbench Activity retry and embed-rebuild doors still run an unbounded inline `ingest()` under the same client deadline — deferred above, and named in the `inlineBudgetMs` docblock rather than denied by it.
- `fetchPdfBytes` still accepts `application/octet-stream` at a `.pdf` URL on the strength of the leaf alone. Unchanged and pre-existing: DW-441 is about an ABSENT header, not a declared one. Named in that function's docblock.
- `INTAKE_ANSWER_BUDGET_MS` is consulted at exactly one point. The steps before it (`request.formData()`, the raw-source write, `fetchUrlContent`, `createIngestJob`, `stageText`) carry no deadline of their own, so work that alone exceeds the budget still clamps the remainder to zero. That is the bundle's scope — the intent names two paths, and both are closed — and the docblocks now say so rather than claiming a whole-request deadline.
