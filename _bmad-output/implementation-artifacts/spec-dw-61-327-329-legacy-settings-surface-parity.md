---
title: 'Legacy /settings surface parity: Custom advisory, vector state, surface-aware refusal frame'
type: 'bugfix'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The Extraction provider picker on the same flat /settings page also offers
      Custom and renders no base-URL or API-key field, so it stores a provider
      the runtime refuses to construct with no on-page pointer.
    evidence: |-
      StructuredKnowledgeSettings.tsx populates its select from the same
      PROVIDER_INFO list that carries `custom`; the route accepts
      structuredKnowledgeProvider: "custom" and config.ts resolves it through
      getConfiguredModel, which throws "The Custom provider needs a base URL.
      Set it in Settings -> LLM Models." (src/lib/llm.ts:395-408) - the twin of
      the primary path's throw at :285-301 that DW-61 closed. Pre-existing: the
      DW-61 ledger entry and this bundle's intent both scope the fix to
      ProviderForm's picker, so the extraction picker was never in scope. There
      is no test file for StructuredKnowledgeSettings at all.
    location: >-
      src/components/StructuredKnowledgeSettings.tsx:84-99
    severity: medium
  - summary: >-
      The five "Settings -> LLM Models" literals in llm.ts are hand-typed rather
      than derived from settingsCategory, so renaming that category leaves five
      runtime errors naming something the nav no longer shows.
    evidence: |-
      src/lib/llm.ts:287, :292, :301, :402, :407 spell the destination as string
      literals. workbench-settings.ts now derives its own pointers from
      SETTINGS_CATEGORIES precisely to prevent that drift, and documents why
      llm.ts deliberately keeps the shorter form - but nothing enforces the
      category half of either string. Pre-existing; surfaced by the new
      settingsPointer helper rather than caused by it.
    location: >-
      src/lib/llm.ts:287
    severity: low
baseline_revision: 'efa4bc9eb3eed6d726e8cf636a46928a78c7426d'
---

<intent-contract>

## Intent

**Problem:** The legacy flat `/settings` page claims things it cannot do. Its provider picker offers `Custom` with no base-URL or key field, so a save there stores a provider no LLM call can construct (DW-61); it renders nothing at all about vector search, so a flat save the DW-303 scoping now ALLOWS lands with no signal that the stored switch is on but inactive (DW-327); and every refusal the flat path can produce ends "Turn it off, or supply what is missing." while naming a switch that page does not render (DW-329).

**Approach:** Copy and surface work only. Add an inline advisory to `ProviderForm` pointing `Custom` at the Workbench's LLM Models fields; surface the existing `vectorSearchInactiveCopy` on `/settings` through `useSettings` reading the `workbench` object `GET /api/settings` already serves; and make the refusal FRAME surface-aware in `validateWorkbenchSettingsPatch` — the flat frame names where the switch lives instead of telling the owner to flip one that is not there — then repin `settings-route.test.ts`.

## Boundaries & Constraints

**Always:**
- One sentence per state, produced by `src/lib/workbench-settings.ts` and rendered by the surfaces — never re-typed in a component or in a test literal that does not also assert the exact string.
- The flat frame changes WHICH sentence a refusal carries, never WHETHER the gate refuses: `canEnableVectorSearch` stays the sole rule, and the legs, their order and their notes stay identical between the two frames.
- The surface is read off the ONE fact the route already computes — `actionableLegs` present means the flat page, absent means a surface that reaches every control. Do not add a second parameter or a second expression for the same fact.
- Category names in new copy derive from `settingsCategory(...)` labels, not typed literals, so the pointer cannot drift from the nav.
- The `Custom` advisory DESCRIBES; it sets no `aria-invalid` and does not block the save (the DW-274 override note's convention in `EmbeddingSettings.tsx`).
- Existing Workbench behaviour is byte-identical: `vectorSearchInactiveCopy` keeps its current wording as the DEFAULT, so every `SettingsCanvas` render and every `workbench-settings.test.ts` expectation is unchanged.

**Block If:**
- The flat vector advisory cannot be derived from the served `workbench` payload without a new API field or a widened `PUT` response shape.

**Never:**
- Do not add `customBaseUrl`/`customApiKey` inputs to `ProviderForm` — a second editor for those two fields extends DW-63's lost-update gap (DW-61's 2026-08-18 decision says so in as many words).
- Do not delete, redirect or restyle the `/settings` route, and do not add the primary provider/model pair to the Workbench surface.
- Do not add an embedding-provider, endpoint or API-key control to `/settings`, and do not widen the `PUT /api/settings` response with an advisory field.
- No stored config shape changes: no new `AppConfig` key, no new `WorkbenchSettingsPatch` field.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Custom selected on the flat form | `provider === "custom"` in `ProviderForm` (typed selection or effective) | Renders the inline advisory naming `Settings → LLM Models` as where the base URL and key live | No error expected |
| Non-custom provider | any other `effectiveProvider`, including `null` | No advisory rendered; Ollama/Ollama Cloud blocks unchanged | No error expected |
| Flat page, switch on and a leg unmet | `GET` body `workbench.vectorSearchEnabled: true`, stored legs incomplete | `/settings` renders the switched-on sentence in the FLAT frame, naming the same legs the Workbench names | No error expected |
| Flat page, switch on and satisfied | `workbench.vectorSearchEnabled: true`, every leg met | Nothing rendered (`vectorSearchInactiveCopy` returns `""`) | No error expected |
| Flat page, switch off or payload unusable | `vectorSearchEnabled: false`, or `workbench` absent/malformed | Nothing rendered; the page renders exactly as it does today | `workbenchSettingsFrom` returns `null`, advisory suppressed |
| Flat refusal, switch already stored on | flat-only `PUT` body moving `embeddingModel` past the gate | 400 with the FLAT switched-on frame: same legs, "…or turn the switch off in Settings → Embeddings" | Nothing written; `saveConfig` not called |
| Workbench refusal, switch already stored on | `PUT` body carrying a `workbench` key, same move | 400 with today's sentence, ending "Turn it off, or supply what is missing." — unchanged | Nothing written |
| Any request turning the switch ON | `workbench.vectorSearchEnabled: true` over a stored `false` | 400 with `vectorSearchMissingCopy` — unchanged, both surfaces | Nothing written |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts` -- the vocabulary and every decision. `vectorSearchInactiveCopy` (:808) is the sentence to parameterize; `vectorSearchMissingLegs` (:704), `vectorSearchLegList` and `withLegNotes` produce the shared legs/notes and must be reused untouched. `SETTINGS_CUSTOM_ENDPOINT_COPY` (:167) is the Workbench twin of the new `Custom` advisory. Frame selection lives at :1284 inside `validateWorkbenchSettingsPatch` (:1099), whose 4th parameter `actionableLegs` is the surface fact. `settingsCategory()` (:96) + `SETTINGS_CATEGORIES` (:70) give the `LLM Models` / `Embeddings` labels. `settingsDraftFromPayload` (:1421) and `draftVectorInputs` (:1545) compose into the stored-state inputs the flat page needs; `workbenchSettingsFrom` (:550) is the existing guard for an unvalidated body.
- `src/app/api/settings/route.ts:445-450` -- the ONE call site that passes `actionableLegs` (`hasWorkbenchKey ? undefined : flatMovableVectorLegs(body)`); the block comment above it enumerates the readings of that fact and gains one. `GET` (:64-105) already serves `workbench: {...getWorkbenchSettings(...), version}` — no route change is needed for DW-327.
- `src/hooks/useSettings.ts` -- `EffectiveSettings` (:14) is a hand-duplicated view of the GET body and has no `workbench` field yet; `fetchSettings` (:139) parses the body and seeds the form; the return object (:330) is where a derived notice is exposed.
- `src/app/settings/page.tsx:146-157` -- where `EmbeddingSettings` is mounted, inside the `readOnly` fieldset and the save form.
- `src/components/EmbeddingSettings.tsx` -- the embedding block; its DW-274 override note (`showOverrideNote`, `OVERRIDE_NOTE_ID`) is the described-not-marked pattern the vector advisory copies.
- `src/components/ProviderForm.tsx:47,74-76` -- `PROVIDER_OPTIONS` spreads `PROVIDER_INFO`; `effectiveProvider` / `showOllamaCloud` (:74-76) is the existing conditional-block pattern the `Custom` advisory follows (see the Ollama Cloud block at the end of the file).
- `src/lib/providers.ts:23` -- `custom` in `PROVIDER_INFO`; READ-ONLY here. Its absence from `DEFAULT_MODELS` is deliberate and stays.
- `src/lib/llm.ts:287-301` -- the runtime errors already say "Set it in `Settings → LLM Models`"; the new advisory must use the same destination.
- `src/components/workbench/SettingsCanvas.tsx:264` -- the other `vectorSearchInactiveCopy` caller; it must keep calling it with no frame argument.
- `src/lib/__tests__/settings-route.test.ts:380-575` -- the flat-branch describe. `MISMATCH_COPY` (:397) and the two `removalCopy` blocks (:530, :556) build the expected string with the default frame and must be repinned; the "answers the SAME sentence whether the move arrives flat or as a workbench patch" test (:448) asserts the very equality DW-329 removes and must become a same-legs/different-frame assertion.
- `src/lib/__tests__/workbench-settings.test.ts:826` -- `vectorSearchInactiveCopy`'s own describe; the default-frame expectations there stay green untouched.
- `src/hooks/__tests__/useSettings.test.tsx` and `src/app/settings/__tests__/settings-page-embedding-wiring.test.tsx` -- the mounted harnesses; the second one stubs only the panels below the form and is the model for a mounted flat-vector test.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- add an exported surface type (two members: the full Workbench surface and the flat page) and give `vectorSearchInactiveCopy` an optional second parameter defaulting to the Workbench surface; the flat branch reuses the same legs/list/notes and replaces only the trailing action clause with one naming `Settings → {embeddings label}` as where the switch is. Add a flat `Custom` advisory constant beside `SETTINGS_CUSTOM_ENDPOINT_COPY`, pointing at `Settings → {llm-models label}` for the base URL and key. Add an exported helper that returns the vector inputs as the STORE holds them, composing `settingsDraftFromPayload` + `draftVectorInputs`. -- One module owns every sentence; deriving labels from `settingsCategory` keeps the pointer and the nav from drifting.
- `src/lib/workbench-settings.ts` (`validateWorkbenchSettingsPatch`) -- select the frame from `actionableLegs === undefined` as well as `turningOn`, and extend the block comment to record the added reading. -- DW-329: the flat path can only ever receive the switched-on frame, so the frame must know which surface asked.
- `src/app/api/settings/route.ts` -- update the block comment above the `validateWorkbenchSettingsPatch` call to say the 4th argument now also picks the frame for a flat body. -- The comment enumerates the readings of that one fact and would otherwise be wrong.
- `src/components/ProviderForm.tsx` -- render an inline advisory block when the effective provider is `custom`, mirroring the Ollama Cloud block's markup. -- DW-61: the form stops silently saving a provider it cannot configure.
- `src/hooks/useSettings.ts` -- add an optional `workbench` field to `EffectiveSettings`, narrow it in `fetchSettings` with `workbenchSettingsFrom`, and expose a derived `vectorNotice: string | null` (non-empty flat-frame copy only when the stored switch is on) on the return object. -- DW-327: the flat surface learns the vector state from the payload the route already serves.
- `src/components/EmbeddingSettings.tsx` -- accept an optional `vectorNotice` prop and render it as a described-not-marked advisory beside the embedding model field. -- The vector state belongs in the embedding block, and the surrounding note already sets the pattern.
- `src/app/settings/page.tsx` -- pass the hook's `vectorNotice` into `EmbeddingSettings`. -- The one line that connects the route's answer to the rendered sentence.
- `src/lib/__tests__/settings-route.test.ts` -- repin the flat-branch expectations to the flat frame, and rewrite the flat-vs-workbench parity test to assert same legs / different frame. -- The old equality is the behaviour DW-329 deliberately removes.
- `src/lib/__tests__/workbench-settings.test.ts` -- add cases for the flat frame: same legs, same order, same notes as the default frame, differing only in the trailing clause, and a satisfied config still returning `""`. -- Covers the I/O matrix rows for the two frames.
- `src/app/settings/__tests__/` -- add a mounted test that drives `/settings` from a `GET` body whose `workbench` holds an on-but-unmet vector config and asserts the flat sentence renders, that a satisfied config renders nothing, and that a `custom` selection renders the `Custom` advisory. -- The wiring between payload and rendered sentence is the half no unit test executes.

**Acceptance Criteria:**
- Given a `/settings` page whose stored provider is `custom`, when the page renders, then the form shows an advisory naming `Settings → LLM Models` as the place to set the base URL and API key, and `ProviderForm` still renders no base-URL and no API-key input.
- Given a `GET /api/settings` body whose `workbench.vectorSearchEnabled` is `true` over legs that are unmet, when `/settings` renders, then the switched-on sentence appears with the same unmet legs the Workbench would name, and its closing clause names where the switch lives rather than instructing the owner to turn it off.
- Given the same body with every vector leg met, or with `workbench` absent, when `/settings` renders, then no vector sentence appears anywhere on the page.
- Given a store holding `vectorSearchEnabled: true`, when a flat-only `PUT /api/settings` body moves a vector input past the gate, then the 400 body carries the flat frame and `saveConfig` is not called.
- Given the same store and the same move sent under a `workbench` key, when the request is refused, then the 400 body is today's sentence unchanged, and both refusals name identical legs in identical order.
- Given any request that turns the switch on over a stored `false`, when it is refused, then the sentence is `vectorSearchMissingCopy` for both surfaces, unchanged.
- Given the whole suite, when `pnpm test` runs, then it passes with no `.llm-wiki-config.json` written and no change to any stored config shape.

## Design Notes

The frame parameter defaults to the Workbench surface so that `SettingsCanvas`, `workbench-settings.test.ts` and every nested-body refusal are untouched by this change — only the two flat callers (the hook and the flat branch of the route's validation) opt into the new sentence, and they opt into the SAME one, which is what keeps `/settings`'s advisory and `/settings`'s refusal from describing the same state two different ways.

The flat vector inputs are composed from the two functions the Workbench already uses rather than from a new derivation:

```ts
// The vector inputs as the STORE holds them — no draft in play (DW-327).
export function storedVectorInputs(p: WorkbenchSettingsValues): VectorSearchInputs {
  return draftVectorInputs(settingsDraftFromPayload(p), p);
}
```

A freshly seeded draft IS the stored state, so the flat page cannot disagree with a just-loaded Workbench about which legs are unmet.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-route.test.ts src/hooks/__tests__/useSettings.test.tsx src/app/settings/__tests__ src/components/__tests__/embedding-settings-override.test.tsx src/components/workbench/__tests__` -- expected: all pass
- `pnpm test` -- expected: full suite passes
- `pnpm lint` -- expected: no new errors
- `pnpm exec tsc --noEmit` -- expected: no new type errors

## Auto Run Result

Status: done
Blocking condition: none

### Summary

Closed DW-61, DW-327 and DW-329 with copy and surface work only — no stored config
shape changed, no new API field, no new control on `/settings`.

- **DW-61** — `ProviderForm` renders an inline advisory whenever the effective
  provider is `custom`, naming Workbench Settings → LLM Models as where the base
  URL and API key live. No `customBaseUrl`/`customApiKey` inputs were added, per
  the 2026-08-18 decision.
- **DW-327** — `useSettings` narrows the `workbench` object `GET /api/settings`
  already serves, derives the switched-on sentence from the STORED vector inputs,
  and `/settings` renders it beside the embedding model field. Nothing renders
  when the switch is off, when every leg is met, or when the payload is unusable.
- **DW-329** — `vectorSearchInactiveCopy` takes a surface, defaulting to the
  Workbench so every existing caller is untouched.
  `validateWorkbenchSettingsPatch` picks the flat frame off the one fact it
  already carries (`actionableLegs === undefined`), so a flat refusal ends
  "Supply what is missing, or turn the switch off in Workbench Settings →
  Embeddings." instead of naming a switch that page does not render.

### Files changed

- `src/lib/workbench-settings.ts` — `SettingsSurface`, `settingsPointer` +
  `WORKBENCH_SETTINGS_LABEL`, `VECTOR_INACTIVE_ACTION`, the surface parameter on
  `vectorSearchInactiveCopy`, `SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY`,
  `storedVectorInputs`, and the surface-aware frame selection.
- `src/app/api/settings/route.ts` — comment only: the fourth argument now has a
  fourth reading.
- `src/components/ProviderForm.tsx` — the `custom` advisory block.
- `src/hooks/useSettings.ts` — narrowed `workbench` state and the derived
  `vectorNotice`.
- `src/components/EmbeddingSettings.tsx` — the optional `vectorNotice` prop and
  the joined `aria-describedby`.
- `src/app/settings/page.tsx` — passes `vectorNotice` through.
- `src/lib/__tests__/settings-route.test.ts` — flat expectations repinned; the
  flat-vs-workbench parity test rewritten as same-legs / different-frame.
- `src/lib/__tests__/workbench-settings.test.ts` — flat-frame, `storedVectorInputs`
  and flat-custom-copy coverage; every scoped call repinned.
- `src/components/__tests__/embedding-settings-override.test.tsx` — both-notes
  `aria-describedby` coverage.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` — new
  mounted suite for the rendered flat surface.

### Review findings

- Patches applied: 6 (high 0, medium 4, low 2)
- Items deferred: 2 (the flat page's Extraction provider picker has the same
  `custom` gap; `llm.ts`'s five hand-typed category literals)
- Items rejected: 14

Follow-up review recommended: **true** — patched severities high 0, medium 4,
low 2; score `3 × 4 + 1 × 2 = 14`, which is ≥ 5.

### Verification

- `tsc --noEmit` — clean.
- `eslint` — no warnings or errors (the three `jsx-ast-utils` notices are
  pre-existing and unrelated).
- `vitest run` — 260 files, 5657 tests, all passing. No `.llm-wiki-config.json`
  written.
- Matrix audit: every row of the I/O & Edge-Case Matrix is covered by a test that
  ran and passed — the Custom advisory (effective and typed paths, plus the four
  non-custom cases), the flat notice on both the editable and env-locked branches,
  the three silent cases, the flat and Workbench refusal frames, and the
  turning-on frame under a scoped call.
- The implementation agent mutation-checked the three verification-gap patches;
  each fails exactly one targeted test and was green across the whole suite before.

### Residual risks

- The frame is inferred from `actionableLegs === undefined` rather than from a
  named surface argument. Within the app the proxy is exact — `useSettings` never
  sends a `workbench` key — but a direct API client sending a combined
  flat + workbench body is answered in the Workbench frame because the key wins
  over the legs. No in-app client sends that shape.
- The standing advisory is unscoped, so it can name legs (`an endpoint`, `an API
  key`) that `/settings` renders no control for. That is deliberate: it is
  informational, not a refusal, and DW-303's "only actionable legs" principle is
  about refusals — the pointer is what tells the owner where those legs live.
- The advisory describes STORED state and sits under a draft-editable model box,
  with no save-bar equivalent on the flat page to qualify unsaved edits. The
  sentence stays truthful about the store, and refreshes on save.
