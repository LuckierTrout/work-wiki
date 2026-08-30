---
title: 'One save verdict per write client: guard the Preview body read, pin the refusal parse, collapse the Settings booleans'
type: 'bugfix'
created: '2026-08-30'
status: 'done'
baseline_revision: 'f855e0e16a159c72c50c0ac1fe1c66112597df83'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      The DW-556 misclassification is still live on three sibling write paths: a 2xx body read
      that dies mid-stream is swallowed and the write is reported as LANDED.
    evidence: |-
      `savePreviewBody` and `saveWorkbenchSettings` now rethrow an `unconfirmedCause` out of
      their 2xx body parse. Three siblings do not. `useSettings.ts:356` reads `PUT
      /api/settings`'s answer with a bare `.catch(() => null)` and then shows "Settings saved.";
      `WikiEditor.tsx:282` does the same on `PUT /api/wiki/[slug]` and adopts the pre-save
      version before navigating away; `send` and `sendForm` (`workbench-request.ts:66,98`)
      swallow it into `{}`, so the destructure that follows can report a landed create, rename
      or delete as a failure. The same abort or dropped socket therefore still reaches the
      owner as a settled outcome on all three. Out of scope here — this bundle's intent names
      the two Workbench write clients only.
    location: >-
      src/hooks/useSettings.ts:356, src/components/WikiEditor.tsx:282, src/lib/workbench-request.ts:66
    severity: medium
  - summary: >-
      `SkillsCanvas.toggle` shows the unknown-outcome sentence for a toggle that may have
      landed and never re-scans, so the rail can keep showing the pre-toggle state.
    evidence: |-
      `SkillsCanvas.tsx:106-118` calls `saveWorkbenchSettings` and re-scans only on
      `result.status === "ok"`; every error path sets the message and returns. A
      `"unconfirmed"` verdict means the enablement flip may already be stored, so the list it
      renders can disagree with the sidecar until something else triggers a scan. Pre-existing
      since DW-376 — the verdict collapse only made the state readable by name — and this is
      the one `saveWorkbenchSettings` call site the intent deliberately left untouched.
    location: >-
      src/components/workbench/SkillsCanvas.tsx:106-118
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three verdict defects survive DW-427/DW-428. `savePreviewBody` parses its 2xx body with an unguarded `.catch(() => null)` and still answers `{ status: "ok" }`, so an abort or a dropped socket mid-body is reported to `PreviewColumn` as a LANDED save — the exact misclassification DW-408 fixed on the sibling Settings client (DW-556). The refusal-branch parse in `saveWorkbenchSettings` is deliberately unguarded and its consequence is argued only in a comment, with nothing executing it (DW-557). And `SettingsSaveResult` carries two independent booleans that can express four states when exactly three are legal — nothing forbids `{ unconfirmed: true, unreadable: true }` (DW-558).

**Approach:** Give `savePreviewBody`'s success-body parse the same guarded-parse/rethrow shape `saveWorkbenchSettings` already has, so a body read that DIES mid-stream reaches the outer catch and answers `unconfirmed: true`, while a body that merely fails to PARSE still answers a landed save with no version. Add a test that executes the Settings refusal branch with a dying body read, so its fallback answer is pinned rather than only argued. Replace `SettingsSaveResult`'s `unconfirmed`/`unreadable` pair with one discriminated `verdict: "refused" | "unconfirmed" | "unreadable"`, mapped from `WriteFailure` in one place, updating `SettingsCanvas` and both suites together. No observable behaviour changes except the one DW-556 fixes.

## Boundaries & Constraints

**Always:** The three Settings verdicts keep exactly the meanings the DW-427 Design Notes gave them, only renamed into one field: `refused` is today's `{ unconfirmed: false, unreadable: false }` (an arrived refusal, or a thrown cause that is not an unconfirmed one — nothing was applied as far as this client can tell, so the caller KEEPS its held version); `unconfirmed` is today's `{ unconfirmed: true }` (nothing came back); `unreadable` is today's `{ unreadable: true }` (a 2xx whose body yielded no payload). The mapping from `WriteFailure.unconfirmed` to a verdict lives in ONE helper, used by both the refusal and the outer-catch returns, so the two cannot drift. `SettingsCanvas` clears the held version on `unconfirmed` and on `unreadable`, and keeps every edit, the draft and the payload's VALUES on both — unchanged behaviour, restated against the new field. On the Preview side, `unconfirmedCause` remains the single rule deciding which body-read failures are rethrown, and `PreviewSaveResult` keeps its `unconfirmed` boolean — it has one legal error state, not three.

**Block If:** the shapeless-200 branch no longer exists as the single place a 2xx without a usable payload lands in `saveWorkbenchSettings`; or `SettingsSaveResult` has grown a consumer outside `SettingsCanvas` that reads a verdict field this change removes.

**Never:** Do not change any owner-facing copy, on either surface — no new sentence, no sentence moved to another branch. Do not touch `WriteFailure`, `writeFailure`, `refusedWriteFailure`, `thrownWriteFailure` or `unconfirmedCause` in `workbench-request.ts`; they are shared by five surfaces. Do not add an `unreadable`-style verdict to `PreviewSaveResult` — DW-556 is the guarded parse only, and a 2xx whose body will not PARSE stays a landed save there (that contract is `PreviewSaveResult.version`'s docblock and is out of scope). Do not guard the refusal-branch parse in either client — DW-557 pins the current answer, it does not change it. Do not touch `revertArtifactRevision`, `workbench-intake-client.ts`, `SkillsCanvas` (it reads only `result.status`), `fetchWorkbenchSettings`, or the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Preview 2xx, body read dies | `savePreviewBody`, `ok: true`, `json` rejects with `TimeoutError`/`AbortError`/`TypeError` | CHANGED: `{ status: "error", message: unconfirmedWriteMessage(action), unconfirmed: true }` | Never `{ status: "ok" }` |
| Preview 2xx, body will not parse | `ok: true`, `json` rejects with `SyntaxError` | Unchanged: `{ status: "ok" }`, no version | Never the unknown-outcome sentence |
| Preview 2xx, body carries no version | `ok: true`, body `{ ok: true }` / `{ version: "" }` | Unchanged: `{ status: "ok" }` | Unchanged |
| Preview canvas, body read dies | Editor seeded at V, save answers a 2xx whose body read dies, owner saves again | Unknown-outcome sentence, editor and draft kept, `dataVersion` nudged, second save carries no `If-Match` | Never a second save carrying V |
| Settings refusal, body read dies | `ok: false, status: 400`, `json` rejects with `TypeError` | `{ status: "error", message: SETTINGS_SAVE_FAILED_COPY, verdict: "refused" }` — held version kept | Never `unconfirmed`, never `unreadable` |
| Settings arrived refusal | 400/412/428/500, and this route's own 503 with `CONFIG_UNREADABLE_COPY` | Server's sentence, `verdict: "refused"` | Unchanged |
| Settings gateway / dropped connection | `UNCONFIRMED_STATUSES`, or `send` rejects with an unconfirmed cause | Unknown-outcome sentence, `verdict: "unconfirmed"` | Unchanged |
| Settings thrown, not an unconfirmed cause | `send` rejects with a plain `Error` | Fallback sentence, `verdict: "refused"` — same answer the two booleans gave | Unchanged |
| Settings 2xx with no payload | `ok: true`, body `{ saved: true }`, or `json` rejects with `SyntaxError` | Fallback sentence, `verdict: "unreadable"` | Unchanged |
| Illegal fourth state | any `status: "error"` result | Object has exactly `status`, `message`, `verdict`; `verdict` is one of the three | Unconstructible by type |

</intent-contract>

## Code Map

- `src/lib/workbench-preview.ts` -- DW-556's fix site. `savePreviewBody` :1428-1487; the success branch's unguarded parse is `const landed = (await response.json().catch(() => null))` :1470-1474, immediately above the `typeof landed?.version === "string"` return :1475-1477. The shape to copy is `workbench-settings.ts`'s guarded parse (see below). Import list :13-17 pulls `refusedWriteFailure, thrownWriteFailure, unconfirmedStatus` from `./workbench-request` — add `unconfirmedCause`. `PreviewSaveResult` :1377-1390: its `version` docblock states the "a body that will not parse is still a landed save" contract that must survive; its `unconfirmed` docblock is the caller's duty. The REFUSAL-branch parse :1478-1479 stays unguarded and untouched. `revertArtifactRevision` (below :1500) is READ-ONLY.
- `src/lib/workbench-settings.ts` -- DW-557 and DW-558's site. `SettingsSaveResult` :3221-3255 — the error branch's `unconfirmed` docblock :3225-3233 and `unreadable` docblock :3234-3253 are the two voices to fuse into the new field's; both say REQUIRED-so-nobody-forgets, which the discriminated field makes structural. `saveWorkbenchSettings` :3299-3384: refusal return :3311-3331 (spreads `refusedWriteFailure`, states `unreadable: false` and already carries DW-557's argument in its comment :3322-3330 — the unguarded parse is :3317-3319); the DW-408 comment block :3338-3362; the guarded parse :3363-3366 (**the shape DW-556 copies**); the shapeless-200 return :3367-3376; outer catch :3377-3393. Import :39-43 already has `refusedWriteFailure, thrownWriteFailure, unconfirmedCause` — add `type WriteFailure` for the mapping helper.
- `src/lib/workbench-request.ts` -- READ-ONLY. `WriteFailure` :183-201 (`message` + `unconfirmed`), `unconfirmedCause` :154-159, `refusedWriteFailure` :265-278 (returns `unconfirmed: true` on a gateway status — which is why the mapping is not "refusal ⇒ refused"), `thrownWriteFailure` :245-257.
- `src/components/workbench/SettingsCanvas.tsx` -- the one consumer of the verdicts. `save` :307-374; `setSaveError(result.message)` :342; `if (result.unconfirmed || result.unreadable) {` :344 with the DW-427 comment :345-370. Only the condition and the field names in that comment change; the action and the copy do not.
- `src/components/workbench/SkillsCanvas.tsx` -- READ-ONLY. `toggle` :91-122 reads `result.status` and `result.message` only, so the shape change does not reach it. Named so it is not "fixed".
- `src/lib/__tests__/workbench-preview.test.ts` -- DW-556's client pin. `describe("savePreviewBody")` starts :2446. `stubFetch` :2186-2197 (an `Error` returned by the handler is THROWN) and `jsonResponse` :2199-2208 (`body === undefined` makes `json` reject with a `SyntaxError` — which is why the existing "still reports a landed save when the answer carries no version" case :2658-2667 must keep passing). `abortError(name)` :2210-2214 is the helper for the two abort flavours. The thrown-cause case :2578-2608 is the model for an `it.each`-style verdict table.
- `src/components/workbench/__tests__/preview-dirty-guard.test.tsx` -- DW-556's seam pin. `describe("a save nothing came back from (DW-376)")` :591-700: `stubUnconfirmed(writes, write)` :604-636 (the handler's return is thrown when it is an `Error`, so a dying body read must be expressed as a response object whose `json` rejects), the `UNCONFIRMED` two-row table :639-650, and the shared `it` :652-702 asserting the editor, the sentence, the `dataVersion` nudge and the second save's absent `If-Match`. A third row is all this needs.
- `src/lib/__tests__/workbench-settings.test.ts` -- every Settings verdict assertion. `saveWorkbenchSettings` cases: :3124-3160 (400 served, plain `Error` fallback, blank 500), :3162-3208 (gateway loop + the three thrown unconfirmed causes), :3210-3224 (shapeless 200), :3226-3264 (unparseable 200), :3266-3306 (the `it.each` mid-stream-death cases), :3325-3348 (this route's own 503, whose stub is named `storeUnreadable`), :3350-3377 (412 and 428). Every `unconfirmed:`/`unreadable:` pair in a `toEqual` and every standalone `expect(result.status === "error" && result.unconfirmed/unreadable)` becomes one `verdict` assertion. `stubFetch` :2733-2751 — its `json` cannot throw, so throwing cases stay bare `SettingsFetch` literals (the `it.each` at :3266 is the template).
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- READ-ONLY for behaviour, but it must still pass. The DW-63/DW-376 describe :364-…: `mountWritable` :369-378, `read`/`saved`/`typeChatModel`/`ifMatchOf` :380-406, the `UNCONFIRMED` table :524-552, the `UNREADABLE` table :618-687, the 503 case (version KEPT) after it. It drives the canvas through the DOM and never names a verdict field, so it is the regression guard that the collapse changed no behaviour.
- `src/lib/__tests__/write-precondition.test.ts` -- READ-ONLY scan :562-601 forbidding the 412/428 sentences' first 40 characters from appearing in `lib/workbench-preview.ts`, `lib/workbench-settings.ts`, `components/workbench/PreviewColumn.tsx` and `components/workbench/SettingsCanvas.tsx`. Three of the four change here; keep new comments paraphrasing, as the existing ones do.
- `src/lib/__tests__/workbench-request.test.ts` -- READ-ONLY. :368-420 pins `thrownWriteFailure`'s own contract; `WriteFailure` keeps both fields.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-preview.ts` -- import `unconfirmedCause` and replace `savePreviewBody`'s success-body `.catch(() => null)` with the guarded form that rethrows an unconfirmed cause and returns `null` otherwise -- so a body read that dies mid-stream lands in the outer catch and answers `unconfirmed: true` instead of a landed save. Say in the comment what the two halves are (a body that will not PARSE is still the route's arrived answer and the save landed; a read that DIES is the same missing confirmation as any other unconfirmed cause) and point at `saveWorkbenchSettings` rather than restating DW-408's argument a third time. Leave the refusal-branch parse alone.
- `src/lib/workbench-settings.ts` -- replace `SettingsSaveResult`'s error-branch `unconfirmed`/`unreadable` booleans with one required `verdict` field over an exported three-value union, carrying the two existing docblocks' content into per-member documentation: what each verdict states as fact, and what the caller must do about the held version. Add one small module-local helper mapping a `WriteFailure` to the `refused`/`unconfirmed` result, and use it at BOTH the refusal and the outer-catch returns; the shapeless-200 return states `verdict: "unreadable"` directly. Update the surrounding comment blocks that name the old fields, including the refusal branch's DW-557 paragraph, without re-arguing them.
- `src/components/workbench/SettingsCanvas.tsx` -- widen-in-place: the version-clearing branch tests the two verdicts by name rather than negating `refused`, so a fourth verdict added later must state its own answer instead of inheriting this one. Update the field names in the DW-427 comment; leave its argument, the action and every sentence untouched.
- `src/lib/__tests__/workbench-preview.test.ts` -- add a `savePreviewBody` case driving a 2xx whose `json` rejects with each of `TimeoutError`, `AbortError` and `TypeError`, asserting the unknown-outcome sentence and `unconfirmed: true`, and stating why a `SyntaxError` is deliberately not in the list. Assert the existing "no version" case's `SyntaxError` still answers `{ status: "ok" }` -- the two halves of one `.catch` are the whole point.
- `src/components/workbench/__tests__/preview-dirty-guard.test.tsx` -- add "a 200 whose body read died mid-stream" as a third row of the DW-376 `UNCONFIRMED` table (a response object whose `json` rejects with a `TypeError`, since the helper throws only what it is handed as an `Error`), and extend the describe's docblock to say the table now covers both sides of the 2xx body read.
- `src/lib/__tests__/workbench-settings.test.ts` -- carry `verdict` through every save-error assertion listed in the Code Map, replacing each boolean pair and each standalone boolean assertion; add the DW-557 case (a refusal whose body read dies mid-stream still answers the fallback sentence and `verdict: "refused"`, with nothing unknown and nothing unreadable); and add a DW-558 case asserting that across the producing scenarios an error result's keys are exactly `status`/`message`/`verdict` and its verdict is one of the three -- the illegal fourth state has no spelling left.

**Acceptance Criteria:**
- Given a Preview save answered by a 2xx whose body read dies mid-stream, when the column shows the outcome, then the owner reads the unknown-outcome sentence, the editor keeps every character, and the next save carries no `If-Match` -- where before the change the column reported a landed save and closed the editor.
- Given the Settings canvas driven through the DOM across all of gateway silence, dropped connection, mid-stream body death, unparseable 2xx, shapeless 2xx, this route's own 503 and a 412/428 refusal, when each save is answered, then every sentence shown and every subsequent `If-Match` is identical to before the verdict collapse.
- Given `SettingsSaveResult`, when a construction site is added, then it must name exactly one of the three verdicts -- there is no field combination expressing a fourth state and no way to omit the verdict.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 3, low 7)
- defer: 2: (high 0, medium 1, low 1)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` `savePreviewBody`'s docblock and `PreviewSaveResult.unconfirmed` still
    enumerated exactly three producers of the unknown outcome; DW-556 added a fourth and stated
    it only in an inline comment. Both contracts now name the 2xx whose body read dies.
  - `[medium]` `[patch]` `PreviewSaveResult.version` said "a body that will not parse is still a
    landed save", a sentence that after this change covers only one of the two halves it used to.
    Narrowed to a PARSE failure, with the dying read's opposite verdict stated beside it.
  - `[medium]` `[patch]` The canvas comment claimed that naming two verdicts forces a fourth to
    state its own answer about the held version. It does not — a fourth would fall to the `else`
    and silently inherit `"refused"`'s keep-the-version answer, the more dangerous default. The
    rule now lives beside `SettingsSaveVerdict` as `verdictClearsHeldVersion`, an exhaustive
    switch whose `never` default makes a new member fail to compile until it answers; the canvas
    asks it. Behaviour unchanged — `settings-read-only.test.tsx` passes untouched by that patch.
  - `[low]` `[patch]` The rewritten refusal comment asserted that a gateway status still reads as
    unknown through `failedSave`, with nothing executing it: the DW-557 case used a 400 and the
    gateway loop stubbed a parseable body. Added the interaction — every `UNCONFIRMED_STATUSES`
    entry over a body read that dies answers `"unconfirmed"`.
  - `[low]` `[patch]` The DW-558 producer table omitted an unparseable 200 and an abort cause, so
    two whole producing branches sat outside the key-shape check the case exists to run over
    every producer. Both added.
  - `[low]` `[patch]` That case was titled for unconstructibility but executed only runtime
    shapes. Added `@ts-expect-error` pins in the repo's idiom — a leftover `unreadable` key and a
    verdict outside the union — so the type-level half of its own claim is enforced.
  - `[low]` `[patch]` `failedSave` was typed as the whole `SettingsSaveResult` union though it
    can only produce the error member; narrowed so it documents that and both call sites keep
    the narrowing.
  - `[low]` `[patch]` One fact now had two vocabularies with nothing saying the asymmetry was
    deliberate. Cross-references added in both directions, and the three verdicts summarised on
    the `verdict` FIELD, since per-member docs on a string-literal union never reach hover.
  - `[low]` `[patch]` Comment tidy: the bare `unreadable` at five sites still read as the removed
    FIELD name rather than the value, one rewritten line ran to ~96 columns in an ~80-column
    block, and the new `savePreviewBody` comment said the argument lived elsewhere and then
    restated it anyway. Trimmed, requoted, and the sibling pointer made a `{@link}`.
  - `[low]` `[patch]` DW-557's consequence was pinned only at the client's return value while
    both neighbouring verdicts are pinned at the canvas seam too. Added the missing row: an
    arrived refusal whose body read dies leaves the seeded `If-Match` on the next save.

## Design Notes

The collapse is a rename of a state space, not a redesign of it. Both booleans map onto one field, and the third name has to cover the two tuples that were already indistinguishable:

```ts
// before                                          // after
{ unconfirmed: false, unreadable: false }  →  { verdict: "refused" }    // arrived refusal, or a thrown non-unconfirmed cause
{ unconfirmed: true,  unreadable: false }  →  { verdict: "unconfirmed" }
{ unconfirmed: false, unreadable: true  }  →  { verdict: "unreadable" }
{ unconfirmed: true,  unreadable: true  }  →  (no spelling)
```

`refused` is the honest name for the merged pair only if the docblock says what it actually claims: not "the server refused", but "nothing was applied as far as this client can tell, so the held version is still current". A thrown plain `Error` lands there because `thrownWriteFailure` already answers `unconfirmed: false` for it — that reading is `workbench-request`'s and is not being reopened here.

The mapping is a helper rather than a ternary typed twice because `refusedWriteFailure` can itself answer `unconfirmed: true` (a gateway status), so "which branch produced it" is exactly the wrong thing to key on — the verdict follows the `WriteFailure`, and one function is where that stays true.

On the Preview side the guard is the same three lines `saveWorkbenchSettings` carries, and it changes one row of the matrix only: a `SyntaxError` is not an `unconfirmedCause`, so a body that will not parse still returns `null` and still reports the landed save with no version, which is `PreviewSaveResult.version`'s stated contract.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/workbench-settings.test.ts src/components/workbench/__tests__/settings-read-only.test.tsx src/components/workbench/__tests__/preview-dirty-guard.test.tsx src/lib/__tests__/write-precondition.test.ts src/lib/__tests__/workbench-request.test.ts` -- expected: all pass
- `pnpm exec tsc --noEmit` -- expected: clean
- `pnpm lint` -- expected: clean
- `pnpm test` -- expected: no new failures against the pre-change baseline

**Manual checks (if no CLI):**
- Revert only the widened condition in `SettingsCanvas.save` and confirm both `UNREADABLE` rows of `settings-read-only.test.tsx` fail; revert only the Preview guard and confirm the new mid-stream row of the `UNCONFIRMED` table in `preview-dirty-guard.test.tsx` fails. Restore both.

## Auto Run Result

Status: done

**Implemented change.** Three verdict defects left over from DW-427/DW-428 are closed together.
`savePreviewBody` now parses its 2xx body through the same guard `saveWorkbenchSettings` carries:
a read that DIES mid-stream is rethrown to the outer catch and answers `unconfirmed: true`, where
before it was swallowed and reported to `PreviewColumn` as a landed save — the editor closed and
the next save carried an `If-Match` nobody could vouch for. A body that merely fails to PARSE is
untouched and still a landed save with no version, which is `PreviewSaveResult.version`'s stated
contract. The Settings refusal parse stays deliberately unguarded, and its argued answer — a
refusal status arrived, nothing was applied, the held version survives — is now executed rather
than only commented, at the client and at the canvas seam. And `SettingsSaveResult`'s two
independent booleans became one discriminated `verdict: "refused" | "unconfirmed" | "unreadable"`,
mapped from `WriteFailure` in a single helper, so the illegal fourth state has no spelling left.
The rule about which verdicts oblige the caller to drop its held version moved next to the union
as an exhaustive switch, so a fourth verdict cannot compile until it states its own answer.

**Files changed.**
- `src/lib/workbench-preview.ts` -- guarded `savePreviewBody`'s success-body parse; `PreviewSaveResult`'s two docblocks now state the fourth unknown-outcome producer and why this side keeps one boolean.
- `src/lib/workbench-settings.ts` -- new `SettingsSaveVerdict` union and `verdictClearsHeldVersion` predicate; `SettingsSaveResult`'s error branch carries one `verdict`; new `failedSave` is the single `WriteFailure`-to-verdict mapping, used by the refusal and thrown returns.
- `src/components/workbench/SettingsCanvas.tsx` -- the version-clearing branch asks the predicate instead of testing booleans; the DW-427 argument is unchanged.
- `src/lib/__tests__/workbench-preview.test.ts` -- DW-556's client pin, plus the `SyntaxError` half stated as the case that must not move.
- `src/components/workbench/__tests__/preview-dirty-guard.test.tsx` -- a third DW-376 row driving the column through a 2xx whose body read dies.
- `src/lib/__tests__/workbench-settings.test.ts` -- every save-error assertion carried onto `verdict`; DW-557's dying refusal; the gateway-over-a-dying-body interaction; the predicate's three answers; DW-558's producer/key-shape table and its two `@ts-expect-error` type pins.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- the DW-557 seam row: an arrived refusal whose body died leaves the seeded `If-Match` on the next save.

**Review findings.** 10 patches applied (medium 3, low 7); 2 items deferred (medium 1, low 1);
6 rejected; 0 intent gaps, 0 spec defects. Follow-up review recommended: **true** -- patched
severities were high 0, medium 3, low 7, scoring 3x3 + 1x7 = 16, at or above the threshold of 5.

**Verification.**
- `pnpm vitest run` over the six suites named above -- 585 passed, 6 files, no failures.
- `pnpm exec tsc --noEmit` -- clean. `pnpm lint` -- clean (only the pre-existing `jsx-ast-utils`
  `TSNonNullExpression` notices).
- `pnpm test` -- 350 files, 8146 passed, 1 skipped, zero failures. The baseline at
  `f855e0e16a159c72c50c0ac1fe1c66112597df83` was 8143 passed / 1 skipped; the rise is the cases
  added here.
- Regression guards, run and restored: reverting only the Preview guard fails the new client case
  and the new `preview-dirty-guard` row; narrowing the canvas branch to `"unconfirmed"` alone
  fails both `UNREADABLE` rows of `settings-read-only.test.tsx`; guarding the Settings refusal
  parse fails the new seam row; adding a fourth union member fails `tsc` on the predicate's
  `never` default; hardcoding `verdict: "refused"` on the refusal branch fails the gateway case.
- Matrix audit: every I/O row has a covering test that ran and passed -- the Preview 2xx trio
  (dying read, unparseable, no version), the Preview canvas seam, the Settings refusal with a
  dying body, arrived refusals including this route's own 503 and 412/428, gateway and dropped
  connection, a thrown non-unconfirmed cause, both `unreadable` producers, and the fourth-state
  row at both the runtime and the type surface.

**Residual risks.** The same unguarded 2xx body read is still live on three sibling write paths
(`useSettings`, `WikiEditor`, `send`/`sendForm`), where a dying socket still reaches the owner as
a settled outcome; and `SkillsCanvas` never reconciles a toggle whose outcome is unknown. Both are
pre-existing and out of this bundle's scope, and both are recorded in frontmatter `deferred`.
`PreviewSaveResult` deliberately keeps one boolean rather than gaining an `unreadable` peer, so
the two write clients now agree about the parse and differ about the verdict vocabulary -- stated
in both docblocks so it cannot be mistaken for an unfinished migration.
