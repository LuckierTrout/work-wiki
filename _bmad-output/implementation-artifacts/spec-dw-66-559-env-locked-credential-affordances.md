---
title: 'Env-locked credential and model affordances (DW-66, DW-559)'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
baseline_revision: '7b1b4945a0402686536c29f4ab25dba834516ba2'
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The Workers AI dimensions sentence on the flat page's embedding model hint is selected by
      model NAME alone, so an `EMBEDDING_MODEL=@cf/baai/bge-m3` pin on a non-Workers-AI provider
      claims the deployment uses Cloudflare Workers AI when it does not.
    evidence: |-
      `EmbeddingSettings.tsx`'s hint appends the sentence on `effectiveModel === "@cf/baai/bge-m3"`
      with no provider term, and the component is never handed the embedding provider. Pre-existing:
      the same name-only condition selected the same sentence before this change, which only added
      the pin sentence in front of it. Reaching the state needs `EMBEDDING_MODEL` pinned to the
      Workers AI model while `embeddingProvider` is something else, where the resolver substitutes
      and the override note already fires — so the dimensions claim is the one sentence still wrong.
    location: >-
      src/components/EmbeddingSettings.tsx:303
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two Settings surfaces present environment-supplied values as owner-editable. `hasCustomApiKey` / `hasFirecrawlApiKey` count `LLM_CUSTOM_API_KEY` / `FIRECRAWL_API_KEY` alongside the stored value, so the row reads "A key is stored." and offers `Remove` for a key the route cannot delete — pressing it clears nothing and the sentence does not change (DW-66). And both flat-page model hints say "Leave empty to use the default…" on the env branch, where the control is a non-editable `<div>` with no box to empty (DW-559).

**Approach:** Split each conflated boolean into a stored-only flag plus a separate env flag, exactly as `hasEmbeddingApiKey` / `envEmbeddingApiKeyProviders` already are, so `Remove` disappears for an env-only key and the row says where the key comes from. Branch both model hints on `modelSource === "env"` so the locked box states what pinned the value instead of giving advice the control refuses.

## Boundaries & Constraints

**Always:**
- The env half is read through ONE door per variable — extend `apiKeyForProvider`'s custom leg and `getFirecrawlSettings` rather than adding a second `process.env` read beside them.
- `nonEmpty` semantics for every env read: set-but-empty (`FIRECRAWL_API_KEY=""`) is not a credential, and must not mask a stored key.
- Both new payload booleans are REQUIRED in `isWorkbenchSettingsPayload`: a payload carrying the stored half without the env half renders "No key is stored." beside a working env credential, which is a wrong answer, not a degraded one.
- Env copy names the VARIABLE where the payload knows it unambiguously; where it does not (`ProviderForm`, whose `"env"` covers both `LLM_MODEL` and `OLLAMA_MODEL`), name the closed set rather than guessing one.
- The env/editable ternary's structure stays as it is: the hint `<p>` and its id stay OUTSIDE the ternary (unconditional id, DW-506), and the locked `<div>` still carries no `aria-describedby`.
- The Workers AI dimensions sentence on `EmbeddingSettings`'s locked branch survives — the pin sentence composes with it rather than replacing it.

**Block If:** nothing here needs a human. Neither DW requires a product decision; both are affordance repairs with an existing in-repo pattern to mirror.

**Never:**
- Do not change what `apiKeyForProvider("custom")`, `providerIsConfigured`, `getFirecrawlSettings().hasKey`, or any runtime resolver returns — this is a reporting split, not a precedence change. Env still wins at runtime.
- Do not put a stored key value on the payload (AD-23): booleans only.
- Do not widen `EffectiveSettings` / `useSettings` with a new field to name `ProviderForm`'s pinning variable.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Env-only custom key | `LLM_CUSTOM_API_KEY=sk-env`, nothing stored | `hasCustomApiKey: false`, `envCustomApiKey: true`; row reads "No key is stored." plus the env sentence; NO `Remove` | No error expected |
| Stored-only custom key | no env var, `customApiKey` stored | `hasCustomApiKey: true`, `envCustomApiKey: false`; "A key is stored." with `Remove` | No error expected |
| Both halves present | env var AND stored key | both booleans true; "A key is stored." + env sentence, `Remove` still offered (it deletes the stored one) | No error expected |
| Empty env var | `FIRECRAWL_API_KEY=""`, key stored | `envFirecrawlApiKey: false`, `hasFirecrawlApiKey: true` — set-but-empty is not a credential | No error expected |
| Env-pinned embedding model | `modelSource: "env"`, `effectiveModel` not `@cf/baai/bge-m3` | hint states the `EMBEDDING_MODEL` pin; never "Leave empty…" | No error expected |
| Env-pinned Workers AI model | `modelSource: "env"`, `effectiveModel === "@cf/baai/bge-m3"` | pin sentence AND the 1,024-dimensional Vectorize sentence, in that order | No error expected |
| Env-pinned LLM model | `ProviderForm` `settings.modelSource === "env"` | hint states the environment pin and names `LLM_MODEL` / `OLLAMA_MODEL`; never "Leave empty…" | No error expected |
| Editable model box | `modelSource` is `config` / `default` / `none` | today's "Leave empty…" copy, unchanged | No error expected |

</intent-contract>

## Code Map

- `src/lib/config.ts:1005-1029` — `apiKeyForProvider`; the `custom` leg is `nonEmpty(process.env.LLM_CUSTOM_API_KEY) ?? nonEmpty(loadConfigSync().customApiKey)`. Extract the env half into a named helper both this and the payload read.
- `src/lib/config.ts:1519-1529` — `getFirecrawlSettings()`; `hasKey` is the OR of env and store. Add the two halves beside it, keep `hasKey` for its existing consumers.
- `src/lib/config.ts:1452-1470` — `envEmbeddingApiKeyProviders()` / `embeddingKeyPresent()`: the pattern to mirror.
- `src/lib/config.ts:1737` (`hasCustomApiKey`), `:1754` (`hasEmbeddingApiKey`, the model comment to copy), `:1783` (`hasFirecrawlApiKey`) — inside `getWorkbenchSettings`.
- `src/lib/workbench-settings.ts:1023` / `:1132` — `WorkbenchSettingsPayload` fields; `:1118` and `:1147-1160` are the doc-comment style for an env-half field.
- `src/lib/workbench-settings.ts:1356-1370` — `isWorkbenchSettingsPayload`, where the new booleans are checked.
- `src/lib/workbench-settings.ts:549-551` — `settingsEnvKeyCopy(providerName)`, the existing env-key sentence (provider-shaped); `:398-405` `settingsEnvOverrideCopy` and `:429-431` `settingsEnvProviderPinCopy` are the "the environment sets X, and that wins at runtime" wordings to stay consistent with.
- `src/components/workbench/SettingsCanvas.tsx:632-698` — `secretRow(key, label, hasStoredKey, extraHint?)`; `Remove` is gated on `hasStoredKey && !stored.readOnly`, so a stored-only boolean suppresses it by construction. `:978-989` is the embedding row passing `settingsEnvKeyCopy` as `extraHint` — the call shape to mirror at `:811` (custom) and `:1254-1258` (Firecrawl).
- `src/components/ProviderForm.tsx:342-378` — the env/editable ternary and the unconditional `providerModelHint` `<p>`.
- `src/components/EmbeddingSettings.tsx:212-289` — same shape; `MODEL_HINT_ID` const at `:135`, hint `<p>` at `:284-288` with the `@cf/baai/bge-m3` special case.
- `src/lib/config.ts:2049-2071` — why `ProviderForm`'s `modelSource === "env"` is ambiguous: `LLM_MODEL` first, then `OLLAMA_MODEL` for the two Ollama providers. `src/lib/config.ts:379-381` — `getEmbeddingModelOverride()` reads `EMBEDDING_MODEL` only, so the embedding hint CAN name its variable.
- Typed fixtures that must gain the two fields: `src/components/workbench/__tests__/settings-harness.tsx:49,73`, `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx:62,77`, `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx:58,73`.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:131-155` (`ENV_KEYS`, missing `FIRECRAWL_API_KEY`) and `:813-841` — the sibling `hasEmbeddingApiKey` / `envEmbeddingApiKeyProviders` cases these new node cases sit beside.
- Existing hint cases to update: `src/components/__tests__/provider-form.test.tsx:670-690` and `src/components/__tests__/embedding-settings-override.test.tsx:331-397`.
- Read-only interaction already covered: `src/components/workbench/__tests__/settings-read-only.test.tsx:206-222`.

## Tasks & Acceptance

**Execution:**
- `src/lib/config.ts` — name the `LLM_CUSTOM_API_KEY` env read once and let `apiKeyForProvider`'s custom leg use it; add `hasEnvKey` / `hasStoredKey` to `FirecrawlSettings`; make `hasCustomApiKey` and `hasFirecrawlApiKey` STORED-only in `getWorkbenchSettings` and add `envCustomApiKey` / `envFirecrawlApiKey` beside them — one door per variable, so the surface and the resolver cannot drift.
- `src/lib/workbench-settings.ts` — declare the two new payload booleans with the doc comment saying why the pair rides apart; require both in `isWorkbenchSettingsPayload`; add the env-key sentence the two rows use (variable-named, alongside the existing provider-named `settingsEnvKeyCopy`).
- `src/components/workbench/SettingsCanvas.tsx` — pass the new env sentence as `extraHint` on the Custom API key and Firecrawl API key rows when the env flag is set; no change to `secretRow` itself.
- `src/components/ProviderForm.tsx` — branch the model hint on `settings?.modelSource === "env"`, keeping the `<p>` and its id outside the ternary.
- `src/components/EmbeddingSettings.tsx` — branch the hint on `modelSource === "env"` so every env-pinned model gets the `EMBEDDING_MODEL` sentence, with the Workers AI dimensions sentence appended for `@cf/baai/bge-m3`.
- `src/components/workbench/__tests__/settings-harness.tsx`, `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx`, `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` — add the two fields to the payload fixtures (fresh deployment: both `false`).
- `src/lib/__tests__/settings-runtime-wiring.test.ts` — add `FIRECRAWL_API_KEY` to `ENV_KEYS`; pin the stored/env split for both keys, including set-but-empty.
- `src/components/workbench/__tests__/settings-env-supplied-keys.test.tsx` (new, dom project) — mount the Models and External Sources categories with each env flag set and assert the sentence and the absent `Remove`.
- `src/components/__tests__/provider-form.test.tsx`, `src/components/__tests__/embedding-settings-override.test.tsx` — update the env-locked hint cases and add the env-pinned non-`bge-m3` embedding case.

**Acceptance Criteria:**
- Given `LLM_CUSTOM_API_KEY` is set and nothing is stored, when the Workbench Settings Models pane renders, then the Custom API key row shows no `Remove` control and its hint names `LLM_CUSTOM_API_KEY` as the source.
- Given `FIRECRAWL_API_KEY` is set and nothing is stored, when the External Sources pane renders, then the Firecrawl API key row shows no `Remove` control and its hint names `FIRECRAWL_API_KEY` as the source.
- Given both an env var and a stored key for the same credential, when the row renders, then `Remove` is still offered and the hint carries both facts.
- Given `EMBEDDING_MODEL` pins a model that is not `@cf/baai/bge-m3`, when `/settings` renders, then the embedding model hint states the `EMBEDDING_MODEL` pin and never says "Leave empty to use the embedding provider default."
- Given `LLM_MODEL` pins the primary model, when `/settings` renders, then the model hint states the environment pin and never says "Leave empty to use the default model for the selected provider."
- Given no env pin, when either page renders its editable model input, then the existing "Leave empty…" copy is unchanged and still announced through `aria-describedby`.

## Design Notes

Why `ProviderForm`'s sentence does not name a single variable: `getEffectiveSettings` reports `modelSource: "env"` for `LLM_MODEL` and, on an Ollama provider with nothing stored, for `OLLAMA_MODEL`. The browser is handed only the source, so picking one name would be a client-side re-derivation of a server rule — the "a rule stated twice is two rules that agree today" failure this repo keeps closing. Naming the closed set is honest and still actionable. `EmbeddingSettings` has no such ambiguity (`getEmbeddingModelOverride()` reads `EMBEDDING_MODEL` and nothing else), so it names it.

Wording follows the established shape — "The environment sets X, and that wins at runtime." — with an honest second half per surface: the model boxes are FIXED (`settingsEnvProviderPinCopy`'s second half), while a key row's second half says nothing needs to be stored here.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/workbench-settings.test.ts` — expected: pass.
- `pnpm exec vitest run --project dom src/components/__tests__/provider-form.test.tsx src/components/__tests__/embedding-settings-override.test.tsx src/components/workbench/__tests__ src/app/settings/__tests__` — expected: pass.
- `pnpm exec tsc --noEmit` — expected: no errors (the payload widening is caught here, not by vitest).
- `pnpm test` — expected: full suite green.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Environment-supplied credentials and models are no longer presented as owner-editable. `hasCustomApiKey` and `hasFirecrawlApiKey` are now STORED-only booleans with `envCustomApiKey` / `envFirecrawlApiKey` riding beside them, mirroring `hasEmbeddingApiKey` / `envEmbeddingApiKeyProviders` — so `secretRow`'s existing gate takes `Remove` off an env-only key by construction, and the row says which variable supplies it. Both flat-page model hints branch on `modelSource === "env"`: the locked box now states what pinned the value instead of telling the owner to empty a control that accepts no keystroke. No resolver or precedence changed — env still wins at runtime.

**Files changed.**
- `src/lib/config.ts` — one `LLM_CUSTOM_API_KEY` door (`envCustomApiKey()`) shared by `apiKeyForProvider`, the flat page's source badge and the payload; `FirecrawlSettings` gains `hasEnvKey` / `hasStoredKey`; `getWorkbenchSettings` serves the two split pairs.
- `src/lib/workbench-settings.ts` — two new REQUIRED payload booleans with their doc rationale, both checked in `isWorkbenchSettingsPayload`, and `settingsEnvKeyVariableCopy(kind, hasStoredKey)`.
- `src/components/workbench/SettingsCanvas.tsx` — the Custom API key and Firecrawl API key rows pass the env sentence as `extraHint`; `secretRow` itself untouched.
- `src/components/ProviderForm.tsx` — model hint branches on the env source, naming the closed `LLM_MODEL` / `OLLAMA_MODEL` set.
- `src/components/EmbeddingSettings.tsx` — hint branches on the env source with the `EMBEDDING_MODEL` pin; the Workers AI dimensions sentence composes rather than being replaced.
- `src/components/workbench/__tests__/settings-env-supplied-keys.test.tsx` (new) — mounted cases for env-only, both-halves and stored-only on both rows.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` — `FIRECRAWL_API_KEY` added to `ENV_KEYS`; the stored/env split pinned for both credentials including set-but-empty and the unchanged resolver.
- `src/lib/__tests__/workbench-settings.test.ts`, `src/components/workbench/__tests__/settings-harness.tsx`, `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx`, `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` — payload fixtures widened; validator rejection case added.
- `src/components/__tests__/provider-form.test.tsx`, `src/components/__tests__/embedding-settings-override.test.tsx` — env-pin copy pinned, plus non-env regression loops over `config` / `default` / `none`.

**Review findings breakdown.** 5 patches applied (1 medium, 4 low), 1 item deferred (low), 16 rejected. No intent gaps and no spec repairs.

**Follow-up review recommendation:** true. Patched severities: high 0, medium 1, low 4 → score `3 × 1 + 1 × 4 = 7`, which is ≥ 5.

**Verification performed.**
- `pnpm exec tsc --noEmit` — clean (the payload widening is caught here, not by vitest).
- `pnpm test` — 348 files, 8074 passed, 1 skipped, after the patch pass.
- Targeted node and dom runs from the Verification section — green before and after the patch pass.
- Matrix audit: every I/O row is covered by a case that ran — the four key-split rows by `settings-runtime-wiring.test.ts` and `settings-env-supplied-keys.test.tsx`, the three model-hint rows and the editable-box row by `embedding-settings-override.test.tsx` and `provider-form.test.tsx`.

**Residual risks.**
- The two model-hint sentences are inline literals in their components (matching the "Leave empty…" copy they replace) and are re-spelled in their suites, so a reword needs both halves edited together.
- Both hint sentences name variables the browser cannot verify: they are pinned against a `modelSource` prop, not against `getEffectiveSettings`'s ladder. A third env leg added to that ladder would leave every case green while the copy named the wrong variables.
- `FirecrawlSettings.hasKey` now has no production reader. It is retained as the credential-presence answer with its comments corrected; nothing depends on it outside tests.
