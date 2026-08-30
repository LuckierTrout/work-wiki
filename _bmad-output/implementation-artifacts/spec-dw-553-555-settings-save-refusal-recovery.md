---
title: 'Settings canvas: a way forward after a refused save (DW-553, DW-555)'
type: 'bugfix'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
baseline_revision: 'b1a711d83dae43cc3bb4625fcc115b35c130492c'
deferred:
  - summary: >-
      Edits typed while a save is in flight are silently dropped, and the DW-555
      recovery read doubles the window in which that can happen.
    evidence: |-
      `SettingsCanvas.save` captures `const current = draftRef.current` before
      the awaits, and only the Save button is disabled while `saving` — the
      field-level `aria-disabled` attributes key off `readOnly`/`envPinned`, not
      `saving`. A landed save then re-seeds the draft from the answered payload,
      so a keystroke made during the round trip is neither sent nor kept.
      Pre-existing, but on a surface holding no version the window is now two
      sequential `REQUEST_TIMEOUT_MS` deadlines rather than one.
    location: >-
      src/components/workbench/SettingsCanvas.tsx (save)
    severity: low
  - summary: >-
      `mountWritable` and `patchOf` are now copied verbatim into a second mounted
      Settings suite, the duplication DW-228 consolidated the rest of that
      harness to remove.
    evidence: |-
      `settings-read-only.test.tsx` and `settings-embedding-provider-switch.test.tsx`
      each carry their own one-response-per-call mount helper and PUT-body
      reader, differing only in the category mounted. `settings-harness.tsx`
      already exists as the stated shared home for exactly this kind of helper,
      and its header explains why a per-file copy is what drifts.
    location: >-
      src/components/workbench/__tests__/settings-harness.tsx
    severity: low
  - summary: >-
      `PUT /api/settings` sends no machine-readable code for the env-pin refusal,
      so the browser recognises it by matching the English sentence.
    evidence: |-
      `settingsRefusalPinsEmbeddingProvider` compares the refusal body against
      every sentence `settingsEnvProviderPinRefusalCopy` can mint. That is exact,
      closed and fails closed, and `settings-route.test.ts` now pins the route's
      body against the same predicate — but a surface branching on copy is a
      coupling a wire-level code would remove. Adding one was ruled out of this
      bundle as a wire-contract change.
    location: >-
      src/app/api/settings/route.ts:434-437
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two refusals leave the Settings canvas with no way forward. (DW-553) When `PUT /api/settings` refuses an env-pinned embedding-provider move with its 400, the draft keeps the endpoint and key that `settingsDraftAfterEmbeddingProvider` blanked, so every retry re-sends the identical refused move. (DW-555) When a clearing verdict drops the held version, nothing on this surface ever restores it, so every later save carries no `If-Match` and is refused 428 — recoverable only by a reload that destroys the draft.

**Approach:** Two recoveries, each an addition to the existing `save` callback in `SettingsCanvas`. On the env-pin refusal — recognised by exact equality against the closed set of sentences `settingsEnvProviderPinRefusalCopy` can mint — re-seed only the three embedding legs of the draft from the payload the surface is holding. When the held version is absent at Save time, re-read ONLY the version through `fetchWorkbenchSettings()` and leave the draft untouched, the shape `SkillsCanvas.toggle` already uses. Both decisions are pure functions in `workbench-settings.ts`; both seams are pinned by mounted tests.

## Boundaries & Constraints

**Always:**
- Every decision stays a pure exported function in `src/lib/workbench-settings.ts`; `SettingsCanvas.tsx` applies it and restates nothing. The node suite executes the rules; the mounted suites execute the wiring.
- The refusal is identified by EXACT string equality against `settingsEnvProviderPinRefusalCopy(p)` for every `p` in `EMBEDDING_PROVIDERS` — no regex, no substring, no parsing. `envEmbeddingProvider()` filters through `isEmbeddingProvider`, so that set is closed and complete.
- The version re-read adopts the VERSION only. The draft, and every other field of the held payload, are left exactly as they are.
- The re-read fires only when the held version is `undefined`. A held version is never refreshed behind the owner's back — that would defeat the precondition it exists to be.
- Both requests keep the surface's `REQUEST_TIMEOUT_MS` deadline discipline; `SettingsCanvas.tsx` still makes no `fetch` call and names no `/api/` URL of its own.
- A refused save still keeps every edit on screen and still shows the SERVER's sentence.

**Block If:**
- The env-pin refusal sentence turns out not to be derivable from a closed enumeration (i.e. `envEmbeddingProvider` can answer a value outside `EMBEDDING_PROVIDERS`).

**Never:**
- Do not add a machine-readable error code to `PUT /api/settings`, and do not touch `src/app/api/settings/route.ts` at all.
- Do not adopt `envEmbeddingProvider` (or any other stored field) into the held payload from the refusal — the surface must not invent store state it was not served.
- Do not re-seed the draft's non-embedding fields on any refusal, and do not re-read the version when one is held.
- Do not change the copy of any existing sentence, and do not add a "reload" sentence — the re-seed is the chosen half of DW-553's either/or.
- Do not refuse to send when the recovery re-read yields no version: send with no `If-Match`, exactly as today, and let the route answer 428.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Pin refusal, stale tab | Draft moved `embeddingProvider` off the stored vendor; save answered 400 with `settingsEnvProviderPinRefusalCopy("openai")` | The route's sentence is shown; `embeddingProvider`, `embeddingBaseUrl` and `embeddingApiKey` are re-seeded from the held payload; every other edit stands; the held version stands | No error expected — the refusal is the input |
| Retry after the re-seed | Save pressed again on the re-seeded draft | The PUT body carries the STORED `embeddingProvider` and `embeddingBaseUrl` — no move, so the pin does not fire | Route answers on the remaining edits |
| Any other refusal | Save answered 400/412/503 with a different sentence | Draft untouched, as today | Existing handling |
| Save with no held version | A clearing verdict (or a versionless 200, or a load that carried none) left `version: undefined` | One `GET` first; the answered version is adopted into the held payload and sent as `If-Match`; the draft is untouched by the read | Read failed, or answered no version: the save is still sent with no `If-Match` and the route answers 428 |
| Save with a held version | Version present | No re-read; exactly one request, carrying the held version | Existing handling |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts` -- the pure module both halves land in. `settingsEnvProviderPinRefusalCopy` (~L467) is the sentence to match; `EMBEDDING_PROVIDERS` is already imported (L24). `settingsDraftAfterEmbeddingProvider` (L2847) is the rule that blanked the pair, and its three-answer shape is the model for the re-seed. `settingsDraftFromPayload` (L2664) shows the exact seeding of the three embedding legs (`embeddingProvider: payload.embeddingProvider ?? ""`, `embeddingBaseUrl: payload.embeddingBaseUrl ?? ""`, `embeddingApiKey: SECRET_UNTOUCHED`). `fetchWorkbenchSettings` (L3200) and `SettingsSaveResult` / `verdictClearsHeldVersion` (L3278-L3337) are the seam.
- `src/components/workbench/SettingsCanvas.tsx` -- `save` (L308-L378) is the only edit site: `payloadRef` (L239) holds the version, `draftRef` (L225) the draft, and the `else` branch at L341-L372 is where the refusal is handled. The mount read effect (L258-L282) stays untouched.
- `src/components/workbench/SkillsCanvas.tsx:96` -- `toggle`'s re-read-only-the-version shape, verbatim precedent.
- `src/app/api/settings/route.ts:379-440` -- READ ONLY. The env pin, and the proof it answers exactly `settingsEnvProviderPinRefusalCopy(storedBefore.envEmbeddingProvider)` with a filtered (`EmbeddingProvider | null`) value.
- `src/lib/config.ts:1739` -- READ ONLY. `envEmbeddingProvider()` filters through `isEmbeddingProvider`, which is what makes the match set closed.
- `src/lib/__tests__/workbench-settings.test.ts:5049-5065` -- the source scan pinning ONE `fetchWorkbenchSettings(` call site in the canvas. DW-555 names this scan as the reason a second read is a deliberate decision; it must move to two and say why.
- `src/components/workbench/__tests__/settings-read-only.test.tsx:443-770` -- the `DW-63` describe: `mountWritable(responses)`, `read`/`saved`/`typeChatModel`/`ifMatchOf` helpers, and the DW-199 / DW-376 / DW-428 reconciliation cases whose "the next save carries NONE" half this change replaces.
- `src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx` -- the mounted home for DW-553; already owns the blank-on-switch fixture (`embeddingBaseUrl: "https://o/v1"`, `hasEmbeddingApiKey: true`).
- `src/components/workbench/__tests__/settings-harness.tsx` -- `settingsPayload`, `installSettingsFetchMock` (returns the mock), `mountSettings`, `announcedFor`.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- add `settingsRefusalPinsEmbeddingProvider(message: string): boolean`, beside `settingsEnvProviderPinRefusalCopy`, answering `EMBEDDING_PROVIDERS.some((p) => settingsEnvProviderPinRefusalCopy(p) === message)` -- exact equality over a closed set is what lets the browser recognise a refusal the route sent no code for.
- `src/lib/workbench-settings.ts` -- add `settingsDraftAfterEmbeddingPinRefusal(draft, payload): SettingsDraft`, beside `settingsDraftAfterEmbeddingProvider`, restoring exactly the three legs `settingsDraftFromPayload` seeds -- the undo of the blanking, so the retry is no longer the refused move.
- `src/components/workbench/SettingsCanvas.tsx` -- in `save`, before the write, re-read the version through `fetchWorkbenchSettings` when `payloadRef.current?.version` is `undefined`, adopt it into the held payload, and send it -- DW-555's recovery, at the moment it matters and nowhere else.
- `src/components/workbench/SettingsCanvas.tsx` -- in `save`'s error branch, apply `settingsDraftAfterEmbeddingPinRefusal` when `settingsRefusalPinsEmbeddingProvider(result.message)` -- DW-553's recovery, leaving the sentence and the version handling alone.
- `src/lib/__tests__/workbench-settings.test.ts` -- unit-test both new rules (every member sentence matches; a near-miss and the other refusal sentences do not; the three legs are restored and nothing else moves), and move the canvas call-site scan to two, naming the second.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- rewrite the DW-199 / DW-376 / DW-428 reconciliation halves around the recovery, and pin that the re-read moves the version and NOT the draft.
- `src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx` -- add a mounted describe driving the stale-tab 400 and the retry that follows it.

**Acceptance Criteria:**
- Given a tab whose payload carries `envEmbeddingProvider: null` and a draft that moved the embedding provider, when the save is answered 400 with `settingsEnvProviderPinRefusalCopy(...)`, then the route's sentence is on screen and the provider select, the endpoint box and the key row all read the stored values again.
- Given that re-seeded draft, when Save is pressed again, then the PUT body carries the stored `embeddingProvider` and `embeddingBaseUrl`, so it is no longer the move the pin refuses.
- Given a save refused with any other sentence, when it is answered, then no embedding field of the draft moves.
- Given a surface holding no version, when Save is pressed, then a `GET /api/settings` precedes the PUT, the PUT carries the answered version as `If-Match`, and every field on screen still shows the owner's unsaved edits rather than the values that read served.
- Given a surface holding a version, when Save is pressed, then exactly one request is made and it carries that version.
- Given a surface holding no version and a store that answers none either, when Save is pressed, then the PUT is still sent, carries no `If-Match`, and the 428 sentence is shown.

## Spec Change Log

No `bad_spec` loopback occurred. Empty.

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 3: (high 0, medium 0, low 3)
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[medium]` `[patch]` The recovery guard tested `version === undefined`, but `isWorkbenchSettingsPayload` accepts `null` and `""` as spellings of absence and `workbenchSettingsFrom` hands the candidate back verbatim, while `saveWorkbenchSettings` gates `If-Match` on truthiness — so a held `null` walked past the recovery into the headerless 428, and an answered `null` was adopted and disabled the recovery for the life of the tab. Both now test falsiness; the source-scan pins were updated and mounted tables drive all three spellings on each side.
  - `[medium]` `[patch]` Nothing observed that the recovered version was ADOPTED into the held payload — deleting the `setPayload` line left both suites green (proven by mutation). Added a mounted case that recovers, is then refused a 412, and presses Save again: exactly one further request, still carrying the recovered version, with no second GET.
  - `[low]` `[patch]` The sole-move DW-553 case had no mounted coverage — both new cases added an unrelated edit to keep Save reachable. Added the case where the move is the owner's only edit: the legs revert, the sentence stands, Save goes disabled, and the comment states that this is the correct terminal state.
  - `[low]` `[patch]` The route/client coupling DW-553 rests on was argued in prose and pinned nowhere. `settings-route.test.ts`'s workbench-writer refusal case now asserts `settingsRefusalPinsEmbeddingProvider` against the body the route actually produced.
  - `[low]` `[patch]` The recovery comment did not state the trade it makes — a re-read precondition cannot be refused as a conflict, so an edit landing in that window is overwritten. Now stated, with why it is still right and why a held version is never refreshed.
  - `[low]` `[patch]` The comment claimed `SkillsCanvas.toggle`'s shape "minus its refusal"; it also differs in reading on every write. Both differences are now named.

## Design Notes

Recognising the refusal by its sentence is deliberate, and it is safe because the set is closed at both ends: the route mints it only from `storedBefore.envEmbeddingProvider`, typed `EmbeddingProvider | null`, and `envEmbeddingProvider()` filters through `isEmbeddingProvider` — so every sentence the route can send is one of four this module can mint. Adding an error code to the route would be a wire-contract change this bundle does not carry.

```ts
export function settingsRefusalPinsEmbeddingProvider(message: string): boolean {
  return EMBEDDING_PROVIDERS.some(
    (provider) => settingsEnvProviderPinRefusalCopy(provider) === message,
  );
}
```

The version re-read is lazy rather than eager for one reason: a held version is the description of the config the draft was seeded from, and refreshing one that is still held would silently convert every conflict into a clobber. Only the absent case has nothing left to lose.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-settings.test.ts` -- expected: all pass, including the two new rule describes and the updated call-site scan.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/` -- expected: all pass, including the new DW-553 describe and the rewritten DW-555 reconciliations.
- `pnpm test` -- expected: both projects green.
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm exec eslint src/lib/workbench-settings.ts src/components/workbench/SettingsCanvas.tsx` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Two recoveries on the Settings canvas, both driven from the one `save` callback and both deciding through pure rules in `workbench-settings.ts`. DW-553: a save refused with the env pin's sentence — recognised by exact equality against every sentence `settingsEnvProviderPinRefusalCopy` can mint, a set `envEmbeddingProvider()`'s `isEmbeddingProvider` filter closes — re-seeds the draft's three embedding legs from the payload the surface is holding, so the retry is no longer the move the route refuses. DW-555: when the held version is falsy at Save time, the version and only the version is re-read through `fetchWorkbenchSettings()` and adopted, leaving every unsaved edit exactly where the owner left it; a read that fails or answers none does not swallow the save.

**Files changed.**
- `src/lib/workbench-settings.ts` — added `settingsRefusalPinsEmbeddingProvider` and `settingsDraftAfterEmbeddingPinRefusal`; no existing rule or copy string touched.
- `src/components/workbench/SettingsCanvas.tsx` — the two recoveries inside `save`, and nothing else.
- `src/lib/__tests__/workbench-settings.test.ts` — rule coverage for both new functions; the canvas source scan moves from one `fetchWorkbenchSettings(` call site to two, with the reason named.
- `src/lib/__tests__/settings-route.test.ts` — the route's refusal body is now asserted against the browser's recognition predicate. Route production code untouched.
- `src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx` — the mounted DW-553 cases, including the sole-move terminal state.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` — the mounted DW-555 cases; the DW-199 / DW-376 / DW-428 reconciliations now end in a recovery rather than a 428 dead end.

**Review findings.** 6 patched (2 medium, 4 low), 3 deferred (all low, in frontmatter `deferred`), 15 rejected.

**Follow-up review recommendation:** true. Patched by severity — high 0, medium 2, low 4; score `3 x 2 + 1 x 4 = 10`, at or above 5.

**Verification.** `pnpm test` — 350 files, 8171 passed / 1 skipped. `pnpm exec tsc --noEmit` — clean. `pnpm exec eslint` over all six changed files — clean. The I/O matrix rows are each covered by a mounted case that ran and passed. During the patch pass the implementer confirmed by mutation that the new adoption test fails when the `setPayload` line is removed, and that the `null` and `""` cases fail when the guard is reverted to `=== undefined`.

**Residual risks.**
- The recovery read arms its deadline with `AbortSignal.timeout`, whose abort reason is a `TimeoutError` rather than `SETTINGS_TIMEOUT_REASON`, so a blown deadline resolves to `stale` rather than `failed`. Both are non-`ok` at this one call site and behave identically, but a future branch on `failed` there would not fire.
- The recovered precondition describes a store state the draft was not seeded from, so that one save cannot be refused as a conflict. Accepted deliberately and documented at the call site; a held version is never refreshed, so ordinary conflict detection is unchanged.
- After the DW-553 re-seed the select is still editable on a stale tab, so the owner can re-make the refused move. The surface does not adopt `envEmbeddingProvider` from a refusal body — it may only show store state it was served — and the next read is what corrects the tab.
