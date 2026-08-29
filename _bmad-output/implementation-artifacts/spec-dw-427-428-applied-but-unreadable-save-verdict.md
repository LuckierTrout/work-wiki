---
title: 'A third save verdict: an unreadable 2xx clears the held version instead of keeping it'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
baseline_revision: '87085918f4eed57d6caf5bb4a133be77b2aa2773'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `SETTINGS_SAVE_FAILED_COPY` tells the owner their settings were not saved on the one
      branch whose whole justification is that nobody knows whether they were.
    evidence: |-
      The `unreadable` verdict clears the held version on the stated ground that a 2xx is no
      proof the route did not run (`src/lib/workbench-settings.ts:3103-3119`), and the canvas
      acts on it (`SettingsCanvas.tsx:343`). The sentence shown beside that action is
      "Settings couldn't be saved." — an assertion the same reasoning says nobody is in a
      position to make. The neighbouring `it.each` docblock in `workbench-settings.test.ts`
      spells out exactly that objection for the sibling branch. Fixing it means a new
      owner-facing sentence for a third outcome, which is an intent-level copy decision this
      bundle's intent did not open.
    location: >-
      src/lib/workbench-settings.ts:3232 and src/lib/workbench-settings.ts (SETTINGS_SAVE_FAILED_COPY)
    severity: medium
  - summary: >-
      Once the held version is cleared, the Settings canvas is a dead end: every later save is
      refused 428 and the only recovery is a reload that destroys the draft.
    evidence: |-
      `SettingsCanvas.save` clears `payload.version` and nothing on this surface ever restores
      it — the read effect runs once on mount and there is no re-seed affordance. Every
      subsequent save therefore carries no `If-Match` and is answered 428, whose recovery half
      is "copy it, reload, and apply it to the current version". `SkillsCanvas.toggle` shows
      the available shape: re-read ONLY the version via `fetchWorkbenchSettings()` and leave
      the draft alone. Pre-existing since DW-376; DW-427 brings a second branch to the same
      dead end rather than creating it, and the one-call-site scan at
      `workbench-settings.test.ts:4661` means adding a re-seed is a deliberate decision.
    location: >-
      src/components/workbench/SettingsCanvas.tsx:343-372
    severity: medium
  - summary: >-
      `savePreviewBody` reads its 2xx body with an unguarded `.catch(() => null)` and still
      answers `{ status: "ok" }`, so a body read that dies mid-stream is reported to Preview as
      a LANDED save.
    evidence: |-
      That is the exact misclassification DW-408 fixed for Settings, still live on the sibling
      write client: `workbench-preview.ts` parses the success body without the
      `unconfirmedCause` rethrow that `saveWorkbenchSettings` now has, so an abort or a dropped
      socket during the body read is indistinguishable from a clean save. Out of scope here —
      this bundle's intent names the Settings client only — but nothing else records it.
    location: >-
      src/lib/workbench-preview.ts (savePreviewBody success-body parse)
    severity: medium
  - summary: >-
      The refusal branch's body parse in `saveWorkbenchSettings` is unguarded, so a refusal
      body read that dies mid-stream is classified as an arrived, fully read refusal.
    evidence: |-
      `const body = (await response.json().catch(() => null))` on the `!response.ok` path has
      no `unconfirmedCause` rethrow, unlike the success parse twenty lines below. An aborted or
      dropped refusal body therefore yields `served === ""` and the fallback sentence, with the
      held version kept. That is defensible — a refusal status arrived and nothing was applied
      — but it is decided by omission rather than stated, and the asymmetry with the guarded
      success parse is invisible.
    location: >-
      src/lib/workbench-settings.ts:3179-3183
    severity: low
  - summary: >-
      `SettingsSaveResult`'s two booleans can express four states when only three are legal;
      nothing forbids `{ unconfirmed: true, unreadable: true }`.
    evidence: |-
      The Design Notes enumerate exactly three verdicts, and `saveWorkbenchSettings` cannot
      currently construct the fourth — but the type permits it, no test pins that the two are
      never both true, and a future construction site could produce it silently. A single
      discriminated `verdict: "refused" | "unconfirmed" | "unreadable"` would make it
      unconstructible; changing the shape now would touch every call site and every assertion.
    location: >-
      src/lib/workbench-settings.ts:3087-3120
    severity: low
---

<intent-contract>

## Intent

**Problem:** DW-408 landed a throwing 2xx body on `saveWorkbenchSettings`'s shapeless-200 branch, which answers `{ status: "error", message: fallback, unconfirmed: false }` (`src/lib/workbench-settings.ts:3196-3200`). `SettingsCanvas.save` clears the held `version` ONLY inside `if (result.unconfirmed)` (`SettingsCanvas.tsx:343-365`), so on that branch the owner keeps a version a 2xx may already have superseded and the next save is refused as 412 — "somebody else changed this while you were editing", about an actor that does not exist — where clearing it yields the truthful 428 (DW-427). And no canvas-level test drives an `ok: true` whose `json` rejects, so what `If-Match` the next save carries after one is unobserved end to end (DW-428).

**Approach:** Apply the recorded 2026-08-28 decision: give `SettingsSaveResult`'s error branch a third, REQUIRED verdict field alongside `unconfirmed`, named `unreadable` for the fact it states (the answer arrived, but its body yielded no payload), set on the shapeless/unparseable-200 branch and on nothing else, and have `SettingsCanvas.save` clear the held version on it as well as on `unconfirmed`. Pin it at the client's return value and at the canvas seam.

## Boundaries & Constraints

**Always:** `unreadable` is REQUIRED on every `status: "error"` result, for the same reason `unconfirmed` is — a future construction site must not be able to forget the verdict into a silent `false`; the two refusal construction sites (`refusedWriteFailure` spread, outer `catch`) therefore state it explicitly. It is `true` on exactly one branch: a 2xx whose body did not yield a payload — whether it failed to PARSE or parsed to something shapeless, which are the same fact and already share one branch. A body read that DIES mid-stream stays an `unconfirmedCause` rethrow answering `unconfirmed: true` — unchanged. `SettingsCanvas` clears the held version on `unconfirmed || unreadable` and keeps every edit, the draft and the payload's VALUES on both.

**Block If:** the shapeless-200 branch no longer exists as the single place a 2xx without a usable payload lands; or `unconfirmedCause` no longer decides which body-read failures are rethrown.

**Never:** Do not change any owner-facing copy — the sentence on this branch stays `SETTINGS_SAVE_FAILED_COPY`, and the unknown-outcome sentence stays off it. Do not touch `WriteFailure`, `refusedWriteFailure`, `thrownWriteFailure` or any other surface's verdict (`PreviewColumn`, `WikiSwitcher`, `WikiWorkbench`, `workbench-preview.ts`, `workbench-intake-client.ts`). Do not touch `fetchWorkbenchSettings`, `SkillsCanvas` (it re-reads its version per click and holds none), or the deferred-work ledger. Do not give this route's own 503 the `unreadable` verdict.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unparseable 2xx | `ok: true, status: 200`, `json` rejects with `SyntaxError` | `{ status: "error", message: SETTINGS_SAVE_FAILED_COPY, unconfirmed: false, unreadable: true }` | Never the unknown-outcome sentence |
| Shapeless 2xx | `ok: true`, body `{ saved: true }` | Same verdict as the row above — one branch, one answer | Same |
| Body read dies mid-stream | `ok: true`, `json` rejects with `TimeoutError`/`AbortError`/`TypeError` | Unchanged: `unconfirmed: true`, composed unknown-outcome sentence, `unreadable: false` | Unchanged |
| Arrived refusal | 400/412/428/500, and this route's own 503 with `CONFIG_UNREADABLE_COPY` | Server's sentence, `unconfirmed: false`, `unreadable: false` — nothing was applied, the held version is still current | Unchanged |
| Gateway / dropped connection | `UNCONFIRMED_STATUSES`, or `send` rejects | Unchanged: `unconfirmed: true`, `unreadable: false` | Unchanged |
| Canvas, unparseable 2xx then save again | Seeded at version V, save answers an unparseable 200, owner edits and saves again | Second save carries NO `If-Match` and is answered 428; every edit still on screen | Never a second save carrying V |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts` -- the fix site. `SettingsSaveResult` at :3087-3101 — the error branch's `unconfirmed` docblock (:3092-3099) is the voice to match for `unreadable`. `saveWorkbenchSettings` :3128-3206: refusal return `{ status: "error", ...refusedWriteFailure(...) }` :3164-3168; the DW-408 comment block :3169-3191 (already argues the consumer's direction and needs its conclusion updated — it currently ENDS on "clearing it yields the truthful 428" as an argument for rethrowing, and must now also say what the arrived-but-unreadable half does); the guarded parse `await response.json().catch(...)` :3192-3195; the shapeless-200 return :3196-3200; outer catch `{ status: "error", ...thrownWriteFailure(...) }` :3201-3205. Docblock :3103-3127 states the shapeless-200 rule and the 503 exception — extend, don't rewrite.
- `src/components/workbench/SettingsCanvas.tsx` -- the consumer. `save` :304-366: `setSaveError(result.message)` :342, `if (result.unconfirmed) {` :343 with the tie-break comment :344-361, `setPayload((current) => current ? { ...current, version: undefined } : current)` :362-364. The landed-save re-seed comment (:325-338) makes the identical argument from the other side — the new branch's comment should point at it rather than restate it a third time.
- `src/components/workbench/SkillsCanvas.tsx` -- READ-ONLY. `toggle` (:91-122) re-reads the version per click and holds none, so `unreadable` changes nothing here. Named so the implementer does not "fix" it.
- `src/lib/workbench-request.ts` -- READ-ONLY. `WriteFailure` :185-202, `thrownWriteFailure` :245-257, `refusedWriteFailure` :265-278, `unconfirmedCause` :154-159. Shared by four other surfaces; `unreadable` lives on `SettingsSaveResult` only.
- `src/lib/__tests__/workbench-settings.test.ts` -- every save-error `toEqual` that must gain `unreadable`: :3022-3032 (400 served + plain `Error` fallback), :3040-3052 (blank 500), :3063-3067 (gateway loop), :3096-3099 (shapeless 200), :3115-3132 (unparseable 200 — the DW-408 case whose comment says it "pins the verdict; it does not flip it", now the one being extended), :3149-3169 (the `it.each` mid-stream-death cases), :3199-3204 (this route's own 503), :3217-3232 (412 and 428). `stubFetch` :2733-2751 — its `json` cannot throw, so throwing cases stay bare `SettingsFetch` literals.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- where DW-428 lands. The DW-63/DW-376 describe starts :364; `mountWritable(responses)` :369-378 (one response per call), `read(version)` :380-386, `saved(version)` :388-397, `typeChatModel` :399-401, `ifMatchOf(call)` :403-406. The DW-376 docblock :500-511 and the `UNCONFIRMED` table :512-529 (504 + `TypeError` only) — the gap. The 503 case :581-606 is the counterexample that must keep passing (version KEPT). `WRITE_PRECONDITION_REQUIRED_COPY` is already imported and is the 428 sentence used by the neighbouring cases.
- `src/lib/__tests__/write-precondition.test.ts` -- READ-ONLY scan (:562-601) forbidding the 412/428 sentences from being typed in `workbench-settings.ts` or `SettingsCanvas.tsx`. Both change here; neither may spell either sentence in code (comments quoting them already exist and are what the scan tolerates — it matches on the copy constants' first 40 characters, so keep new comments paraphrasing as the existing ones do).

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- add `unreadable: boolean` to `SettingsSaveResult`'s error branch with a docblock in `unconfirmed`'s voice that states the fact (a 2xx arrived, its body yielded no payload), the caller's duty (clear the held version so the next save re-seeds), and the two things it is NOT (not the unknown outcome — the answer arrived; not this route's own 503, which applied nothing and keeps the version). Set it `true` on the shapeless-200 return and explicitly `false` at the refusal and outer-catch returns. Update the DW-408 comment block so it carries the arrived-but-unreadable half through to its consequence instead of stopping at the rethrow.
- `src/components/workbench/SettingsCanvas.tsx` -- widen the version-clearing branch in `save` to `unreadable` as well as `unconfirmed`, and say in the comment what separates them (one is "nobody answered", the other is "the route answered and we could not read it") and why both end at the same action -- the held version is the one thing on screen that can now be a lie either way.
- `src/lib/__tests__/workbench-settings.test.ts` -- carry `unreadable` through every save-error `toEqual` listed in the Code Map; extend the shapeless-200 and unparseable-200 cases to assert it is `true` on its own as well as inside the object, and the mid-stream-death `it.each` and the 503/412/428 refusals to assert it is `false` -- the whole point is which side of the line each cause falls on.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- add a case to the DW-63/DW-376 describe that mounts writable, answers the save with `ok: true, status: 200` whose `json` rejects with a `SyntaxError`, then edits and saves again against a 428, asserting the first save carried the seeded `If-Match`, the second carries none, the 428 sentence is shown, and every edit survives -- the seam the client suite cannot see. Extend the DW-376 docblock to say the table now covers both sides of the 2xx body read.

**Acceptance Criteria:**
- Given the Settings canvas seeded at a version and a save whose 200 body fails to parse, when the owner edits and saves again, then that second save carries no `If-Match` at all and is refused with the 428 sentence, with every edit still on screen.
- Given the same canvas and this route's own 503 refusal, when the owner saves again, then the save still carries the seeded `If-Match` — `unreadable` did not widen into arrived refusals.
- Given a save answered by a gateway status or a dropped connection, when the canvas shows the outcome, then the unknown-outcome sentence is shown exactly as before and `unreadable` played no part in it.

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 4, low 4)
- defer: 5: (high 0, medium 3, low 2)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The tie-break argument every comment in this area rests on misquoted
    `WRITE_CONFLICT_COPY`: the real 412 sentence names no actor, so "a sentence about an actor
    that does not exist" was never what the owner reads. Re-derived from what the copy actually
    says — the 412 declares outright that the save was not applied and puts the change down to
    somewhere else, which on this branch may be the owner's own save a moment earlier — and the
    paraphrase removed from all five sites inside the changed files, including the three
    pre-existing ones. No comment quotes either sentence, so `write-precondition.test.ts`'s scan
    still passes.
  - `[medium]` `[patch]` The `unreadable` docblock's causal chain ran backwards ("a 2xx is not
    proof the route ran, SO the config may have moved past it"). Restated in the coherent
    direction `SettingsCanvas` already used: a 2xx is no proof the route did NOT run.
  - `[medium]` `[patch]` The pre-existing comment "it ran and it replied, so nothing here is
    unknown" ended up directly above the return that now answers `unreadable: true`, flatly
    contradicting the uncertainty that verdict is justified by. Rewritten to separate what is
    known (a status line arrived) from what the missing payload leaves open (whether the route
    ran and rotated the version).
  - `[medium]` `[patch]` The change sets `unreadable: true` for BOTH producers, but only the
    parse-failure half was driven at the canvas — reproducing, for the widened half, the very
    gap DW-428 exists to close. The canvas case became a two-row table covering a body that
    will not parse and a 200 that parses to `{ saved: true }`; reverting the canvas condition
    now fails both rows.
  - `[low]` `[patch]` The refusal branch's new comment claimed "a verdict ARRIVED and was
    read", which its unguarded parse does not guarantee. Reworded to claim only the status, and
    to state the unguarded parse explicitly.
  - `[low]` `[patch]` Two prose slips in the canvas suite: a comment saying "a shapeless 200"
    over a `SyntaxError` stub, and a docblock claiming its table covered both sides of the 2xx
    body read while explaining that the `unreadable` half sits outside it. Both corrected.
  - `[low]` `[patch]` The 503 stub was named `unreadable`, shadowing the new field inside the
    block asserting `unreadable: false`. Renamed `storeUnreadable` and the comment reargued
    from the fact rather than the name.
  - `[low]` `[patch]` The new canvas case never pinned the call count before its second save,
    and `mountWritable` pads with its last response — an extra request would have silently
    shifted what `ifMatchOf(2)` inspected. Call count now asserted.

## Design Notes

Three verdicts now, and each is decided by what came back rather than by what the caller would like to do about it:

```ts
// arrived refusal     — nothing applied           → keep the version
{ status: "error", message: served, unconfirmed: false, unreadable: false }
// nothing arrived     — the patch MAY have landed → clear the version
{ status: "error", message: unknownSentence, unconfirmed: true, unreadable: false }
// arrived, unreadable — a 2xx with no payload     → clear the version
{ status: "error", message: fallback, unconfirmed: false, unreadable: true }
```

The third one is deliberately NOT folded into `unconfirmed`. `unconfirmed` is what the unknown-outcome sentence is composed from and what every other surface reads; widening it here would put "the outcome is unknown" on screen over a status line that arrived. Naming the fact — the body could not be read — rather than the consequence keeps the claim provable: a 200 from an intermediary is not proof the route ran, so the field must not assert that the patch was applied, only that nothing usable came back and the held version can therefore no longer be relied on.

The owner-facing sentence on this branch stays `SETTINGS_SAVE_FAILED_COPY`. Whether that copy is right for a 2xx is a separate, intent-level question this change deliberately does not open.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-settings.test.ts src/components/workbench/__tests__/settings-read-only.test.tsx src/lib/__tests__/write-precondition.test.ts src/lib/__tests__/workbench-request.test.ts` -- expected: all pass
- `pnpm exec tsc --noEmit` -- expected: clean
- `pnpm lint` -- expected: clean
- `pnpm test` -- expected: no new failures against the pre-change baseline

## Auto Run Result

Status: done

**Implemented change.** `SettingsSaveResult`'s error branch gained a third, REQUIRED verdict —
`unreadable` — for a 2xx whose body yields no payload, whether it failed to parse or parsed to
something shapeless. It is `true` on that one branch and explicitly `false` at the refusal and
thrown returns, so no construction site can forget it into a silent default. `SettingsCanvas.save`
now clears the held `version` on `unconfirmed || unreadable`: the owner no longer keeps a version
a 2xx may have superseded, so the next save carries no `If-Match` and gets the truthful 428
instead of a 412 that would declare the save unapplied and blame a change made somewhere else
(DW-427). A body read that DIES mid-stream is unchanged — still an `unconfirmedCause` rethrow
answering `unconfirmed: true`, because a status line that arrived must never be described as
silence. The verdict is pinned at both surfaces: at the client's return value in
`workbench-settings.test.ts`, and at the seam in `settings-read-only.test.tsx`, where a new
two-row table drives the canvas with both producers and asserts what `If-Match` the NEXT save
carries (DW-428).

**Files changed.**
- `src/lib/workbench-settings.ts` -- added `unreadable: boolean` to `SettingsSaveResult`'s error
  branch with its docblock; set it on all three returns; reworked the DW-408 comment block and
  the shapeless-200 comment so the arrived-but-unreadable half is carried through to its
  consequence.
- `src/components/workbench/SettingsCanvas.tsx` -- version-clearing branch widened to
  `unconfirmed || unreadable`, with the comment saying what separates the two facts and why they
  end at one action.
- `src/lib/__tests__/workbench-settings.test.ts` -- `unreadable` carried through every save-error
  `toEqual`, asserted `true` standalone on both unreadable producers and `false` on the
  mid-stream-death and refusal cases; 503 stub renamed.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- new `UNREADABLE` canvas
  table (a body that will not parse, and a 200 parsing to `{ saved: true }`) plus a new
  `UNCONFIRMED` row for a 2xx body read that dies mid-stream.

**Review findings.** 8 patches applied (medium 4, low 4); 5 items deferred (medium 3, low 2);
6 rejected; 0 intent gaps, 0 spec defects. Follow-up review recommended: **true** — patched
severities were high 0, medium 4, low 4, scoring 3x4 + 1x4 = 16, at or above the threshold of 5.

**Verification.**
- `pnpm vitest run src/lib/__tests__/workbench-settings.test.ts
  src/components/workbench/__tests__/settings-read-only.test.tsx
  src/lib/__tests__/write-precondition.test.ts src/lib/__tests__/workbench-request.test.ts`
  -- 339 passed, 4 files, no failures.
- `pnpm exec tsc --noEmit` -- clean. `pnpm lint` -- clean (only the pre-existing `jsx-ast-utils`
  `TSNonNullExpression` notices).
- `pnpm test` -- 7577 passed, 229 failed. The failing set was measured at the baseline revision
  by stashing this change and re-running those 13 files: identical 13 files / 229 tests fail
  there too, on `window.localStorage` being undefined in those dom suites. No new failures; the
  passing count rose by the 3 tests added.
- Regression guard: reverting only `|| result.unreadable` fails both rows of the new canvas
  table, so the added coverage is not vacuous. Restored and re-verified.
- Matrix audit: every I/O row has a covering test that ran and passed -- unparseable 2xx and
  shapeless 2xx (client + canvas), mid-stream body death (client `it.each` + canvas row),
  arrived refusals including this route's own 503, gateway/dropped connection, and the
  canvas-level "next save carries no `If-Match`" row.

**Residual risks.** The owner-facing sentence on the new branch is still
`SETTINGS_SAVE_FAILED_COPY`, which asserts the save did not happen on the one branch whose
justification is that nobody knows -- deferred, because a third outcome needs a copy decision the
intent did not open. Clearing the version leaves the surface with no in-app re-seed, so every
later save is refused 428 until a reload; that dead end is pre-existing from DW-376 and this
change brings a second branch to it. `savePreviewBody` still carries the unguarded success-body
parse DW-408 fixed here. All three are recorded in frontmatter `deferred`.
