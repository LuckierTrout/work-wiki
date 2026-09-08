---
title: 'DW-587: decompose ChatCanvas — the conversation store, the assemble door, and the composer'
type: 'refactor'
created: '2026-09-04'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'c19a5a29327d0abb5aa2d51bde942ecc4a37bc7d'
context:
  - _bmad-output/implementation-artifacts/spec-dw-444-chat-canvas-transport-extract.md
warnings: [oversized]
deferred:
  - summary: >-
      Chat's create, delete and rename call sites report nothing when their door
      refuses: the failure is an unhandled rejection and the owner sees no
      sentence.
    evidence: |-
      `void createConversation()`, `void deleteConversation(item.id)` and
      `void commitRename(item.id)` in `ChatCanvas.tsx` have no `catch`, and
      `useChatConversations` routes only the mount load and "Conversation not
      found." through its `onError`. A refused DELETE leaves the row on screen
      with no explanation; a refused rename silently restores the old label.
      Pre-existing — the same three call sites are unguarded at `c19a5a29`, and
      DW-587 moved the doors without changing them — but the split is what
      introduced the `onError` reporter that would close it.
    location: >-
      src/components/workbench/ChatCanvas.tsx (createConversation,
      deleteConversation, commitRename)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `src/components/workbench/ChatCanvas.tsx` is 1,247 lines. DW-444 took the sidecar wire
out, but conversation CRUD and persistence (`loadList`, `loadConversation`, `createConversation`,
`deleteConversation`, `commitRename`, `patchActive`, `persistFrames`, `saveToWiki`), the assemble
call to `/retrieve`, the Skill scan, attachments and the `/skill` command decision are all still
inline beside 487 lines of JSX. None of those rules — which URL, which method, which body, which
defaults a loaded conversation falls back to — can be executed without mounting React.

**Approach:** Move the non-render concerns into framework-free sibling modules under `src/lib` with
`node` suites, and hold the conversation state in one sibling hook next to the component:
`chat-conversation-store.ts` (the `/api/chat/conversations*` doors plus the pure list/message
rules), `chat-assemble.ts` (the `/retrieve` door and the history slice), `chat-composer.ts` (the
Skill scan, the attach path, the `/skill` decision, the hint prefix), and
`useChatConversations.ts` (the React state and effects those doors write into). ChatCanvas keeps
the turn refs, the per-turn state, and rendering.

## Boundaries & Constraints

**Always:** Every kernel call still goes through `send` from `@/lib/workbench-request` with the
same URL, method and JSON body it sends at `c19a5a29` — a parsed-body helper, never
`response.json()`. The Skill scan still reaches the sidecar through `loopbackFetch(SKILL_SCAN_URL)`
and stays silent on every failure. Attachments still go through `submitIntakeFiles` (Intake, the one
arrival path for bytes). `readOnly` still refuses New Chat, delete, rename, send, regenerate, save
and settings writes, at the same call sites. The three `src/lib` modules stay framework-free — no
React import, no JSX, no hooks — and are exercised by `*.test.ts` in the `node` project. The
in-flight guards keep their exact shapes: `loadSeq`/`persistSeq` last-writer-wins, the serialized
`patchChain` with its swallowed rejection, `sendInFlight`/`saveInFlight`.

**Block If:** preserving an existing assertion in `epic8-chat-ui.test.tsx`,
`chat-search-contracts.test.tsx` or `chat-live-stream.test.tsx` would require editing that file.

**Never:** change any owner-visible copy, any request body, any URL, or the order of state writes an
outcome implies. Touch `sidecar/`, `SettingsCanvas.tsx`, `src/lib/workbench-settings.ts`,
`src/lib/chat-session-transport.ts` or `src/lib/chat-pending-turn.ts`. Move the JSX out of
ChatCanvas, or split it into presentational child components. Add a new API surface, a new route, or
a second door onto an existing one. Fix any of the five robustness gaps DW-444 deferred. Edit
`llm-wiki.md`, `.github/`, `.yoyo/`, frozen identifiers, `AGENTS.md`, or intent contracts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| List conversations | none | `GET /api/chat/conversations`; returns `body.conversations` | A body with no `conversations` yields `[]` |
| Read a conversation | id `c 1` | `GET /api/chat/conversations/c%201` | A body with no `conversation` returns `null` |
| Settings of a loaded row | row with `retrievalMode: "sources"`, no budgets | `sources`, `CHAT_TOKEN_BUDGET_DEFAULT`, `CHAT_HISTORY_DEPTH_DEFAULT`, `selectedSkill` passed through | An unrecognized `retrievalMode` falls back to `wiki` |
| Create | current settings | `POST /api/chat/conversations` with exactly `{retrievalMode, tokenBudget, historyDepth}` | No `conversation` in the body returns `null` |
| Rename | id, name | `PATCH …/{id}` with `{name}` | No `conversation` in the body leaves the list untouched |
| Patch a setting | id, `{tokenBudget: 8000}` | `PATCH …/{id}` with that patch; the row is merged into the list | A rejection is swallowed and does not break the next patch |
| Persist a turn | two frames, `replaceLastTurn: true` | `POST …/{id}/messages` with `persist: true`, that flag, and per-frame `role`/`content`/`citations`, omitting empty `thinking`/`toolCalls`/`outputs` | No `conversation` in the body throws `Persist failed.` |
| Save to wiki | id, message id | `POST …/{id}/save` with `{messageId}` | The thrown message reaches the caller |
| Assemble | query, mode, budgets, history | `POST /api/v1/projects/{wikiId}/retrieve` with `{query, retrievalMode, tokenBudget, historyDepth, history}` | A body whose `coverage` is not a boolean throws `Retrieve failed.` |
| History slice | canvas messages | `{id, role, content, citations, createdAt: ""}` per message | A message with no citations sends `[]` |
| Skill scan | sidecar answers `{skills:[…]}` | that array | Non-ok, a thrown fetch, or a non-array `skills` yields "no list to apply", NOT an empty list |
| Attach | two files, one refused | Intake's report sentence and whether a data-version check is owed | An empty report means no note is shown |
| `/skill` bare, enabled Skills exist | text `/skill` | open the picker with an empty term | — |
| `/skill` bare, none enabled | text `/skill` | clear the Skill | — |
| `/skill <exact name>` | text `/skill recap` | pick that Skill's id | A term matching one enabled Skill picks it; anything else opens the picker on the term |
| Not a command | text `recap the call` | `none`, so the text is sent as a message | — |
| Regenerate target | last two messages are user then assistant | that user's text plus the history before them | Any other tail returns nothing to regenerate |

</intent-contract>

## Code Map

- `src/components/workbench/ChatCanvas.tsx` (1,247 lines) -- the source. Moving out: `ConversationRow`
  (`:82-91`), `CanvasMessage` (`:93-102`), `AssembleResponse` (`:104-119`), `loadList` (`:164`),
  `loadConversation` (`:173`), the mount effect (`:196-212`), the Skill-scan effect (`:260-276`),
  `createConversation` (`:300`), `deleteConversation` (`:319`), `commitRename` (`:337`),
  `patchActive` (`:355`), `persistFrames` (`:387`), `clearOptimistic` (`:423`), the assemble block
  inside `sendTurn` (`:444-476`), `attachFiles` (`:602`), `handleSkillCommand`'s decision
  (`:643-664`), `saveToWiki`'s door (`:730`), `lastCitations`/`grouped` (`:741`, `:751`), and the
  hint-prefix expression (`:1069-1071`). STAYING: `thinkingLines` (`:121`), every ref
  (`abortRef`, `turnRef`, `sendInFlight`, `saveInFlight`, `attachRef`, `liveRef`, `drafts`), the
  per-turn state, `stopTurn`, `switchConversation`, `sendTurn`'s own body, `turnHandlers`,
  `driveTurn`, `answerPending`, `pickSkill`, `onSend`, `onComposerKey`, `regenerate`, the Esc
  effect (`:234-249`), and all JSX from `:761`.
- `src/lib/workbench-request.ts` -- `send<T>(url, init)`. The ONLY import the new modules may take
  from it: `epic8-chat-ui.test.tsx:26` and `chat-search-contracts.test.tsx:6` replace the whole
  module with `{ send }`, so any other named import resolves to `undefined` under those suites.
- `src/lib/chat-contract.ts` -- `CHAT_TOKEN_BUDGET_DEFAULT`, `CHAT_HISTORY_DEPTH_DEFAULT`,
  `ChatCitation`, `ChatExportMessage`. Reuse; do not restate the defaults.
- `src/lib/chat-agent.ts` -- `SKILL_SCAN_URL`, `SkillSummary`, `parseSkillCommand`, `matchSkills`,
  `COMPOSER_TOOLS`. Reuse all five; duplicate none.
- `src/lib/loopback-client.ts` -- `loopbackFetch`, the sidecar door the Skill scan uses.
- `src/lib/workbench-intake-client.ts` -- `submitIntakeFiles`, `intakeReport`,
  `intakeShouldRefresh`. The attach path is these three plus `requestDataVersionCheck` from
  `src/lib/workbench-data-version.ts`.
- `src/lib/chat-session-transport.ts`, `src/lib/chat-pending-turn.ts` -- DW-444's modules.
  READ-ONLY: the turn already routes through them and must keep doing so unchanged.
- `src/components/workbench/useReviewBadge.ts` -- the repo's existing hook-as-sibling-file
  convention: `"use client"`, named `use*`, imported by the component beside it. Follow it.
- `src/lib/__tests__/workbench-epic3.test.ts:275-297` -- READ-ONLY EVIDENCE and the one pin this
  change must edit. `expect(chat).toContain("send<{")` fails once the doors move; re-aim that half
  at `src/lib/chat-conversation-store.ts` and pin ChatCanvas's import of it, the way DW-444 re-aimed
  `sidecarChatUrl`. Every other assertion in the file — including
  `expect(chat).not.toContain("await response.json()")` and the `/api/query` / `ChatWorkspace`
  negatives — stays exactly as it is.
- `src/lib/__tests__/chat-session-transport.test.ts:345-370` -- READ-ONLY. Its "seam actually moved"
  pins require `chat` to still contain `@/lib/chat-session-transport` and `@/lib/chat-pending-turn`,
  and both DW-444 modules to stay framework-free. Do not edit; do not break.
- `src/components/workbench/__tests__/epic8-chat-ui.test.tsx`,
  `chat-search-contracts.test.tsx`, `chat-live-stream.test.tsx` -- READ-ONLY. The mounted proof.
  `chat-search-contracts.test.tsx:93-102` is the read-only pin: after clicking New Chat, Delete,
  Regenerate, Save to Wiki and Send, `send` must not have been called at all.
- `AGENTS.md` "Test environments" -- `*.test.ts` ⇒ `node`, `*.test.tsx` ⇒ `dom`; suites live under
  `__tests__`. All three new suites are `.test.ts`. Also: no new source-string guard without naming
  the production regression it catches.

## Tasks & Acceptance

**Execution:**
- `src/lib/chat-conversation-store.ts` -- new framework-free module owning the Chat conversation
  doors and their rules: `ConversationRow`, `CanvasMessage`, `ConversationSettings`,
  `conversationUrl(id)`, `listConversations()`, `readConversation(id)`, `createConversation(settings)`,
  `deleteConversation(id)`, `renameConversation(id, name)`, `patchConversation(id, patch)`,
  `persistConversationMessages(id, frames, options)`, `saveAnswerToWiki(id, messageId)`, plus the
  pure rules `conversationSettings(row)`, `mergeConversationRow(rows, id, patch)`,
  `dropOptimisticMessages(messages)`, `lastAssistantMessage(messages)`,
  `groupCitationsByType(citations)`, `regenerateTarget(messages)` and `messageWirePayload(frames)`
  -- so every URL, body and default is executable without React.
- `src/lib/chat-assemble.ts` -- new framework-free module owning the retrieval door:
  `AssembleResponse` and `assembleTurn({wikiId, query, retrievalMode, tokenBudget, historyDepth,
  history})` with the `typeof coverage !== "boolean"` refusal, plus `chatHistorySlice(messages)`.
  Separate from `chat-pending-turn.ts`, which by its own design never fetches.
- `src/lib/chat-composer.ts` -- new framework-free module owning the composer's non-render
  concerns: `scanSkills(signal)` returning `SkillSummary[] | null` (null means "no list to apply",
  which is what keeps a failed scan from writing state), `attachThroughIntake(files)` returning
  `{note, refresh}`, `skillCommandOutcome(text, skills)` returning `none` / `pick` / `picker`, and
  `composerHintText(current, hint)`.
- `src/components/workbench/useChatConversations.ts` -- new `"use client"` hook holding the
  conversation state (`conversations`, `activeId`, `messages`, `retrievalMode`, `tokenBudget`,
  `historyDepth`, `selectedSkill`), the `loadSeq`/`persistSeq`/`patchChain` guards, the mount load
  effect, and thin callbacks over the store module. It takes `{readOnly, onError}` and owns no
  composer, draft or per-turn state.
- `src/components/workbench/ChatCanvas.tsx` -- delete the moved bodies and call the four new
  seams; keep the refs, the per-turn state, the `readOnly` guards at their existing call sites, and
  every line of JSX.
- `src/lib/__tests__/chat-conversation-store.test.ts` -- new node suite covering every conversation
  and persistence row of the I/O matrix against a mocked `send`, plus the pure rules.
- `src/lib/__tests__/chat-assemble.test.ts` -- new node suite covering the assemble and
  history-slice rows.
- `src/lib/__tests__/chat-composer.test.ts` -- new node suite covering the Skill-scan, attach,
  `/skill` and hint rows, including that a non-ok or thrown scan returns `null` rather than `[]`.
- `src/components/workbench/__tests__/chat-conversation-crud.test.tsx` -- new mounted suite
  for the hook's own serialization, rename and delete paths; see the Spec Change Log.
- `src/lib/__tests__/workbench-epic3.test.ts` -- re-aim only the `send<{` half of the existing pin
  at `src/lib/chat-conversation-store.ts` and pin ChatCanvas's import of it; leave every other
  assertion in the file alone.

**Acceptance Criteria:**
- Given `epic8-chat-ui.test.tsx`, `chat-search-contracts.test.tsx` and `chat-live-stream.test.tsx`
  at `c19a5a29`, when they run against the decomposed component, then every assertion still holds
  with no edit to any of the three files.
- Given `ChatCanvas.tsx` after the change, when it is read, then it contains no `send<` call, no
  `/api/chat/conversations` literal, no `/retrieve` literal, no `SKILL_SCAN_URL` and no
  `submitIntakeFiles`, and it is materially shorter than 1,247 lines.
- Given the three new `src/lib` modules, when the `node` project runs their suites, then every I/O
  matrix row is asserted with no React and no DOM, and none of the three imports `react`.
- Given the repo after the change, when `sidecar/`, `SettingsCanvas.tsx`,
  `src/lib/workbench-settings.ts`, `src/lib/chat-session-transport.ts` and
  `src/lib/chat-pending-turn.ts` are diffed against `c19a5a29`, then they are unchanged.

## Spec Change Log

- 2026-09-04 — the Code Map says every assertion in `workbench-epic3.test.ts`
  other than the `send<{` half "stays exactly as it is". ONE MORE HAD TO MOVE:
  `:314` pins `expect(chat).toContain("body: JSON.stringify({ messageId: assistant.id })")`,
  and that literal is `saveToWiki`'s door body — which the Code Map itself sends
  to `chat-conversation-store.ts` (`saveAnswerToWiki(id, messageId)`). The two
  instructions cannot both hold. Re-aimed the same way DW-444 re-aimed
  `sidecarChatUrl` and the same way this change re-aimed `send<{`: the store is
  pinned to contain `body: JSON.stringify({ messageId })`, and ChatCanvas is
  pinned to contain `saveAnswerToWiki(activeId, assistant.id)` — so the door's
  body and the fact that Save still saves the ANSWER (not the conversation, not
  whatever message is last) each keep a pin, and neither half can drift alone.
  No other assertion in the file changed.

- 2026-09-04 — `scanSkills` returns `null` for a body whose `skills` is not an
  array, per the I/O matrix's "Skill scan" row. At `c19a5a29` that path called
  `setSkills([])`, so this is a deliberate narrowing rather than a pure move.
  It is unobservable in practice: the scan runs once on mount, `skills` starts
  as `[]`, and the only reachable difference would be a re-scan overwriting a
  non-empty list — which no code path performs. The matrix asks for it because
  `null` and `[]` are the two distinct answers the surface must be able to tell
  apart, and a malformed body is "the scan said nothing", not "there are no
  Skills". Asserted in `chat-composer.test.ts`, alongside the one case that IS
  an empty list (`{skills: []}`).

- 2026-09-04 (matrix audit) — the "Patch a setting" row's error column ("a
  rejection is swallowed and does not break the next patch") was covered only at
  the door: `chat-conversation-store.test.ts` proves `patchConversation` keeps no
  poisoned state, but the SWALLOW is `patchChain.current.catch(() => undefined)`
  in `useChatConversations`, which no `node` suite can reach. Losing it is a real
  owner-visible break — a rejected chain's `.then` callback never runs, so after
  one refused toolbar change no later setting would ever persist, with no error
  to read. Closed with a NEW mounted suite,
  `src/components/workbench/__tests__/chat-conversation-crud.test.tsx` (new file
  on purpose, so the three existing mounted suites stay unedited), which drives
  two toolbar patches through the surface with the first refused and asserts the
  second still reaches the door. Mutation-verified: deleting the `.catch` fails
  it. The same file also covers the rename and delete paths the hook took over,
  which had no positive mounted assertion before.

## Review Triage Log

### 2026-09-04 — Review pass 1

- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 4, low 7)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[low]` `[patch]` `createConversation` took the full `ConversationSettings` while serializing only
    three of its four fields, so `selectedSkill` was a dead parameter a typed door is meant to
    refuse — and `startConversation` read it and listed it in its `useCallback` deps, churning the
    callback identity for a value thrown away before the wire. Added
    `CreateConversationSettings = Pick<…, "retrievalMode" | "tokenBudget" | "historyDepth">`,
    stopped passing and depending on `selectedSkill`. The body is byte-identical.
  - `[low]` `[patch]` `AssembleHistoryMessage` in `chat-assemble.ts` collided with
    `wiki-retrieve.ts:95`'s export of the same name in the same directory with an incompatible
    shape. Renamed to `ChatHistorySource` — the canvas message the slice is built FROM, not the
    slice — and the suite now types its fixture with it.
  - `[low]` `[patch]` `scanSkills`'s docblock claimed `null` was "exactly as the original did". False for
    the non-array branch, which used to write `[]`. The comment now names the narrowing and points
    at the Spec Change Log entry that records it.
  - `[low]` `[patch]` ChatCanvas's Skill-scan comment said `null` covered "a wiki with no Skills". It does
    not — that answers `{skills: []}` and is written like any other list, which
    `chat-composer.test.ts` pins. Sentence corrected.
  - `[low]` `[patch]` The store's header claimed every `/api/chat/conversations*` door; the legacy
    `ChatWorkspace.tsx` still opens its own on that path. Claim narrowed to the Workbench's Chat.
  - `[medium]` `[patch]` `loadSeq` and `persistSeq` were declared "LAST WRITER WINS on both legs" with nothing
    exercising either. Both now have a mounted case in the new
    `chat-conversation-crud.test.tsx`; both mutation-verified. The persist half needed a hook probe
    rather than the surface — see the Design Notes addendum.
  - `[medium]` `[patch]` `/skill` had no mounted execution, and it is the only thing stopping a `/skill …`
    line reaching `/retrieve` and then a provider. Added a case asserting the Skill is selected and
    persisted, the composer is cleared, and neither the assemble `send` nor the sidecar `fetch` ran.
  - `[medium]` `[patch]` Attach had no mounted execution. Added a case firing a real `File` at the hidden
    input and asserting both surface effects — Intake's own report on screen, and
    `requestDataVersionCheck` called.
  - `[medium]` `[patch]` New Chat's writes now straddle the hook and the component with nothing crossing the
    seam. Added a case asserting the new row is selected (hook's half) and the old transcript and
    draft are gone (component's half).
  - `[low]` `[patch]` `chat-composer.test.ts`'s "single enabled match" case opened with the DISABLED-Skill
    exclusion, which is a different rule. Split into its own named case, and strengthened: the
    exact name `offsite` does not select it either.
  - `[low]` `[patch]` Every `attachThroughIntake` case called it with `[]`, so a wrapper forwarding the
    wrong argument passed. All cases now pass real `File`s and assert `submitIntakeFiles` received
    exactly that list, in order.

## Design Notes

The split line is "which door, and what does its answer mean" (the `src/lib` modules) versus "when
is that door opened and what state does the answer write" (the hook) versus "what is on screen"
(the component). The doors are pure functions of their arguments, so the node suite can assert the
exact URL, method and body without a component; the hook is deliberately thin glue, because a hook
can only be tested by mounting and the mounted suites must stay unedited.

Two shapes carry a reason and must survive re-derivation:

- `scanSkills` returns `SkillSummary[] | null`, not `SkillSummary[]`. At `c19a5a29` a non-ok or
  thrown scan simply `return`s without calling `setSkills`. Returning `[]` would make the component
  write a fresh empty array on that path — a state write, and a render, the original never did.
- `drafts` stays a component ref and is NOT passed into the hook. It is composer text keyed by
  conversation; the hook owns the conversation, the component owns the composer, and giving the
  hook a draft map would put the composer's state behind the conversation's door.

Example of the intended thinness, replacing `persistFrames` (`:387-421`):

```ts
const persistFrames = useCallback(async (id, frames, options) => {
  const seq = ++persistSeq.current;
  const conversation = await persistConversationMessages(id, frames, options);
  if (seq !== persistSeq.current) return;
  setMessages(conversation.messages ?? []);
  setConversations((rows) => mergeConversationRow(rows, id, conversation));
}, []);
```

The `Persist failed.` throw stays inside `persistConversationMessages`, ahead of the sequence
guard, exactly as it is today.

**Addendum (review pass 1).** `persistSeq` is NOT reachable from the mounted surface, and the
mounted coverage for it says so out loud. `sendTurn` holds `sendInFlight` true for the whole of
`driveTurn`, and `driveTurn` awaits `persistFrames` inside that window, so ChatCanvas serializes
turns and never has two persists open at once; `answerPending` is gated on `pending`, which its own
first statement clears. The guard is still part of the hook's stated contract, and a hook contract
can only be asserted by mounting one — so `chat-conversation-crud.test.tsx` mounts a probe that
renders `useChatConversations` alone and issues the two overlapping writes the surface cannot. The
load guard needs no probe: fast conversation switching reaches it through the real UI, and that
case drives `ChatCanvas` itself.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/chat-conversation-store.test.ts src/lib/__tests__/chat-assemble.test.ts src/lib/__tests__/chat-composer.test.ts src/lib/__tests__/workbench-epic3.test.ts src/lib/__tests__/chat-session-transport.test.ts src/lib/__tests__/chat-pending-turn.test.ts` -- expected: all pass.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/epic8-chat-ui.test.tsx src/components/workbench/__tests__/chat-search-contracts.test.tsx src/components/workbench/__tests__/chat-live-stream.test.tsx` -- expected: all pass.
- `pnpm exec tsc --noEmit` -- expected: exit 0.
- `pnpm test` -- expected: no new failure against the `c19a5a29` baseline.
- `git diff --stat c19a5a29 -- sidecar src/components/workbench/SettingsCanvas.tsx src/lib/workbench-settings.ts src/lib/chat-session-transport.ts src/lib/chat-pending-turn.ts src/components/workbench/__tests__/epic8-chat-ui.test.tsx src/components/workbench/__tests__/chat-search-contracts.test.tsx src/components/workbench/__tests__/chat-live-stream.test.tsx` -- expected: empty.
- `wc -l src/components/workbench/ChatCanvas.tsx` -- expected: materially below 1,247.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

DW-587 is resolved. `ChatCanvas.tsx` went from 1,247 to 1,026 lines, and every concern the ledger
entry named is out of it: conversation CRUD, persistence, the assemble call, the Skill scan,
attachments, regenerate's decision and save-to-wiki. Three framework-free browser modules under
`src/lib` now own the doors and their rules, exercised by `node` suites with no React and no DOM,
and one sibling hook owns the React state those answers land in. The component keeps what is
genuinely its own — the abort controller, the ref-held open turn, the per-turn state, the readOnly
guards at their existing call sites, and 485 lines of JSX. No route, prop or wire body changed, and
the three pre-existing mounted Chat suites pass byte-identical, which is the proof the intent asked
for.

### Files changed

- `src/lib/chat-conversation-store.ts` (new) -- every Workbench `/api/chat/conversations*` door
  (`listConversations`, `readConversation`, `createConversation`, `deleteConversation`,
  `renameConversation`, `patchConversation`, `persistConversationMessages`, `saveAnswerToWiki`) plus
  the pure rules that read an answer: `conversationSettings`, `mergeConversationRow`,
  `dropOptimisticMessages`, `lastAssistantMessage`, `groupCitationsByType`, `regenerateTarget`,
  `messageWirePayload`.
- `src/lib/chat-assemble.ts` (new) -- the `/retrieve` door: `AssembleResponse`, `assembleTurn` with
  the non-boolean-`coverage` refusal, and `chatHistorySlice`.
- `src/lib/chat-composer.ts` (new) -- the composer's non-render concerns: `scanSkills` (`null`
  means "no list to apply"), `attachThroughIntake`, `skillCommandOutcome`, `composerHintText`.
- `src/components/workbench/useChatConversations.ts` (new) -- the conversation state, the
  `loadSeq`/`persistSeq` last-writer-wins guards, the serialized `patchChain` with its swallowed
  rejection, the mount load, and thin callbacks over the store.
- `src/components/workbench/ChatCanvas.tsx` -- the moved bodies deleted and the four seams called;
  refs, per-turn state, readOnly guards and every line of JSX kept.
- `src/lib/__tests__/chat-conversation-store.test.ts` (new) -- 26 node tests over the doors and the
  rules.
- `src/lib/__tests__/chat-assemble.test.ts` (new) -- 8 node tests over the assemble and the slice.
- `src/lib/__tests__/chat-composer.test.ts` (new) -- 20 node tests over the scan, the attach, the
  `/skill` decision and the hint.
- `src/components/workbench/__tests__/chat-conversation-crud.test.tsx` (new) -- 5 mounted tests for
  what only a mount can reach: the patch chain's swallow, the two sequence guards, `/skill` through
  the composer, Attach through the file input, and New Chat's split state writes.
- `src/lib/__tests__/workbench-epic3.test.ts` -- the `send<{` and `messageId` pins follow the doors
  to the store and gain their negative halves; every other assertion in the file is untouched.

### Review findings

- Patches applied: 11 (high 0, medium 4, low 7) -- see the Review Triage Log for each.
- Items deferred: 1 (low) -- Chat's create/delete/rename call sites report nothing when their door
  refuses.
- Items rejected: 8 -- pre-existing shapes unchanged from `c19a5a29` (the create body's dropped
  Skill, `removeConversation`'s list snapshot, a null read leaving settings stale, rename not
  sharing the patch chain), hypothetical wire shapes the routes do not produce (a non-array
  `conversations`, an out-of-range stored budget), the `AssembleResponse`/`AssembledContext`
  hand-copy that predates the move, and a proposed source-string guard that names no regression.

### Follow-up review recommendation

`false`. Patched findings this pass: high 0, medium 4, low 7. The rule is `true` only when a
patched finding was `high`; medium and low are fixed in-pass and recorded.

### Verification performed

- `pnpm exec vitest run --project node` over `chat-conversation-store`, `chat-assemble`,
  `chat-composer`, `workbench-epic3`, `chat-session-transport`, `chat-pending-turn` -- 117 passed.
- `pnpm exec vitest run --project dom` over `epic8-chat-ui`, `chat-search-contracts`,
  `chat-live-stream`, `chat-conversation-crud` -- 22 passed.
- `pnpm exec tsc --noEmit` -- exit 0. `pnpm lint` -- exit 0.
- `pnpm test` -- 385 files, 9,534 passed, 1 skipped, 0 failed (9,527 before the review patches,
  9,528 at `c19a5a29` scale with no failure at any point).
- `git diff --stat c19a5a29 -- sidecar src/components/workbench/SettingsCanvas.tsx
  src/lib/workbench-settings.ts src/lib/chat-session-transport.ts src/lib/chat-pending-turn.ts` and
  the three pre-existing mounted Chat suites -- empty.
- `wc -l src/components/workbench/ChatCanvas.tsx` -- 1,026, down from 1,247. The file contains no
  `send<`, no `/api/chat/conversations`, no `/retrieve`, no `SKILL_SCAN_URL`, no
  `submitIntakeFiles`, no `getReader()` and no `sidecarChatUrl`.
- Matrix test audit: every I/O row is covered by a test that ran and passed above. The "Patch a
  setting" row's error column needed the new mounted suite, because the swallow lives in the hook;
  that gap and its closure are recorded in the Spec Change Log.
- Mutation-verified: the patch-chain swallow, both sequence guards, the `/skill` short-circuit,
  Attach's data-version check, and New Chat's transcript reset each fail their own test when
  deleted.

### Residual risks

- The hook is glue a `node` suite cannot reach. Five of its behaviours now have mounted assertions;
  the rest is covered only indirectly, through the pre-existing mounted Chat suites.
- The deferred row above is live: a refused create, delete or rename is still an unhandled
  rejection with no sentence in front of the owner. Pre-existing, and unchanged by this pass.
- `AssembleResponse` remains a hand-copy of `wiki-retrieve.ts`'s `AssembledContext` with nothing
  tying the two together. It was a hand-copy inside the component before; the move made it visible
  without making it worse.
