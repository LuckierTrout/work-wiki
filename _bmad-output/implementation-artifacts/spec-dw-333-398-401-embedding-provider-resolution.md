---
title: 'Embedding provider resolution: blanks, env pins, and unusable Ollama endpoints'
type: 'bugfix'
created: '2026-08-27'
baseline_revision: '5ec752a8a147a7e1b8eae309074578f4fb3d5b52'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Under an EMBEDDING_PROVIDER pin the provider row's hint still ends "What you save
      here applies only once that variable is unset", which promises a save the pin now
      refuses.
    evidence: |-
      `settingsEnvOverrideCopy` is one sentence for three env-owned fields, and the two
      others (`model`, `customBaseUrl`) stay editable, so the sentence is true for them.
      `researchProviderRow` solves this with a dedicated pinned sentence
      ("RESEARCH_PROVIDER is set to X and wins over this box."). The recorded DW-398
      decision names "the existing env-override hint copy", so a pinned variant is a new
      copy decision rather than something this pass could take.
    location: >-
      src/lib/workbench-settings.ts:373 (settingsEnvOverrideCopy)
    severity: medium
  - summary: >-
      An unsupported EMBEDDING_PROVIDER has no owner-visible signal on the embeddings
      surface at all — no pin, no invalid-value sentence, only the standing hint.
    evidence: |-
      `researchProviderRow` reads `stored.envResearchProviderInvalid` and says
      "RESEARCH_PROVIDER is set to unsupported value X. No Deep Research run will start
      until the environment is corrected." There is no `envEmbeddingProviderInvalid`
      counterpart: `envEmbeddingProvider()` filters junk to `null`, so with
      `EMBEDDING_PROVIDER=deepseek` the select shows the stored value, is editable, and
      the hint is the generic SETTINGS_VECTOR_PROVIDER_COPY, while the resolver refuses
      the value and embeds nothing. Adding the signal needs a new payload field threaded
      through GET/PUT — this spec's Block If.
    location: >-
      src/components/workbench/SettingsCanvas.tsx:830 (embedding provider row)
    severity: medium
  - summary: >-
      The runtime resolver and the vector gate disagree about a junk EMBEDDING_PROVIDER —
      the resolver refuses outright, the gate falls back to the stored provider.
    evidence: |-
      `resolveEmbeddingProvider` returns null for an unsupported override, while
      `getVectorSearchSettings` (src/lib/config.ts:1289-1290) reads through
      `envEmbeddingProvider()`, gets null, and falls back to `nonEmpty(cfg.embeddingProvider)`.
      So the gate can report the switch satisfied on the stored provider while nothing
      embeds. Pre-existing and untouched here — DW-333 aligned the two on BLANK, not on
      junk, and aligning them on junk moves which value the gate reports.
    location: >-
      src/lib/config.ts:1289 (getVectorSearchSettings)
    severity: medium
  - summary: >-
      DW-398's pin is browser-side only — PUT /api/settings still accepts an
      embeddingProvider patch under an env pin and still deletes the stored key and
      endpoint.
    evidence: |-
      `applyWorkbenchSettings` clears `embeddingApiKey`/`embeddingBaseUrl` through
      `embeddingProviderChanged` regardless of `EMBEDDING_PROVIDER`, so a direct PUT, a
      stale tab, or a CLI reaches the destruction the select now refuses. This matches the
      repo's existing convention — the `researchProvider` pin is UI-only too — and the
      recorded decision names the select specifically, so a route-level refusal is a
      separate decision.
    location: >-
      src/app/api/settings/route.ts (embeddingProvider patch branch)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `resolveEmbeddingProvider` reads `EMBEDDING_PROVIDER` raw, so a whitespace-only value is truthy, shadows a valid stored provider, and is then refused while quoting a blank string (DW-333) — every sibling reader already goes through `nonEmpty`. The recorded DW-398 decision (disable the embedding-provider select under an env pin) is unapplied. And DW-370's endpoint-usability check reached only the auto-detect rung: an explicit `ollama` selection still resolves silently to the AI SDK's own localhost default when no endpoint resolves (DW-401).

**Approach:** Read both override legs through `nonEmpty` so blank is unset and the store wins; funnel every rung that returns `ollama` through one helper that warns once, naming the SDK default endpoint actually in effect; and give the embedding-provider select the `envPinned` treatment `researchProviderRow` already uses.

## Boundaries & Constraints

**Always:**
- `resolveEmbeddingProvider`'s override legs read through the module's existing `nonEmpty`, matching `getVectorSearchSettings`'s `nonEmpty(env) ?? nonEmpty(config)` ordering exactly.
- Env still wins over the store whenever `EMBEDDING_PROVIDER` is really set; only blank/whitespace stops shadowing.
- The DW-401 change is log-only: which provider is selected, and every return value of `resolveEmbeddingProvider`, is unchanged.
- The new warning uses the module's existing `warnOnceAbout`, keyed on the misconfiguration's identity (not its call site).
- The select uses `aria-disabled` + an `onChange` guard, never `disabled` — the convention `providerRow`/`researchProviderRow` own.
- The select keeps showing the STORED value and keeps `settingsEnvOverrideCopy("provider", …)` as its hint (pinned by "renders the STORED selection while describing the env one" in `settings-vector-namespace.test.tsx`).

**Block If:**
- Closing DW-398 would require a new payload field (e.g. an "invalid env embedding provider" signal) to be threaded through the settings route.

**Never:**
- Do not change `embeddingProviderChanged` or either save path's clear rule.
- Do not add per-provider keying/migration for `embeddingApiKey`/`embeddingBaseUrl`.
- Do not pass a base URL to `createOllama()` that the ladder refused — the fall-through to the SDK default stays, it only becomes audible.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Blank env, stored provider | `EMBEDDING_PROVIDER=" "`, `cfg.embeddingProvider="openai"`, `OPENAI_API_KEY` set | Resolves `openai`; no warning | No error expected |
| Blank env, nothing stored | `EMBEDDING_PROVIDER=" "`, no stored provider | Falls through to auto-detect exactly as an unset variable does | No error expected |
| Padded env value | `EMBEDDING_PROVIDER=" openai "`, `OPENAI_API_KEY` set | Resolves `openai` — the same reading the vector gate already applies | No error expected |
| Blank stored provider | `cfg.embeddingProvider="  "`, no env | Falls through to auto-detect; no "not embedding-capable" warning quoting blanks | No error expected |
| Explicit ollama, no endpoint | `EMBEDDING_PROVIDER=ollama`, no `OLLAMA_BASE_URL`, no stored endpoint | Still resolves `ollama`; warns ONCE naming `http://127.0.0.1:11434/api` | Warning only |
| Explicit ollama, usable endpoint | `EMBEDDING_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://host:11434/api` | Resolves `ollama`, silent | No error expected |
| Stored generation provider ollama, no endpoint | `cfg.provider="ollama"`, nothing else | Resolves `ollama`; same warning, same key | Warning only |
| Repeat resolutions | Any of the above, called from several embed doors | The substitution sentence is said exactly once per process | Warning only |
| Endpoint fixed in-process | Warned once, then a save makes the endpoint resolve | Silent while it resolves, and audible again if it breaks again | Warning only |
| Select under a valid env pin | `envEmbeddingProvider="workers-ai"` | Select is `aria-disabled`, still focusable, still shows the stored value; a change event writes nothing | No error expected |
| Select with no env pin | `envEmbeddingProvider=null` | Unchanged: editable, still applies `settingsDraftAfterEmbeddingProvider` | No error expected |

</intent-contract>

## Code Map

- `src/lib/embeddings.ts:197-262` -- `resolveEmbeddingProvider`. Line 202-203 is the DW-333 raw `??` pair (the comment above it claims blanks fall to auto-detect and must be rewritten). Line ~230 `if (override === "ollama") return override;`, lines ~239-243 the `cfg.provider` rung, lines ~250-257 the credential tail — the three rungs that return `ollama`.
- `src/lib/embeddings.ts:90-95` -- `warnOnceAbout`; `:98-110` `rearmWarningAbout` (DW-332's precedent for a key a caller can see evidence of being fixed); `:31-88` the doc block enumerating the guarded identities — a new key belongs in that census.
- `src/lib/embeddings.ts:317` -- `nonEmpty`, module-local trim-and-null.
- `src/lib/embeddings.ts:458-514` -- `_createEmbeddingModel`; `:509-510` is where `getOllamaBaseUrl(cfg)` falling to `undefined` becomes `createOllama()` with no baseURL.
- `src/lib/config.ts:452-517` -- `envOllamaBaseUrlAnswer` / `envOllamaBaseUrl`; `:564` `getOllamaBaseUrl(cfg)`, the full env→store ladder. Already imported by `embeddings.ts:13-14`.
- `src/lib/config.ts:1287-1293` -- `getVectorSearchSettings`, the sibling whose `envEmbeddingProvider() ?? nonEmpty(cfg.embeddingProvider)` shape DW-333 must match; `:1405-1408` `envEmbeddingProvider()` (the payload leg, `nonEmpty` + `isEmbeddingProvider`, so a junk pin reaches the browser as `null`).
- `src/components/workbench/SettingsCanvas.tsx:706-756` -- `researchProviderRow`, the `envPinned` pattern to copy (`aria-disabled={… || envPinned}`, `onChange` early return).
- `src/components/workbench/SettingsCanvas.tsx:800-870` -- the embedding-provider select: `aria-disabled` at :811, the `settingsDraftAfterEmbeddingProvider` handler at :813-834, `aria-invalid` at :842, the hint at :854-868 (already renders `settingsEnvOverrideCopy("provider", stored.envEmbeddingProvider)`).
- `src/lib/workbench-settings.ts:352-379` -- `settingsEnvOverrideCopy` and its doc claim "The box is not disabled", which the provider row is about to stop honouring.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx:543-600` -- the two env-pin tests that pin the value shown and the absence of `aria-invalid`. READ-ONLY constraints on this change.
- `src/lib/__tests__/embeddings.test.ts:1666-2060` -- provider-resolution and warn-once suites; `:2003-2019` asserts exactly two warnings while setting `EMBEDDING_PROVIDER=ollama` with no endpoint, so it needs a usable endpoint added to stay about model-key identity.
- `node_modules/ollama-ai-provider-v2/dist/index.js:1438` -- the SDK default `http://127.0.0.1:11434/api` the new sentence names.

## Tasks & Acceptance

**Execution:**
- `src/lib/embeddings.ts` -- read `EMBEDDING_PROVIDER` and `cfg.embeddingProvider` through `nonEmpty`, and rewrite the stale DW-311 comment above them to say what now wins -- blank must not shadow the store, and the refusal must never quote a blank string (DW-333).
- `src/lib/embeddings.ts` -- add a module-level constant naming the SDK's own default Ollama endpoint and a small helper that every rung returning `ollama` goes through: `warnOnceAbout` a fixed key when `getOllamaBaseUrl(cfg)` is `undefined`, `rearmWarningAbout` the same key when it resolves -- makes the substitution audible without moving the selection (DW-401). Extend the module's warn-census doc block with the new identity and say why it re-arms.
- `src/components/workbench/SettingsCanvas.tsx` -- derive `envPinned` from `stored.envEmbeddingProvider !== null` and apply it to the select's `aria-disabled` and `onChange` guard, following `researchProviderRow` -- so an env-pinned deployment cannot clear the credential the env-selected vendor is using (DW-398). Comment why a junk `EMBEDDING_PROVIDER` is deliberately not pinned here, and correct `researchProviderRow`'s comment claiming the embedding select shows the env value.
- `src/lib/workbench-settings.ts` -- amend `settingsEnvOverrideCopy`'s doc comment so "the box is not disabled" records the provider row's exception.
- `src/lib/__tests__/embeddings.test.ts` -- give the "keys on the PROVIDER too" case a usable `OLLAMA_BASE_URL` so its two-warning count stays about model/provider keying, and add cases for every DW-333 and DW-401 row of the I/O matrix.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- add cases for the pinned/unpinned select rows of the I/O matrix, asserting the pin refuses a change while leaving the stored value and the hint intact.

**Acceptance Criteria:**
- Given a whitespace-only `EMBEDDING_PROVIDER` and a valid stored provider, when any embed door resolves a provider, then the stored provider is selected and no warning quotes a blank string.
- Given `EMBEDDING_PROVIDER` is genuinely set to a supported provider, when resolution runs, then it still wins over the store and the refusal sentences for unsupported values are unchanged.
- Given `ollama` is selected on any rung and no endpoint resolves, when resolution runs repeatedly across embed doors, then `ollama` is still returned and exactly one warning names `http://127.0.0.1:11434/api` as the endpoint in effect.
- Given the settings payload carries a non-null `envEmbeddingProvider`, when the owner activates the embedding-provider select, then it is announced as disabled, remains focusable, keeps showing the stored value, and a change event leaves the draft — and therefore the stored key and endpoint — untouched.

## Design Notes

One helper, not three inline checks: the auto-detect rung can reach the SDK default too (`OLLAMA_MODEL` set beside an unusable `OLLAMA_BASE_URL` — already pinned in `embeddings.test.ts`), so warning on two of three rungs would be an asymmetry with no rule behind it.

The key re-arms because the store leg of the endpoint ladder (`cfg.ollamaBaseUrl`) is fixable in-process by a save, unlike the three env/binding identities that never re-arm — the same reasoning DW-332 applied to drift, with the evidence read from the ladder itself.

DW-398 pins on `stored.envEmbeddingProvider`, which is `null` for a junk `EMBEDDING_PROVIDER` because `envEmbeddingProvider()` filters through `isEmbeddingProvider`. That is the right boundary: a junk pin disables embeddings entirely, so there is no env-selected vendor whose credential a move could clear, and the store remains the thing that applies once the variable is fixed.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/embeddings.test.ts` -- expected: pass
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- expected: pass
- `pnpm test` -- expected: pass
- `pnpm exec tsc --noEmit` -- expected: no errors

## Auto Run Result

Status: done
Bundle: embeddings-provider-resolution (DW-333, DW-398, DW-401)

### Implemented change

`resolveEmbeddingProvider` now reads both override legs through the module's `nonEmpty`, so a blank `EMBEDDING_PROVIDER` no longer shadows a stored provider and no refusal can quote a blank string; every rung that returns `ollama` goes through one `selectOllama` helper that warns once, naming the SDK's own localhost default as the endpoint actually in effect, and re-arms that key when the endpoint starts resolving again; and the embedding-provider select takes the `envPinned` treatment `researchProviderRow` already applies, so an env-pinned deployment cannot make an edit whose only effect is to delete the credential the env-selected vendor is using.

### Files changed

- `src/lib/embeddings.ts` -- DW-333's `nonEmpty` on both override legs, the `OLLAMA_SDK_DEFAULT_BASE_URL` constant and `selectOllama` helper for DW-401, and the warn-census docblock rewritten for five identities and two re-arming keys.
- `src/components/workbench/SettingsCanvas.tsx` -- DW-398's `envPinned` on the embedding-provider select (`aria-disabled` + `onChange` guard), with the boundary for a junk `EMBEDDING_PROVIDER` stated, and `researchProviderRow`'s comment corrected about which value each row shows.
- `src/lib/workbench-settings.ts` -- `settingsEnvOverrideCopy`'s docblock scoped to the free-text kinds, recording the provider row's exception and why.
- `src/lib/__tests__/embeddings.test.ts` -- 15 cases across two new describes covering every DW-333 and DW-401 matrix row, `_resetConfigWarnings` in the `beforeEach`, and a usable endpoint added to a pre-existing count assertion the new warning would otherwise perturb.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- embedding cases pinning the argument `createOllama` receives (undefined for an absent and for a refused endpoint, the URL for a usable one), plus the junk-`EMBEDDING_PROVIDER` payload assertion.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- pinned and unpinned select cases asserting the endpoint AND the stored key in both directions.
- `src/lib/__tests__/workbench-settings.test.ts` -- the source-scan counts moved for the new compound `aria-disabled` form, with a pin on the two rows that carry it.

### Review findings breakdown

- Patches applied: 8 (1 medium, 7 low) -- see the Review Triage Log.
- Items deferred: 4 (all medium) -- recorded in frontmatter `deferred`.
- Items rejected: 9.
- Follow-up review recommended: true. Patched severities: high 0, medium 1, low 7; score = 3x1 + 1x7 = 10, which is 5 or more.

### Verification

- `pnpm exec vitest run src/lib/__tests__/embeddings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts` -- 218 passed.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- 29 passed.
- `pnpm test` -- 330 files, 7636 passed, 1 skipped.
- `pnpm exec tsc --noEmit` -- clean.
- Matrix audit: every row of the I/O & Edge-Case Matrix is covered by a named case that ran and passed (verified by re-running the two new describes and the two select cases with `--reporter=verbose`).

### Residual risks

- `OLLAMA_SDK_DEFAULT_BASE_URL` is a hand-copy of the SDK's own default; nothing resolves against it, so an `ollama-ai-provider-v2` bump would make the log line name a stale address rather than misroute a call. Disclosed at the constant.
- The DW-401 warning is new log output on any deployment that selects `ollama` with no resolvable endpoint -- including a working local Ollama on the default port, which is exactly the case where the substitution is harmless. It is said once per process.
- The DW-398 pin is browser-side, matching the `researchProvider` pin's existing convention; the route-level half is deferred above.
- One unrelated suite (`src/components/__tests__/workspace-purpose-settings.test.tsx`) failed once mid-run on a toast assertion and passed on re-run and in isolation; both full-suite runs recorded above were green. Noted as a possible pre-existing flake, not chased.
