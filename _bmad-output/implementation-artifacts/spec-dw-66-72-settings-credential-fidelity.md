---
title: 'DW-66/67/69/70/71/72 — Settings credential fidelity'
type: 'bugfix'
created: '2026-08-18'
status: 'in-progress' # draft | ready-for-dev | in-progress | in-review | done | blocked
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: ['oversized']
baseline_revision: 'da113a34d74406bad6e684f073a507325729a5d8'
deferred:
  - summary: >-
      `textRow` describes its hint with `aria-describedby={hintId}` instead of
      `describedBy(hintId)`, so on a read-only deployment a text field's hint is
      announced without the sentence explaining why the box refuses.
    evidence: |-
      `SettingsCanvas.tsx`'s `providerRow`, the embedding provider select and the
      vector checkbox all route their `aria-describedby` through `describedBy()`,
      which appends the save bar's `SETTINGS_READ_ONLY_COPY` id. `textRow` predates
      this change and does not. Pre-existing, but every new env-override sentence
      lands on a `textRow`, which makes the gap materially more visible.
    location: >-
      src/components/workbench/SettingsCanvas.tsx (textRow)
    severity: low
---

<intent-contract>

## Intent

**Problem:** The Settings surface misreports credentials and loses edits. `hasCustomApiKey`/`hasFirecrawlApiKey` fold an env-supplied key into the stored one, so `Remove` is offered for a key the route cannot delete; `LLM_CUSTOM_BASE_URL` wins at runtime while the endpoint box shows only the store, so a typed endpoint saves and does nothing; one `embeddingApiKey` and one `embeddingBaseUrl` are shared by OpenAI and Google, so switching provider silently sends one vendor's credential to the other; the embedding endpoint box is offered for `ollama`/`workers-ai`, which never read it; and a landed save re-seeds the whole draft, discarding anything typed while the request was in flight.

**Approach:** Split env from store on the wire for the Custom and Firecrawl credentials and for the Custom endpoint — the same split embeddings already use (`hasEmbeddingApiKey` + `envEmbeddingApiKeyProviders` + `settingsEnvOverrideCopy`). Key the stored embedding credential and endpoint per embedding provider in `AppConfig`, with a load-time migration that moves the legacy flat values onto the provider they were selected for. Show the embedding endpoint and key rows only for providers that read them. Merge a landed save's re-seed with the live draft so fields typed during the request survive.

## Boundaries & Constraints

**Always:** Every rule stays a pure function in `src/lib/workbench-settings.ts` executed by the node suite — no rule may live only inside JSX. No stored secret ever appears in a payload: presence is reported as booleans/provider lists. Env keeps winning at runtime everywhere it wins today; the split changes what the surface SAYS, not which value applies. `GET`/`PUT /api/settings` keep the one nested `workbench` key and the flat legacy contract frozen. The write precondition (`If-Match`, DW-63) stays required and unchanged.

**Block If:** the migration cannot attribute a legacy embedding credential without inventing a vendor — resolve it by the documented fallback chain (explicit `embeddingProvider`, then `provider` when it is a keyed embedding provider), never by copying the value to more than one provider.

**Never:** Do not add a second settings route, a second embedding-model field, or browser-durable storage of settings. Do not freeze the form while a save is in flight (the alternative DW-67 rejects). Do not teach `hasEmbeddingSupport()` about the vector gate. No new UI surface, no locale picker, no dark tokens.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Env-only Custom key | `LLM_CUSTOM_API_KEY=x`, nothing stored | `hasCustomApiKey: false`, `envCustomApiKey: true`; hint says the environment supplies it; no `Remove` button | No error expected |
| Stored Custom key | `customApiKey` stored, no env var | `hasCustomApiKey: true`, `envCustomApiKey: false`; `Remove` offered and it clears the stored key | No error expected |
| Env Custom endpoint | `LLM_CUSTOM_BASE_URL=https://e/v1`, store empty | `customBaseUrl: null`, `envCustomBaseUrl` served; box editable with the override sentence naming the variable | No error expected |
| Env Firecrawl key | `FIRECRAWL_API_KEY=x` | `hasFirecrawlApiKey: false`, `envFirecrawlApiKey: true`; no `Remove` | No error expected |
| Per-provider key | OpenAI key stored, provider switched to `google` | Key field reads "No key is stored." for Google; save sends the key under `google` only; OpenAI's stays | Vector gate refuses with its own sentence |
| Legacy config migration | `{embeddingProvider:"google", embeddingApiKey:"g", embeddingBaseUrl:"https://e"}` | Read back as `embeddingApiKeys:{google:"g"}`, `embeddingBaseUrls:{google:"https://e"}`; Google still gets both at embed time | Unattributable legacy value is dropped, not copied to a vendor |
| Self-transporting provider | provider `ollama` or `workers-ai` | Embedding endpoint and key rows are not rendered; a sentence says the provider carries its own transport | No error expected |
| Typing during a save | Save in flight, owner edits `chatModel` | The landed response re-seeds every field EXCEPT the ones edited since the request started; the edited field keeps the typed text and stays dirty | Refused save still keeps every edit |

</intent-contract>

## Code Map

- `src/lib/config.ts` — `AppConfig` (:40-77 Story 1.9 fields), `loadConfig` (:197), `apiKeyForProvider` (:294 `custom` branch folds env+store), `getCustomBaseUrl` (:341), `getVectorSearchSettings` (:506), `envEmbeddingApiKeyProviders` (:552), `embeddingKeyPresent` (:566), `getFirecrawlSettings` (:620), `getWorkbenchSettings` (:639), `workbenchSettingsStored` (:689), `applyWorkbenchSettings` (:717). Migration belongs in `loadConfig` so every reader and `objectVersion` see one shape.
- `src/lib/workbench-settings.ts` — payload/patch/stored types + `isWorkbenchSettingsPayload` (:340), `SELF_TRANSPORTING_EMBEDDING_PROVIDERS` (:401, module-private — export a predicate), `mergedVectorInputs` (:656), draft rules `settingsDraftFromPayload`/`settingsDirty`/`settingsSaveBody`/`draftVectorInputs` (:725-880), copy `settingsEnvOverrideCopy` (:190)/`settingsEnvKeyCopy` (:198).
- `src/lib/embeddings.ts` — `embeddingApiKeyFor` (:145) and `_createEmbeddingModel` (:228-260) both read the vendor-agnostic stored values.
- `src/components/workbench/SettingsCanvas.tsx` — `save` (:159-186) re-seeds the whole draft; `secretRow` (:346) takes one `hasStoredKey` boolean; embeddings category (:425-521); llm-models category (:405-420).
- `src/app/api/settings/route.ts` — GET (:38-66) and PUT (:258-305) both serve `{...getWorkbenchSettings(), version}`; no change expected beyond what the types force.
- Tests: `src/lib/__tests__/workbench-settings.test.ts` (payload fixture :185-215, save/merge, route cases), `src/lib/__tests__/settings-runtime-wiring.test.ts` (:427-551 stored embedding credential), `src/components/workbench/__tests__/settings-read-only.test.tsx` (:41 payload fixture).

## Tasks & Acceptance

**Execution:**
- `src/lib/config.ts` — add `embeddingApiKeys`/`embeddingBaseUrls` maps to `AppConfig`, mark the flat `embeddingApiKey`/`embeddingBaseUrl` legacy-only; add an exported pure `migrateEmbeddingCredentials(cfg)` applied inside `loadConfig`; add per-provider readers; make `getWorkbenchSettings`/`workbenchSettingsStored`/`getVectorSearchSettings`/`embeddingKeyPresent` provider-aware; report `hasCustomApiKey`/`hasFirecrawlApiKey` from the STORE only and add `envCustomApiKey`/`envCustomBaseUrl`/`envFirecrawlApiKey`; key `applyWorkbenchSettings`' embedding secret and endpoint by the patch's effective embedding provider.
- `src/lib/workbench-settings.ts` — widen the payload/stored types (per-provider `embeddingApiKeyProviders` + `embeddingBaseUrls`, the three new env fields) and their validator; export an endpoint/key-provider predicate; extend the env copy for `LLM_CUSTOM_BASE_URL` and add one secret-override sentence; re-seed the endpoint/key when the drafted embedding provider changes; omit embedding endpoint/key from the save body for providers that do not read them; add the post-save draft merge.
- `src/lib/embeddings.ts` — resolve the stored embedding key and base URL per provider.
- `src/components/workbench/SettingsCanvas.tsx` — render the env sentences, drop `Remove` for env-only keys, hide the embedding endpoint/key rows for self-transporting or unselected providers, route the provider select through the new draft rule, and merge instead of re-seed after a landed save.
- `src/lib/__tests__/workbench-settings.test.ts`, `src/lib/__tests__/settings-runtime-wiring.test.ts` — update fixtures and add cases for every row of the I/O matrix, including the migration chain under `EMBEDDING_PROVIDER` and under env-key auto-detect, and the in-flight-typing merge (including a mid-flight provider switch).
- `src/components/workbench/__tests__/settings-read-only.test.tsx` — update its payload fixture only. New mounted-DOM cases for this change belong in a new `src/components/workbench/__tests__/settings-credentials.test.tsx`, and must cover the env-override row/vendor-sentence pairing and the no-provider-chosen sentence.

**Acceptance Criteria:**
- Given a deployment that supplies a credential or endpoint through the environment, when the owner opens Settings, then the surface names the variable that wins and offers no control that would silently do nothing.
- Given a stored embedding credential or endpoint, when the owner changes the embedding provider, then neither value follows the switch — at the surface or at embed time.
- Given a config written before this change, when it is read back, then its embedding credential and endpoint apply to exactly the provider they were selected for, and no vendor receives a credential it was not given.
- Given a save in flight, when the owner keeps typing, then the landed response updates only the fields they did not touch and the surface stays dirty for the ones they did.

## Spec Change Log

### 2026-08-18 — Migration attribution, the effective embedding provider, and the empty state

**Triggering findings:** (1) `migrateEmbeddingCredentials` attributed legacy values from the stored config only, so a deployment naming its embedding provider through `EMBEDDING_PROVIDER` — or relying on env-key auto-detect — had a working endpoint and key deleted on read and erased from disk on the next save (reviewer probes confirmed `getEmbeddingModelName()` going from a live model to `null`). (2) The endpoint/key rows, the "supplies its API key from the environment" sentence and the route's keying each used the picker's raw value, so under an override the owner typed credentials into rows the runtime never reads — DW-71's inert save, one field over — and the sentence could name a different vendor than the row it decorated. (3) With no provider selected (a fresh install's Auto-detect) both rows vanished with no sentence at all. (4) `settingsDraftAfterSave` merged field-by-field, so a provider switched mid-flight kept the landed payload's endpoint, which belongs to the replaced provider. (5) "Which providers read a credential" was written twice, independently, in `config.ts` and `workbench-settings.ts`.

**Amended:** `## Design Notes` now fixes the runtime-resolution order as the single authority for all three sites (migration target, rendered rows, route keying), requires exactly one of three renderings where the endpoint and key rows would be, requires one shared predicate, and states the embedding triple moves as a unit in the post-save merge. `## Tasks & Acceptance` moves new mounted-DOM cases into their own test file and names the env-override and auto-detect coverage. `## Verification` switches to `npx` (this repo's `pnpm run` is not wired for it) and widens the component-test glob. `<intent-contract>` is untouched: the corrected chain makes the previously-mislabelled configs ATTRIBUTABLE, so the matrix's "unattributable ⇒ dropped, never copied to a vendor" rule still holds for what remains.

**Known-bad state avoided:** a silent, permanent deletion of an owner's embedding credential and endpoint on upgrade, plus a second class of save that reports success and changes nothing at runtime.

**KEEP — must survive re-derivation:**
- `AppConfig.embeddingApiKeys` / `embeddingBaseUrls` as `Partial<Record<EmbeddingProvider, string>>`, with the flat fields kept only as migration input.
- Migration applied inside `loadConfig` (one door, so every reader, the sync cache and `objectVersion` see one shape), and defensively in `workbenchSettingsStored` / `applyWorkbenchSettings`; idempotent, returning by identity when there is nothing to move.
- `hasCustomApiKey` / `hasFirecrawlApiKey` reported from the STORE only, with `envCustomApiKey` / `envCustomBaseUrl` / `envFirecrawlApiKey` beside them, so `Remove` is structurally impossible for an env-only key.
- `getFirecrawlSettings` keeping the folded `hasKey` for runtime consumers while adding `hasStoredKey` / `hasEnvKey`.
- The payload replacing `hasEmbeddingApiKey` / `embeddingBaseUrl` with `embeddingApiKeyProviders` / `embeddingBaseUrls` rather than carrying both, with every new field on `isWorkbenchSettingsPayload`.
- `settingsEnvSecretCopy` and the `custom-endpoint` arm of `settingsEnvOverrideCopy`; `SETTINGS_SELF_TRANSPORT_COPY`.
- `settingsSaveBody` omitting the embedding endpoint and key for providers that do not read them, and `settingsDraftWithEmbeddingProvider` re-seeding the endpoint and resetting the key on a provider switch.
- The route-level store tests (write, clear one entry, drop an emptied map) and the sanity-check technique used on the in-flight merge test: revert the merge line and confirm the test fails.

## Review Triage Log

### 2026-08-18 — Review pass
- intent_gap: 0
- bad_spec: 5: (high 1, medium 3, low 1)
- patch: 0
- defer: 1: (high 0, medium 0, low 1)
- reject: 12
- addressed_findings:
  - `[high]` `[bad_spec]` The migration attributed legacy embedding credentials from the stored config only, deleting a working endpoint and key on any deployment whose embedding provider comes from `EMBEDDING_PROVIDER` or env-key auto-detect — spec now fixes `resolveEmbeddingProvider`'s order as the attribution chain; implementation loopback.
  - `[medium]` `[bad_spec]` Endpoint/key rows, the env-key sentence and the route's keying used the picker's raw value instead of the effective (env-overridden) provider, reproducing DW-71's inert save and mislabelling the vendor — spec now names one expression for all three sites; implementation loopback.
  - `[medium]` `[bad_spec]` With no embedding provider chosen, both rows vanished with no sentence — spec now requires exactly one of three renderings there; implementation loopback.
  - `[medium]` `[bad_spec]` `settingsDraftAfterSave` merged field-by-field, so a provider switched mid-flight kept the replaced provider's endpoint — spec now requires the embedding triple to move as a unit; implementation loopback.
  - `[low]` `[bad_spec]` "Which providers read a stored credential" was written twice independently — spec now requires one exported predicate; implementation loopback.

## Design Notes

**Which provider owns a stored embedding credential.** "The provider" is always the one the RUNTIME will embed with, never the picker's raw value. `resolveEmbeddingProvider` (`src/lib/embeddings.ts:92-130`) resolves it as `EMBEDDING_PROVIDER` env → `cfg.embeddingProvider` → Workers AI binding → `cfg.provider` when embedding-capable → env-key auto-detect (`OPENAI_API_KEY`, then `GOOGLE_GENERATIVE_AI_API_KEY`). Three places must agree with that order, restricted to providers that take a credential:

1. **Migration target.** Attribute a legacy flat value to the first of: `EMBEDDING_PROVIDER`; `cfg.embeddingProvider`; `cfg.provider`; env-key auto-detect. An override naming a keyless or invalid provider does NOT fall through — `resolveEmbeddingProvider` short-circuits on an override, so nothing reads the value and it is unattributable. Only a value no leg answers for is dropped. This chain is what makes the "unreachable today" claim true; a chain that stopped at the stored fields would DELETE a working endpoint and key from any deployment that names its embedding provider through the environment, which is the failure this note exists to prevent.
2. **The surface's rows.** `envEmbeddingProvider ?? draftedProvider` decides which endpoint/key rows render, which vendor the "supplies its API key from the environment" sentence names, and what `settingsSaveBody` sends. Keying the rows to the picker alone reproduces DW-71's inert save one field over: under an override the owner would type a credential into a row the runtime never consults.
3. **The route's keying.** `applyWorkbenchSettings` keys the embedding secret and endpoint by the same expression over the merged config, so the browser and the route never disagree about which vendor a save lands on.

Migration is idempotent, returns by identity when there is nothing to move, and never writes a value to more than one provider. A provider whose credential cannot be attributed keeps neither field.

**States the Embeddings category must never render as a gap.** Exactly one of three things appears where the endpoint and key rows would be: the two rows (a provider that reads them); one sentence saying the provider carries its own transport (`ollama`, `workers-ai`); or one sentence saying a provider must be chosen before an endpoint and a key can be stored (no provider from the picker or the environment). A silent `null` branch is a regression — both rows were unconditional before this change.

**One predicate, not two.** "Does this embedding provider read a stored endpoint and key" is exported once from `workbench-settings.ts` and imported by `config.ts`. A second literal provider list in the store layer would let the surface offer and send a credential the merge silently discards.

**Managing a vendor's credential means selecting that vendor.** Only the effective provider's endpoint and key are editable; another vendor's stored values are reached by selecting it. That is deliberate — one visible field per concept — and is why the payload reports presence per provider rather than one boolean.

```ts
// The post-save merge — a pure rule, not a branch in the click handler.
// Fields edited while the request was in flight beat the response; everything
// else is re-seeded from what the store now holds. The embedding provider,
// endpoint and key move as ONE unit: a provider switched mid-flight must not
// keep the landed payload's endpoint, which belongs to the provider it replaced.
export function settingsDraftAfterSave(
  sent: SettingsDraft, current: SettingsDraft, payload: WorkbenchSettingsValues,
): SettingsDraft {
  const seeded = settingsDraftFromPayload(payload);
  const merged = { ...seeded };
  for (const key of Object.keys(seeded) as Array<keyof SettingsDraft>) {
    if (current[key] !== sent[key]) (merged as Record<string, unknown>)[key] = current[key];
  }
  return merged; // …then re-apply the embedding triple from `current` when its provider moved.
}
```

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/config.test.ts src/lib/__tests__/embeddings.test.ts src/components/workbench/__tests__/` — expected: all pass
- `npx vitest run` — expected: no new failures
- `npx eslint` — expected: clean
- `npx tsc --noEmit` — expected: clean
