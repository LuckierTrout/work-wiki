---
title: 'EMBEDDING_PROVIDER env pin: pinned copy, an invalid signal, gate alignment, and a route refusal'
type: 'bugfix'
created: '2026-08-29'
baseline_revision: 'a01509cc07a566ed9e387e24e318da3692923442'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      DW-509 aligned only the RUNTIME gate on a junk EMBEDDING_PROVIDER, so the route's
      and the browser's halves of canEnableVectorSearch now disagree with it for that
      state.
    evidence: |-
      `getVectorSearchSettings` now reads the raw variable and refuses `deepseek`
      (`enabled: false`), but `mergedVectorInputs` (src/lib/workbench-settings.ts:2411)
      and `draftVectorInputs` (:2935) still read the FILTERED `envEmbeddingProvider`,
      which is `null` for junk, and fall through to the stored provider. Verified
      end-to-end by the review: with `EMBEDDING_PROVIDER=deepseek` and a complete stored
      OpenAI configuration, the Workbench switch reads as satisfiable, `PUT
      /api/settings` answers 200 and stores `vectorSearchEnabled: true`, while
      `getVectorSearchSettings()` answers `{provider: "deepseek", enabled: false}`. The
      repo's own comments (src/app/api/settings/route.ts:546,
      src/lib/workbench-settings.ts:2199) and an existing test
      (workbench-settings.test.ts:2601) assert all three feeders answer identically. Not
      a functional regression — the backfill that 200 enqueues failed before this change
      too, on a different sentence — but the three feeders no longer agree, and the new
      `envEmbeddingProviderInvalid` field reaches no readiness surface, unlike its
      research twin, which drives `draftResearchProviderConfigured` to `false`. This
      spec's intent named `src/lib/config.ts:1289` alone and its ledger entry called the
      other two feeders "pre-existing and untouched", so aligning them (and deciding
      whether a junk pin should refuse a turn-on) is a separate decision.
    location: >-
      src/lib/workbench-settings.ts:2411 (mergedVectorInputs) and :2935 (draftVectorInputs)
    severity: medium
  - summary: >-
      A stale tab refused by the new route pin has no way forward: the draft keeps the
      blanked endpoint and key, so every retry re-sends the same move and gets the same
      400.
    evidence: |-
      `SettingsCanvas`'s save keeps the draft on any non-ok result (SettingsCanvas.tsx:341-343),
      and the draft that produced the refusal already had `embeddingBaseUrl` and
      `embeddingApiKey` blanked by `settingsDraftAfterEmbeddingProvider`. The owner of a
      tab opened before `EMBEDDING_PROVIDER` was set can only escape by reverting the
      select by hand or reloading, and the refusal sentence names neither. The same
      keep-the-draft behaviour applies to every other 400 on this surface, so re-seeding
      the draft from the answered payload for this refusal specifically — or saying
      "reload" in the copy — is a surface decision this bundle did not carry.
    location: >-
      src/components/workbench/SettingsCanvas.tsx:341 (save result handling)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The `EMBEDDING_PROVIDER` pin DW-398 shipped is half a pin. Under it the provider row still shows the generic `settingsEnvOverrideCopy` sentence promising "what you save here applies once that variable is unset" — a save the select now refuses (DW-507); an unsupported value (`EMBEDDING_PROVIDER=deepseek`) produces no owner-visible signal at all while the resolver refuses it and nothing embeds (DW-508); `getVectorSearchSettings` falls back to the stored provider on that same junk while `resolveEmbeddingProvider` returns `null`, so the runtime gate can report the switch satisfied on a provider that never embeds (DW-509); and the pin is browser-side only, so a direct PUT, a stale tab or a CLI still reaches the `embeddingProviderChanged` clear that destroys the stored embedding key and endpoint (DW-510).

**Approach:** Make the embedding row behave like the `researchProviderRow` it was modelled on: a dedicated pinned sentence replacing the generic one, plus an `envEmbeddingProviderInvalid` payload field carrying an invalid-value sentence; align `getVectorSearchSettings`'s provider ladder with `resolveEmbeddingProvider`'s (raw env value first, `isEmbeddingProvider` refusal at the gate); and refuse an `embeddingProvider` MOVE at `PUT /api/settings` while a supported `EMBEDDING_PROVIDER` is set.

## Boundaries & Constraints

**Always:**
- The route refusal fires on a MOVE, never on presence: `settingsSaveBody` sends `embeddingProvider` on every save, so a presence check would refuse every unrelated edit (a timeout, the loopback switch) on a pinned deployment. `embeddingProviderChanged(existing, incoming)` is the one predicate, the same one both writers already clear on.
- The route refusal covers BOTH writers of the field — the flat `body.embeddingProvider` branch and `body.workbench.embeddingProvider` — and refuses before `saveConfig`, so a refused request leaves the store byte-identical.
- The route pin reads the same FILTERED value the select pins on (`workbenchSettingsStored(existing, …).envEmbeddingProvider`), so the route refuses exactly the moves the select refuses and no others.
- A junk `EMBEDDING_PROVIDER` leaves the select editable and the route open, per DW-398's recorded boundary: it names no vendor, so there is no credential a move could sabotage, and the store is what applies the moment the variable is corrected.
- `getVectorSearchSettings`'s provider ladder becomes `nonEmpty(process.env.EMBEDDING_PROVIDER) ?? nonEmpty(cfg.embeddingProvider)` — the exact ladder `resolveEmbeddingProvider` reads, with the `isEmbeddingProvider` refusal left to `vectorSearchMissingLegs`' existing provider leg. `providerOrigin` follows the same raw read.
- `VectorSearchSettings`'s DECLARED shape is unchanged (five keys, pinned by `settings-runtime-wiring.test.ts`).
- `envEmbeddingProviderInvalid` is optional in the payload and validated exactly as `envResearchProviderInvalid` is, so no existing payload fixture becomes invalid.
- New copy lives in `src/lib/workbench-settings.ts` beside `settingsEnvOverrideCopy` (client-safe, node-testable), not inline in the component.

**Block If:**
- Nothing. All four entries carry their decision: DW-510's is recorded 2026-08-28 ("Refuse at the route"), and DW-507/DW-508 are copy decisions this spec takes explicitly.

**Never:**
- Do not change `embeddingProviderChanged`, `applyWorkbenchSettings`'s clear rule, or the flat branch's clear rule — the refusal sits in FRONT of them.
- Do not pin the select, or refuse at the route, on a junk `EMBEDDING_PROVIDER`.
- Do not teach the SAVE gate (`mergedVectorInputs` / `draftVectorInputs`, which read the filtered `stored.envEmbeddingProvider`) about junk: refusing a save there would lock the owner out of storing the provider that applies once the variable is corrected. Only the RUNTIME gate aligns.
- Do not add per-provider keying or migration for `embeddingApiKey`/`embeddingBaseUrl`.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Pinned provider row | `envEmbeddingProvider: "workers-ai"` | Hint is the PINNED sentence naming `EMBEDDING_PROVIDER`, its value, and that this box is fixed until it is unset; no "applies only once that variable is unset" promise | No error expected |
| Junk provider row | `EMBEDDING_PROVIDER=deepseek`, stored `openai` | Payload carries `envEmbeddingProvider: null`, `envEmbeddingProviderInvalid: "deepseek"`; hint is the invalid sentence; select stays editable and unpinned | No error expected |
| No variable set | `envEmbeddingProvider: null`, no invalid | Unchanged: `SETTINGS_VECTOR_PROVIDER_COPY`, editable select | No error expected |
| Junk env, runtime gate | `EMBEDDING_PROVIDER=deepseek`, stored `openai` + key + model, `vectorSearchEnabled: true` | `getVectorSearchSettings()` reports `provider: "deepseek"`, `enabled: false` — the same refusal `resolveEmbeddingProvider` makes | No error expected |
| Blank env, runtime gate | `EMBEDDING_PROVIDER="  "`, stored `openai` + legs | Unchanged: `provider: "openai"`, `providerOrigin: "stored"`, `enabled: true` | No error expected |
| PUT moves the provider under a pin | `EMBEDDING_PROVIDER=workers-ai`, stored `openai`, body `{embeddingProvider:"google"}` | 400 with the refusal sentence naming the variable; store untouched, key and endpoint intact | 400, nothing written |
| PUT moves it via `workbench` | Same pin, body `{workbench:{embeddingProvider:"google", …}}` | Same 400, same sentence | 400, nothing written |
| PUT repeats the stored provider under a pin | `EMBEDDING_PROVIDER=workers-ai`, stored `openai`, body carries `embeddingProvider:"openai"` plus a timeout edit | 200 — not a move, so the pin does not fire and the unrelated edit lands | No error expected |
| PUT moves it under a JUNK variable | `EMBEDDING_PROVIDER=deepseek`, stored `openai`, body `{embeddingProvider:"google"}` | 200 — unpinned, existing clear-on-switch behaviour unchanged | No error expected |
| PUT moves it with no variable | No `EMBEDDING_PROVIDER`, body moves the provider | 200 — unchanged | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts:392-406` -- `ENV_OVERRIDE_VARIABLES` + `settingsEnvOverrideCopy`. The `provider` kind loses its last caller here; retire it so the remaining two kinds (`model`, `customBaseUrl`) are the free-text boxes the docblock at `:365-392` already describes, and the "boundary rather than a retraction" paragraph goes with it. New copy for the pin and the invalid value belongs beside it.
- `src/lib/workbench-settings.ts:344-364` -- `SETTINGS_VECTOR_BINDING_ENV_NOTE`'s docblock reasons its non-duplication against `settingsEnvOverrideCopy` being "the provider row's standing hint". Re-point at the new pinned sentence, which must still say the variable wins over this box.
- `src/lib/workbench-settings.ts:1769-1773` -- `vectorSearchFieldIssue`'s `"model"` exception docblock, same re-pointing where it names the provider row.
- `src/lib/workbench-settings.ts:1005-1020` -- `WorkbenchSettingsValues.envEmbeddingProvider`; `:1066-1068` `envResearchProvider` / `envResearchProviderInvalid?` — the optional-field shape to mirror. `:1251` is its validator line in `isWorkbenchSettingsPayload`.
- `src/lib/config.ts:1287-1332` -- `getVectorSearchSettings`; `:1289-1290` the `envEmbeddingProvider() ?? nonEmpty(cfg.embeddingProvider)` fallback and `:1304` its `providerOrigin`. `:1402-1408` `envEmbeddingProvider()` (keep — still the payload/`workbenchSettingsStored` leg); `:1392-1398` `nonEmpty`.
- `src/lib/config.ts:1691,1732` -- `getWorkbenchSettings`'s `envProvider` and `envEmbeddingProvider:` line; `:1754` `envResearchProviderInvalid: research.invalidEnvProvider` is the sibling to add beside.
- `src/lib/embeddings.ts:212-256` -- `resolveEmbeddingProvider`, the ladder DW-509 aligns to: raw `nonEmpty` env, then store, then `if (!isEmbeddingProvider(override)) return null`.
- `src/lib/workbench-settings.ts:1476-1481` -- `vectorSearchMissingLegs`' first leg (`!v.provider || !isEmbeddingProvider(v.provider)`), which is what makes a junk provider refuse without any new branch.
- `src/components/workbench/SettingsCanvas.tsx:823-905` -- the embedding provider row: `envPinned` at `:823`, the hint composition at `:893-904`. `:706-760` `researchProviderRow` is the three-way hint precedent (invalid → pinned → standing).
- `src/app/api/settings/route.ts:296-304` -- `existing` is read here; `:426-469` the flat `embeddingProvider` branch; `:536-546` `validateWorkbenchSettingsPatch` and the 400 refusal shape. `workbenchSettingsStored` and `embeddingProviderChanged` are already imported (`:1-21`).
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx:545-600,690-700` -- three assertions on `settingsEnvOverrideCopy("provider", …)` that MUST move to the new pinned sentence.
- `src/lib/__tests__/workbench-settings.test.ts:887-894` -- pins the binding note's non-duplication against the provider hint; `:2525-2533` pins the three kinds of the override sentence.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:964-1000` -- the junk-`EMBEDDING_PROVIDER` payload case and the `VectorSearchSettings` key-shape pin.
- `src/lib/__tests__/settings-route.test.ts:544-740,1040-1210` -- the PUT suite that already drives both writers of `embeddingProvider` (flat at `:1180`, `workbench` at `:1156`) and asserts what `saveConfig` was called with; the pin cases belong here rather than in a new file.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- add `settingsEnvProviderPinCopy(value)` (the pinned sentence: names `EMBEDDING_PROVIDER`, its value, that it wins over this box, and that the box is fixed until it is unset) and `settingsEnvProviderInvalidCopy(value)` (names the unsupported value and that nothing will embed until the environment is corrected); retire the now-callerless `provider` kind from `ENV_OVERRIDE_VARIABLES` and rewrite the docblock paragraphs that leaned on it; add `envEmbeddingProviderInvalid?: string | null` to `WorkbenchSettingsValues` and its optional line to `isWorkbenchSettingsPayload`, both mirroring `envResearchProviderInvalid`.
- `src/lib/config.ts` -- serve `envEmbeddingProviderInvalid` from `getWorkbenchSettings` (raw `nonEmpty(process.env.EMBEDDING_PROVIDER)` when it is set and unsupported, else `null`), and change `getVectorSearchSettings`'s provider ladder and `providerOrigin` to read the RAW env value so the runtime gate refuses junk exactly as `resolveEmbeddingProvider` does -- DW-508, DW-509.
- `src/components/workbench/SettingsCanvas.tsx` -- give the embedding provider row the three-way hint `researchProviderRow` uses (invalid sentence → pinned sentence → `SETTINGS_VECTOR_PROVIDER_COPY`), keeping the gate's complaint appended as today, and comment why the invalid arm describes without pinning -- DW-507, DW-508.
- `src/app/api/settings/route.ts` -- refuse an `embeddingProvider` MOVE (either writer) with 400 and the shared refusal sentence while `workbenchSettingsStored(existing, …).envEmbeddingProvider` is non-null, placed after the write precondition and before `updated` is mutated -- DW-510.
- `src/lib/__tests__/workbench-settings.test.ts` -- retarget the two `settingsEnvOverrideCopy("provider", …)` assertions at the new pinned sentence, and add payload-validator cases for the new optional field.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- cover the junk/blank/valid rows of the matrix for both `getWorkbenchSettings().envEmbeddingProviderInvalid` and `getVectorSearchSettings()`, including the unchanged five-key shape.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- move the three env-pin assertions onto the pinned sentence and add the junk-variable row (invalid sentence shown, select editable, no `aria-invalid` from the pin).
- `src/lib/__tests__/settings-route.test.ts` -- add the six PUT rows of the matrix, asserting `saveConfig` is never called on a refused move and that the store's `embeddingApiKey`/`embeddingBaseUrl` are intact.

**Acceptance Criteria:**
- Given a pinned deployment, when the owner saves any unrelated setting from the Workbench with the select showing the stored provider, then the save lands — the pin costs no owner an unrelated edit.
- Given any of the four DW entries' surfaces, when `EMBEDDING_PROVIDER` is unset, then every behaviour is byte-identical to today.
- Given a supported `EMBEDDING_PROVIDER`, when a caller PUTs a different `embeddingProvider` through either writer, then the response is 400 and a subsequent GET shows the stored embedding key and endpoint unchanged.

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 1, low 7)
- defer: 2: (high 0, medium 2, low 0)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[medium]` `[patch]` DEPLOY.md still said a flat `embeddingProvider` is "stored silently" and that "nothing gates EMBEDDING_PROVIDER", and presented the `[embeddings]` log line as the whole signal for an unsupported value — all three made false by DW-510 and DW-508. Rewrote those three facts in the document's voice, leaving the stored-feeder paragraph (still log-only) intact.
  - `[low]` `[patch]` The route's refusal sentence named neither the forced provider nor anything its motivating reader (a stale tab) can act on. Replaced the constant with `settingsEnvProviderPinRefusalCopy(value)`, shaped like every sibling env sentence, and rewrote the JSDoc that argued the opposite.
  - `[low]` `[patch]` The pin's non-string carve-out comment was wrong for the flat field, which the earlier validation block already refuses with a 400. Comment corrected to say only `workbench.embeddingProvider` can reach it.
  - `[low]` `[patch]` The pin built a third `workbenchSettingsStored(existing, …)` in one handler. Hoisted one `storedBefore` and reused it at the pin, the gate's baseline argument and the backfill's "was it off" question.
  - `[low]` `[patch]` The hint's invalid-first ordering would announce "Nothing will embed" on a pinned, disabled select if a wire payload ever carried both env fields. `envInvalid` is now derived only when `envEmbeddingProvider === null`, with a component case pinning it.
  - `[low]` `[patch]` `ollamaBaseUrlRefusedCopy`'s JSDoc still said `settingsEnvOverrideCopy` is "one function for three variables" after the `provider` kind was retired. Corrected to two.
  - `[low]` `[patch]` `VectorSearchSettings.provider`'s doc no longer described what the field can hold after the raw read. It now says the value may be one the gate refused, and that consumers read `enabled`.
  - `[low]` `[patch]` Two route cases the pin introduced and nothing covered: a move to `null` under a supported pin (a delete is a move and reaches the same clear, so it must refuse) and the workbench writer staying open under a junk variable.

## Design Notes

Why the route refusal mirrors the SELECT's pin rather than "the variable is set at all": the recorded decision's own rationale is "destroyed by a caller that bypasses the select", so the route's job is to close the bypass, not to invent a stricter rule than the surface states. On junk the select is deliberately open (DW-398's recorded boundary) and the route stays open with it.

Why only the RUNTIME gate aligns on junk (DW-509) and not the save gate: `getVectorSearchSettings().enabled` answers "is anything embedding right now", and the honest answer under a junk pin is no — `wiki-retrieve`'s `storedOn && !enabled` branch already renders `CHAT_VECTOR_FALLBACK_COPY` for exactly that state. `canEnableVectorSearch` answers "may this save be written", and a junk variable is a deployment mistake the owner fixes in the environment, not a reason to refuse them the store they will need afterwards. The new invalid sentence is what closes the gap between the two answers on screen.

The provider ladder, after alignment — the same three lines `resolveEmbeddingProvider` reads:

```ts
const envProviderRaw = nonEmpty(process.env.EMBEDDING_PROVIDER);
const provider = envProviderRaw ?? nonEmpty(cfg.embeddingProvider);
// …providerOrigin: envProviderRaw !== null ? "env" : "stored"
```

`vectorSearchMissingLegs`' first leg already refuses `!isEmbeddingProvider(provider)`, so junk needs no new branch and the reported `provider` stays the value the gate was actually read against.

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- expected: pass
- `pnpm exec vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/config.test.ts` -- expected: pass
- `pnpm test` -- expected: pass
- `pnpm exec tsc --noEmit` -- expected: no errors

## Auto Run Result

Status: done
Bundle: embedding-provider-env-pin (DW-507, DW-508, DW-509, DW-510)

### Implemented change

The `EMBEDDING_PROVIDER` pin now behaves like the `RESEARCH_PROVIDER` pin it was modelled on. The pinned provider row has its own sentence instead of the generic env-override one, so it no longer promises a save the select and the route both refuse; an unsupported value reaches the browser as `envEmbeddingProviderInvalid` and is said out loud on the row that used to render exactly as if no variable were set; `getVectorSearchSettings` reads the raw variable through the same ladder `resolveEmbeddingProvider` reads, so the runtime gate refuses a junk pin instead of reporting the switch satisfied on a stored provider that never embeds; and `PUT /api/settings` refuses an `embeddingProvider` MOVE through either writer while a supported variable is set, closing the bypass that let a direct PUT, a stale tab or a CLI destroy the stored embedding key and endpoint.

### Files changed

- `src/lib/workbench-settings.ts` -- retired the callerless `provider` kind from `ENV_OVERRIDE_VARIABLES`; added `settingsEnvProviderPinCopy`, `settingsEnvProviderInvalidCopy` and `settingsEnvProviderPinRefusalCopy`; added the optional `envEmbeddingProviderInvalid` payload field and its validator line; re-pointed the docblocks that leaned on the retired kind.
- `src/lib/config.ts` -- `getVectorSearchSettings`'s provider ladder and `providerOrigin` read the RAW `EMBEDDING_PROVIDER` (DW-509); `getWorkbenchSettings` serves `envEmbeddingProviderInvalid` (DW-508).
- `src/components/workbench/SettingsCanvas.tsx` -- the provider row's three-way hint (invalid, then pinned, then the standing sentence), with the invalid arm describing without pinning.
- `src/app/api/settings/route.ts` -- the server-side pin: one hoisted `storedBefore`, a move-not-presence refusal over both writers, answered before anything is merged or written.
- `DEPLOY.md` -- the three statements this change made false, corrected.
- `src/lib/__tests__/workbench-settings.test.ts` -- the copy assertions retargeted, the three new sentences pinned, and the optional-field validator cases.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- the junk/blank/supported rows for the payload field and the runtime gate, including the unchanged five-key shape and the resolver agreeing.
- `src/lib/__tests__/settings-route.test.ts` -- seven PUT cases for the pin (both writers refused, a delete refused, an unrelated edit landing, both writers open under junk, open with no variable).
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- the pinned sentence, the junk row, and the both-fields payload.

### Review findings breakdown

- Patches applied: 8 (1 medium, 7 low) -- see the Review Triage Log.
- Items deferred: 2 (both medium) -- recorded in frontmatter `deferred`.
- Items rejected: 7.
- Follow-up review recommended: true. Patched severities: high 0, medium 1, low 7; score = 3x1 + 1x7 = 10, which is 5 or more.

### Verification

- `pnpm exec tsc --noEmit` -- clean.
- `pnpm exec next lint` -- no warnings or errors.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- 31 passed.
- `pnpm exec vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/config.test.ts src/lib/__tests__/settings-route.test.ts` -- 481 passed.
- `pnpm test` -- 7574 passed, 1 skipped, 229 failed across 13 files. Every failure is `TypeError: Cannot read properties of undefined (reading 'clear')` on `window.localStorage.clear()` in a `beforeEach`, in workbench component suites this change does not touch. PRE-EXISTING and verified as such: `git stash push -- src/` at `a01509cc` and re-running `workbench-sheet.test.tsx` reproduced 10/10 identical failures on the untouched baseline. Cause is a vitest 3.2.4 / jsdom 30.0.1 incompatibility -- vitest's `populateGlobal` copies `Object.getOwnPropertyNames(win)` plus a hardcoded key list, neither of which carries `localStorage` on this jsdom, so `window.localStorage` is `undefined` in the dom project. Out of scope for this bundle; see residual risks.
- Matrix audit: every row of the I/O & Edge-Case Matrix is covered by a named case that ran and passed -- the three row states of the provider hint and the junk payload in `settings-vector-namespace.test.tsx` and `settings-runtime-wiring.test.ts`, the junk and blank runtime-gate rows in `settings-runtime-wiring.test.ts`, and all five PUT rows in `settings-route.test.ts`.

### Residual risks

- `pnpm test` cannot pass on this machine until the vitest/jsdom mismatch above is resolved; it fails identically with and without this change. Nothing in this bundle can fix it, and it is not recorded here as deferred work because it is an environment/dependency fault rather than a code finding.
- The runtime gate and the two save-gate feeders now disagree for a junk `EMBEDDING_PROVIDER` -- deferred above with the end-to-end evidence. The user-visible outcome is unchanged (the backfill that a 200 enqueues failed before this change too), but the repo's "all three feeders answer identically" invariant no longer holds for that one state.
- `getVectorSearchSettings().provider` can now carry a string that is not an `EmbeddingProvider`. No shipped consumer reads the field (only `.enabled` is read outside tests) and the doc now says so, but a future consumer that treated it as an id would be wrong.
