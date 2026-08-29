---
title: 'URL fetch: sniff the headerless content type, and order the fetch budgets'
type: 'bugfix'
created: '2026-08-29'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
baseline_revision: '8d6693466c7cf12dc5fa7c36d3f692a437fb56b2'
---

<intent-contract>

## Intent

**Problem:** Two defects on the shared server fetch path. (1) DW-441: `fetchUrlContent` and `fetchPdfBytes` both guard with `if (mimeType && …)`, so a response that omits `Content-Type` skips the allowlist entirely and whatever arrived is ingested unchecked. (2) DW-439: the Workbench client's `send`/`sendForm` deadline (`REQUEST_TIMEOUT_MS`, 15s) wraps a server URL fetch budgeted at the same 15s — and applied PER REDIRECT HOP, so the server can outlast the client. A slow but successful HTML fetch trips the client deadline and is reported to the owner as an unconfirmed write while the route completes and stores the source anyway.

**Approach:** (1) When `Content-Type` is absent, sniff the body's leading bytes against the caller's allowlist and refuse only what does not match — applied at both doors in `src/lib/fetch.ts`, pinned with byte fixtures. (2) Give the server's URL fetch ONE total budget across the whole redirect chain, strictly smaller than the client's send deadline, and pin the strict inequality with a test so the two can never be equal again.

## Boundaries & Constraints

**Always:**
- A sniffed type is subject to the SAME `allowedContentTypes` the caller passed. Sniffing decides what the bytes are; the caller's door still decides what it takes.
- Refusals from the sniff path throw `ClientInputError` with the existing `Unsupported content type` wording family, so the routes above keep answering 400 rather than 500.
- A declared `Content-Type` still wins outright — sniffing runs ONLY when the header is absent or blank. No declared type is ever second-guessed.
- The server URL-fetch budget is a TOTAL across the redirect chain (one signal created once, reused for every hop), not a per-hop timeout.
- The strict ordering `URL_FETCH_BUDGET_MS < REQUEST_TIMEOUT_MS` is enforced by an executable assertion, not by a comment.

**Block If:** Nothing here needs a human decision.

**Never:**
- Do not widen the sniff into a guess: bytes that match nothing on the allowlist are refused, not defaulted to `text/html`.
- Do not touch `MAX_RESPONSE_SIZE`, `MAX_PDF_SIZE`, `MAX_CONTENT_LENGTH`, or the `ALLOWED_CONTENT_TYPES` / `INTAKE_ALLOWED_CONTENT_TYPES` lists themselves.
- Do not change `REQUEST_TIMEOUT_MS` (15s) — widening the client deadline makes every other Workbench write hang longer to fix a URL-fetch defect.
- Do not change the image-download budget (`FETCH_TIMEOUT_MS` in `downloadImages` / `fetchImageBytes`): those run inside ingest, not inside the client's send deadline.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Declared type, allowed | `content-type: text/html` | Unchanged: Readability path | No error expected |
| Declared type, refused | `content-type: image/png` | Unchanged refusal | `ClientInputError` `Unsupported content type: image/png…` |
| Headerless HTML | No `Content-Type`; body starts `<!DOCTYPE html>` | Sniffed `text/html`; Readability path runs; title/content returned | No error expected |
| Headerless plain text | No `Content-Type`; body is printable text with no markup | Sniffed `text/plain`; body returned verbatim | No error expected |
| Headerless PDF, default list | No `Content-Type`; body starts `%PDF-` | Sniffed `application/pdf`; `unpdf` extraction runs | No error expected |
| Headerless PDF, Intake list | No `Content-Type`; `%PDF-` body; `INTAKE_ALLOWED_CONTENT_TYPES` | Refused — that door takes no PDF; extractor never reached | `ClientInputError` naming `application/pdf` |
| Headerless binary | No `Content-Type`; PNG magic / NUL bytes | Refused before any parse | `ClientInputError` `Unsupported content type` |
| Headerless empty body | No `Content-Type`; zero bytes | Refused | `ClientInputError` `Unsupported content type` |
| PDF door, headerless non-PDF | `fetchPdfBytes` on a body without `%PDF-` and no header | Refused | `ClientInputError` `…Only PDF is accepted at this door.` |
| PDF door, headerless PDF | `fetchPdfBytes`, no header, `%PDF-` body | Bytes returned | No error expected |
| Slow redirect chain | 3 hops, each near the budget | Whole chain aborts at `URL_FETCH_BUDGET_MS`, so the route answers before the client deadline | Server refuses with a fetch error → route answers 400 |

</intent-contract>

## Code Map

- `src/lib/fetch.ts` -- both defective doors. `responseMimeType` (l.216) returns `null` for a missing header; `fetchPdfBytes` guard at l.257 (`mimeType && mimeType !== "application/pdf" && !(octet-stream && looksPdf)`) and `fetchUrlContent` guard at l.290 (`mimeType && !allowedContentTypes.includes(mimeType)`) both skip on `null`. `fetchFollowingRedirects` (l.163) arms `AbortSignal.timeout(FETCH_TIMEOUT_MS)` INSIDE the hop loop (l.181) — a fresh 15s per hop, up to 6 hops. `readPdfBuffer` (l.221) already caps at `MAX_PDF_SIZE` and is the reuse point for the headerless buffered read. Body streaming for the text path is l.324-351; the `mimeType` value is read again at l.301, l.357 and l.393, so a sniffed value must be assigned into the same variable for the downstream branches to follow it.
- `src/lib/constants.ts` -- `FETCH_TIMEOUT_MS = 15_000` (l.28). Keep it for image downloads; add `URL_FETCH_BUDGET_MS` beside it as the total URL-fetch budget.
- `src/lib/workbench-request.ts` -- `REQUEST_TIMEOUT_MS = 15_000` (l.33), the client send deadline used by `send` (l.64) and `sendForm` (l.96). Client-safe module (no `node:` imports), so a node-project test may import it alongside `constants.ts`.
- `src/lib/workbench-intake-client.ts` -- `submitIntakeUrl` (l.204) calls `send(INTAKE_ROUTE, …)`; `writeFailure` turns the fired deadline into `unconfirmed: true`. This is the exact path DW-439 mis-reports.
- `src/app/api/workbench/intake/route.ts` -- l.365 calls `fetchUrlContent(url, { allowedContentTypes: INTAKE_ALLOWED_CONTENT_TYPES })` and maps any throw to 400 (l.371-374). No change needed; it inherits both fixes.
- `src/lib/workbench-intake.ts` -- `INTAKE_ALLOWED_CONTENT_TYPES` (l.288): `text/html`, `application/xhtml+xml`, `text/plain`, `text/markdown`. READ-ONLY here — it is what makes a sniffed `application/pdf` refuse at that door.
- `src/lib/__tests__/fetch.test.ts` -- existing suite (node project). `mockResponse` (l.27) sets `body: null` to force the `response.text()` fallback and stubs `arrayBuffer` to an empty buffer, so headerless fixtures need a bytes-backed mock beside it. `vi.mock("unpdf")` at l.17 is how "the extractor was never reached" is asserted.
- `src/lib/__tests__/workbench-request.test.ts` -- l.195 already asserts a floor on `REQUEST_TIMEOUT_MS`; the budget-ordering assertion belongs beside it.

## Tasks & Acceptance

**Execution:**
- `src/lib/constants.ts` -- add `URL_FETCH_BUDGET_MS = 10_000`, documented as the TOTAL budget for one server-side URL fetch including its redirect chain, and as deliberately strictly under the Workbench client's `REQUEST_TIMEOUT_MS` so the route's verdict always beats the client deadline -- so a slow fetch produces a real refusal instead of an unknown outcome.
- `src/lib/fetch.ts` -- export `sniffContentType(prefix: Uint8Array): string | null`: `%PDF-` magic → `application/pdf`; any NUL or non-whitespace C0 control byte in the sniffed window → `null` (binary); otherwise decode the window as UTF-8 and return `application/xml` for a leading `<?xml`, `text/html` when it opens with (or contains within the window) a recognisable HTML tag, and `text/plain` for anything else printable; empty input → `null` -- conservative by construction so a `null` refuses rather than guesses.
- `src/lib/fetch.ts` -- in `fetchUrlContent`, when `responseMimeType` is `null`, buffer the body once (reusing `readPdfBuffer`'s cap so a headerless PDF is not penalised), sniff it, assign the result to `mimeType`, and refuse when the sniff yields `null` or a type outside `allowedContentTypes`; reuse that same buffer for the PDF branch and for the text body so the body is never read twice -- closes DW-441 at the text door without changing the declared-type path.
- `src/lib/fetch.ts` -- in `fetchPdfBytes`, when `responseMimeType` is `null`, read the buffer first and require the `%PDF-` sniff before returning; refuse otherwise with the existing door sentence -- closes DW-441 at the PDF door. A `.pdf`-looking URL alone must NOT satisfy it.
- `src/lib/fetch.ts` -- in `fetchFollowingRedirects`, create ONE `AbortSignal.timeout(URL_FETCH_BUDGET_MS)` before the hop loop and pass that same signal to every hop, so the budget covers the whole chain and the body read that follows -- closes DW-439's server half.
- `src/lib/__tests__/fetch.test.ts` -- add a bytes-backed response fixture and cover every headerless row of the I/O matrix at both doors, plus a direct `sniffContentType` unit block; assert the `unpdf` mocks are never called on the Intake-list PDF refusal, and that one signal instance is shared across redirect hops -- the fixtures the decision asks for.
- `src/lib/__tests__/workbench-request.test.ts` -- assert `URL_FETCH_BUDGET_MS < REQUEST_TIMEOUT_MS` strictly, with a comment naming the unconfirmed-write defect it prevents -- the ordering pin that stops the two going equal again.

**Acceptance Criteria:**
- Given a response whose `Content-Type` header is present, when either door validates it, then behaviour is byte-for-byte what it was before this change (no sniff runs).
- Given a headerless response, when the sniffed type is outside the caller's `allowedContentTypes`, then a `ClientInputError` is thrown before any parsing or extraction occurs and no Source is stored.
- Given a redirect chain, when the total elapsed fetch time reaches `URL_FETCH_BUDGET_MS`, then the fetch aborts as a whole rather than restarting the clock on the next hop.
- Given the constants as shipped, when the ordering test runs, then `URL_FETCH_BUDGET_MS` is strictly less than `REQUEST_TIMEOUT_MS`, and making them equal fails the suite.

## Design Notes

The sniff window is the first 512 bytes — enough for the `%PDF-` magic at offset 0 and for any leading markup, and the same window browsers use for the equivalent job.

`mimeType` must be a reassignable local in `fetchUrlContent`, not a second variable: the PDF branch, the `text/plain`/`text/markdown` branch, and the image-salvage guard all re-read it, and a sniffed type has to steer all three exactly as a declared one does.

Reading the headerless body through `readPdfBuffer` means the headerless path is capped at `MAX_PDF_SIZE` before the type is known, then falls back under the ordinary `MAX_RESPONSE_SIZE` check once the sniff says it is not a PDF. That ordering is deliberate: capping at `MAX_RESPONSE_SIZE` first would refuse a headerless PDF that a header-declared one is allowed to be.

Budget arithmetic: 10s of server fetch leaves 5s inside the client's 15s deadline for hashing, the raw-source write and the enqueue — so the route's own answer, success or refusal, reaches the client before `send` gives up. `FETCH_TIMEOUT_MS` stays 15s for `downloadImages` and `fetchImageBytes`, which run inside queued ingest where no client deadline is waiting.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/fetch.test.ts src/lib/__tests__/workbench-request.test.ts` -- expected: all pass, including the new headerless and budget-ordering cases
- `pnpm exec tsc --noEmit` -- expected: no new type errors
- `pnpm exec eslint src/lib/fetch.ts src/lib/constants.ts src/lib/workbench-request.ts` -- expected: clean
- `pnpm test` -- expected: the whole suite stays green (no existing content-type or intake assertion regresses)
