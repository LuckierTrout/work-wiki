---
title: 'DW-692 multipart transport newline-budget runtime proof'
type: 'chore'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'd3665ad0b1efa326598334efc7e00b4b5e0e1a57'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** DW-692 treats Node/undici's conversion of lone LF and CR characters to CRLF during `FormData` serialization as a possible production data-loss defect: an under-cap Worker body could arrive above the route's 100,000-character gate and cost the sender the body and attachments. An exact workerd probe at the email Worker's `2026-08-01` compatibility date disproved that premise—workerd preserves all three newline forms—but the repository has no durable runtime test and its Worker test still describes the Node observation as an unresolved production risk.

**Approach:** Add a narrow Vitest-node test that launches real workerd through a directly pinned Miniflare dependency, proves the configured runtime preserves the relevant multipart values, and makes the Node/workerd distinction executable. Correct the stale test commentary; leave production behavior unchanged.

## Boundaries & Constraints

**Always:** Run serialization, raw-payload inspection, and `Request.formData()` inside workerd, not Node. Use the compatibility date declared by `workers/email-ingest/wrangler.jsonc`; fail rather than silently substituting an older date. Dispose Miniflare in `finally`. Keep a Node negative control so the fixtures prove the runtimes differ.

**Ask First:** Any production Worker/route change, route-cap change, Vitest major upgrade, or replacement of the existing Node/jsdom project layout.

**Never:** Do not normalize or truncate multipart content at the route, lower either 100,000-character cap, change email acknowledgement behavior, edit `.github/`, or touch `deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Newline forms | `a\nb`, `a\rb`, `a\r\nb`, and the two-LF truncation marker | Workerd raw multipart payload and parsed field equal each input exactly; Node negative control differs for lone LF/CR | Any mismatch fails |
| Truncated boundary | 100,000-character value ending `\n\n[Email body truncated]` | Workerd returns the same value and length 100,000 | Any inflation fails |
| Under-cap multiline | 98,599 characters containing 3,398 lone LFs | Workerd returns 98,599 unchanged; Node crosses 100,000 | Any inflation fails |
| Runtime drift | Configured compatibility date unsupported by installed workerd | Suite fails at startup; it never skips or falls back | Dispose runtime, surface error |

</frozen-after-approval>

## Code Map

- `workers/email-ingest/wrangler.jsonc:5-7` -- production compatibility date and flags the runtime proof must honor; read-only.
- `workers/email-ingest/index.ts:1263-1266,1328-1367` -- body cap, multipart append, and service-binding request; production code remains byte-identical.
- `src/app/api/email/ingest/route.ts:125-146,292-297` -- multipart read and shared route cap; production code remains byte-identical.
- `src/lib/__tests__/email-ingest-worker.test.ts:69-101,3135-3320` -- stale unresolved-risk commentary and pre-serialization truncation proofs to reconcile with the new runtime evidence.
- `vitest.config.ts:72-119` -- `.test.ts` files run in the Node project; Miniflare starts workerd from inside that existing project.
- `package.json:54-74`, `pnpm-lock.yaml` -- add exact `miniflare@5.20260828.0-alpha` (workerd `1.20260828.1`) without adopting the Vitest-4-only Cloudflare plugin.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `pnpm-lock.yaml` -- pin `miniflare@5.20260828.0-alpha` directly so a fresh root install contains the compatibility-date-capable workerd `1.20260828.1` runtime investigated here.
- [x] `src/lib/__tests__/email-ingest-workerd.test.ts` -- launch inline producer and receiver module Workers, cross a real workerd service binding for every matrix row, parse returned diagnostics in Node, prove the fixtures inflate under Node, and always dispose the runtime.
- [x] `src/lib/__tests__/email-ingest-worker.test.ts` -- replace the two stale “unmeasured production risk” explanations with the bounded truth: Node inflates; the configured workerd runtime does not; the dedicated suite guards that distinction.

**Acceptance Criteria:**
- Given a fresh root install, when `pnpm test` runs, then the pinned local workerd binary launched with the email Worker's declared compatibility date and flags—not Node globals—proves multipart content stays within the existing route cap across the inline service-binding seam for both recorded boundary shapes.
- Given the completed change, when the production Worker and route are compared with baseline, then both are byte-identical.

## Spec Change Log

## Design Notes

The current Cloudflare Vitest plugin requires Vitest 4.1, while this repository is on Vitest 3.2. A direct Miniflare test preserves the existing runner architecture and crosses a real service binding between two Workers inside its pinned local workerd binary. This is local compatibility evidence, not an assertion about Cloudflare's currently deployed binary. The dependency is direct because pnpm does not expose Wrangler's transitive Miniflare as an import contract; exact pinning keeps the evidence reproducible.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/email-ingest-workerd.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- expected: runtime seam, existing arithmetic, route cap, and duplicated constants all pass.
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm lint` -- expected: no new errors.
- `pnpm test` -- expected: full suite passes.
- `git diff --exit-code d3665ad0b1efa326598334efc7e00b4b5e0e1a57 -- workers/email-ingest/index.ts src/app/api/email/ingest/route.ts` -- expected: both production files are byte-identical to baseline.
- `git diff --check` -- expected: clean; production Worker, route, and ledger absent from the diff.

**Observed:**
- Focused runtime and contract gate passed: 4 files, 124 tests.
- TypeScript passed with no errors; lint passed with three pre-existing informational messages.
- The first full run hit the unrelated five-second `storage-fs.test.ts` timeout. That suite then passed 95/95 in isolation, and the unchanged full rerun passed 360 files, 8,784 tests, with 1 skipped.
- Independent final focused rerun passed 4 files and 124 tests; TypeScript, production byte-identity, and diff checks also passed.
- Production Worker and route remained byte-identical to baseline; `.github/` and `deferred-work.md` remained untouched.

## Suggested Review Order

**Runtime transport proof**

- Start with the executable producer-to-receiver service-binding contract.
  [`email-ingest-workerd.test.ts:175`](../../src/lib/__tests__/email-ingest-workerd.test.ts#L175)

- Inspect receiver-side raw parsing and the unchanged 100,000-character gate.
  [`email-ingest-workerd.test.ts:74`](../../src/lib/__tests__/email-ingest-workerd.test.ts#L74)

- Compare exact workerd preservation against Node's deliberate CRLF normalization control.
  [`email-ingest-workerd.test.ts:298`](../../src/lib/__tests__/email-ingest-workerd.test.ts#L298)

**Evidence boundaries**

- Confirm commentary distinguishes pinned local workerd evidence from deployed Cloudflare behavior.
  [`email-ingest-worker.test.ts:3204`](../../src/lib/__tests__/email-ingest-worker.test.ts#L3204)

**Test tooling**

- Verify Miniflare is exact-pinned without changing the repository's Vitest architecture.
  [`package.json:69`](../../package.json#L69)
