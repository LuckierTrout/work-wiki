---
title: 'Settings save: one refusal frame, an honest unreadable sentence, a machine code for the env pin'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized, multiple-goals]
deferred: []
baseline_revision: 'ef521bf8873f6f4823fc8ee0d81d241c67a3e75d'
---

<intent-contract>

## Intent

**Problem:** Three seams where `PUT /api/settings` and the Settings surface disagree. (1) DW-330: the route picks the vector refusal's FRAME from the STORED flag (`turningOn = !baseline.vectorSearchEnabled`) while `SettingsCanvas` picks its checkbox hint from the DRAFT flag, so a draft that ticks the box and then breaks a leg shows "…is switched on, but it needs…" beside a 400 reading "…before it can be turned on". (2) DW-554: the `unreadable` verdict — a 2xx whose body yielded no payload — shows `SETTINGS_SAVE_FAILED_COPY` ("Settings couldn't be saved."), the one claim the branch's own reasoning says nobody is in a position to make, since it clears the held version precisely because the route may have run. (3) DW-628: the env-pin refusal carries no machine-readable code, so the browser recognises it by exact-matching the English sentence.

**Approach:** Frame the route's vector refusal from the REQUEST's flag (which, inside `if (enabled)`, is always on) so both surfaces say the switched-on sentence; mint a distinct `SETTINGS_SAVE_UNREADABLE_COPY` for the `unreadable` verdict that names the unknown outcome and the reload; and add a `code` to the env-pin 400 that `saveWorkbenchSettings` relays and `settingsRefusalPinsEmbeddingProvider` prefers, keeping the sentence match as a closed-set fallback.

## Boundaries & Constraints

**Always:**
- `canEnableVectorSearch` stays the ONE rule deciding WHETHER a save is refused. Only WHICH sentence moves. `turningOn` keeps its two existing jobs — the `(turningOn || !vectorInputsEqual(…))` trigger and the `actionableLegs && !turningOn` suppression — untouched.
- The `"workbench"` / `"flat"` action clause keeps being chosen from `actionableLegs === undefined`, unchanged.
- Refusal sentences are the exported copy functions' own output, never a second spelling.
- `SETTINGS_SAVE_FAILED_COPY` stays the sentence for real failures (`refused`), and `unconfirmedWriteMessage` stays the sentence for `unconfirmed`. The three verdicts keep three distinct sentences.
- The env-pin code is ADDITIVE: the refusal's `error` sentence is byte-identical, and `settingsRefusalPinsEmbeddingProvider` still answers `true` off the sentence alone when no code arrives (a stale tab, or any client stubbing the old body).
- A code is relayed only for an arrived refusal (`verdict === "refused"`); a gateway status or a thrown cause never carries one, so a proxy's body cannot attach a code to an unknown outcome.

**Block If:**
- Making `vectorSearchMissingCopy` unreachable from `validateWorkbenchSettingsPatch` turns out to break a consumer other than the route's own tests (the client hint at `SettingsCanvas.tsx:490` must keep using it).

**Never:**
- Do not change `SettingsCanvas`'s hint selector — the client half is the reference the route is being aligned TO (this is DW-330's chosen decision; the rejected alternative was aligning the client).
- Do not delete or rename `vectorSearchMissingCopy`, `SETTINGS_SAVE_FAILED_COPY`, or the `SettingsSaveVerdict` union members.
- Do not add a code to any other refusal, or a second machine field to the wire.
- Do not touch `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Turning the switch on over unmet legs | `PUT {workbench:{vectorSearchEnabled:true}}`, baseline flag OFF, legs unmet | 400 with `vectorSearchInactiveCopy(merged, "workbench")` — the same sentence the ticked checkbox hint shows | 400, nothing written |
| Breaking an already-on switch | baseline flag ON, request moves a leg | 400 with `vectorSearchInactiveCopy(merged, "workbench")` — unchanged | 400, nothing written |
| Flat-only body over an on switch | no `workbench` key, baseline ON, request moves a leg it can move | 400 with `vectorSearchInactiveCopy(merged, "flat")` — unchanged | 400, nothing written |
| Shapeless / unparseable 2xx | `{ok:true,status:200}` with no `workbench` payload | `{status:"error", message: SETTINGS_SAVE_UNREADABLE_COPY, verdict:"unreadable"}`; canvas shows it and clears the held version | Not a failure claim |
| Gateway / dropped connection | 502/504, abort, `TypeError` | `unconfirmedWriteMessage(SETTINGS_SAVE_ACTION)`, `verdict:"unconfirmed"` — unchanged | Unknown outcome |
| Arrived refusal | 400/412/428/503 with a served sentence | served sentence, `verdict:"refused"`, `SETTINGS_SAVE_FAILED_COPY` when the body served nothing — unchanged | Refusal |
| Env-pin refusal | `EMBEDDING_PROVIDER` set, request MOVES the provider | 400 `{error: settingsEnvProviderPinRefusalCopy(v), code: SETTINGS_ENV_PROVIDER_PIN_CODE}`; canvas re-seeds the embedding legs | 400, nothing written |
| Env-pin refusal, no code on the wire | same body without `code` (stale route, stubbed test) | predicate still matches on the sentence; recovery unchanged | Fails closed on a reworded sentence |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts:2398` -- `turningOn`; keep it for the trigger (`:2400`) and the suppression (`:2437`).
- `src/lib/workbench-settings.ts:2478-2483` -- the `error: turningOn ? vectorSearchMissingCopy(merged) : vectorSearchInactiveCopy(merged, …)` ternary and the ~35-line comment block above it (`:2444-2477`) arguing the baseline reading. This is DW-330's edit: collapse to the inactive frame and rewrite the argument.
- `src/lib/workbench-settings.ts:1723-1770` -- `vectorSearchInactiveCopy` docblock; its second bullet says the frame is "chosen when `baseline` held the flag on" — restate as the request's flag.
- `src/lib/workbench-settings.ts:212` -- `SETTINGS_SAVE_FAILED_COPY`; `:216` `SETTINGS_SAVE_ACTION`. New `SETTINGS_SAVE_UNREADABLE_COPY` belongs beside them.
- `src/lib/workbench-settings.ts:3616` -- `: { status: "error", message: fallback, verdict: "unreadable" }` — DW-554's edit.
- `src/lib/workbench-settings.ts:3389-3406` -- `SettingsSaveVerdict`'s `"unreadable"` docblock ("Not the UNKNOWN outcome…") — the claim DW-554 overturns; restate.
- `src/lib/workbench-settings.ts:3408-3430` -- `SettingsSaveResult` error member; the optional `code` field goes here.
- `src/lib/workbench-settings.ts:3554-3572` -- the refusal branch parsing `body.error`; parse `body.code` alongside and relay it.
- `src/lib/workbench-settings.ts:532-565` -- `settingsEnvProviderPinRefusalCopy` and `settingsRefusalPinsEmbeddingProvider` (whose docblock states "the route sends no machine-readable code" — DW-628 overturns it).
- `src/app/api/settings/route.ts:434-438` -- the env-pin `Response.json({ error: … }, {status:400})`; add `code`. Imports at `:15-23`.
- `src/components/workbench/SettingsCanvas.tsx:386` -- `settingsRefusalPinsEmbeddingProvider(result.message)` call and the comment above it; `:396-400` the two-sentences comment DW-554 changes.
- `src/components/workbench/SettingsCanvas.tsx:490,508,1228-1231` -- READ-ONLY reference: the client hint selector this change aligns the route to. Do not edit.
- `src/lib/__tests__/workbench-settings.test.ts:2588-2710` -- `describe("the refusal's FRAME follows the stored flag (DW-308)")`; five cases, two of which pin the turning-on request to `vectorSearchMissingCopy`.
- `src/lib/__tests__/workbench-settings.test.ts:3734-3826` -- the two `unreadable` cases and the neighbouring DW-408 `it.each`; `:3892-3908` the verdict/held-version rule test; `:3911-4011` the "no fourth verdict" state-space test (asserts exact result keys).
- `src/lib/__tests__/workbench-settings.test.ts:6426-6452` -- `describe("settingsRefusalPinsEmbeddingProvider (DW-553)")`; call sites pass a bare string today.
- `src/lib/__tests__/settings-route.test.ts:1487-1527` -- the two env-pin refusal body assertions (`toEqual({error: …})`) plus the DW-553 coupling assertion; `:1588` a third; `:1626-1638` the turning-on refusal sentence this change re-frames.
- `src/components/workbench/__tests__/settings-read-only.test.tsx:868-921` -- the `UNREADABLE` table loop asserting `SETTINGS_SAVE_FAILED_COPY` and `queryByText(/outcome is unknown/)` is null.
- `src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx:215` -- stubs the pin refusal body WITHOUT a code; the sentence fallback must keep it green unchanged.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- DW-330: replace the frame ternary with `vectorSearchInactiveCopy(merged, actionableLegs === undefined ? "workbench" : "flat")` and rewrite the comment block to argue the REQUEST's flag (`enabled` — the request's own `vectorSearchEnabled` where it sends one, the stored flag where it does not — which is `true` by construction inside this branch, so the switched-on frame is the only one the route mints). Update `vectorSearchInactiveCopy`'s docblock bullet. Leave `turningOn`'s other two uses alone. -- client and route must answer one draft with one sentence.
- `src/lib/workbench-settings.ts` -- DW-554: add exported `SETTINGS_SAVE_UNREADABLE_COPY` beside `SETTINGS_SAVE_FAILED_COPY`, worded as "the outcome is unknown" + "Reload to see what landed", no transport vocabulary; return it as the `unreadable` branch's `message` instead of `fallback`; restate the `"unreadable"` verdict docblock and `saveWorkbenchSettings`'s docblock so they no longer claim the outcome is known. -- the sentence beside a version-clearing action must not assert the save failed.
- `src/lib/workbench-settings.ts` -- DW-628: add exported `SETTINGS_ENV_PROVIDER_PIN_CODE`; add optional `code?: string` to `SettingsSaveResult`'s error member (documented as a relay of the server's machine code, carrying no verdict meaning); in the refusal branch read a string `body.code` and attach it only when the verdict is `"refused"`; change `settingsRefusalPinsEmbeddingProvider` to take `{ message, code? }`, answering `true` on a code match and falling back to the existing closed-set sentence equality. -- remove the copy coupling without breaking clients that send no code.
- `src/app/api/settings/route.ts` -- emit `code: SETTINGS_ENV_PROVIDER_PIN_CODE` alongside the existing `error` on the env-pin 400 only, importing the constant from `@/lib/workbench-settings`. -- the wire fact the browser should branch on.
- `src/components/workbench/SettingsCanvas.tsx` -- pass `result` (message + code) to `settingsRefusalPinsEmbeddingProvider`; update the comment above it (no longer "recognised by the sentence, because the route sends no code") and the `verdictClearsHeldVersion` comment at `:396` (both clearing verdicts now say the outcome is unknown; they differ in what came back and what to do). -- keep the surface's prose true.
- `src/lib/__tests__/workbench-settings.test.ts` -- re-point the DW-308 describe at the request's flag: the turning-on case now asserts the switched-on frame; the "copy functions' own output" case asserts `vectorSearchInactiveCopy` on both halves; the "moves no refusal boundary" case asserts both stored flags refuse AND now carry the same switched-on sentence. Add a case pinning DW-330's contradictory composition: for a draft that ticks the box and then unmeets a leg, the checkbox hint's `vectorSearchInactiveCopy(draftVectorInputs(draft, payload))` equals the route's refusal `error` for the same request. Assert both `unreadable` producers now answer `SETTINGS_SAVE_UNREADABLE_COPY` and still differ from `unconfirmedWriteMessage(SETTINGS_SAVE_ACTION)`; add an `it.each` beside the DW-408 one asserting each of the three verdicts' sentence from a producer that mints it. Keep the state-space test's exact-keys claim by excluding the relayed `code` explicitly. Extend the DW-553 describe: object argument, code match wins, sentence fallback still matches, a wrong code with a wrong sentence answers `false`. -- executable pins for all three ledger entries.
- `src/lib/__tests__/settings-route.test.ts` -- add `code: SETTINGS_ENV_PROVIDER_PIN_CODE` to the three env-pin body assertions and pass the whole body to the DW-553 coupling assertion; re-point the `EMBEDDING_PROVIDER=deepseek` turning-on case at the switched-on frame plus `SETTINGS_VECTOR_PROVIDER_ENV_NOTE`. -- the route body is the contract.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- in the `UNREADABLE` loop, expect `SETTINGS_SAVE_UNREADABLE_COPY` and replace the `/outcome is unknown/`-is-null assertion with one that the UNCONFIRMED sentence is absent (the two clearing verdicts stay two sentences). -- the DOM half of DW-554.

**Acceptance Criteria:**
- Given a stored flag OFF with met legs, when a request sends `vectorSearchEnabled: true` alongside a change that unmeets a leg, then the 400 body is exactly `vectorSearchInactiveCopy(merged, "workbench")` and is byte-identical to the hint `SettingsCanvas` renders beside the ticked box for that same draft.
- Given a stored flag ON, when a flat-only body moves a leg it can move, then the refusal is still `vectorSearchInactiveCopy(merged, "flat")` and no refusal boundary moves — every situation refused before is refused after.
- Given a 200 whose body yields no `workbench` payload, when the canvas saves, then the owner reads `SETTINGS_SAVE_UNREADABLE_COPY`, never `SETTINGS_SAVE_FAILED_COPY` and never the `unconfirmed` sentence, and the held `If-Match` is still dropped.
- Given `EMBEDDING_PROVIDER` is set and a request moves the embedding provider, when the route refuses, then the body carries both the unchanged sentence and `code: SETTINGS_ENV_PROVIDER_PIN_CODE`, and `settingsRefusalPinsEmbeddingProvider` answers `true` from the code.
- Given the same refusal body with `code` absent, when the predicate is asked, then it still answers `true` from the sentence; given a reworded sentence and no code, it answers `false`.
- Given a 502 whose body carries a `code`, when `saveWorkbenchSettings` answers, then the result has verdict `"unconfirmed"` and no `code`.

## Spec Change Log

_No bad_spec loopback occurred._

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 0
- reject: 16: (high 0, medium 0, low 16)
- addressed_findings:
  - `[medium]` `[patch]` `DEPLOY.md` documented the retired turning-on frame as the route's 400 body in five passages (around lines 71, 98, 113, 186 and 323). Rewrote all five: "before it can be turned on" is now described as the surface's UNTICKED-box hint, and the switched-on frame as the only sentence `PUT /api/settings` sends.
  - `[medium]` `[patch]` DW-330's symptom — the checkbox hint and the save bar disagreeing on one draft — was pinned only as two pure functions compared side by side, so a regression in `SettingsCanvas`'s own hint selector would have left the pin green. Added a mounted case in `settings-embedding-provider-switch.test.tsx` that ticks the box, unmeets a leg, drives a real PUT whose 400 body is computed by `validateWorkbenchSettingsPatch` over the patch actually sent, and asserts the save bar's sentence is byte-identical to the checkbox's rendered description.
  - `[low]` `[patch]` `src/app/api/settings/route.ts` still argued that "a request turning the switch on reads '…before it can be turned on' on both surfaces" directly above the call this change re-framed. Rewrote it: `actionableLegs` picks the action CLAUSE, not a frame, and the stored flag decides only WHETHER.
  - `[low]` `[patch]` `vectorSearchMissingCopy`'s own docblock still introduced it as what a refusal says and what "the route was unhappy about". Rescoped: it is the unticked-box hint and nothing the route mints.
  - `[low]` `[patch]` The new DW-330 comment cited `SettingsCanvas.tsx:1228` for the hint selector, which had already drifted to 1235. Replaced the line number with a symbol reference to the `vectorInactive`/`vectorBlocked` ternary.

Rejected (no action): the "switched on" wording reaching a CLI turn-on refusal (the intent's own chosen decision — "Frame from the request"); DW-308's both-frames-at-the-route boundary not being preserved (same authority); the `code` relay guard being keyed on the verdict rather than also on status 400 (the docblock's claim — that an UNKNOWN outcome can never carry a code — is exactly what the guard delivers, and a 500 is an arrived refusal); `code` typed on the shared error variant rather than a split union; the relay trimming `code` while the predicate compares raw; `SkillsCanvas` also showing the new unreadable sentence (it relays `result.message` unbranched, and the sentence names no surface); the three sentences being pinned as distinct rather than non-overlapping; refusal strings retyped as literals in two test files; import ordering; and the deferred-work ledger not being updated (this run was explicitly forbidden to touch it).

## Design Notes

The frame collapse is the whole of DW-330's code change. `enabled` is `true` for every path that reaches the refusal, so "frame from the request" has exactly one answer and the ternary becomes dead. `vectorSearchMissingCopy` stays exported and stays the client's unticked-box hint; it simply stops being a sentence the ROUTE can mint. The long comment at `:2444` currently argues the opposite and must be rewritten, not merely trimmed — leaving it would make the file argue against its own code.

`code` on `SettingsSaveResult` is a relay, not a fourth state. The "no spelling left for a fourth verdict" test guards the verdict state space; keep that guard by destructuring `code` off before the exact-keys comparison rather than by widening the expected key list:

```ts
const { code: _relayed, ...state } = result;
expect([label, Object.keys(state).sort()]).toEqual([label, ["message", "status", "verdict"]]);
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-route.test.ts src/components/workbench/__tests__/settings-read-only.test.tsx src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx src/components/workbench/__tests__/settings-vector-namespace.test.tsx src/lib/__tests__/settings-runtime-wiring.test.ts` -- expected: all pass
- `pnpm exec tsc --noEmit` -- expected: no errors (the `@ts-expect-error` pins in the verdict tests must still fire)
- `pnpm lint` -- expected: clean
- `pnpm vitest run` -- expected: no new failures anywhere else

## Auto Run Result

Status: done

### Summary

Three seams between `PUT /api/settings` and the Settings surface, closed together.

- **DW-330 — one refusal frame.** `validateWorkbenchSettingsPatch` framed the vector refusal from `baseline.vectorSearchEnabled` while `SettingsCanvas` frames its checkbox hint from the draft, so ticking the box and then unmeeting a leg put "…is switched on, but it needs…" beside a 400 reading "…before it can be turned on". The route now frames from the flag the REQUEST carries, which is `true` for every refusal it can reach — so the ternary is gone and `vectorSearchInactiveCopy` is the only sentence the route sends. `turningOn` keeps its trigger and scoping jobs; `vectorSearchMissingCopy` stays the client's unticked-box hint.
- **DW-554 — a third sentence.** The `unreadable` verdict (a 2xx whose body yielded no payload) showed `SETTINGS_SAVE_FAILED_COPY`, asserting the save failed on the one branch that clears the held version precisely because the route may have run. New `SETTINGS_SAVE_UNREADABLE_COPY` — "The answer came back with nothing to show, so the outcome is unknown. Reload to see what landed." — now carries that branch. Three verdicts, three sentences.
- **DW-628 — a machine code.** The env-pin 400 now carries `code: SETTINGS_ENV_PROVIDER_PIN_CODE` beside a byte-identical `error`. `saveWorkbenchSettings` relays it only when the verdict is `refused`, and `settingsRefusalPinsEmbeddingProvider` prefers it, keeping the closed-set sentence equality as the fallback for a client that sends none.

### Files changed

- `src/lib/workbench-settings.ts` — the frame collapse; `SETTINGS_SAVE_UNREADABLE_COPY` and its use on the `unreadable` branch; `SETTINGS_ENV_PROVIDER_PIN_CODE`, the optional `code` relay on `SettingsSaveResult`, and the predicate's new object argument.
- `src/app/api/settings/route.ts` — `code` on the env-pin refusal; the stale DW-329 frame comment above the gate call.
- `src/components/workbench/SettingsCanvas.tsx` — hands the whole refusal to the predicate; comment corrections. The hint selector is untouched.
- `DEPLOY.md` — five passages that documented the retired turning-on frame as the route's 400 body.
- `src/lib/__tests__/workbench-settings.test.ts` — the frame describe re-pointed at the request's flag, a client-half/route-half byte comparison, per-verdict sentence `it.each`, the `code` relay cases, and the DW-553 predicate arms.
- `src/lib/__tests__/settings-route.test.ts` — `code` on the three env-pin bodies; the `EMBEDDING_PROVIDER=deepseek` turn-on re-framed.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` — five DOM assertions moved onto the new sentence, with both other verdicts' sentences asserted absent.
- `src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx` — code-only recovery under a reworded sentence, and the mounted one-draft-one-sentence composition.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` — one route-body sentence re-framed.

### Review findings

- Patches applied: 5 (medium 2, low 3) — see the Review Triage Log.
- Items deferred: 0.
- Items rejected: 16.
- Follow-up review recommended: **true** — patched counts high 0, medium 2, low 3; score `3×2 + 1×3 = 9`, which is at least 5.

### Verification

- `pnpm vitest run` over the six spec-named files — 526 passed.
- `pnpm exec tsc --noEmit` — exit 0; the `@ts-expect-error` pins in the verdict state-space test still fire.
- `pnpm lint` — exit 0.
- `pnpm vitest run` (full suite) — 8898 passed, 1 skipped, 1 failed: `storage-fs.test.ts > stops at STRANDED_SCRATCH_CANDIDATE_CAP`, "Test timed out in 5000ms". Confirmed pre-existing and unrelated: it also failed on a clean stash of this change, passes in isolation on both trees, and this diff touches no storage code.
- Matrix audit: all eight I/O rows are covered by tests that ran and passed — the turn-on and already-on frames and the client/route byte comparison in `workbench-settings.test.ts`; the flat frame in `settings-route.test.ts`; the three verdicts' sentences in the new `it.each` plus five DOM assertions; the env-pin body in `settings-route.test.ts` with both canvas halves (code-driven and sentence-driven) in `settings-embedding-provider-switch.test.tsx`.

### Residual risks

- A non-browser client (CLI, script) that asks to turn vector search on and is refused now reads "Vector search is switched on, but it needs … Turn it off, or supply what is missing." about a switch its deployment still has off. This is the accepted cost of the intent's chosen decision ("Frame from the request"); the sentence describes the configuration the request asked for, which is what the ticked box on the surface shows.
- `SETTINGS_ENV_PROVIDER_PIN_CODE` is the first top-level `code` on a REST error body in this app. There is no shared error-response type for the next refusal that wants one to conform to.
- `SkillsCanvas` relays `result.message` from the same helper, so a shapeless 2xx there now shows the new unreadable sentence too. The sentence names no surface, so it reads correctly, but no test covers that pane.
