---
title: 'DW-444: extract the pending turn and the session transport out of ChatCanvas'
type: 'refactor'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'ab263b9826041da00d3c755c7a707e5744186c5a'
context:
  - _bmad-output/implementation-artifacts/epic-8-sidecar-runtime.md
warnings: [oversized]
deferred:
  - summary: >-
      The SSE event regex is unanchored, so a block with no `event:` line whose
      data payload contains the text `event: done` is read as a done frame.
    evidence: |-
      `EVENT_RE = /event:\s*(\w+)/` is matched against the whole block rather
      than a line start, so `readSidecarSseBlock` returns `{event:"done"}` for
      `data: {"delta":"see event: done for details","content":"FAKE"}`. Moved
      verbatim from `ChatCanvas.tsx` at `ab263b98`, so it predates DW-444; the
      extraction is what made it reachable from a test. `/^event:\s*(\w+)/m`
      would close it. Low today because the sidecar's `formatSse` always writes
      the `event:` line first.
    location: >-
      src/lib/chat-session-transport.ts:48
    severity: low
  - summary: >-
      A malformed `data:` payload throws a raw SyntaxError that kills a turn the
      owner is already reading.
    evidence: |-
      `readSidecarSseBlock` calls `JSON.parse` with no guard, and the throw
      escapes `consumeSidecarStream`, so `turnFailureCopy` shows the parser's
      own sentence. Pre-existing: identical code in `applySseBlock` at
      `ab263b98`. Returning `null` for an unparseable payload would match the
      module's stated "an unknown block must not kill an answer" rule.
    location: >-
      src/lib/chat-session-transport.ts:63-71
    severity: low
  - summary: >-
      The stream reader is never released or cancelled when a turn throws, so an
      `error` or `cancelled` frame leaves the response body locked and undrained.
    evidence: |-
      `consumeSidecarStream` has no `try/finally` around the read loop; after an
      `error` frame `body.locked` stays true and `cancel()` is never called.
      Pre-existing shape from `ab263b98`. A `finally { reader.cancel().catch(()
      => {}) }` would close it. Bounded impact: the door is a local loopback
      connection.
    location: >-
      src/lib/chat-session-transport.ts:113-133
    severity: low
  - summary: >-
      `frame.citations ?? turn.fallbackCitations` never fires, because the
      sidecar sends `citations: []` rather than omitting the field.
    evidence: |-
      `??` only substitutes on null/undefined. `sidecar/agent.mjs` and
      `sidecar/chat-transport.mjs` emit `citations: []` on the settle paths, so
      `OpenTurn.fallbackCitations` is effectively dead and such an answer is
      reduced to the coverage sentence. Moved verbatim from `ab263b98`, so the
      behaviour is unchanged by DW-444; deciding whether the assemble's
      citations should stand in for an empty array is a Chat-behaviour question,
      not a refactor one.
    location: >-
      src/lib/chat-pending-turn.ts:139
    severity: low
  - summary: >-
      Nothing asserts that pressing Stop, or unmounting, actually aborts an
      in-flight turn.
    evidence: |-
      `stopTurn()` and the unmount effect abort `abortRef`, and `driveTurn`
      forwards `controller.signal` to `runSidecarTurn`; the transport suite only
      checks that whatever signal it is handed is forwarded. No mounted test
      presses Stop. The gap predates DW-444, but the abort hop now crosses a
      module boundary, so it is worth a mounted assertion.
    location: >-
      src/components/workbench/ChatCanvas.tsx:278
    severity: low
  - summary: >-
      ChatCanvas is still 1,247 lines: conversation CRUD, persistence, the
      assemble call, the Skill scan, attachments, regenerate and save-to-wiki
      remain inline beside the JSX.
    evidence: |-
      DW-444 named exactly two subjects and both are out, but the retro finding
      that opened this thread was about file size. A further decomposition pass
      (the conversation store, and the composer's non-render concerns) is the
      natural next follow-on to `epic-8-retro-architecture-follow-on`.
    location: >-
      src/components/workbench/ChatCanvas.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** `src/components/workbench/ChatCanvas.tsx` is 1,388 lines and still holds the whole
sidecar turn inline — the POST, the SSE reader, the `done`-frame decision, and the resume body
(`:563-694`). No pending-turn or session-transport module exists anywhere under `src`, so none of
those rules can be executed without mounting the component, and a Chat-door change cannot be
reviewed without the conversation list, the toolbar, and 480 lines of JSX.

**Approach:** Move the two seams into sibling browser modules under `src/lib` with their own node
suites: one owns the sidecar wire (POST, SSE consume, the five locked events), the other owns the
turn's own rules (request shape, hold-open vs write-down, resume body, failure copy). ChatCanvas
keeps React state, the conversation CRUD it already has, and rendering.

## Boundaries & Constraints

**Always:** SSE events stay exactly `meta`, `agent`, `done`, `cancelled`, `error` (read from
`SIDECAR_SSE_EVENTS`; an unknown name is ignored, not an error). The agent turn still sends
`tools: true` and `coverage: true` regardless of what the assemble reported. A `pending` frame
holds the turn open: nothing is persisted, live rows stay, and the ref-held open turn survives.
Deny and Cancel still go back to the sidecar as a resume. Both new modules stay framework-free —
no React import, no JSX — and are exercised by `*.test.ts` in the `node` project. Chat still
reaches the sidecar through `loopbackFetch` and `sidecarChatUrl`.

**Block If:** the extract cannot preserve an existing assertion in
`epic8-chat-ui.test.tsx`, `chat-search-contracts.test.tsx`, or `workbench-epic3.test.ts` without
changing what that assertion means.

**Never:** change the sidecar wire (body fields, SSE names, resume shape) or any owner-visible
copy. Touch `sidecar/`, `SettingsCanvas.tsx`, or `src/lib/workbench-settings.ts` — the Settings
extract stays follow-on. Move the conversation CRUD (`loadList`, `loadConversation`,
`createConversation`, `deleteConversation`, `commitRename`, `patchActive`, `saveToWiki`), the
Skill command handling, or the JSX. Close `epic-8-retro-architecture-follow-on`. Edit
`llm-wiki.md`, `.github/`, `.yoyo/`, frozen identifiers, or intent contracts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Streamed turn | SSE `agent` deltas split mid-block across reads, then `done` | Deltas and thinking arrive in order; the trailing block with no `\n\n` is still applied at stream end; the `done` frame is returned | No error expected |
| Unknown event | `event: heartbeat` between two `agent` blocks | Ignored; the turn continues | No error expected |
| `error` frame | `event: error`, `data: {"message":"provider down"}` | Turn throws | `Error("provider down")`; no message defaults to `Chat failed.` |
| `cancelled` frame | `event: cancelled` | Turn throws | `DOMException("cancelled", "AbortError")` so the caller stays silent |
| Stream ends with no `done` | `agent` frames only, then close | Turn throws | `Error("Chat ended before a complete answer.")` |
| Sidecar refuses | non-ok response, body `{"error":"api_disabled"}` | No stream is read | `Error("api_disabled")`; unparseable or empty body ⇒ `Sidecar chat failed.` |
| Assemble says no coverage | `coverage: false` from `/retrieve` | Request still carries `coverage: true` and `tools: true` | No error expected |
| `done` carries `pending` | `pending.kind: "skill_form"` | Outcome is hold-open, carrying the pending and the initial form values; no frames to persist | No error expected |
| `done` carries a shell pause | `pending.kind: "shell"` | Outcome is hold-open with no form values | No error expected |
| Settled with empty answer | `content: ""`, no tool calls, assemble `coverageMessage` set | Frames use the assemble's sentence; with no `coverageMessage`, `CHAT_COVERAGE_MISSING_COPY` | No error expected |
| Deny a shell pause | open turn + `approved: false` | Resume body is the original request plus `resume: { capabilityId, approved: false }`, no `answers` | No error expected |
| Submit a form | `skill_form` pending + collected values | Resume body adds `answers` alongside `capabilityId` and `approved: true` | No error expected |
| Door refusal copy | thrown message `api_disabled` / `unauthorized` | Owner-facing Settings sentence from `chatDoorRefusalCopy` | Any other message passes through verbatim |

</intent-contract>

## Code Map

- `src/components/workbench/ChatCanvas.tsx` -- the extract's source. `SidecarDone` (`:118-125`),
  `OpenTurn` (`:134-141`), `sendTurn`'s request literal (`:507-527`), `turnFailureCopy`
  (`:551`), `runSidecarTurn` (`:563`) with its `applySseBlock` reader, `settleTurn` (`:642`), and
  the resume body inside `answerPending` (`:696`). Everything else stays:
  state, conversation CRUD, Skill command handling, Esc handling, and the JSX from `:902`.
- `src/lib/chat-agent.ts` -- already the browser's rule module. Reuse `ChatPending`,
  `isChatPending`, `initialFormValues`, `ChatToolRow`, `isChatToolRow`, `mergeToolRow`,
  `chatDoorRefusalCopy`. Do not duplicate any of them.
- `src/lib/sidecar.ts` -- `SIDECAR_SSE_EVENTS`, `sidecarChatUrl`. The locked five live here.
- `src/lib/loopback-client.ts` -- `loopbackFetch`, the one authenticated door to `:19828`.
- `src/lib/chat-citations.ts` -- `sanitizeCitedAnswer`, used by the settle decision.
- `src/lib/workbench-modes.ts` -- `CHAT_COVERAGE_MISSING_COPY`.
- `src/lib/chat.ts` -- `ChatOutput`, `ChatToolCall` frame types.
- `src/lib/__tests__/workbench-epic3.test.ts:277-300` -- READ-ONLY EVIDENCE and the one pin this
  change must edit: it asserts `ChatCanvas.tsx` contains `sidecarChatUrl`. Once the door moves,
  re-aim that half at the transport module and add a pin that ChatCanvas imports it, keeping the
  negative pins (`/api/query`, `ChatWorkspace`, `await response.json()`) exactly as they are.
- `src/components/workbench/__tests__/epic8-chat-ui.test.tsx` -- mounted turn/pause coverage; it
  stubs global `fetch` and asserts on the resume body. Must pass unchanged.
- `src/components/workbench/__tests__/chat-search-contracts.test.tsx` -- read-only and citation
  docking. Must pass unchanged.
- `AGENTS.md` "Test environments" -- `*.test.ts` ⇒ `node`, `*.test.tsx` ⇒ `dom`; suites live under
  `__tests__`. Both new suites are `.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/lib/chat-session-transport.ts` -- new module owning the wire: `SidecarDoneFrame`, a
  `SidecarTurnHandlers` sink (`onDelta`, `onThinking`, `onToolRow`), a block reader that filters to
  `SIDECAR_SSE_EVENTS`, a stream consumer that flushes the trailing partial block, and
  `runSidecarTurn({ wikiId, request, signal, handlers })` doing the `loopbackFetch` POST to
  `sidecarChatUrl(wikiId)` and returning the `done` frame -- so the SSE rules are executable
  without mounting Chat.
- `src/lib/chat-pending-turn.ts` -- new module owning the turn's rules: `OpenTurn`,
  `ChatTurnFrame`, `chatTurnRequest(...)` (the `tools`/`coverage` invariant),
  `settleTurn(turn, frame)` returning hold-open-with-pending or settled-with-frames,
  `resumeRequest(turn, pending, approved, formValues)`, and `turnFailureCopy(cause)` -- so
  hold-open vs write-down is one testable decision.
- `src/components/workbench/ChatCanvas.tsx` -- delete the extracted bodies and call the two
  modules; keep the refs, the state writes each outcome implies, and every other behavior --
  the component renders and holds state, nothing else.
- `src/lib/__tests__/chat-session-transport.test.ts` -- new node suite covering every transport row
  of the I/O matrix, plus a source pin that `ChatCanvas.tsx` no longer contains `getReader()` or an
  `event:` regex and that neither new module imports `react`.
- `src/lib/__tests__/chat-pending-turn.test.ts` -- new node suite covering every pending/settle/
  resume row of the I/O matrix.
- `src/lib/__tests__/workbench-epic3.test.ts` -- re-aim only the `sidecarChatUrl` half of the
  existing pin at `src/lib/chat-session-transport.ts` and pin ChatCanvas's import of it; leave
  every other assertion in the file alone.

**Acceptance Criteria:**
- Given the mounted Chat suites at `ab263b98`, when they run against the extracted component, then
  every existing assertion still holds with no edit to either file.
- Given `ChatCanvas.tsx` after the change, when it is read, then it holds no SSE parsing, no
  `getReader()`, no sidecar POST, and no resume-body literal, and it is materially shorter than
  1,388 lines.
- Given the two new modules, when the `node` project runs them, then every I/O matrix row is
  asserted without React or a DOM.
- Given the repo after the change, when `sidecar/`, `SettingsCanvas.tsx`, and
  `src/lib/workbench-settings.ts` are diffed against `ab263b98`, then they are unchanged.

## Spec Change Log

- 2026-08-29 -- implementation note on the "Settled with empty answer" row. In
  `ChatCanvas.tsx` at `ab263b98` the expression was
  `sanitized.content || turn.coverageMessage || CHAT_COVERAGE_MISSING_COPY`, and
  the middle branch was UNREACHABLE: `sanitizeCitedAnswer` already substitutes
  its own `coverageCopy` argument (defaulting to `CHAT_COVERAGE_MISSING_COPY`)
  whenever no marker survives, so `sanitized.content` is never empty. The
  extracted `settleTurn` therefore hands the assemble's sentence to
  `sanitizeCitedAnswer` as its `coverageCopy` and reuses it as the final
  fallback, which is what the matrix row describes. No owner-visible copy
  changes: `/retrieve` only ever emits `coverageMessage` as `null` or exactly
  `CHAT_COVERAGE_MISSING_COPY` (`src/lib/wiki-retrieve.ts:583,666`), so both
  spellings resolve to the same sentence today.
- 2026-08-29 -- the "Door refusal copy" row names `api_disabled`, but
  `chatDoorRefusalCopy` (reused, not duplicated, per the Code Map) keys on
  `disabled` / `unauthorized`, which is what the sidecar actually sends
  (`sidecar/loopback.mjs:34`). The suite asserts the real codes; every other
  message still passes through verbatim.
- 2026-08-29 (review pass 1) -- the deviation logged above is REVERTED.
  `settleTurn` is back to `ab263b98` exactly: `sanitizeCitedAnswer` is called
  with two arguments and the content is
  `sanitized.content || turn.coverageMessage || CHAT_COVERAGE_MISSING_COPY`.
  Three reviewers found the three-argument form was not just unreachable but
  would be UNDONE downstream if it ever became reachable: `persistChatTurn`
  re-runs `isCoverageSentence` and `sanitizeCitedAnswer` with the DEFAULT copy
  (`src/lib/chat.ts:480,483`), so a per-query assemble sentence written by the
  turn would be rewritten back to `CHAT_COVERAGE_MISSING_COPY` on the way into
  the store. A pure extraction has no business introducing a difference the
  store then erases, so the historical shape stays and the comment now says
  plainly that the middle term is a preserved shape rather than a live branch.
  The suite asserts the restored behavior; the `"Nothing about Q3 …"` fixture,
  which `/retrieve` cannot produce, is gone.

## Review Triage Log

### 2026-08-29 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 6: (high 0, medium 0, low 6)
- reject: 14: (high 0, medium 0, low 14)
- addressed_findings:
  - `[medium]` `[patch]` `settleTurn` had changed owner-visible behaviour inside what the intent
    frames as a pure extraction: it passed `turn.coverageMessage || CHAT_COVERAGE_MISSING_COPY`
    into `sanitizeCitedAnswer` as `coverageCopy`. Three reviewers found the new form unreachable
    today and self-defeating if it ever became reachable — `persistChatTurn` re-runs
    `isCoverageSentence` and `sanitizeCitedAnswer` with the DEFAULT copy (`src/lib/chat.ts:480`,
    `:483`), so a per-query sentence would be rewritten back in the store. Reverted to the exact
    `ab263b98` expression, rewrote the two empty-answer tests onto the restored behaviour, dropped
    the `"Nothing about Q3 has been ingested yet."` fixture `/retrieve` cannot produce, and
    appended a Spec Change Log entry.
  - `[medium]` `[patch]` The component's `turnHandlers()` sink was unverified: no-opping all three
    handlers left the entire suite green, so the streaming answer, the thinking line and the live
    tool rows could stop rendering silently. Added `chat-live-stream.test.tsx` — a new mounted
    suite (new file on purpose, so `epic8-chat-ui.test.tsx` stays unedited) that gates the `done`
    frame behind a promise and asserts the accumulated deltas, the thinking line and the tool row
    while the turn is still live. Mutation-verified: no-opping each handler individually fails it.
  - `[low]` `[patch]` `meta` — the one locked event that passes the block filter and then falls off
    the end of `applySidecarSseBlock` — was untested. Added a case pinning that it parses, calls no
    sink handler, and returns `null`.
  - `[low]` `[patch]` The re-aimed `workbench-epic3` pin claimed to be "doubled so neither half can
    drift alone" but asserted no absence. Added `expect(chat).not.toContain("sidecarChatUrl")`.
  - `[low]` `[patch]` The "seam actually moved" pins were weak enough to pass a re-regression
    (`not.toContain("</")` misses self-closing JSX; `from "react"` misses single quotes and
    `react/jsx-runtime`). Replaced with regexes, sanity-checked against 11 spellings.
  - `[low]` `[patch]` The door-request test never asserted `Content-Type: application/json`, which
    the sidecar route requires. Added.
  - `[low]` `[patch]` `chat-pending-turn.test.ts` hardcoded the transport's sentences, so a copy
    change would leave a green test asserting a stale string. It now imports
    `SIDECAR_TURN_INCOMPLETE_COPY`.

Rejected as noise (14): hypothetical wire shapes the local sidecar does not produce (CRLF block
separators, multi-line `data:` fields, a non-string `error` field, non-array `citations`, non-string
`thinking`); cosmetic or by-design structure (`ChatTurnFrame.id` unused by `persistFrames`, the
third structural restatement of the assemble shape, the `chat-session-transport.ts` /
`sidecar/chat-transport.mjs` name similarity, `turnFailureCopy`'s side of the wire/turn line); loop
behaviour unchanged from `ab263b98` (no post-`done` break, no turn timeout, `turnRef` re-read after
the await, live rows left when the ref is cleared mid-flight); the deferred-work ledger being
untouched (orchestrator-owned by instruction); and the reading that DW-444 asked for a whole-file
decomposition rather than the two extractions its own title names.

## Design Notes

The split line is "wire" vs "turn". `chat-session-transport.ts` knows the five event names, the
byte reader, and the door; it knows nothing about conversations, coverage, or citations.
`chat-pending-turn.ts` knows what a turn is and what a `done` frame means; it never fetches.
ChatCanvas holds the `turnRef`/`abortRef` refs and does the state writes, because a resume that
read a stale render's request body would re-send the previous question — that reason belongs to the
component, so the ref stays there and the modules take the turn as an argument.

`settleTurn` is a pure decision, not an effect, so the component performs the writes:

```ts
const outcome = settleTurn(turn, frame);
if (outcome.kind === "pending") {
  setPending(outcome.pending);
  if (outcome.formValues) setFormValues(outcome.formValues);
  return true;
}
setLiveRows([]); setPending(null); turnRef.current = null;
await persistFrames(turn.conversationId, outcome.frames, {
  replaceLastTurn: outcome.replaceLastTurn,
});
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/chat-session-transport.test.ts src/lib/__tests__/chat-pending-turn.test.ts src/lib/__tests__/workbench-epic3.test.ts` -- expected: all pass.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/epic8-chat-ui.test.tsx src/components/workbench/__tests__/chat-search-contracts.test.tsx` -- expected: all pass.
- `pnpm exec tsc --noEmit` -- expected: exit 0.
- `pnpm test` -- expected: both projects green.
- `git diff --stat ab263b98 -- sidecar src/components/workbench/SettingsCanvas.tsx src/lib/workbench-settings.ts` -- expected: empty.
- `wc -l src/components/workbench/ChatCanvas.tsx` -- expected: materially below 1,388.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

DW-444 is resolved. The sidecar turn no longer lives inside `ChatCanvas.tsx`. Two framework-free
browser modules now own it — `chat-session-transport.ts` for the wire (the loopback POST, the byte
reader, the five locked SSE events, the `done` frame) and `chat-pending-turn.ts` for the turn's own
rules (the Agent request shape, hold-open vs write-down, the resume body, the door's refusal copy).
Both are exercised by `node`-project suites with no DOM. ChatCanvas went from 1,388 to 1,247 lines
and keeps only what is genuinely the component's: the abort controller, the ref-held open turn, the
state writes each outcome implies, and rendering. The sidecar wire is unchanged, and so is every
owner-visible sentence.

### Files changed

- `src/lib/chat-session-transport.ts` (new) -- the sidecar chat wire: `runSidecarTurn`,
  `consumeSidecarStream`, `applySidecarSseBlock`, `readSidecarSseBlock`, `SidecarDoneFrame`, the
  `SidecarTurnHandlers` sink, and the three refusal sentences as constants.
- `src/lib/chat-pending-turn.ts` (new) -- the turn's rules: `OpenTurn`, `ChatTurnFrame`,
  `chatTurnRequest`, `settleTurn`, `resumeRequest`, `turnFailureCopy`.
- `src/components/workbench/ChatCanvas.tsx` -- extracted bodies deleted; `turnHandlers()` and
  `driveTurn()` replace them. Conversation CRUD, Skill handling, Esc handling and the JSX untouched.
- `src/lib/__tests__/chat-session-transport.test.ts` (new) -- 17 node tests over the wire, plus the
  source pins that the seam moved and that both modules stay framework-free.
- `src/lib/__tests__/chat-pending-turn.test.ts` (new) -- 17 node tests over the request invariant,
  both pause kinds, the settle decision, both resume bodies, and the refusal copy.
- `src/components/workbench/__tests__/chat-live-stream.test.tsx` (new) -- the mounted proof that the
  component's sink is wired: a gated `done` frame, with the live region asserted mid-turn.
- `src/lib/__tests__/workbench-epic3.test.ts` -- the `sidecarChatUrl` pin follows the door to the
  transport module and gains its negative half; every other assertion in the file is untouched.

### Review findings

- Patches applied: 7 (medium 2, low 5) -- see the Review Triage Log for each.
- Items deferred: 6 (all low) -- five pre-existing robustness gaps the extraction made visible
  (unanchored event regex, unguarded `JSON.parse`, unreleased reader, the `??` that never fires,
  the unasserted Stop/abort hop) and one scope note (ChatCanvas is still 1,247 lines).
- Items rejected: 14 -- hypothetical wire shapes the local sidecar does not produce, cosmetic or
  by-design structure, loop behaviour unchanged from `ab263b98`, the orchestrator-owned ledger, and
  the whole-file-decomposition reading of the intent.

### Follow-up review recommendation

`true`. Patched findings this pass: high 0, medium 2, low 5. Score = 3x2 + 1x5 = 11, which is >= 5.

### Verification performed

- `pnpm exec vitest run --project node src/lib/__tests__/chat-session-transport.test.ts
  src/lib/__tests__/chat-pending-turn.test.ts src/lib/__tests__/workbench-epic3.test.ts` -- 54
  passed.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/epic8-chat-ui.test.tsx
  src/components/workbench/__tests__/chat-search-contracts.test.tsx
  src/components/workbench/__tests__/chat-live-stream.test.tsx` -- 15 passed.
- `pnpm exec tsc --noEmit` -- exit 0.
- `pnpm test` -- 7,698 passed, 233 failed in 13 `dom` files. Those 233 are PRE-EXISTING and
  unrelated: every one fails in `beforeEach` with `TypeError: Cannot read properties of undefined
  (reading 'clear')` on `window.localStorage`. Confirmed by stashing this run's changes and
  re-running `workbench-split-wiring.test.tsx` at `ab263b98` -- the same 29 failures. No Chat suite
  is among them, and the passing count rose from 7,695 to 7,698 with no new failure.
- `git diff --stat ab263b98 -- sidecar src/components/workbench/SettingsCanvas.tsx
  src/lib/workbench-settings.ts src/components/workbench/__tests__/epic8-chat-ui.test.tsx
  src/components/workbench/__tests__/chat-search-contracts.test.tsx` -- empty. The Settings extract
  stays follow-on, and both pre-existing mounted Chat suites pass unedited.
- `wc -l src/components/workbench/ChatCanvas.tsx` -- 1,247, down from 1,388.
- Matrix test audit: every I/O row is covered by a test that ran and passed in the runs above.

### Residual risks

- The five deferred robustness gaps are all pre-existing shapes moved verbatim. They are now easier
  to fix than they were, but they are still live: the unanchored `event:` regex is the one with a
  demonstrated (if practically unreachable) wrong outcome.
- The 13 pre-existing `dom` failures mean a full-suite regression signal in this working copy is
  noisier than it looks. Chat coverage was checked per-project instead.
- `epic-8-retro-architecture-follow-on` stays open: the Settings API/MCP extract was explicitly out
  of scope here, and ChatCanvas itself is still a large file (deferred above).
