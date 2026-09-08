---
title: 'Provider selection truthfulness (DW-368, DW-370)'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The custom-endpoint pointer is visually adjacent to the provider picker on
      both the primary and the extraction surface, but no `aria-describedby`
      associates it, so a screen-reader owner selecting Custom never hears where
      the base URL and API key live.
    evidence: |-
      `StructuredKnowledgeSettings.tsx` renders the note with
      `id="structuredKnowledgeCustomEndpoint"` and `#structuredKnowledgeProvider`
      sets `aria-describedby` only in the read-only case; `ProviderForm.tsx`'s
      DW-61 note carries no id at all. The repo already states the opposite
      convention at `src/components/workbench/SettingsCanvas.tsx:419-433`, whose
      comment says a hint sitting beside a control is invisible to a screen
      reader. Fixing only the new note would leave the two pickers inconsistent,
      so this covers both.
    location: >-
      src/components/StructuredKnowledgeSettings.tsx:181 and src/components/ProviderForm.tsx:227
    severity: medium
  - summary: >-
      DW-370's harm class survives on the EXPLICIT ollama selections: an
      `EMBEDDING_PROVIDER=ollama` override and a stored `cfg.provider === "ollama"`
      still select ollama regardless of endpoint usability, then fall to a bare
      `createOllama()`.
    evidence: |-
      `resolveEmbeddingProvider` returns the override at
      `src/lib/embeddings.ts:203` and the saved provider at `:211-215` without
      consulting `getOllamaBaseUrl`, and `getEmbeddingModel` constructs
      `createOllama()` with no baseURL when none resolves. So a corpus can still
      be embedded against the SDK's localhost default while the owner believes
      it is going to the endpoint they typed. This bundle's intent scopes the
      fix to auto-DETECTION, so the explicit rungs were deliberately untouched
      and are neither closed nor documented as exceptions.
    location: >-
      src/lib/embeddings.ts:203-215
    severity: medium
  - summary: >-
      A refused `OLLAMA_BASE_URL` is now described only in a server log; every
      owner-facing surface still advertises the variable as the remedy and
      reports no reason it was ignored.
    evidence: |-
      `StatusBadge.tsx:81` lists `OLLAMA_BASE_URL / OLLAMA_MODEL` as the fix in
      the very panel shown when nothing is configured, and `getEffectiveSettings`
      reports `ollamaBaseUrlSource: "none"` with no accompanying reason, so an
      owner who set the variable to `localhost:11434` sees "no provider
      configured" while the variable is set. The repo already has the pattern
      for saying this out loud (`envCustomBaseUrl` + `settingsEnvOverrideCopy`,
      `SettingsCanvas.tsx:531-535`).
    location: >-
      src/components/StatusBadge.tsx:81
    severity: medium
  - summary: >-
      The extraction section's "Credential ready" badge can be green for `custom`
      while extraction still throws, because `providerIsConfigured("custom")`
      checks base URL and API key but not the model name Custom also requires.
    evidence: |-
      `providerIsConfigured` at `src/lib/config.ts:865-867` tests only the two
      credential halves, and `DEFAULT_MODELS` deliberately carries no `custom`
      entry, so `getConfiguredModel` throws "The Custom provider needs a model
      name" (`src/lib/llm.ts:406-410`) for a deployment the badge calls ready.
      Pre-existing and independent of this change's pointer.
    location: >-
      src/lib/config.ts:865
    severity: medium
baseline_revision: '2fb929d13e0cd7452617aaf4c97a4a214f4d3f9e'
---

<intent-contract>

## Intent

**Problem:** Two provider selections claim more than the runtime delivers. `detectEnvProvider()` (`src/lib/config.ts:777-779`) and the embedding fallback (`src/lib/embeddings.ts:217`) select `ollama` from the mere PRESENCE of `OLLAMA_BASE_URL`, including a typo'd value such as `localhost:11434` that `getOllamaBaseUrl` refuses and warns about — so the provider resolves while the endpoint does not, and calls silently go to the SDK's own localhost default instead of the address the owner typed (DW-370). Separately, `StructuredKnowledgeSettings` offers `custom` in its Extraction provider picker but renders no base-URL and no API-key field and no pointer to where they live, so a save there stores a provider `getConfiguredModel` refuses to construct and the first anyone hears of it is a failed extraction call (DW-368).

**Approach:** Gate the env detection on a USABLE endpoint rather than a present one, by routing both detection sites through the same validated env-URL rule `getOllamaBaseUrl` already applies. On the Settings surface, follow the DW-61 precedent exactly: keep offering `custom` and render the same on-page pointer `ProviderForm` renders, so the owner is told where the other two halves are finished. Cover both with tests, including a first test file for the component.

## Boundaries & Constraints

**Always:**
- One rule for "is the env `OLLAMA_BASE_URL` usable" — extract it from `getOllamaBaseUrl`'s env leg and call it from all three sites; never restate `isAbsoluteHttpUrl` checks at a detection site.
- `OLLAMA_MODEL` remains an independent, usable signal: set alone (or set beside an unusable URL) it still selects `ollama`, because a model name is usable on its own and the SDK's default endpoint is then the honest resolution.
- Blank is unset: `OLLAMA_BASE_URL=` and whitespace stay "not configured", not "invalid" — the `nonEmpty` convention already in `config.ts`.
- Detection must not start answering a WIDER question: it reads env only. Do not consult `cfg.ollamaBaseUrl` from `detectEnvProvider` or from the embeddings fallback.
- The `custom` pointer reuses `SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY` from `src/lib/workbench-settings.ts` — do not type a second sentence.
- The pointer DESCRIBES: no `aria-invalid`, no blocked save, matching `ProviderForm`'s note.
- Read the extraction provider for the pointer off the EFFECTIVE provider (form value falling back to `settings.structuredKnowledgeProvider`), so a deployment already storing `custom` sees it on first paint.

**Block If:**
- Closing DW-368 would require a second editor for `customBaseUrl`/`customApiKey` on the flat page. It does not: the 2026-08-18 decision on DW-61 rules that out (two surfaces, one lost-update race), and the pointer is the sanctioned resolution.

**Never:**
- Do not add base-URL or API-key inputs to `StructuredKnowledgeSettings`, and do not remove `custom` from `PROVIDER_INFO` or filter it out of the extraction picker.
- Do not make `getOllamaBaseUrl` throw, and do not change what it returns for any input.
- Do not touch the EXPLICIT owner selections (`cfg.provider === "ollama"`, `EMBEDDING_PROVIDER=ollama`, the `override === "ollama"` leg) — this is about auto-detection only.
- Do not rename or re-scope `OLLAMA_BASE_URL` / `OLLAMA_MODEL`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Usable env endpoint | `OLLAMA_BASE_URL=http://host:11434`, no other keys | `detectEnvProvider()` → `{ provider: "ollama", apiKey: null }`; embedding fallback → `"ollama"` | No error expected |
| Unusable env endpoint, no model | `OLLAMA_BASE_URL=localhost:11434`, no other keys | `detectEnvProvider()` → `{ provider: null, apiKey: null }`; embedding fallback → `null` | Existing warn-once sentence from `getOllamaBaseUrl`'s env leg; no throw |
| Unusable env endpoint, model set | `OLLAMA_BASE_URL=localhost:11434`, `OLLAMA_MODEL=llama3.2` | Both still select `ollama` — the model is the usable signal; endpoint resolves to `undefined` | Warn-once only |
| Blank env endpoint | `OLLAMA_BASE_URL=` (or whitespace), nothing else | Selects nothing (`provider: null`) and warns about nothing | No error expected |
| Keyed provider wins | `ANTHROPIC_API_KEY` set beside an unusable `OLLAMA_BASE_URL` | `detectEnvProvider()` → anthropic, unchanged | No error expected |
| Extraction picker on `custom` | Extraction provider selected (or stored) as `custom` | The custom-endpoint pointer renders beside the picker | No error expected |
| Extraction picker not on `custom` | Any other extraction provider, or "Use primary provider" | No pointer rendered at all | No error expected |

</intent-contract>

## Code Map

- `src/lib/config.ts:343-361` -- `getOllamaBaseUrl`: env leg (`nonEmpty` → `isAbsoluteHttpUrl` → `warnOnceAbout`) then stored leg. Extract the env leg into a module-local helper and call it from here; the doc block above it (`:300-342`) already states the fall-through rule, so extend it rather than restating it.
- `src/lib/config.ts:759-782` -- `detectEnvProvider`: the `if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL)` branch at `:777-779` is the DW-370 site. Its four callers (`getEffectiveProvider` `:848`, `getEffectiveSettings` `:1460`, `getResolvedCredentials` `:1600`, `hasLLMKey` in `src/lib/llm.ts:199`) all consume it as "env alone"; none needs changing.
- `src/lib/config.ts:1048-1053` -- `nonEmpty` (module-local trim-and-null). `isAbsoluteHttpUrl` is imported at `:13` from `src/lib/workbench-settings.ts:1163`; `warnOnceAbout` is at `:291`.
- `src/lib/embeddings.ts:217` -- second copy of the same presence test, inside `resolveEmbeddingProvider`'s "any available embedding-capable credential" tail. It already imports `getOllamaBaseUrl` from `./config` (`:10`) — add the new helper to that import.
- `src/components/StructuredKnowledgeSettings.tsx:37-44,88-118` -- `effectiveProvider` is already computed at `:37`; the picker at `:99-118` maps `PROVIDER_INFO`. The DW-368 site: no `custom` branch anywhere in the file.
- `src/components/ProviderForm.tsx:97-111,227-238` -- the precedent to copy verbatim in shape: `showCustom = effectiveProvider === "custom"`, and a bordered note rendering `SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY`, with the comment explaining why it describes rather than marks.
- `src/lib/workbench-settings.ts:242` -- `SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY`, the one sentence. Client-safe (already imported by `ProviderForm`).
- `src/lib/llm.ts:279-308` and `:395-408` -- the two throws the pointer prevents an owner from meeting blind. Read-only evidence; do not edit.
- `src/app/settings/page.tsx:186-198` -- the only mount of `StructuredKnowledgeSettings`; no prop change is needed.
- `src/lib/__tests__/config.test.ts:49,1136-1241` -- env save/restore list already includes `OLLAMA_BASE_URL`; `getOllamaBaseUrl` cases and the warn-once cases live here. Add the `detectEnvProvider` cases here.
- `src/lib/__tests__/embeddings.test.ts:101,930-950` -- env list plus the existing "detected via OLLAMA_MODEL" and valid-URL cases; those must keep passing unchanged.
- `src/components/__tests__/embedding-settings-override.test.tsx` -- the mounted-component pattern to follow (`render`/`screen` from `@testing-library/react`, `cleanup` in `afterEach`, a `props()` factory). `vitest.config.ts` collects `src/**/__tests__/**/*.test.tsx` into the `dom` project.

## Tasks & Acceptance

**Execution:**
- `src/lib/config.ts` -- extract the env leg of `getOllamaBaseUrl` into a module-local `envOllamaBaseUrl(): string | undefined` (nonEmpty → `isAbsoluteHttpUrl` → warn-once → `undefined`), have `getOllamaBaseUrl` call it, and export it for `embeddings.ts` -- one rule for "usable env endpoint", so detection and resolution cannot disagree.
- `src/lib/config.ts` -- rewrite `detectEnvProvider`'s ollama branch to `envOllamaBaseUrl() !== undefined || nonEmpty(process.env.OLLAMA_MODEL) !== null`, with a comment naming DW-370 and why `OLLAMA_MODEL` stays an independent signal -- a present-but-unusable endpoint must stop selecting a provider it cannot reach.
- `src/lib/embeddings.ts` -- apply the same predicate at `:217` and import `envOllamaBaseUrl` from `./config` -- the mirrored site must not stay on the old presence test.
- `src/lib/__tests__/config.test.ts` -- add `detectEnvProvider` cases for every ollama row of the I/O matrix (usable, unusable-alone, unusable-with-model, blank, keyed-provider-wins) -- the matrix is only closed if it is executed.
- `src/lib/__tests__/embeddings.test.ts` -- add the mirrored fallback cases (unusable URL alone → `null`; unusable URL + `OLLAMA_MODEL` → `"ollama"`) -- the second site needs its own evidence, not the first site's.
- `src/components/StructuredKnowledgeSettings.tsx` -- render the `SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY` pointer, on an element carrying a stable id (`structuredKnowledgeCustomEndpoint`), when `effectiveProvider === "custom"` -- selecting `custom` here must stop being a silent half-configuration.
- `src/components/__tests__/structured-knowledge-settings.test.tsx` -- new file: the pointer renders on `custom` picked in the form, renders on `custom` stored-but-untouched, renders the shared constant's text, and is absent otherwise -- the component has no test today and a source scan cannot see a rendered sentence.

**Acceptance Criteria:**
- Given `OLLAMA_BASE_URL` holds a value `getOllamaBaseUrl` refuses and no other provider credential is set, when generation or embedding resolves its provider through auto-detection, then no provider is selected — `detectEnvProvider().provider` is `null` and the embedding fallback returns `null` — rather than an `ollama` selection pointed at the SDK's own default.
- Given the same unusable `OLLAMA_BASE_URL` with `OLLAMA_MODEL` also set, when detection runs, then `ollama` is still selected, so the fix removes only the endpoint's false signal and not the model's true one.
- Given an owner on `/settings` selects `Custom` in the Extraction provider picker, when the section re-renders, then the page names where the base URL and the API key are set, using the same sentence the primary provider picker uses.
- Given a deployment that already stored `structuredKnowledgeProvider: "custom"`, when `/settings` first paints and the owner has touched nothing, then the pointer is already on screen.
- Given any extraction provider other than `custom` (including "Use primary provider"), when the section renders, then no custom-endpoint pointer exists in the DOM.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 4: (high 0, medium 4, low 0)
- reject: 9: (high 0, medium 3, low 6)
- addressed_findings:
  - `[medium]` `[patch]` `showCustom` also fired on the inherit-from-primary case — `workloadModelSettings` serves `structuredKnowledgeProvider: "custom"` with source `"default"` when a `custom` primary has no extraction override, so the pointer rendered while the flow badge read "Primary provider" and the page printed the shared sentence twice. Gated on `!usesPrimary && effectiveProvider === "custom"` so the badge and the pointer read the same rung.
  - `[medium]` `[patch]` `src/lib/llm.ts`'s `hasLLMKey` docblock still taught the retired rule ("presence of either env var signals intent"). Rewritten to state the asymmetry: the endpoint counts only as an absolute http(s) URL, `OLLAMA_MODEL` still counts on presence.
  - `[low]` `[patch]` The new component test's inherit case used a fixture (`custom` primary beside a null extraction provider) the route can never emit, so it proved nothing. Rebuilt on the served shape and confirmed to fail against the pre-patch component.
  - `[low]` `[patch]` The "any other provider" loop hardcoded four of six non-custom providers and named no iteration on failure. Derived from `PROVIDER_INFO` with a per-provider message.
  - `[low]` `[patch]` `getEffectiveProvider`'s model ladder read `OLLAMA_MODEL` by bare truthiness while detection now reads it through `nonEmpty`, so `OLLAMA_MODEL="  "` was unset to one and the active model to the other. Aligned, with a regression case.

## Design Notes

`envOllamaBaseUrl` is an EXTRACTION, not a new rule: `getOllamaBaseUrl` keeps its exact current behaviour and every existing case in `config.test.ts` must pass untouched. Sharing it also means detection inherits the warn-once key, so a typo'd endpoint is still described once per process rather than once per resolver.

```ts
// config.ts — the extracted rule, called from three places
function envOllamaBaseUrl(): string | undefined {
  const fromEnv = nonEmpty(process.env.OLLAMA_BASE_URL);
  if (fromEnv === null) return undefined;
  if (isAbsoluteHttpUrl(fromEnv)) return fromEnv;
  warnOnceAbout(`ollama-endpoint:env:${fromEnv}`, `OLLAMA_BASE_URL is not an absolute http(s) URL (${fromEnv}); ignoring it.`);
  return undefined;
}
```

Note the asymmetry that is deliberate: detection stays env-only while `getOllamaBaseUrl` keeps its stored leg. Widening detection to the store would make a saved endpoint select a provider the owner never saved, which is a different question from the one DW-370 asks.

## Verification

**Commands:**
- `pnpm test -- src/lib/__tests__/config.test.ts src/lib/__tests__/embeddings.test.ts src/lib/__tests__/llm.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts` -- expected: all pass, including the pre-existing `getOllamaBaseUrl`, warn-once and `OLLAMA_MODEL`-detection cases.
- `pnpm test -- --project dom src/components/__tests__/structured-knowledge-settings.test.tsx` -- expected: the new mounted suite passes.
- `pnpm test` -- expected: full suite green (brand-copy and english-only scans included).
- `pnpm lint` -- expected: no new findings.

## Auto Run Result

Status: done

**Implemented change.** Provider selection now reports only what is reachable. `getOllamaBaseUrl`'s env leg was extracted into `envOllamaBaseUrl()` — one rule for "is the environment's Ollama endpoint usable" — and both auto-detection sites (`detectEnvProvider` and `resolveEmbeddingProvider`'s credential tail) now branch on that usable value plus a `nonEmpty` `OLLAMA_MODEL`, instead of the bare presence of either variable. A typo'd `OLLAMA_BASE_URL=localhost:11434` therefore selects nothing rather than selecting `ollama` and silently resolving to the SDK's own localhost default; `OLLAMA_MODEL` remains an independent signal, so only the endpoint's false signal was removed. On the flat `/settings` page the Extraction provider picker keeps offering `custom` and now renders the shared `SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY` pointer when the extraction section owns that choice — the DW-61 resolution, applied to its twin picker.

**Files changed.**
- `src/lib/config.ts` -- new exported `envOllamaBaseUrl()`; `getOllamaBaseUrl` delegates to it unchanged in behaviour; `detectEnvProvider`'s ollama branch gated on usability; `getEffectiveProvider`'s model ladder reads `OLLAMA_MODEL` through `nonEmpty`.
- `src/lib/embeddings.ts` -- the mirrored detection site uses the same predicate through the same function.
- `src/lib/llm.ts` -- `hasLLMKey`'s docblock restated to teach the new rule (docs only; no behaviour change).
- `src/components/StructuredKnowledgeSettings.tsx` -- inherit-aware `showCustom` gate and the custom-endpoint pointer.
- `src/lib/__tests__/config.test.ts` -- eight `detectEnvProvider` cases plus the blank-`OLLAMA_MODEL` model-ladder regression.
- `src/lib/__tests__/embeddings.test.ts` -- four mirrored fallback cases.
- `src/components/__tests__/structured-knowledge-settings.test.tsx` -- new; the component's first test file, six cases over the pointer.

**Review findings breakdown.** 5 patches applied (0 high, 2 medium, 3 low), 4 items deferred (all medium, recorded in frontmatter `deferred`), 9 rejected, 0 intent gaps, 0 spec repairs.

**Follow-up review recommendation:** `true`. Patched severities: high 0, medium 2, low 3 — score `3 x 2 + 1 x 3 = 9`, which is at or above the threshold of 5.

**Verification performed.**
- `npx vitest run` -- 270 files / 5996 tests passed.
- `npx vitest run --project dom src/components/__tests__/structured-knowledge-settings.test.tsx` -- 6 passed.
- `npx eslint` -- exit 0.
- `npx tsc --noEmit` -- exit 0.
- Every I/O matrix row is covered by a case that ran and passed. The inherit-case test was confirmed to FAIL against the pre-patch component before being kept.
- Note: `pnpm test` / `pnpm lint` abort in this checkout with `ERROR packages field missing or empty`, a pnpm workspace-resolution problem unrelated to this change and present before it; the same commands were run through `npx`.

**Residual risks.**
- Behavioural change by design: a deployment whose ONLY ollama signal is a malformed `OLLAMA_BASE_URL` now auto-detects no provider instead of quietly using the SDK's localhost default. It turns a silently-wrong resolution into a visible "not configured" state, and the refused value is named only in a server-side warning — see the deferred entry on `StatusBadge`.
- With the inherit-aware gate, an owner whose primary is `custom` and whose extraction inherits it sees the pointer exactly once, from `ProviderForm`; the extraction section itself says nothing in that configuration. That is the intended single destination, not an omission.
