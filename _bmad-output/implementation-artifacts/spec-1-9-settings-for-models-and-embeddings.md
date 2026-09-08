---
title: 'Story 1.9: Settings for models and embeddings'
type: 'feature'
created: '2026-08-16'
status: 'done'
baseline_revision: '2b898327e529d225a85b185e7db7f5c2666bbbd7'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-8-edit-schema.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The legacy `/settings` page now offers `Custom` in its provider picker but
      has no base-URL or key field for it, so selecting it there stores a
      provider no LLM call can construct.
    evidence: |-
      `custom` was added to the shared `PROVIDER_INFO`, which
      `src/components/ProviderForm.tsx:47` spreads into the legacy page's
      dropdown; that form renders conditional fields only for `ollama` and
      `ollama-cloud`. Saving `provider: "custom"` there leaves `getModel()`
      throwing "The Custom provider needs a base URL. Set it in Settings → LLM
      Models." — actionable, and recoverable from the Workbench surface, which is
      why it was not patched here: this story's spec forbids modifying
      `ProviderForm` or the legacy route, and the honest fix is either to give
      that form the two fields or to retire the page.
    location: >-
      src/components/ProviderForm.tsx:47, src/lib/providers.ts (PROVIDER_INFO)
    severity: medium
  - summary: >-
      The `g s` keyboard shortcut still routes out of the shell to the legacy
      Settings page, doing exactly the route change the rail control stopped
      doing.
    evidence: |-
      `src/hooks/useKeyboardShortcuts.ts:46` maps `g s` to `/settings` and
      dispatches it with `router.push`, and `KeyboardShortcutsProvider` wraps the
      Workbench. So from inside the shell the keyboard path unmounts everything
      above the canvas and lands on a page with none of this story's categories,
      while the rail button opens the in-shell surface. `keyboard-shortcuts.test.ts:102,203`
      pin the old route, and this story is forbidden from editing pre-existing
      test files beyond the one rail pin — closing it means deciding whether the
      shortcut opens the surface or the legacy page stays a legitimate target.
    location: >-
      src/hooks/useKeyboardShortcuts.ts:46,161
    severity: medium
  - summary: >-
      Two live Settings surfaces now write one config file with no lost-update
      protection between them.
    evidence: |-
      Both the new surface and `/settings` read-modify-write the same
      `AppConfig` through `loadConfig` → merge → `saveConfig`, with no `If-Match`,
      no version and no lock. A draft seeded before the other surface (or another
      tab) saved will overwrite it silently on the next Save. This is the same
      lost-update shape already recorded for the page and artifact writes
      (DW-38, DW-51, DW-56) rather than a new mechanism, and closing it needs the
      conflict-surface design those entries are waiting on.
    location: >-
      src/app/api/settings/route.ts, src/lib/config.ts (saveConfig)
    severity: medium
  - summary: >-
      The configured deadline bounds a whole STREAM on `callLLMStream`, and a
      deadline that fires surfaces raw transport vocabulary.
    evidence: |-
      `callLLMStream` is not retry-wrapped, so its single `AbortSignal.timeout`
      measures total stream duration rather than time-to-first-response: a 30s
      deadline set to catch hangs would truncate every answer that takes longer
      than 30s to finish. Separately, `AbortSignal.timeout` raises a
      `TimeoutError` whose message matches none of `RETRYABLE_MESSAGES`, so it
      propagates verbatim — "The operation was aborted due to timeout" is
      exactly the transport vocabulary this repo's copy rules exclude. Both need
      Chat's streaming semantics (Epic 3) to decide what a deadline means for a
      stream and which sentence the owner should see.
    location: >-
      src/lib/llm.ts (callLLMStream, timeoutOption)
    severity: medium
  - summary: >-
      On a read-only deployment the Settings selects and checkbox are `disabled`,
      which takes them out of the tab order, so a keyboard user cannot even read
      the stored provider.
    evidence: |-
      Text inputs use `readOnly` (focusable, still readable) while selects and the
      vector checkbox use `disabled`, because HTML has no `readonly` for either.
      The accessible fix is `aria-disabled` plus a suppressed change handler, and
      it wants one decision applied to every control class in the shell rather
      than one made inside this surface.
    location: >-
      src/components/workbench/SettingsCanvas.tsx
    severity: low
  - summary: >-
      `hasCustomApiKey` / `hasFirecrawlApiKey` conflate an env-supplied key with a
      stored one, so `Remove` is offered for keys it cannot remove.
    evidence: |-
      `apiKeyForProvider("custom")` and `getFirecrawlSettings().hasKey` both count
      `LLM_CUSTOM_API_KEY` / `FIRECRAWL_API_KEY` alongside the stored value, and
      the surface renders "A key is stored." plus a `Remove` button from that one
      boolean. Pressing Remove on an env-supplied key clears nothing and the
      sentence does not change. The embeddings half of this was closed in the
      patch pass (`hasEnvEmbeddingApiKey` rides separately); the same split for
      the other two was left out to keep the payload from growing again.
    location: >-
      src/lib/config.ts (getWorkbenchSettings), src/components/workbench/SettingsCanvas.tsx
    severity: low
  - summary: >-
      Edits typed while a save is in flight are discarded when the response
      re-seeds the draft.
    evidence: |-
      `save` re-seeds the whole draft from the stored values the route answers
      with, which is what clears `dirty` — but the fields stay editable during the
      request, so anything typed in that window is replaced without a word. The
      alternatives (freeze the form while saving, or merge only untouched fields)
      are both behavioural choices this story's acceptance does not settle.
    location: >-
      src/components/workbench/SettingsCanvas.tsx (save)
    severity: low
  - summary: >-
      Storing an embedding key through the new surface flips
      `hasEmbeddingSupport()` on for the existing ingest caller even with vector
      search switched off.
    evidence: |-
      `embeddingApiKeyFor` now falls back to `loadConfigSync().embeddingApiKey`
      (which the spec's Execution list requires, or the three stored vector
      values would have no reader at all). `hasEmbeddingSupport()` →
      `getEmbeddingModelName()` → `resolveEmbeddingProvider()` →
      `embeddingApiKeyFor()`, so an owner who pastes a key into Settings →
      Embeddings and leaves the switch off — the story's headline default — turns
      `ingest.ts:989` from off to on. Nothing fails: `embeddings.test.ts` drives
      that path from env vars, which are unchanged. The epic assigns "embed after
      ingest only when vector is on" to Story 2.9 and the spec's Never list
      forbids gating the callers here, so closing it is that story's work.
    location: >-
      src/lib/embeddings.ts:139 (embeddingApiKeyFor), src/lib/ingest.ts:989
    severity: medium
  - summary: >-
      One `embeddingApiKey` is shared by both keyed embedding vendors, so
      switching provider silently reuses the other vendor's key.
    evidence: |-
      `embeddingApiKeyFor` reads the same stored value for `openai` and
      `google`, and `settingsSaveBody` omits an untouched secret — so an owner
      who stored an OpenAI key and then picks Google sends that key to Google
      while the hint still reads "A key is stored." Keying the field per provider
      (or labelling which vendor the stored key belongs to) is a store-shape
      decision this story's acceptance does not settle; the vector gate's env
      leg was made provider-aware in this pass, but the STORED key deliberately
      stayed vendor-agnostic so a provider changed in the draft can still answer
      the gate before it is saved.
    location: >-
      src/lib/embeddings.ts:139, src/lib/config.ts (getWorkbenchSettings)
    severity: low
  - summary: >-
      The Embeddings category offers an endpoint field that is never read for
      `ollama` or `workers-ai`.
    evidence: |-
      `_createEmbeddingModel` applies `config.embeddingBaseUrl` for `openai` and
      `google` only; `ollama` reaches its server through `getOllamaBaseUrl()` and
      `workers-ai` through the Cloudflare binding. The vector gate agrees (both
      are in `SELF_TRANSPORTING_EMBEDDING_PROVIDERS` and are not asked for an
      endpoint), so nothing is broken — but the field still accepts a value that
      goes nowhere. Hiding it per provider, or routing `ollama`'s embedding
      endpoint through it, both change what `ollamaBaseUrl` means and want one
      decision rather than a fix inside this surface.
    location: >-
      src/lib/embeddings.ts:228-247, src/components/workbench/SettingsCanvas.tsx
    severity: low
  - summary: >-
      `LLM_CUSTOM_BASE_URL` wins at runtime but is invisible on the surface, so
      the Custom endpoint box can be typed into and saved with no effect.
    evidence: |-
      `getCustomBaseUrl()` resolves `nonEmpty(process.env.LLM_CUSTOM_BASE_URL) ??
      nonEmpty(cfg.customBaseUrl)`, while `getWorkbenchSettings()` serves
      `customBaseUrl: nonEmpty(cfg.customBaseUrl)` — the STORE only. A deployment
      that sets the env var therefore renders an empty endpoint box; the owner
      types a URL, the save succeeds, and the runtime keeps using the variable.
      This is exactly the failure the follow-up pass fixed for embeddings with
      `settingsEnvOverrideCopy` / `envEmbeddingModel`, and closing it the same way
      means another payload field plus another copy function — worth doing beside
      the already-recorded `hasCustomApiKey` env/store split rather than as a
      third separate touch of the same rows.
    location: >-
      src/lib/config.ts (getWorkbenchSettings, getCustomBaseUrl), src/components/workbench/SettingsCanvas.tsx
    severity: medium
  - summary: >-
      One stored `embeddingBaseUrl` is handed to whichever embedding provider is
      active, so an endpoint entered for OpenAI is sent to Google after a switch.
    evidence: |-
      `_createEmbeddingModel` reads `loadConfigSync().embeddingBaseUrl` and
      applies it to the `openai` and `google` branches alike, with nothing tying
      the value to the provider it was typed for. This is the endpoint twin of
      the already-recorded vendor-agnostic `embeddingApiKey`, and it has the same
      resolution: keying the field per provider is a store-shape decision this
      story's acceptance does not settle. Nothing breaks today — the pair is
      usually changed together — but the silent reuse is real.
    location: >-
      src/lib/embeddings.ts:228-238 (_createEmbeddingModel)
    severity: low
  - summary: >-
      A `workers-ai` embedding model outside the `@cf/` namespace satisfies the
      vector gate and is then silently discarded at resolution time.
    evidence: |-
      `canEnableVectorSearch` asks `workers-ai` for a provider and a model only
      (it is keyless and self-transporting), so `{ provider: "workers-ai", model:
      "text-embedding-3-small" }` turns the switch on. `resolveEmbeddingModelName`
      then rejects the same value for a namespace mismatch and falls back to
      `@cf/baai/bge-m3`. The owner's model choice is replaced without a word. The
      namespace guard is pre-existing; teaching the gate about it means deciding
      whether the surface refuses the model, rewrites it, or narrows the picker.
    location: >-
      src/lib/workbench-settings.ts:427-440, src/lib/embeddings.ts (resolveEmbeddingModelName)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Epic 1's last unbuilt surface. The rail's Settings control is still `<a href="/settings">` (`IconRail.tsx:126`) pointing at the pre-fork public settings page, and the kernel store behind it knows only ONE generation provider/model pair (`AppConfig`, `config.ts:18-32`). There is no Chat-vs-Ingest split, no `custom` provider, no configurable LLM timeout, no Firecrawl credentials, and no vector-search switch at all — so `hasEmbeddingSupport()` is on whenever any embedding-capable credential exists, which is the always-on path AD-12 says must change. Epic 2's Ingest and Epic 3's Chat have nowhere to read a model or a key from.

**Approach:** Bring Settings inside the shell as the rail-bottom surface (settings nav in the left column, detail + sticky save bar on the canvas) and extend the ONE kernel settings store and the ONE settings API it already has with the fields Story 1.9 owns: Chat and Ingest models, the `custom` provider, LLM timeout, vector search (off by default, endpoint + key + model to enable), and Firecrawl. Every rule the surface enforces is a pure function in one client-safe module that the node suite executes and the server re-runs.

## Boundaries & Constraints

**Always:**
- **One settings store, one settings API.** The bytes stay in `AppConfig` written through `saveConfig` (`config.ts:154-161`) and the only HTTP surface is the existing owner-gated `GET/PUT /api/settings`. Story 1.9's fields ride under ONE nested `workbench` key on both sides of that route — the flat legacy fields (`provider`, `model`, `ollamaBaseUrl`, `structuredKnowledge*`, `embeddingProvider`, `embeddingModel`) keep their exact current wire shape and merge semantics, so `/settings` and `useSettings` keep working untouched.
- **One embedding model, one config key.** The Embeddings category writes the EXISTING `embeddingModel` / `embeddingProvider` keys. A second embedding-model field anywhere is the forked copy this rule exists to prevent.
- **Secrets are write-only over the wire.** `PUT` accepts `customApiKey` / `embeddingApiKey` / `firecrawlApiKey`; `GET` answers `hasCustomApiKey` / `hasEmbeddingApiKey` / `hasFirecrawlApiKey` booleans and never the stored value. AD-23 puts the keys in the kernel store; it does not put them back on the browser's screen.
- **Vector search is off until all three arrive.** The stored default is `false`, and enabling requires an endpoint, a model, and a key (stored, or set in the same request) — ONE predicate, evaluated over the MERGED config, called by both the client (to disable the toggle) and the route (to answer 400). FR-56's "cannot turn on without endpoint + key + model" is that predicate and nothing else.
- **Every decision the node suite cannot execute in a DOM is a pure function.** `vitest.config.ts` is `environment: "node"` (DW-15). The category vocabulary, every user-visible sentence, the draft/dirty/discard rules, the save-body builder, the validation and the vector predicate all live in `src/lib/workbench-settings.ts` and are executed by tests; the components hold state and markup only.
- **The shell stays router-free.** Opening Settings is `useState` on the one mounted shell, exactly as a mode switch is. No `useRouter`, no `next/link`, no `router.push` under `src/components/workbench` (pinned by `workbench-chrome.test.ts:130-134` and `workbench-left-column.test.ts:437-446`).
- **One canvas at a time.** The Settings canvas takes over `CANVAS_ID` and `tabIndex={-1}` from `ModeCanvas` while it is open, so the skip link keeps exactly one target and the id stays unique.
- **The surface is owner-gated by the same route that stores the bytes.** The client never decides who may save; a 403/404 from `/api/settings` is relayed as copy.

**Block If:**
- Satisfying "Chat and Ingest models persist in the kernel store" turns out to require a second store (sidecar-local, browser-local, or a per-Wiki artifact) rather than `AppConfig`.
- Making vector search default off cannot be expressed without changing `hasEmbeddingSupport()`'s current return for existing callers — that consumption is Story 2.9's and Story 3.4's (see **Never**).

**Never:**
- **Never** gate `ingest.ts:989`, `searchByVector`, or `hasEmbeddingSupport()` on the new switch. The epic assigns the embed step to Story 2.9 ("embed after ingest only when vector is on") and the search merge to Story 3.4; this story owns the setting, the default and the resolver they will read. Turning the callers over here would silently pre-empt two stories and rewrite `embeddings.test.ts`.
- **Never** rewire `callLLM` / `ingest.ts` / `chat.ts` to the Chat or Ingest model selection. This story exposes `getChatModelSettings()` / `getIngestModelSettings()` (and `getConfiguredModel({ workload })`); Epics 2 and 3 own the call sites, per `epic-1-context.md:63`.
- **Never** delete, redirect or restyle the legacy `/settings` route, `useSettings`, `ProviderForm`, `EmbeddingSettings` or the other legacy settings components. `error-hints.test.ts` and `keyboard-shortcuts.test.ts` both still point at that route; retiring it is not this story's acceptance.
- **Never** add a Schema or `purpose.md` editor to any Settings category. Story 1.8 shipped the ONE confirm-gated editor and deliberately left `purpose.md` shut (DW-58); General points at it in a sentence and writes nothing.
- **Never** touch the workspace profile, `saveWorkspaceProfile`, the Wiki registry, or `dataVersion` — Settings are deployment-scoped, not Wiki-scoped, and DW-14/DW-21/DW-49 stay open.
- **Never** persist which Settings category is open, or whether Settings is open, to `localStorage`. `workbench-state.ts`'s durable set is mode, tab, selection, collapse and widths; a reload must not land the owner in Settings.
- **Never** add a dependency, a DOM test environment, `@testing-library/*`, a locale picker, a second overlay level, a non-English sentence, or `Georgia`/`serif` under `src/components/workbench`.
- **Never** modify a pre-existing test file other than `src/lib/__tests__/workbench-chrome.test.ts`, and there only the single `href="/settings"` rail pin this story deliberately changes.
- **Never** log, echo in an error message, or return a stored API key.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Owner opens Settings | `GET /api/settings`, owner principal | 200 whose body still carries every legacy field AND a `workbench` object with the stored values, the three `has*ApiKey` booleans, `vectorSearchEnabled: false` by default and `language: "English"` | No error expected |
| No key is ever served | any stored `customApiKey` / `embeddingApiKey` / `firecrawlApiKey` | The serialized GET body does not contain the stored value anywhere | Presence is a boolean |
| Non-owner opens Settings | signed-in non-owner | 404 (the route's existing refusal); the surface shows one load-failure sentence | No existence oracle |
| Owner saves dual models | `PUT { workbench: { chatProvider: "openai", chatModel: "gpt-4o", ingestProvider: "anthropic", ingestModel: "claude-sonnet-4-20250514" } }` | 200; `saveConfig` receives those four keys merged onto the existing config; `getChatModelSettings()` and `getIngestModelSettings()` return them independently | No error expected |
| Unset workload inherits | neither `chatProvider` nor `chatModel` stored | `getChatModelSettings()` returns the primary provider/model with `usesPrimary: true` | Same ladder as `getStructuredKnowledgeModelSettings` |
| Legacy save still works | `PUT { provider: "ollama-cloud", model: "gpt-oss:120b" }` (no `workbench` key) | 200 and exactly the same saved object as today | Unchanged |
| Vector on without all three | `{ workbench: { vectorSearchEnabled: true } }` with no endpoint / model / key in store or patch | 400 with one sentence naming what is missing; nothing written; the switch stays off | The toggle is also disabled client-side by the same predicate |
| Vector on with all three | endpoint + model + key present after merge | 200; `vectorSearchEnabled` is `true` in the store; `getVectorSearchSettings().enabled` is `true` | — |
| A key is cleared | `{ workbench: { firecrawlApiKey: null } }` | 200; the key is deleted from the config; `hasFirecrawlApiKey` is `false` | `""` clears too; an ABSENT field leaves it untouched |
| An untouched key field saves | owner edits only the timeout and saves | The request body carries no `*ApiKey` field at all, so no stored key is disturbed | Builder omits empty secret drafts |
| Invalid provider / model / URL / timeout | `chatProvider: "acme"`, `chatModel: ""`, `customBaseUrl: "not-a-url"`, `llmTimeoutSeconds: 0` or `4000` or `1.5` | 400 with one sentence; nothing written | Timeout is an integer 5–3600 seconds; URLs must be absolute `http`/`https` |
| Read-only deployment | `YOPEDIA_READONLY=1` | `GET` reports `readOnly: true` and the save bar refuses with its own sentence; `PUT` answers the route's existing 403 | Same shape as today |
| Save fails | route answers 4xx/5xx with `{ error }` | The surface shows the SERVER's sentence, keeps every edit on screen, and applies nothing | A thrown/transport error shows one fixed fallback sentence, never its own message |
| Save succeeds | 200 | The response re-seeds the draft from the stored values, the dirty state clears, and a polite status line says so | — |
| Owner leaves without saving | edits, then clicks any rail mode | The surface unmounts and the draft is gone; nothing was sent; returning shows the stored values | Discard is unmount, not a diff |
| Category with no fields yet | Intake / MinerU PDF / API + MCP | One muted sentence, no controls, no save bar activity | Listed, not required to function |

</intent-contract>

## Code Map

**New:**
- `src/lib/workbench-settings.ts` — the pure, client-safe module. Same posture as `workbench-modes.ts` (vocabulary + copy) and `workbench-preview.ts:389-556` (decisions + one fetch/save client taking `fetchImpl`): `SETTINGS_CATEGORIES` (id, label, and a `pending` sentence or `null`), `DEFAULT_SETTINGS_CATEGORY`, `settingsAnnouncement(label)` → `` `Settings, ${label}` `` (EXPERIENCE.md:175), the save-bar/read-only/failure/saved copy constants, `WorkbenchSettingsPayload` + `isWorkbenchSettingsPayload`, `SettingsDraft` + `settingsDraftFromPayload`, `settingsDirty`, `settingsSaveBody`, `canEnableVectorSearch`, `validateWorkbenchSettingsPatch`, `fetchWorkbenchSettings` / `saveWorkbenchSettings`. Imports `PROVIDER_INFO` / `EMBEDDING_PROVIDERS` from `providers.ts` (already client-safe by its own header comment) — it never restates a provider list.
- `src/components/workbench/SettingsNav.tsx` — the left-column second list (`{components.settings-nav}`): one `<nav aria-label="Settings categories">` of buttons over `SETTINGS_CATEGORIES`, active row `aria-current="page"` plus a wash, `data-no-localize` (i18n.ts:21 carries "Settings").
- `src/components/workbench/SettingsCanvas.tsx` — the detail column: owns the fetch, the draft, the sticky save bar and the ONE `fetch`-driven save. Takes `CANVAS_ID` and `tabIndex={-1}` from `ModeCanvas`, a local `REQUEST_TIMEOUT_MS = 15_000` + `AbortSignal.timeout(...)` (the `PreviewColumn.tsx:94,293` / `WikiSwitcher.tsx:44,53` convention), and every sentence from `workbench-settings.ts`.
- `src/lib/__tests__/workbench-settings.test.ts` — the one new test file: the pure decisions, the route (fixture shape from `settings-route.test.ts:1-73`, plus a real-config block for the resolvers using `config.test.ts`'s temp-`DATA_DIR` idiom), and the source scans for the wiring a node suite cannot execute.

**Extend:**
- `src/lib/providers.ts:12-19,53-61` — add `{ value: "custom", label: "Custom" }` to `PROVIDER_INFO` and a `DEFAULT_MODELS.custom` entry is deliberately NOT added (a custom endpoint has no default model; `getEffectiveProvider`'s existing `?? provider` fallback already covers the empty case). `EMBEDDING_PROVIDERS` is unchanged.
- `src/lib/config.ts:18-32` — `AppConfig` gains `chatProvider`, `chatModel`, `ingestProvider`, `ingestModel`, `customBaseUrl`, `customApiKey`, `llmTimeoutSeconds`, `vectorSearchEnabled`, `embeddingBaseUrl`, `embeddingApiKey`, `firecrawlApiKey`, `firecrawlBaseUrl`. `:234-253` `apiKeyForProvider` gains `case "custom"` (env `LLM_CUSTOM_API_KEY` then `loadConfigSync().customApiKey`) and `providerIsConfigured` treats `custom` as configured only with BOTH a key and a base URL. `:457-504` `ResolvedCredentials` gains `customBaseUrl`. New, all modelled on `getStructuredKnowledgeModelSettings():308-345`: `getChatModelSettings()`, `getIngestModelSettings()`, `getVectorSearchSettings()`, `getLlmTimeoutMs()` (seconds × 1000, `null` when unset), `getFirecrawlSettings()`, `getWorkbenchSettings()` (the GET payload) and `applyWorkbenchSettings(existing, patch)` (the merge). `getEffectiveSettings():350-451` is NOT changed — its shape is a pinned fixture in `settings-route.test.ts:47-66` and the new fields ride beside it.
- `src/app/api/settings/route.ts:29-36,42-222` — `GET` returns `{ ...getEffectiveSettings(), workbench: getWorkbenchSettings() }`. `PUT` keeps every existing branch verbatim and, after them, handles `body.workbench` through `validateWorkbenchSettingsPatch` (400 on refusal) then `applyWorkbenchSettings`; the response gains the fresh `workbench` object beside `saved`/`effective`.
- `src/lib/llm.ts:227-290,297-345,352-452` — a `custom` case in both model factories: `createOpenAI({ apiKey, baseURL }).chat(model)`, exactly the treatment `deepseek` already gets at `:250-263` and for the same reason (OpenAI-compatible endpoint, `.chat()` not the Responses API). `callLLM`, `callVisionLLM` and `callLLMStream` pass `abortSignal: AbortSignal.timeout(ms)` when `getLlmTimeoutMs()` is non-null — constructed INSIDE the `retryWithBackoff` thunk so each attempt gets its own deadline, and omitted entirely when unset so today's no-timeout behaviour is the default.
- `src/lib/embeddings.ts:126-137,196-224` — `embeddingApiKeyFor` falls back to `loadConfigSync().embeddingApiKey` after its env var (env still wins), and `_createEmbeddingModel` passes `baseURL` for `openai`/`google` when `config.embeddingBaseUrl` is set. Both are additive: with nothing stored, every existing branch resolves exactly as it does now.
- `src/components/workbench/IconRail.tsx:45-48,80-90,124-128` — the Settings `<a href="/settings">` becomes a `<button>` with `onClick={onOpenSettings}`, `aria-current="page"` when `settingsActive`, and the same `wb-rail-item--active` wash; a mode's `active` becomes `!settingsActive && item.id === mode` so exactly one rail control is ever current.
- `src/components/workbench/Workbench.tsx:112-137,253-261,425-433,458-471,479-508,538-540` — `settingsOpen` + `settingsCategory` state; `openSettings` announces `settingsAnnouncement(...)` and closes the sheet; `selectMode` clears `settingsOpen`; the left column renders `SettingsNav` and is labelled `Settings panel`; the canvas renders `SettingsCanvas` instead of `ModeCanvas`; `previewOpen` becomes `shouldDockPreview(mode, selection) && !settingsOpen`. The Tab-loop comment at `:326-336` stops saying "the Settings link".
- `src/app/globals.css` (after the Story 1.8 block) — `.wb-set-*` rules only, built from the existing `--wb-*` tokens: nav list, detail sections, labels/inputs/selects, the muted pending sentence, and the sticky save bar. No new token, no new colour.
- `src/lib/__tests__/workbench-chrome.test.ts:100-104` — the one deliberate re-pin: `href="/settings"` becomes the rail-button assertion (`onOpenSettings`, `aria-current`), keeping `aria-label="Settings"`.

**Reuse as-is (do not fork, do not edit):**
- `src/lib/config.ts:137-161` `loadConfig`/`saveConfig`, `:181-195` the sync cache, `:79-81` `isReadOnly`, `:208-231` `detectEnvProvider` — the store and its ladder already exist.
- `src/lib/providers.ts` `VALID_PROVIDERS`, `isEmbeddingProvider`, `providerLabel`; `src/lib/auth.ts` `getPrincipal`; `src/lib/owner.ts` `isOwnerHandle`; `src/lib/errors.ts` `getErrorMessage`; `src/lib/brand.ts` `APP_NAME`/`APP_TAGLINE` (the About category's only copy).
- `src/components/workbench/ModeCanvas.tsx:38` `CANVAS_ID` — imported, never restated.
- `src/lib/workbench-tree.ts` `shouldDockPreview` — unchanged; the Settings conjunction sits at its one call site.

**Read-only constraints (do not regress):**
- `workbench-chrome.test.ts` — the rail's `aria-label="Modes"`, `WORKBENCH_MODES.map`, badge rules, the three sidecar states, no router/`next/link`, no serif under `src/components/workbench`, and the `.wb-shell` token block.
- `workbench-modes.test.ts` — the ten-mode order and every empty-state sentence. Settings is NOT a mode and must not enter `WORKBENCH_MODES`.
- `workbench-left-column.test.ts`, `workbench-preview.test.ts`, `workbench-data-version.test.ts` — the view-first pin set, the Preview's write targets, and the `bumpDataVersion` file/count/position guards. This story adds no bump and no writer.
- `settings-route.test.ts` — all four cases must pass untouched, including the two exact `saveConfig` object assertions.
- `config.test.ts`, `embeddings.test.ts`, `ingest.test.ts` — provider/model resolution and `hasEmbeddingSupport`'s current answers.
- `brand-copy.test.ts` — new user-visible sentences say work-wiki, never `Yopedia`; new identifiers keep `yopedia` spellings where they exist.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- new pure module: category vocabulary, every sentence, the payload/draft types, `settingsDraftFromPayload` / `settingsDirty` / `settingsSaveBody`, `canEnableVectorSearch`, `validateWorkbenchSettingsPatch`, and the fetch/save client with an injectable `fetchImpl` -- there is no DOM test environment, so "which categories exist", "may vector be enabled", "what does Save actually send" and "which sentence does a rejected save show" have to be functions a node test executes rather than branches typed into JSX; injecting `fetchImpl` is what lets the suite drive them without a socket.
- `src/lib/providers.ts` -- add the `custom` provider entry -- the AC requires the provider list to include Custom, and a second list typed into the Settings UI is the forked vocabulary this module exists to prevent.
- `src/lib/config.ts` -- add the new `AppConfig` fields, the `custom` credential/configured rules, and the seven resolvers plus the merge -- `AppConfig` is the kernel store AD-23 names, and resolution belongs beside the ladder every other setting already resolves through; `getEffectiveSettings` is left alone so the legacy contract and its fixture do not move.
- `src/app/api/settings/route.ts` -- serve `workbench` on GET and accept/validate/merge `body.workbench` on PUT, leaving every existing branch verbatim -- one owner-gated settings API is what keeps the browser from addressing the store directly, and re-running the client's own predicate server-side is what makes the vector rule a rule rather than a disabled button.
- `src/lib/llm.ts` -- add the `custom` model construction and apply the configured timeout inside the retry thunk -- a provider the owner can select but the runtime cannot construct is a silently inert save, and a timeout nobody applies is the same thing; both are the failure mode Story 1.8's review pass named.
- `src/lib/embeddings.ts` -- fall back to the stored embedding key and honour a stored endpoint -- otherwise "vector search needs endpoint + key + model" stores three values no code path can use.
- `src/components/workbench/SettingsNav.tsx` -- the left-column category list -- UX-DR14's second list, and the left column is where the shell already puts a mode's own navigation.
- `src/components/workbench/SettingsCanvas.tsx` -- fetch, draft, category detail panes, and the sticky save bar reading `Changes apply after saving` -- the draft must live in this component and nowhere else, because "unsaved edits are discarded on leave" IS the unmount, and one save `fetch` is what stops a second write path appearing beside it.
- `src/components/workbench/IconRail.tsx` -- turn Settings into a rail button with its own active state -- the epic requires Settings inside the shell, and a link would be the route change `epics.md:367` forbids for a surface switch.
- `src/components/workbench/Workbench.tsx` -- own `settingsOpen` / `settingsCategory`, swap both columns, announce the surface, and undock the Preview while Settings is open -- the shell is the one component that owns which surface is showing; a docked Preview beside a Settings detail column would describe a row the owner cannot point at.
- `src/app/globals.css` -- add the `.wb-set-*` rules from existing tokens -- the chrome is custom Tailwind-free CSS in this shell, and a new colour here would break the "colour means state" rule.
- `src/lib/__tests__/workbench-settings.test.ts` -- new: execute every I/O matrix row (the route for each status, the resolvers against a temp `DATA_DIR`, the pure decisions directly), assert the GET body contains no stored key, assert the legacy PUT shape is byte-identical to today's, and source-scan the three components for the wiring a node suite cannot run (one `fetch(`, no `useRouter`, `CANVAS_ID` imported, no `localStorage`, no serif) -- the whole story is invisible when it works, and the parts most likely to rot silently are the secret discipline and the vector gate.
- `src/lib/__tests__/workbench-chrome.test.ts` -- re-pin only the rail's Settings control -- that pin is exactly what this story changes; everything else in the file is a read-only constraint.

**Acceptance Criteria:**
- Given a signed-in owner in the Workbench, when they click Settings in the rail, then the shell (not a new route) shows the settings nav listing at least General, LLM Models, Embeddings, Interface and About — with Intake, MinerU PDF, API + MCP and External Sources listed too — the canvas shows that category's detail under a sticky save bar reading `Changes apply after saving`, the live region announces `Settings, <category>`, and no Preview column is docked.
- Given the owner sets a Chat model and an Ingest model on different providers and saves, when the app is reloaded (or the process restarted), then both selections come back from the kernel store independently of each other and of the primary provider, and `getChatModelSettings()` / `getIngestModelSettings()` report them.
- Given a fresh deployment with no saved settings, when the Embeddings category renders, then vector search is off, the enable control refuses while an endpoint, a model or a key is missing, and a `PUT` that tries to force it on is refused with a sentence and writes nothing.
- Given the owner types a Firecrawl key and an LLM timeout and saves, when the settings are read back, then the timeout and the Firecrawl base URL come back as stored values while the key comes back only as a presence boolean — and the response body carries the key nowhere.
- Given the owner edits several fields and then clicks a mode in the rail without saving, when they open Settings again, then every field shows the stored value, nothing was sent to the server, and no LLM call behaves differently.
- Given the Interface category, when it renders, then Language reads English with no picker and no other locale offered anywhere in the surface.
- Given the full suite, when `npx vitest run`, `npx tsc --noEmit` and `npx eslint` run, then all three are clean and the only pre-existing test file modified is `workbench-chrome.test.ts`.

## Spec Change Log

### 2026-08-16 — Implementation run

One deviation from the **Never** list, forced by an incomplete enumeration in
the spec rather than by a design choice.

- **`src/lib/__tests__/providers.test.ts` pins the provider list at six.** The
  Code Map and the Execution list both instruct adding
  `{ value: "custom", label: "Custom" }` to `PROVIDER_INFO` and deliberately NOT
  adding a `DEFAULT_MODELS.custom` entry. That pre-existing file asserts
  `PROVIDER_INFO` has exactly 6 entries, `VALID_PROVIDERS.size === 6`, and — the
  one that cannot be satisfied at all — that **every** member of
  `VALID_PROVIDERS` has a `DEFAULT_MODELS` entry. Satisfying the Never clause and
  the Code Map at once is impossible, so four assertions moved: the two counts
  became 7, the per-provider default now skips `custom` with the reason written
  beside it, and the `DEFAULT_MODELS` count assertion stayed at 6 and gained
  `expect(DEFAULT_MODELS.custom).toBeUndefined()` so the omission is now pinned
  rather than merely tolerated. Nothing else in the file changed.

The acceptance criterion "the only pre-existing test file modified is
`workbench-chrome.test.ts`" therefore reads as two files instead of one.

Two smaller resolutions of under-specified points, both decided the way the I/O
matrix reads rather than the way the legacy route behaves:

- **A blank model string is a 400, not a clear.** The matrix lists
  `chatModel: ""` under "Invalid provider / model / URL / timeout", while the
  legacy flat `model` field treats `""` as delete. `null` is how a workload model
  is unset (and is what `settingsSaveBody` sends for an emptied box), so `""`
  reaching the route means something went wrong rather than that the owner asked
  for anything.
- **`vectorSearchEnabled` is validated over the merge even when the patch omits
  it.** The matrix only names the "turn it on" direction, but a patch that
  clears the embedding key while the stored switch is `true` leaves the same
  forbidden state by another door, so the predicate is evaluated against the
  merged flag rather than only against a `true` in the patch.

## Review Triage Log

### 2026-08-16 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 0, medium 9, low 4)
- defer: 7: (high 0, medium 4, low 3)
- reject: 18: (high 0, medium 3, low 15)
- addressed_findings:
  - `[medium]` `[patch]` The mount read could stick on `Loading…` forever. The
    effect returned before `setLoading(false)` on ANY abort, so a blown
    15-second deadline left the surface in the exact state the deadline exists
    to prevent. The read now carries `SETTINGS_TIMEOUT_REASON` the way
    `workbench-preview.ts` does, `fetchWorkbenchSettings` grew a third `stale`
    outcome, and an unmount is silent while a deadline shows the load-failed
    sentence. Pinned by two executed tests (deadline before the response, and a
    deadline that fires after it landed).
  - `[medium]` `[patch]` `getModel()`'s `custom` branch could request a model
    literally named `custom`. `getResolvedCredentials` ended with
    `DEFAULT_MODELS[provider] ?? provider`, and `DEFAULT_MODELS.custom` is
    deliberately absent. It now resolves `null` for `custom`, and `getModel()`
    refuses with the same actionable sentence `getConfiguredModel` already used.
  - `[medium]` `[patch]` The vector gate was unsatisfiable for two of the four
    embedding providers. `ollama` and `workers-ai` are documented keyless and
    carry their own transport, so demanding an endpoint and a key made vector
    search unreachable for them and stored an endpoint nothing reads.
    `canEnableVectorSearch` is now provider-aware: an EXPLICIT embedding provider
    is required (which also closes the hole where auto-detect could resolve none
    at all), the model is always required, and the key/endpoint legs are
    satisfied by the provider itself where it supplies them. The refusal sentence
    names the legs that provider is actually missing.
  - `[medium]` `[patch]` `embeddingKeyPresent`'s `??` chain short-circuited on
    `OPENAI_API_KEY=""` and masked a real Google key. Truthiness now, via
    `nonEmpty`.
  - `[medium]` `[patch]` Client and server disagreed about `EMBEDDING_MODEL`: the
    payload served the stored model while the gate resolved the env override, so
    a deployment configured that way had a permanently disabled checkbox for a
    model the route would have accepted. The env overrides
    (`envEmbeddingProvider`, `envEmbeddingModel`, `hasEnvEmbeddingApiKey`) are now
    served BESIDE the editable stored fields, and both `draftVectorInputs` and
    the route's merge read them the same way. A table-driven test asserts the two
    answer identically across five configurations, including the env cases the
    old suite could not see.
  - `[medium]` `[patch]` The payload served `getVectorSearchSettings().enabled` —
    the stored flag intersected with the predicate — while `settingsSaveBody`
    always sends the field back, so any unrelated save could silently rewrite a
    stored `true` to `false`. The editing payload now serves the STORED flag;
    `getVectorSearchSettings().enabled` stays the effective one for consumers.
    Both are pinned, including a timeout-only save that leaves `true` intact.
  - `[medium]` `[patch]` Settings was unusable with the left column collapsed
    (`display: none` hid the nav, and `collapsed` is durable). The shell now
    reports `data-settings`, and CSS force-shows the column for the duration —
    the stored preference is not rewritten. The narrow breakpoint names the
    two-attribute selector explicitly, because it outranks the single-attribute
    rules there.
  - `[medium]` `[patch]` The rail's Settings control marked itself
    `aria-current="page"` but never closed. It toggles now, and closing announces
    the mode's own surface label the way `selectMode` does.
  - `[medium]` `[patch]` A nonsense timeout silently CLEARED the stored deadline:
    `Number("abc")` is `NaN`, which `JSON.stringify` writes as `null`, which the
    merge treats as "clear" — and reported success. `settingsSaveBody` now sends
    the raw string when the box does not hold a finite number, so the validator
    refuses it with a sentence; the patch type is widened to admit that, with the
    reason written down.
  - `[medium]` `[patch]` Three behaviours this story added had no coverage at
    all: the `abortSignal` reaching `generateText`/`streamText`, the `custom`
    model construction, and the stored embedding key/endpoint fallbacks. New
    `settings-runtime-wiring.test.ts` covers all three in the
    `llm-deepseek.test.ts` idiom, including both `custom` guard errors and a
    retry that proves each attempt gets its OWN deadline.
  - `[low]` `[patch]` A whitespace-only secret deleted a stored key: `"   "` rode,
    and the merge trimmed it to empty. `secretPatchValue` now treats it as
    untouched, exactly like `""`.
  - `[low]` `[patch]` A refusal stayed beside Save while the owner fixed the very
    field it named. `set()` clears `saveError` as well as `status`.
  - `[low]` `[patch]` The timeout's range hint and the vector checkbox's disabled
    reason were plain siblings, invisible to a screen reader. Both are now
    `aria-describedby` targets, as is the embedding-provider hint.
  - `[low]` `[patch]` Housekeeping: `.wb-set-canvas` was applied and never
    defined (the class is gone, and a new test asserts every applied `wb-set-*`
    class has a rule); `mergedVectorInputs` is module-private with a docblock
    that matches; `SettingsResponseBody` and `isSettingsCategoryId` are deleted;
    `SETTINGS_CATEGORIES`' docblock and its test now say six built and three
    pending; and `workloadModelSettings` is genuinely the one ladder —
    `getStructuredKnowledgeModelSettings` calls through to it instead of keeping
    its own copy.

### 2026-08-16 — Review pass (follow-up)

- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 1, medium 4, low 8)
- defer: 3: (high 0, medium 1, low 2)
- reject: 19: (high 0, medium 4, low 15)
- addressed_findings:
  - `[high]` `[patch]` **`hasLLMKey()` was blind to `custom`, so selecting the
    provider this story added produced a deployment that reported itself
    configured and then skipped every LLM step.** The function still answered
    `detectEnvProvider() || cfg.provider === "ollama"` — the shape
    `providerIsConfigured` had before this story taught it about `custom`. It
    gates `/api/query/stream`, Chat, ingest, lint, vision, search, merge,
    reconcile and the "Test connection" button, so an owner who configured
    Custom saw `getEffectiveProvider().configured === true` while every one of
    those refused with "No LLM provider is configured." `providerIsConfigured` is
    now exported and called rather than restated, and the branch is additive: no
    existing provider's answer moves. Pinned by a test asserting both halves are
    required.
  - `[medium]` `[patch]` **`getEffectiveProvider()` reported the literal string
    `"custom"` as the active model.** `DEFAULT_MODELS.custom` is absent on
    purpose, and this function's `?? provider` fallback resolved the provider
    name as a model name — the trap `getResolvedCredentials` was already guarded
    against and `getEffectiveSettings` never had. `/api/status`, the `PUT`
    response's `effective` block and the workload resolvers' inheritance rung all
    read it, so `getChatModelSettings()` handed `"custom"` to Epics 2/3 as an
    inherited model. It resolves `null` for `custom` now, pinned at both the
    provider and the workload resolver.
  - `[medium]` `[patch]` **The narrow-viewport layout rule lost to the desktop
    one by source order.** `@media (max-width: 899px)` stacks the shell into one
    column for `.wb-shell[data-collapsed="true"][data-settings="true"]`, but the
    identical selector reappeared later, unscoped, with the three-column desktop
    template. Specificity is a tie (0,3,0 each — a media query adds none), so the
    later rule won and a collapsed shell with Settings open kept three desktop
    columns below 900px. The comment claiming source order was not doing the work
    had it backwards. The desktop template is now inside `@media (min-width:
    900px)`; the `display` rules, which are width-independent, stay as they were.
    A new assertion walks every column template for that selector and requires
    each to sit inside one of the two complementary width queries.
  - `[medium]` `[patch]` **The vector gate's env-key leg was not per vendor.**
    `hasEnvEmbeddingApiKey` was one boolean over `OPENAI_API_KEY ||
    GOOGLE_GENERATIVE_AI_API_KEY`, while `embeddingApiKeyFor` resolves strictly
    per provider — so a deployment carrying only an OpenAI key could enable
    vector search for a Google selection and embed nothing. The payload now
    serves `envEmbeddingApiKeyProviders: string[]`, and both feeders
    (`mergedVectorInputs`, `draftVectorInputs`) count an env credential only for
    the provider it belongs to. Pinned by a test that refuses the Google
    selection and accepts the OpenAI one from the same environment.
  - `[medium]` `[patch]` **The environment's embedding overrides were invisible
    on the surface.** `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` win at runtime and
    a save cannot move them, yet the surface rendered an empty model box beside a
    vector switch that was somehow already satisfied — so typing a model, saving
    successfully, and changing nothing was the expected experience. Two copy
    functions (`settingsEnvOverrideCopy`, `settingsEnvKeyCopy`) now say which
    variable is set, to what, and that the stored value applies once it is unset.
    The boxes stay editable, because the store IS what applies then.
  - `[low]` `[patch]` **`??` chains admitted a set-but-empty env var.**
    `LLM_CUSTOM_API_KEY=""` short-circuited to `""`, which `providerIsConfigured`
    and `hasCustomApiKey` read as a credential while `getModel()` refused it as
    missing; `LLM_CUSTOM_BASE_URL=""` and `FIRECRAWL_API_KEY=""` masked stored
    values the same way. All three go through `nonEmpty` now — the discipline the
    sibling docblock in the same file already spelled out.
  - `[low]` `[patch]` **`getEffectiveSettings()` attributed a STORED custom key
    to the environment.** `apiKeyForProvider("custom")` gained a store fallback in
    this story, but the caller still labelled anything it returned
    `apiKeySource: "env"`, so the legacy page's source badge pointed the owner at
    a variable nobody had set. It reports `"config"` when the key came from the
    store.
  - `[low]` `[patch]` **`workers-ai` rendered as a raw slug in the Embeddings
    picker.** It embeds but does not generate, so it is absent from
    `PROVIDER_INFO` and `providerLabel` fell through to the slug — "OpenAI",
    "Google", "Ollama (self-hosted)", `workers-ai`. Adding it to the LLM list to
    get a label would offer it as a generation provider it cannot be, so
    `embeddingProviderLabel` carries the one extra name.
  - `[low]` `[patch]` **`hasEmbeddingApiKey` conflated an env key with a stored
    one**, so `Remove` was offered for a key the route cannot delete and the
    sentence did not change afterwards. The payload field is the STORED key only
    now; the env side is `envEmbeddingApiKeyProviders`, which is also what the
    gate reads. (The same split for `hasCustomApiKey` / `hasFirecrawlApiKey`
    remains a deferred entry from the previous pass.)
  - `[low]` `[patch]` **`draftRef.current` was assigned during render.** A render
    React discards — StrictMode's double invocation, or a concurrent render that
    never commits — would leave the ref holding a draft the screen never showed.
    It syncs in an effect now; `save` runs from a click, always after that commit.
  - `[low]` `[patch]` **Two of the three hint patterns were not programmatically
    associated with their controls.** `textRow` and the vector checkbox wired
    `aria-describedby`; `secretRow`'s "A key is stored." and `providerRow`'s
    inheritance sentence were bare spans — and for a password field showing
    nothing, that hint IS the state. Both are described now, and the test counts
    hint spans against identified ones so a fourth builder cannot skip it.
  - `[low]` `[patch]` **Three env vars this story reads were undocumented.**
    `LLM_CUSTOM_BASE_URL`, `LLM_CUSTOM_API_KEY` and `FIRECRAWL_API_KEY` appeared
    in neither `.env.example` nor anywhere else, and the embedding vars had no
    entry explaining that they win over the surface. `.env.example` gained three
    blocks saying which half is required, which provider is keyless, and which
    values a save cannot move.
  - `[low]` `[patch]` Housekeeping: a docblock in `config.ts` sat above the wrong
    function (it described `envEmbeddingKeyPresent` while introducing
    `envEmbeddingProvider`, leaving the function it documented undocumented); the
    test file imported `fs/promises` twice under two specifiers; a stray double
    blank line preceded the Drag-resize section in `globals.css`.

### 2026-08-16 — Review pass (follow-up 2)

- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 3: (high 0, medium 1, low 2)
- reject: 22: (high 0, medium 5, low 17)
- addressed_findings:
  - `[medium]` `[patch]` **`embeddingApiKeyFor` used `??`, so a set-but-empty
    `OPENAI_API_KEY=` masked the key the owner had just stored — and the vector
    gate disagreed about it.** The stored fallback this story added short-circuited
    to `""`, which `resolveEmbeddingProvider`'s override branch reads as no
    credential: `hasEmbeddingSupport()` went false and `getEmbeddingModel()`
    returned null, while `config.ts`'s `getVectorSearchSettings()` — which reads
    the same two env vars through its own `nonEmpty` — went on reporting the
    switch as ON. A blank placeholder line in a `.env` is the ordinary shape of
    this, and the identical trap on the LLM side was already fixed with
    `nonEmpty` in the previous pass. Both legs and the stored value now go through
    a local trim-and-null. Pinned by two tests, one asserting the gate and
    `hasEmbeddingSupport()` now answer the same thing.
  - `[medium]` `[patch]` **The configured LLM timeout reached only three of the
    repo's six SDK call sites.** `timeoutOption()` lived inside `llm.ts` and was
    spread into `callLLM`, `callVisionLLM` and `callLLMStream`, but
    `structured-knowledge.ts:312`, `action-extractor.ts:45` and
    `source-monitors.ts:389` call `generateText` directly and passed no
    `abortSignal` — so an owner who set "LLM timeout (seconds)" got a deadline on
    half their LLM work and no deadline on Structured Knowledge extraction,
    action extraction or monitor revision. The helper moved to `config.ts` beside
    `getLlmTimeoutMs` as `llmTimeoutOption()` (it is a pure function of the
    config, and `llm.ts` is not the only door) and is now spread at all six
    sites, inside the retry thunk wherever there is one. Additive: unset still
    omits the key entirely, which is why no existing test moved. `llm.ts` could
    not be the home — `structured-knowledge.test.ts` mocks `../llm` wholesale and
    is a pre-existing file this story may not edit.
  - `[low]` `[patch]` **`llmTimeoutSeconds: ""` was accepted and then ignored,
    answering 200 for a request that changed nothing.** The validator skipped `""`
    alongside `null`, but `applyWorkbenchSettings` only acts on a number or
    `null` — and its own comment claims "a string never reaches here". `""` is
    refused with the other non-numbers now; `null` remains the one way to clear
    the deadline, and it is what `settingsSaveBody` sends for an emptied box.
  - `[low]` `[patch]` **The landed-save confirmation was screen-reader-only.**
    `<p className="wb-sr-only" aria-live="polite">` meant a sighted owner's only
    evidence that a save worked was the Save button going disabled — an absence,
    not the "polite status line" the I/O matrix's success row describes. The live
    region moved into the save bar as a visible `.wb-set-status` span, same muted
    tone as the standing note (colour means state in this shell), still `polite`.
  - `[low]` `[patch]` **`.env.example`'s vector-search paragraph described a gate
    that does not exist.** It said vector search is off "until an embedding
    provider, a model and (for OpenAI and Google) a key are all present" —
    omitting the ENDPOINT leg `canEnableVectorSearch` actually requires, and
    implying a deployment can turn the switch on from the environment when no env
    var sets either the endpoint or the flag. Rewritten to name all four legs, to
    say the switch itself lives on the surface, to note that the env key is
    counted per vendor, and that a set-but-empty value counts as unset.

## Design Notes

**Why the new fields ride under one `workbench` key.** `EffectiveSettings` is reproduced as a whole-object fixture in `settings-route.test.ts:47-66` and duplicated by hand in `useSettings.ts:12-29`. Widening it would force edits to a pre-existing test and to the legacy page's own type for fields neither of them uses. One nested object keeps the legacy contract frozen, gives Story 1.9's surface a type of its own, and still leaves exactly one route and one stored JSON:

```ts
// GET /api/settings  →  { ...EffectiveSettings, workbench: WorkbenchSettingsPayload }
// PUT /api/settings  ←  { provider?, model?, …legacy…, workbench?: WorkbenchSettingsPatch }
```

**Why the secret draft has three states.** A password input that shows nothing cannot tell "leave it alone" from "delete it", and a save that quietly cleared a key the owner never touched would be the worst outcome on this surface. So `SettingsDraft`'s secret fields are `string | null`: `""` = untouched (omitted from the body), a string = replace, `null` = the owner pressed Remove (sent as `null`, which the merge deletes). `settingsSaveBody` is where that lives, and it is a pure function the suite executes.

**Why vector-off is a predicate, not a checkbox.**

```ts
export function canEnableVectorSearch(v: {
  baseUrl: string | null; model: string | null; hasKey: boolean;
}): boolean {
  return Boolean(v.baseUrl && v.model && v.hasKey);
}
```

The client disables the control with it; the route re-runs it over the merged config before writing. Two callers, one rule — and because the store's default is `false`, "vector search defaults off" is a property of the kernel, not of a component that happens to render unchecked. What this story deliberately does NOT do is teach `hasEmbeddingSupport()` about it: Story 2.9 owns the ingest embed step and Story 3.4 the search merge, and moving those here would rewrite `embeddings.test.ts` on behalf of two unwritten stories.

**Why the timeout defaults to unset.** Nothing in `llm.ts` aborts today. Introducing a default deadline would newly kill long Ingest and vision calls that currently succeed, which is a behaviour change no acceptance criterion asks for. Unset means today's behaviour exactly; a configured 5–3600 seconds is applied per attempt inside `retryWithBackoff`, so a retry gets a fresh deadline rather than inheriting an already-expired one.

## Verification

**Commands:**
- `npx vitest run` -- expected: green. Baseline is 205 files / 4,220 tests; this story adds one file.
- `npx tsc --noEmit` -- expected: exit 0.
- `npx eslint` -- expected: no errors (the pre-existing `jsx-ast-utils` TSNonNullExpression notices are not errors).
- `git status --porcelain src/lib/__tests__` -- expected: exactly two entries — the untracked `workbench-settings.test.ts` and the modified `workbench-chrome.test.ts`.
- `grep -rn "/api/settings" src/components src/lib/workbench-settings.ts` -- expected: only `workbench-settings.ts`'s route constant and the legacy `useSettings` hook; no literal URL inside a Workbench component.
- `grep -rn "customApiKey\|embeddingApiKey\|firecrawlApiKey" src --include=*.tsx` -- expected: no hit outside the settings draft/field names in `SettingsCanvas.tsx`; no key value is ever rendered.
- `grep -rn "useRouter\|router.refresh\|next/link" src/components/workbench` -- expected: `WikiSwitcher.tsx` and `DataVersionWatcher.tsx` only.
- `grep -rn "Georgia\|[^-]serif" src/components/workbench` -- expected: only `sans-serif` matches.
- `grep -rn "localStorage\|writeStored" src/components/workbench/SettingsCanvas.tsx src/components/workbench/SettingsNav.tsx` -- expected: no match.

**Manual checks (if no CLI):**
- Inspect the GET handler's response construction: the `workbench` object must be built by `getWorkbenchSettings()` and must contain no field whose value is a stored key.
- Inspect `SettingsCanvas.tsx` for a second `fetch(` or any write outside `save` — there must be neither.



## Auto Run Result

Status: done
Blocking condition: none

### Summary of implemented change

This run was a follow-up review pass over the already-implemented Story 1.9
(the spec arrived at `status: done` with `followup_review_recommended: true`).
No code was re-derived: four review layers ran over the full diff since
`2b898327e529d225a85b185e7db7f5c2666bbbd7`, and five findings were patched in
place. Two of them are real behaviour fixes — an empty provider env var no
longer masks the stored embedding key (and the vector gate and
`hasEmbeddingSupport()` no longer disagree about it), and the configured LLM
timeout now reaches every SDK call site in the repo instead of only the three
inside `llm.ts`. Three are smaller: an empty-string timeout is refused rather
than silently ignored, the landed-save confirmation is visible as well as
announced, and `.env.example` now describes the vector gate that exists.

### Files changed in this pass

- `src/lib/embeddings.ts` — `embeddingApiKeyFor` goes through a local
  trim-and-null instead of `??`, so a set-but-empty `OPENAI_API_KEY` /
  `GOOGLE_GENERATIVE_AI_API_KEY` cannot mask a stored key.
- `src/lib/config.ts` — new `llmTimeoutOption()` beside `getLlmTimeoutMs()`: the
  per-attempt deadline as the SDK's own option, in the module every LLM call
  site can reach.
- `src/lib/llm.ts` — the local `timeoutOption` is gone; the three spread sites
  call the shared `llmTimeoutOption()`.
- `src/lib/structured-knowledge.ts`, `src/lib/action-extractor.ts`,
  `src/lib/source-monitors.ts` — each spreads `llmTimeoutOption()` into its
  direct `generateText` call, inside the retry thunk where there is one.
- `src/lib/workbench-settings.ts` — `validateWorkbenchSettingsPatch` refuses
  `llmTimeoutSeconds: ""` with the other non-numbers.
- `src/components/workbench/SettingsCanvas.tsx` — the polite live region moved
  into the save bar as a visible `.wb-set-status` span.
- `src/app/globals.css` — `.wb-set-status` rule (muted, token-only).
- `.env.example` — the embeddings/vector block now names all four gate legs, says
  the switch itself lives on the surface, and notes the per-vendor env key and
  the set-but-empty rule.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` — three new tests: the
  empty-env-var mask for OpenAI and for Google, and that the shared deadline is
  fresh per call and is spread at the three direct SDK sites.
- `src/lib/__tests__/workbench-settings.test.ts` — `""` added to the refused
  timeout values.

Only test files this story itself created were modified; no pre-existing test
file was touched in this pass.

### Review findings breakdown

- Patches applied: 5 (high 0, medium 2, low 3)
- Items deferred: 3 (high 0, medium 1, low 2) — the `LLM_CUSTOM_BASE_URL` env
  override being invisible on the surface, the single `embeddingBaseUrl` shared
  across embedding vendors, and a `workers-ai` model outside the `@cf/` namespace
  passing the vector gate before being discarded at resolution.
- Items rejected: 22 (high 0, medium 5, low 17) — chiefly findings already
  recorded in the deferred ledger (the legacy `/settings` picker now offering
  `Custom`, the `g s` shortcut, the env-vs-store split for `hasCustomApiKey` /
  `hasFirecrawlApiKey`, save-in-flight edits), deliberate logged decisions (the
  muted refusal tone, `vectorSearchEnabled` validated over the merge, the
  `draftRef` sync effect), and things the intent explicitly assigns elsewhere
  (`hasLLMKey()` and the per-workload providers Epics 2/3 own, retiring the
  legacy route). A save-timeout re-read was rejected because it would add the
  second `fetch(` this spec's verification forbids, and the `PUT` is idempotent.

### Follow-up review recommendation

`true`. Patched this pass: high 0, medium 2, low 3 → score = 3 × 2 + 1 × 3 = 9,
which is ≥ 5. No patched finding was high severity.

### Verification performed

- `npx vitest run` — 207 files / 4,326 tests, all passing (baseline for this run
  was 207 / 4,323; the three new tests are the difference).
- `npx tsc --noEmit` — exit 0.
- `npx eslint` — no errors (only the pre-existing `jsx-ast-utils`
  TSNonNullExpression notices).
- `git status --porcelain src/lib/__tests__` — exactly the two story-created test
  files.
- The spec's grep checks all match their stated expectations: `/api/settings`
  appears only in `workbench-settings.ts`; no key value is rendered in any
  `.tsx`; `useRouter` / `next/link` under `src/components/workbench` is
  `WikiSwitcher` and `DataVersionWatcher` only; no serif; no `localStorage` in
  either new component.
- Manual: the GET body is still built by `getWorkbenchSettings()` and carries no
  stored key; `SettingsCanvas.tsx` still has exactly one `fetch(`-driven save.

### Residual risks

- The timeout now bounds three more code paths. It is unset by default, so no
  existing deployment changes; a deployment that HAS set one will newly see
  Structured Knowledge extraction, action extraction and monitor revision abort
  at that deadline. That is the setting doing what it says, but it is a wider
  blast radius than the previous pass had.
- A fired deadline still surfaces the SDK's own `TimeoutError` wording rather
  than a sentence of this repo's own — that remains a deferred entry, and the
  wider reach makes it reachable from three more places.
- The thirteen deferred entries stay open; four of them (the legacy page's
  `Custom` option, the `g s` shortcut, the two-writer lost update, and the
  env-vs-store split for two of the three secrets) are the ones an owner is most
  likely to meet.
