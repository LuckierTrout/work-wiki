---
title: 'Harden the sidecar SSE reader against a hostile or malformed stream'
type: 'bugfix'
created: '2026-09-04'
baseline_revision: '8ebaa58f97f8e1ddf40629025ad278831e59d56d'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      A `done` frame whose `data:` payload is truncated mid-write resolves the turn as a
      successful EMPTY answer instead of failing with the module's own incomplete-turn sentence.
    evidence: |-
      Pre-existing, and the sibling branch of the DW-583 guard rather than a consequence of it.
      `DATA_RE` (`chat-session-transport.ts:56`) requires a closing `}`, so a payload cut off
      mid-write does not match at all — `data` falls through to `{}` and the block is returned as
      a VALID `done` frame. The unparseable-but-complete shape this bundle fixed now returns
      `null`; the truncated shape three lines up still returns `{}`. It is reachable in production
      precisely because `consumeSidecarStream` deliberately flushes the trailing partial block at
      stream end (`:142-145`), which is exactly where a dropped loopback connection lands.
      VERIFIED during this run's review: `readSidecarSseBlock('event: done\ndata: {"content":"Roll')`
      returns `{"event":"done","data":{}}`, and `consumeSidecarStream` over
      `['event: agent\ndata: {"delta":"Roll"}\n\n', 'event: done\ndata: {"content":"Roll']`
      RESOLVES with `{}` rather than rejecting. Downstream, `ChatCanvas.driveTurn`
      (`ChatCanvas.tsx:527`) hands that `{}` to `settleTurn` (`chat-pending-turn.ts:130-168`),
      which substitutes `CHAT_COVERAGE_MISSING_COPY` and persists it over the turn just streamed
      — so the owner's real streamed answer is silently replaced with a "no coverage" sentence
      instead of the honest "Chat ended before a complete answer." The existing row at
      `chat-session-transport.test.ts:111` pins the payload-LESS `event: done` case as a
      deliberate empty success, so telling the two apart needs `readSidecarSseBlock` to notice a
      `data:` line it could not read, not merely a stricter `DATA_RE`.
    location: >-
      src/lib/chat-session-transport.ts:74-75 (with the trailing-block flush at :142-145)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `src/lib/chat-session-transport.ts` states its own rule at :58-62 — an unknown or unusable block must not kill an answer the owner is already reading — and then breaks it in three places. `EVENT_RE` (:50) is unanchored, so a block with no `event:` line whose payload contains the literal text `event: done` is read as a done frame (DW-582). `JSON.parse` (:70) is unguarded, so a malformed `data:` payload throws a raw `SyntaxError` that escapes `consumeSidecarStream` and reaches the owner as the parser's own sentence (DW-583). The read loop (:124-137) has no `try/finally`, so an `error` or `cancelled` frame leaves the response body undrained and its reader never cancelled (DW-584).

**Approach:** Apply the module's stated rule at all three points: anchor the event regex to a line start, return `null` from `readSidecarSseBlock` when the matched payload will not parse, and wrap the read loop in `try/finally` that cancels the reader on every exit. Add one executable regression row per entry to the existing `chat-session-transport` suite.

## Boundaries & Constraints

**Always:** Keep every existing assertion in `src/lib/__tests__/chat-session-transport.test.ts` and `src/components/workbench/__tests__/chat-live-stream.test.tsx` passing unchanged — this hardens how a block is *read*, not what a well-formed turn does. A cancel that fails must never replace the turn's own failure: swallow its rejection. The five locked event names and the three public copy constants stay exactly as they are. Every new comment says *why* the guard exists, in this module's established voice.

**Block If:** Anchoring `EVENT_RE` makes a real sidecar frame unreadable — i.e. `formatSse` in `sidecar/chat-transport.mjs` turns out to emit the `event:` line anywhere but the block's first line, meaning the wire format itself disagrees with the reader.

**Never:** Do not change `sidecar/chat-transport.mjs`, `src/lib/sidecar.ts`, `src/components/workbench/ChatCanvas.tsx`, or `src/lib/chat-pending-turn.ts` — all three entries are located in the transport module and no other surface is wrong. Do not touch `DATA_RE`: its greedy shape is outside this bundle. Do not add a new test file; the regression rows belong in the existing suite. Do not introduce a new exported symbol or copy constant. Do not use `reader.releaseLock()` in place of `reader.cancel()` — releasing the lock leaves the body undrained, which is the half of DW-584 that matters.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Forged done in payload (DW-582) | `readSidecarSseBlock('data: {"delta":"see event: done for details","content":"FAKE"}')` — no `event:` line | `null`; no done frame, no handler call | No error expected |
| Real frame still reads | `event: agent\ndata: {"delta":"see event: done"}` | `{ event: "agent", data: { delta: "see event: done" } }` | No error expected |
| Malformed payload (DW-583) | `readSidecarSseBlock('event: done\ndata: {"content":}')` | `null` — the block is unusable, so it is ignored like an unknown name | No throw escapes |
| Malformed payload through the stream | Stream of one `agent` delta then `event: done\ndata: {"content":}`, then close | Delta still delivered; rejects with `SIDECAR_TURN_INCOMPLETE_COPY` | The module's own sentence, never a `SyntaxError` |
| Error frame on an open body (DW-584) | Body enqueues `event: error\ndata: {"message":"provider down"}` and stays open | Rejects with `provider down` AND the body's `cancel` algorithm has run | Cancel rejection swallowed |
| Cancelled frame on an open body | Body enqueues `event: cancelled\ndata: {}` and stays open | Rejects with an `AbortError` AND the body's `cancel` algorithm has run | Cancel rejection swallowed |
| Ordinary completed turn | `agent` deltas then a `done` frame, stream closed | Unchanged: deltas delivered, done frame returned | Cancel on an already-closed body is a no-op |

</intent-contract>

## Code Map

- `src/lib/chat-session-transport.ts` -- the only file to change. `EVENT_RE` at :50 (`/event:\s*(\w+)/`); `readSidecarSseBlock` at :64-72 with the unguarded `JSON.parse` at :70; the module's stated rule in the doc comment at :58-62 — the three fixes are that rule applied; `consumeSidecarStream` at :116-140 with `const reader = body.getReader()` at :120 and the unwrapped `while (true)` loop at :124-137.
- `src/lib/__tests__/chat-session-transport.test.ts` -- the suite the regression rows join. Reuse its existing helpers: `sink()` (:39), `streamOf()` (:54) and `frame()` (:64). The DW-584 rows need a body that stays OPEN after the frame, which `streamOf` cannot express (it always closes), so those rows build a `ReadableStream` inline with a `cancel()` hook. Existing describe blocks: "SSE blocks are filtered to the locked five" (:72) for DW-582/583 unit rows, "consuming one streamed turn" (:107) for the stream-level rows.
- `sidecar/chat-transport.mjs:39` -- read-only evidence for the Block If: `formatSse` returns `` `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` ``, so the `event:` line is always the block's first line and anchoring cannot break a real frame. `JSON.stringify` also escapes newlines, so a payload can never put a forged `event:` at a line start.
- `src/lib/sidecar.ts:131-139` -- `SIDECAR_SSE_EVENTS`, the locked five the filter checks against. Read-only.
- `src/components/workbench/__tests__/chat-live-stream.test.tsx:87-125` -- `gatedTurn()`'s `failBody()` errors the body mid-turn (DW-586's abort pin). After this change the new `finally` calls `reader.cancel()` on an already-errored stream, which rejects; the `.catch` is what keeps that suite green. Read-only.
- `src/lib/chat-pending-turn.ts:207` -- `turnFailureCopy` passes an `Error`'s own `message` straight through, which is why a raw `SyntaxError` is owner-visible today. Read-only.

## Tasks & Acceptance

**Execution:**
- `src/lib/chat-session-transport.ts` -- anchor `EVENT_RE` to `/^event:\s*(\w+)/m` -- a payload's text is not a frame header; only a line start declares an event name (DW-582).
- `src/lib/chat-session-transport.ts` -- guard the `JSON.parse` in `readSidecarSseBlock` so an unparseable matched payload returns `null` instead of throwing -- the module already says an unusable block is ignored, not fatal; a `SyntaxError` reaching `turnFailureCopy` shows the parser's sentence to the owner (DW-583).
- `src/lib/chat-session-transport.ts` -- wrap the read loop of `consumeSidecarStream` in `try { ... } finally { reader.cancel().catch(() => {}) }` -- an `error` or `cancelled` frame must leave the body drained rather than parked with a live reader (DW-584).
- `src/lib/__tests__/chat-session-transport.test.ts` -- add one regression row per I/O matrix scenario above, using the existing helpers and an inline open-ended `ReadableStream` with a `cancel()` hook for the two DW-584 rows -- each row must fail against the pre-change module.

**Acceptance Criteria:**
- Given a block whose only occurrence of the text `event: done` is inside its `data:` payload, when `readSidecarSseBlock` reads it, then it returns `null` and no `done` frame is produced.
- Given a block naming one of the locked five whose `data:` payload matches `DATA_RE` but is not valid JSON, when `readSidecarSseBlock` reads it, then it returns `null` and no exception escapes `applySidecarSseBlock`.
- Given a stream whose only `done` frame carries an unparseable payload, when `consumeSidecarStream` drains it, then it rejects with `SIDECAR_TURN_INCOMPLETE_COPY` and never with a `SyntaxError`.
- Given a still-open body that emits an `error` or `cancelled` frame, when `consumeSidecarStream` throws, then the body's `cancel` algorithm has run before the rejection reaches the caller, and the rejection is the frame's own error rather than a cancel failure.
- Given the existing `chat-session-transport` and `chat-live-stream` suites, when they run against the changed module, then every pre-existing assertion still passes unmodified.

## Spec Change Log

## Review Triage Log

### 2026-09-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 1: (high 0, medium 0, low 1)
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[low]` `[patch]` The new `finally` comment credited the `.catch` with an ordering guarantee it
    cannot provide — `reader.cancel()` is not awaited, so its rejection could never have replaced
    the thrown error — and "EVERY EXIT DRAINS THE BODY" claimed a completed drain the un-awaited
    call does not deliver. Reworded (comment text only, no executable line moved) to state the two
    real reasons: the call is deliberately not awaited because awaiting inside a `finally` is what
    would let a cancel's rejection replace the turn's real failure, and the `.catch` absorbs the
    rejection an already-errored stream hands back. The guarantee is now stated accurately: the
    cancel algorithm is invoked synchronously, so the body is released before the caller sees the
    turn's ending.

## Design Notes

The guard shape, so the three fixes stay one rule rather than three habits — an unusable block is ignored, and a turn's exit always drains its body:

```ts
const EVENT_RE = /^event:\s*(\w+)/m;

// ...inside readSidecarSseBlock, replacing the bare JSON.parse:
let data: Record<string, unknown> = {};
if (dataMatch) {
  try {
    data = JSON.parse(dataMatch[1]) as Record<string, unknown>;
  } catch {
    return null; // Unusable is UNKNOWN, not fatal — same rule as a sixth event name.
  }
}
```

`reader.cancel()` is deliberate over `releaseLock()`: only `cancel` runs the body's own cancel algorithm, which is what actually drains a loopback connection the sidecar is still holding open. Its rejection is swallowed because on the abort path the stream is already errored — surfacing that would replace the turn's real failure with a cancel's.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/chat-session-transport.test.ts` -- expected: all rows green, including the new DW-582/583/584 rows.
- `pnpm vitest run src/components/workbench/__tests__/chat-live-stream.test.tsx src/lib/__tests__/chat-pending-turn.test.ts src/lib/__tests__/workbench-epic3.test.ts` -- expected: green; the abort and cancelled-frame paths are unaffected by the new `finally`.
- `pnpm lint` -- expected: no new errors or warnings.
- `pnpm test` -- expected: no regressions against the pre-change baseline.

## Auto Run Result

Status: done

**Summary.** `src/lib/chat-session-transport.ts` now applies its own stated rule (`:63-68` — an unusable
block must not kill an answer the owner is already reading) at the three places it was not honoured.
`EVENT_RE` is anchored to a line start, so the literal text `event: done` inside a `data:` payload can
no longer be read as a done frame (DW-582). The `JSON.parse` in `readSidecarSseBlock` returns `null`
on an unparseable payload instead of throwing a raw `SyntaxError` out to `turnFailureCopy` (DW-583).
The read loop in `consumeSidecarStream` is wrapped in `try/finally { reader.cancel().catch(() => {}) }`,
so an `error` or `cancelled` frame releases the body rather than leaving it parked with a live reader
(DW-584). Seven regression rows were added to the existing suite — five fail against the pre-change
module, two are guard rows pinning behaviour that must NOT move.

**Files changed.**
- `../../src/lib/chat-session-transport.ts` — anchored `EVENT_RE`, guarded the payload parse, wrapped
  the read loop in `try/finally` with a cancel; each guard carries a why-comment in the module's voice.
- `../../src/lib/__tests__/chat-session-transport.test.ts` — new `watchedBody()` helper (a body that
  reports whether its own `cancel` algorithm ran and by default stays OPEN, which `streamOf` cannot
  express) plus seven rows, one per I/O matrix scenario, in the two existing describe blocks.

**Review findings.** patches applied 1 (low 1) · items deferred 1 (low 1) · items rejected 15 (low 15).
Four layers ran in parallel (blind-hunter, edge-case-hunter, verification-gap, intent-alignment).
The patch corrected an inaccurate rationale in the new `finally` comment. The deferred item is the
truncated-`done`-payload path, which is pre-existing and the sibling branch of the DW-583 guard rather
than a consequence of it. The rejected findings were: proposals to fall back to `{}` for a malformed
`error`/`cancelled` frame (the intent explicitly prescribes `null`, and `formatSse` always emits a
parseable payload); anchoring `DATA_RE` and tightening `EVENT_RE`'s `\s*` to `[ \t]*` (residue of the
named fix, unreachable once the DW-583 guard rejects a payload carrying a raw newline); the loop not
breaking on `done`; CRLF delimiters and multi-line `data:` continuations (neither shape the sidecar
emits); a synchronously-throwing `cancel()` and a `getReader()` outside the `try` (not reachable from
`runSidecarTurn`, which always passes a fresh body); and the observation that the new tests sit at the
parser surface rather than the owner surface — the intent names this module and its functions as the
surface, and the owner-facing hop is already pinned by `chat-live-stream.test.tsx` and
`chat-pending-turn.test.ts`.

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 0, low 1.
Score: no patched finding was high severity, so no further review pass is warranted.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/chat-session-transport.test.ts` — 24/24 passed.
- `pnpm vitest run` over `chat-live-stream.test.tsx`, `chat-pending-turn.test.ts`,
  `workbench-epic3.test.ts` — 64/64 passed with the transport suite; the DW-586 abort pin survives
  because the `.catch` absorbs the already-errored stream's cancel rejection.
- `pnpm lint` — no errors or warnings (three pre-existing `jsx-ast-utils` notices, unrelated).
- `pnpm test` — 381 files, 9472 passed / 1 skipped, no regressions. Re-run after the patch: identical.
- Matrix test audit: all seven I/O rows are covered by a named row that ran and passed.
- Mutation check (review layer, file restored after each): unanchoring `EVENT_RE` fails the DW-582
  row; restoring the bare `JSON.parse` fails both DW-583 rows; removing `reader.cancel()` fails both
  DW-584 drain rows.
- Block If did not trigger: `sidecar/chat-transport.mjs:39` routes every SSE write through `formatSse`,
  which emits `event:` as the block's first line.

**Residual risks.**
- `reader.cancel()` releases the body but does not unlock it — `body.locked` stays `true` after a
  cancel, per the streams spec. The intent prescribed `cancel()`, and the drain is the half that
  matters for a loopback connection, but the DW-584 ledger wording also said "locked" and that half
  is unchanged.
- The DW-583 guard drops an unparseable payload for ALL five locked names, so a hostile producer's
  malformed `cancelled` frame now ends the turn with `SIDECAR_TURN_INCOMPLETE_COPY` rather than the
  silence a real Stop earns. Unreachable through `formatSse`, which always emits `{}` for `cancelled`.
- The deferred truncated-`done` path above remains open.
