---
title: 'Order the workbench client deadline above the server fetch budget (DW-439; DW-438 already resolved)'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
baseline_revision: '5634a670b194741dff71c7df3386eac11ddaf28d'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A fixed client margin cannot bound the server's TOTAL work, so DW-439's
      unconfirmed-write report is still reachable on two intake paths this
      story's ordering does not reach.
    evidence: |-
      The ordering shipped here guarantees only that the server's FETCH deadline
      fires before the client's. Two paths outlast any fixed margin:

      1. `fetchFollowingRedirects` (src/lib/fetch.ts:163-201) arms
         `AbortSignal.timeout(FETCH_TIMEOUT_MS)` INSIDE the
         `for (let hop = 0; hop <= MAX_REDIRECTS; hop++)` loop at :175, with
         `MAX_REDIRECTS = 5` (:169) -- five redirects, so up to six fetches with
         a full 15 s each, up to 90 s server-side.
      2. `src/app/api/workbench/intake/route.ts:640` ends in
         `enqueueOrInline(jobId, task, () => ingest(title, text, options))`.
         Where `enqueueTask` returns false (src/lib/ingest-async.ts:52-58, the
         off-Workers deployment), the FULL `ingest()` -- LLM map/reduce, retries,
         embeddings, image downloads -- runs inside the request the client
         deadline wraps, and `storeAndQueue` has already stored the Source
         before that call.

      In both, the client aborts first, `unconfirmedCause`
      (src/lib/workbench-request.ts) classifies the `TimeoutError` as
      unconfirmed, and the owner is told "the outcome is unknown" about a Source
      that landed -- DW-439's exact harm. Pre-existing and not caused by this
      change: the ordering fixes the single-hop, queued case, which is the shape
      DW-439's own `reason` describes ("a slow but ultimately successful HTML
      fetch"). Both are now named in the shipped docblocks so the comments do
      not overstate. Out of scope here because closing them means giving the
      server a TOTAL budget rather than a per-hop one (which changes the timeout
      semantics of every `fetchUrlContent` caller -- ingest, source monitors,
      research providers) and deciding what the inline path should do about a
      client that has already gone away -- neither is a two-constant edit.
      Note: `_bmad-output/implementation-artifacts/spec-dw-441-439-url-fetch-guard-and-budgets.md`
      (created 2026-08-29, still `status: in-review`) prescribed exactly that
      total-budget approach and an explicit "Do not change `REQUEST_TIMEOUT_MS`".
      DW-439's ledger `decision:` is dated 2026-08-31 and reverses it, so the
      approach shipped here is the later authority -- but that spec still
      carries the superseded constraints.
    location: src/lib/fetch.ts:175 / src/app/api/workbench/intake/route.ts:640
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `REQUEST_TIMEOUT_MS` (`src/lib/workbench-request.ts:33`) and `FETCH_TIMEOUT_MS` (`src/lib/constants.ts:28`) are both `15_000`, and the client deadline WRAPS the server fetch it triggers: `submitIntakeUrl` → `send` → `POST /api/workbench/intake` → `fetchUrlContent`. With equal budgets a slow-but-valid HTML fetch trips the client's `AbortSignal.timeout` first, so `writeFailure` classifies the `TimeoutError` as unconfirmed and tells the owner "the outcome is unknown" — while the route runs to completion and stores the Source anyway. The route's own timeout path is a definite **400** carrying `getErrorMessage(error)` (`route.ts:369-372`), i.e. a real refusal the owner can act on, which the client never gets to see.

**Approach:** Raise `REQUEST_TIMEOUT_MS` to `20_000` so the server's 15 s fetch deadline always fires first and its 400 reaches the client as a refusal. Name the required ordering in a comment at BOTH constants, and pin `REQUEST_TIMEOUT_MS > FETCH_TIMEOUT_MS` in an executed test so the two cannot silently converge again.

## Boundaries & Constraints

**Always:** The ordering is stated at both constants, each naming the other by name and file, so a future edit to either one meets the rule where it lives. The pin is an EXECUTED comparison of the two imported values — not a source scan and not a restatement of either literal — so it fails when either constant moves into violation. `src/lib/workbench-request.ts` stays client-safe: no `node:` imports (`src/lib/__tests__/workbench-left-column.test.ts:284` asserts this) and no new runtime import into the client bundle — the comparison belongs to the test, not to the shipped helper.

**Block If:** Nothing here needs a human. (`Never` below bounds the one judgement call.)

**Never:** Do NOT edit `_bmad-output/implementation-artifacts/deferred-work.md`; the orchestrator records resolution. Do NOT touch DW-438 — it is `status: done 2026-08-29`, archived, resolved by sweep bundle `dw-raw-source-listing-and-store-safety`; no code change is owed for it. Do NOT implement this bundle's Intent PROSE (email-Worker KV guard, attachment-filename union) — see Design Notes; those are different defects under different ids and closing them under DW-438/439 is the DW-433 harm. Do NOT change `FETCH_TIMEOUT_MS`'s value: lowering the server budget to create the gap shortens every URL fetch in the app. Do NOT touch the two private `REQUEST_TIMEOUT_MS = 15_000` copies in `SettingsCanvas.tsx:142` and `PreviewColumn.tsx:219` — neither reaches a URL fetch (`/api/settings`, preview/revert), so neither is in DW-439's harm, and merging them is a separate consolidation. Do NOT rework `unconfirmedCause` / `UNCONFIRMED_STATUSES`; the classifier is correct and the budgets are what is wrong.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ordering holds | `REQUEST_TIMEOUT_MS` and `FETCH_TIMEOUT_MS` as shipped | `REQUEST_TIMEOUT_MS > FETCH_TIMEOUT_MS`, strictly | Test fails if equal or inverted |
| Deadline still a rescue | `REQUEST_TIMEOUT_MS` as shipped | `>= 5_000` — existing assertion survives | Test fails below the floor |
| Slow server fetch | Route answers 400 after its own fetch deadline fires | `send` rejects `RequestFailedError` status 400; `writeFailure` reports `unconfirmed: false` and the route's sentence | Refusal, not silence |
| Deadline armed | Any `send` / `sendForm` call | `init.signal` is an unaborted `AbortSignal` | Unchanged by this story |

</intent-contract>

## Code Map

- `src/lib/workbench-request.ts:33` -- `REQUEST_TIMEOUT_MS = 15_000`, the value to raise. Its docblock (:28-32) explains the deadline as a rescue for a never-settling request; the ordering note is a SECOND fact and goes beside it. Armed at :63 (`send`) and :95 (`sendForm`) via `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` — both spellings are asserted verbatim by source scans, so leave the call sites alone.
- `src/lib/constants.ts:27-28` -- `/** URL fetch timeout in milliseconds (15 seconds). */ export const FETCH_TIMEOUT_MS = 15_000;` — the server side of the pair. Pure constants module, no imports, safe to import from a node-project test.
- `src/lib/fetch.ts:181` -- `AbortSignal.timeout(FETCH_TIMEOUT_MS)` inside `fetchFollowingRedirects`, PER HOP of a `MAX_REDIRECTS = 5` loop (:169-183). Read-only evidence: the server budget is 15 s per hop, not per request. See Design Notes.
- `src/app/api/workbench/intake/route.ts:359-372` -- `fetchUrlContent` in a try/catch answering **400** with `getErrorMessage(error)`. This is the refusal the ordering makes reachable; nothing to change here.
- `src/lib/workbench-intake-client.ts:33,190,224-227` -- `submitIntakeUrl` calls `send(INTAKE_ROUTE, …)` and routes the catch through `writeFailure`; `submitIntakeFile` calls `sendForm`. The one client path where the two budgets meet.
- `src/lib/workbench-request.ts:157-160` -- `unconfirmedCause` returns true for `TimeoutError`, which is exactly how a client-side abort becomes "the outcome is unknown". Read-only: the classifier is right.
- `src/lib/__tests__/workbench-request.test.ts:20,192-196` -- already imports `REQUEST_TIMEOUT_MS` and holds `it("has a deadline long enough to be a rescue…")` asserting `>= 5_000`. The ordering pin belongs in this `describe("send")` block next to it. Stubbed-`fetch` style, node project (`.test.ts`).
- `src/lib/__tests__/workbench-left-column.test.ts:283-296` -- source scan requiring `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` in the helper, `not.toMatch(/from "node:/)`, and no `const REQUEST_TIMEOUT_MS` in the two consumers. Read-only constraint on how the edit may be shaped.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-request.ts` -- raise `REQUEST_TIMEOUT_MS` to `20_000` and extend its docblock with the ordering rule: it must stay strictly above `FETCH_TIMEOUT_MS` (`src/lib/constants.ts`) by a margin covering request and response overhead, because this deadline wraps a server fetch that carries its own, and equal budgets make a completed write look unconfirmed -- so the server's refusal, not the client's abort, is what the owner sees.
- `src/lib/constants.ts` -- extend the `FETCH_TIMEOUT_MS` doc comment with the same rule from the server side, naming `REQUEST_TIMEOUT_MS` in `src/lib/workbench-request.ts` and warning that raising this value without raising that one re-opens DW-439.
- `src/lib/__tests__/workbench-request.test.ts` -- import `FETCH_TIMEOUT_MS` from `../constants` and add a case to `describe("send")` asserting `REQUEST_TIMEOUT_MS` is strictly greater, with a comment stating the harm the ordering prevents. Keep the existing `>= 5_000` case.

**Acceptance Criteria:**
- Given the shipped constants, when the pin executes, then `REQUEST_TIMEOUT_MS > FETCH_TIMEOUT_MS` holds strictly and the suite is green.
- Given either constant is edited so the two are equal or inverted, when `pnpm exec vitest run --project node src/lib/__tests__/workbench-request.test.ts` runs, then it fails and names the ordering.
- Given a reader opens either constant, when they read its comment, then the ordering rule and the other constant's name and file are stated there, without following a link.
- Given the full suite, when `pnpm test` runs, then no previously passing test regresses -- in particular the three `workbench-request.ts` source scans and the `>= 5_000` deadline floor.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 4, low 3)
- defer: 1: (high 0, medium 1, low 0)
- reject: 8: (high 0, medium 1, low 7)
- addressed_findings:
  - `[medium]` `[patch]` Both docblocks claimed the 5 s margin "covers request travel, the route's post-fetch work and the response back". False on two paths (`enqueueOrInline`'s inline `ingest()`; the per-hop redirect chain). Rewrote the claim to what the ordering actually buys — the server's FETCH deadline fires first — and named both paths that outlast it.
  - `[medium]` `[patch]` Three constants now named `REQUEST_TIMEOUT_MS` hold two values, and the docblock's existing paragraph about `SettingsCanvas.tsx` / `PreviewColumn.tsx` gave no hint the 15 s siblings were deliberate. Added the exemption clause and its reason (their routes reach no `fetchUrlContent`).
  - `[medium]` `[patch]` The ordering pin passed at `15_001`, satisfying nothing the docblocks promise. Added an executed `REQUEST_TIMEOUT_MS - FETCH_TIMEOUT_MS >= 5_000` floor. Proven to bite: at `FETCH_TIMEOUT_MS = 19_999` it fails with `expected 1 to be greater than or equal to 5000`.
  - `[medium]` `[patch]` Nothing asserted that the fetch the client deadline wraps is armed with `FETCH_TIMEOUT_MS` at all — raising the literal at `src/lib/fetch.ts:181` reopened DW-439 with the whole suite green. Added a source scan in the repo's existing `workbench-left-column.test.ts` idiom. A whole-file scan was insufficient (the constant is armed at three call sites and still matched after sabotage), so the scan is scoped to the `fetchFollowingRedirects` slice; verified out-of-tree that the scoped form fails on that sabotage and the file-wide form does not.
  - `[low]` `[patch]` Docblock recorded no blast radius: the constant also arms `sendForm` and every workbench write, all of which now wait 5 s longer. Added.
  - `[low]` `[patch]` `constants.ts` cited `MAX_REDIRECTS` as though it were a shared symbol (it is function-local in `src/lib/fetch.ts`), read as contradicting `MAX_REDIRECTS = 5` by saying "six hops", omitted the 90 s bound, and never named where the pin lives. All four fixed.
  - `[low]` `[patch]` The new test restated the whole rationale a third time after both docblocks. Cut to the invariant plus a pointer, leaving one owner for the prose.

## Design Notes

**Why 20 s.** The gap has to leave the route's 400 room to travel back once the server's own fetch deadline has fired. 5 s over the server's 15 s is that floor. It is a floor with slack, not a measurement — which is why the test pins the ORDERING and the 5 s MARGIN rather than the value. Strict inequality alone was not enough: it passes at `15_001`, which buys nothing the docblocks promise.

**What the ordering does NOT cover — and what the comments must therefore not claim.** The ordering buys exactly one thing: the server's FETCH deadline fires first. It does not bound the route's total work. Two paths outlast any fixed margin — the per-hop redirect chain (up to six fetches, 90 s) and the inline `ingest()` where `enqueueTask` returns false. Both are named in the shipped docblocks and recorded in `deferred`. An earlier draft of these comments claimed the margin "covers the route's post-fetch work"; that was false on both paths and was corrected in review.

**Why the pin needed a second half.** Comparing the two constants guards nothing if the fetch the client wraps stops honouring `FETCH_TIMEOUT_MS`. A whole-file scan of `fetch.ts` does not close that: the constant is armed at three call sites, so sabotaging the redirect-loop one still matches elsewhere (verified). The scan is therefore scoped to the `fetchFollowingRedirects` slice.

**Bundle intent mismatch (for the orchestrator).** The bundle at `.bmad-loop/runs/20260820-220331-0f16/bundles/c3-email-worker-reply-path-hardening/intent.md` carries `dw_ids: DW-438, DW-439` and quotes those two entries verbatim, but its Intent prose describes unrelated email-Worker defects (an unguarded KV config read, and the `"unnamed attachment"` / `attachment-${index+1}` filename divergence feeding `localSkipped`). The prose's anchors do not match HEAD either: it cites `workers/email-ingest/index.ts:401` for the KV read, which at HEAD is inside `supportedPart`; the actual unguarded read is `index.ts:719`. This is the DW-433 shape exactly — "the bundle this story came from is keyed to DW-415, but its Intent prose describes DW-411" — and `spec-dw-433-hidden-attribute-css-specificity.md` is the precedent for resolving it in favour of the LEDGER entries, since those are what the orchestrator closes. So this story implements DW-439. Left undone and NOT closed by this run, with the two halves in different states:
- The **KV read** is real and open at HEAD. `env.YOPEDIA_CONFIG.get(CONFIG_KEY, "json")` is still the first statement of `email()` (`workers/email-ingest/index.ts:719`), outside any try/catch and ahead of every `reply()`/`setReject()` path, so a binding or KV failure throws and the sender gets silence. It appears in no ledger entry and needs its own bundle.
- The **attachment-filename union** must NOT be implemented as the prose asks. The divergence is now deliberate: `workers/email-ingest/index.ts:1095-1141` documents that collapsing the forwarded name onto the recorded one would make unnamed parts share a display name and collide `intakeSourceSlug(file.name)` (DW-454), and the phantom-skip harm the prose cites was separately closed by counting only `countableAttachments` (:1142). What remains of that area is DW-690's dedup-before-sanitize ordering, which is its own entry. Implementing the prose here would reverse a recorded decision.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-request.test.ts` -- expected: green, including the new ordering case.
- `pnpm exec tsc --noEmit` -- expected: no new errors from the added import.
- `pnpm test` -- expected: no regression against the pre-change baseline; record both counts.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented.** DW-439 only. `REQUEST_TIMEOUT_MS` (the shared workbench client deadline) raised `15_000` → `20_000` so it sits strictly above the `FETCH_TIMEOUT_MS = 15_000` server fetch it wraps on the URL-intake path (`submitIntakeUrl` → `send` → `POST /api/workbench/intake` → `fetchUrlContent`). A slow URL now comes back as the route's own 400 — a refusal the owner can act on — instead of a client abort that `writeFailure` could only report as "the outcome is unknown" over a Source that had already been stored. The required ordering is stated at both constants, each naming the other by symbol and file, and is executed in a test alongside a 5 s minimum-margin floor and a scan that the wrapped fetch still honours `FETCH_TIMEOUT_MS`.

**DW-438: no code owed.** It is `status: done 2026-08-29`, archived, resolved by sweep bundle `dw-raw-source-listing-and-store-safety`. Untouched.

**Bundle intent mismatch — read this before recording resolution.** The bundle's `dw_ids` and verbatim ledger entries (DW-438, DW-439) describe different defects from its Intent prose, which describes email-Worker reply-path work whose line anchors do not resolve at HEAD. This is the DW-433 shape; per the `spec-dw-433-hidden-attribute-css-specificity.md` precedent this run implemented the LEDGER entries, since those are what the orchestrator closes. Full analysis in Design Notes, including what of the prose is still genuinely open (the unguarded Worker KV read at `workers/email-ingest/index.ts:719`, in no ledger entry) and what must not be implemented as written (the attachment-filename union, deliberate since DW-454).

**Files changed:**
- `src/lib/workbench-request.ts` — `REQUEST_TIMEOUT_MS` 15_000 → 20_000; docblock gains the ordering rule, the two paths it does not bound, the blast radius, and the sibling-constant exemption.
- `src/lib/constants.ts` — `FETCH_TIMEOUT_MS` doc comment gains the same rule from the server side, the 90 s redirect bound, and a pointer to the pin. Value unchanged.
- `src/lib/__tests__/workbench-request.test.ts` — ordering + 5 s margin pin, and a scoped source scan asserting `fetchFollowingRedirects` still arms `FETCH_TIMEOUT_MS`.

**Review findings breakdown:** 7 patches applied (4 medium, 3 low), 1 deferred (medium), 8 rejected. Detail in the Review Triage Log.

**Follow-up review recommended: true.** Patched findings this pass: high 0, medium 4, low 3. Score = 3 × 4 + 1 × 3 = 15, which is ≥ 5.

**Verification performed:**
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-request.test.ts src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/fetch.test.ts` — 127 passed / 3 files, after patches.
- `pnpm exec tsc --noEmit` — no errors in any of the three changed files.
- `pnpm test` (pre-patch, at 00:53) — 357 files, 8575 passed, 1 skipped, 1 failed. The one failure is `src/lib/__tests__/portable-archive.test.ts` "holds the merge fence while a skip import acquires its collision snapshot", a 15 s timeout. It is **not** this change: that suite imports `../portable-archive`, `../storage` and `../lifecycle` and reaches nothing changed here, and a concurrent session is mid-implementation on exactly those files in this same working tree (see residual risks). The same full suite ran 8576 passed / 0 failed at 00:48, with all three of this story's files already changed and before that session's edits landed.
- Both new guards proven to bite. The margin floor fails at `FETCH_TIMEOUT_MS = 19_999` (`expected 1 to be greater than or equal to 5000`). The wiring scan was verified out-of-tree against an in-memory sabotage of `src/lib/fetch.ts:181`: the scoped `fetchFollowingRedirects` slice loses the match (guard bites) while a whole-file search still matches at the other two call sites (which is why the scan is scoped). `src/lib/fetch.ts` was never modified on disk.
- Matrix audit: all four I/O rows are covered by tests that ran and passed — the two new cases for the ordering rows, the existing non-2xx loop (which includes 400 → `writeFailure` `unconfirmed: false` with the route's sentence) for the slow-fetch row, and the existing content-type/deadline cases for the armed-deadline row.

**Residual risks:**
1. *Concurrent session in the same working copy.* Throughout this run another bmad session was implementing `spec-dw-293-679-bulk-read-and-write-cost.md`, editing `src/lib/storage/{types,filesystem,r2}.ts`, `portable-archive.ts`, `backups.ts`, `embeddings.ts` and `raw.ts` (~620 lines). Those files were deliberately not touched, not staged and not committed by this run, and the reviewed diff was scoped to this story's three files. Any transient `tsc` error or suite failure in that set belongs to that session, not to this change.
2. *The ordering does not bound the server's total work.* Recorded in `deferred` (medium): the per-hop redirect chain (up to six fetches / 90 s) and the inline `ingest()` path where `enqueueTask` returns false both still outlast the client deadline and still read as unconfirmed. Both are now named in the shipped docblocks so the comments do not overstate.
3. *A superseded spec still claims DW-439.* `spec-dw-441-439-url-fetch-guard-and-budgets.md` (created 2026-08-29, still `status: in-review`) prescribes the opposite approach — one total server budget across the redirect chain, and an explicit "Do not change `REQUEST_TIMEOUT_MS`". DW-439's ledger `decision:` is dated 2026-08-31 and reverses it, so this run followed the later authority; that spec still carries the superseded constraints and its DW-441 half is unrelated and still open.
4. *Observed but not filed (deliberately, to respect the one-entry leftover budget).* `send`/`sendForm` do `await response.json().catch(() => ({}))` after `response.ok`. If the deadline fires between headers and the end of the body, the `AbortError` is swallowed into `{}`, `response.ok` is still true, `send` RESOLVES, and `outcomeFromBody` (`src/lib/workbench-intake-client.ts:81-95`) falls through to `stored(name)` — the owner is told the Source was stored when nothing is known. Pre-existing in the helper, not caused or made more reachable by this change (a longer deadline fires less often), and a different defect class from the budget ordering. Recorded here rather than as a ledger row.
