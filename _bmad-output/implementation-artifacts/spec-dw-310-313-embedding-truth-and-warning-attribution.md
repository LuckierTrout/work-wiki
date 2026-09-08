---
title: 'Embedding diagnostics say what is true and say it once (DW-310, DW-311, DW-312, DW-313)'
type: 'bugfix'
created: '2026-08-20'
status: 'done'
baseline_revision: '24693ea46d271d8ad4dd30b0cc21815b0dfcc4d1'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      The `drift:<active model>` key is never re-armed, so a corpus that is
      rebuilt and then drifts again under the same active model is silent for
      the rest of the process.
    evidence: |-
      `warnedMisconfigurations` is documented as never clearing, on the argument
      that "a restart (or a new isolate) already fixes" the case. That holds for
      the three env/binding misconfigurations it was written for, but not for
      drift: drift is fixed by REBUILDING THE CORPUS, which happens in the same
      process. `searchByVector` already holds the counter-signal that proves the
      drift is over — `kept.length > 0` — and could delete the key there. The
      intent said only "bring it under the same throttle", and the module's
      recorded trade-off argues the other way, so whether drift should be the
      one identity that re-arms is a decision neither contains.
    location: src/lib/embeddings.ts (searchByVector, warnedMisconfigurations)
    severity: medium
  - summary: >-
      A whitespace-only `EMBEDDING_PROVIDER` is truthy, shadows a valid stored
      provider, and is now attributed to the environment while quoting a blank
      string.
    evidence: |-
      `resolveEmbeddingProvider` reads `process.env.EMBEDDING_PROVIDER ??
      cfg.embeddingProvider` with no `nonEmpty`, so `EMBEDDING_PROVIDER="   "`
      is truthy, wins over the store, fails `isEmbeddingProvider`, and warns
      `EMBEDDING_PROVIDER="   " is not embedding-capable`. Pre-existing and
      untouched here — this story's Boundaries forbade changing which value wins
      — but DW-311 made the sentence attribute it, so the blank now reads as a
      deliberate env choice. Every sibling reader of the model key
      (`resolveEmbeddingModelName`, `getVectorSearchSettings`,
      `embeddingModelAnswer`) goes through `nonEmpty`; this leg does not, and
      fixing it moves a resolution boundary.
    location: src/lib/embeddings.ts:resolveEmbeddingProvider
    severity: low
  - summary: >-
      `getEffectiveSettings` still re-enters the 5 s config cache on its
      non-embedding legs, so only the embedding half of its answer is
      snapshot-consistent.
    evidence: |-
      After DW-313 the embedding legs all resolve against the `cfg` read at the
      top of the function, but `getStructuredKnowledgeModelSettings()`,
      `apiKeyForProvider`'s `custom` branch and `getCustomBaseUrl()` each call
      `loadConfigSync()` themselves. The intent's sentence — "give
      `getEffectiveSettings` one config snapshot" — reads broader than the
      ledger entry it came from, which names only `getEmbeddingModelName` and
      `hasEmbeddingSupport`. Closing the rest means `cfg`-taking doors on three
      more resolvers, which is a distinct piece of work from the one DW-313
      described.
    location: src/lib/config.ts:getEffectiveSettings
    severity: low
  - summary: >-
      `settings-vector-namespace.test.tsx`'s default fixture encodes a config
      whose real payload would carry the substitution note, so several
      exact-equality announcements pin a state the wire cannot produce.
    evidence: |-
      The fixture is `embeddingProvider: "workers-ai"` with `embeddingModel:
      "text-embedding-3-small"` and `embeddingModelOverridden: false,
      embeddingModelInEffect: null`. For that config `embeddingModelAnswer`
      returns `overridden: true, inEffect: "@cf/baai/bge-m3"`, so the real GET
      body would carry a third sentence on the model row. The pre-existing cases
      assert the announced string with `toBe`, and they are about the vector
      gate rather than the substitution, so the simplification is deliberate and
      documented in the fixture comment — but it means those assertions describe
      a payload the server never serves. Making the fixture faithful would
      repin every one of them.
    location: src/components/workbench/__tests__/settings-vector-namespace.test.tsx
    severity: low
  - summary: >-
      The substitution sentence exists as two hand-maintained twins — the flat
      page's JSX and the canvas's copy function — with nothing pinning that they
      keep saying the same thing.
    evidence: |-
      `EmbeddingSettings.tsx` renders "Not in effect. This deployment embeds
      with <mono/> — the embedding provider cannot serve the model above, …"
      while `settingsModelSubstitutedCopy` returns the same sentence with "the
      model that is set". The divergence is deliberate and argued (the canvas
      box is empty whenever `EMBEDDING_MODEL` owns the value, so it cannot point
      at a control), and both are separately tested — but a wording fix to one
      leaves the other stale with no failing test. DW-312 asked for the two
      surfaces to answer the same question; they now agree on the VALUES,
      through `embeddingModelAnswer`, and nothing holds the two sentences
      together.
    location: >-
      src/components/EmbeddingSettings.tsx with
      src/lib/workbench-settings.ts:settingsModelSubstitutedCopy
    severity: low
  - summary: >-
      The canvas substitution note is payload-derived while the two sentences
      beside it are draft-derived, so mid-edit the row can describe pre-edit
      server state.
    evidence: |-
      `modelSubstitution` reads `stored.embeddingModelOverridden` /
      `stored.embeddingModelInEffect`, while the env sentence and
      `vectorModelIssue` on the same row come from `values`. An owner who
      corrects the model in the box still reads "Not in effect. This deployment
      embeds with …" until a PUT lands. This is unavoidable without the server —
      the rule runs over the env and the store together — and it is documented
      in code and in DEPLOY.md ("re-reads it on save"), but the same row now
      mixes two freshness contracts and no test mounts the edit-then-read path.
      Whether the note should be suppressed while the model or provider field is
      dirty is a decision the intent does not contain.
    location: src/components/workbench/SettingsCanvas.tsx (modelSubstitution)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Four gaps leave the embedding diagnostics either repeating themselves, misattributing blame, or answering the same question two ways. `searchByVector`'s model-drift breadcrumb is standing state logged through a bare `logger.warn` on a per-search-query door, so a drifted corpus emits it for every query (DW-310). The non-embedding-capable override warning hardcodes `EMBEDDING_PROVIDER="…"` even when the value came from Settings — and since DW-273 it is said exactly once, so that one line may be the only thing the owner ever reads (DW-311). The Workbench Settings canvas builds its embedding-model row from `getWorkbenchSettings`, which never carries `embeddingModelInEffect`/`embeddingModelOverridden`, so the two Settings surfaces answer the DW-274 question differently (DW-312). And `getEffectiveSettings` reads the 5 s-TTL config cache three times, so its "what is set" and "what is in effect" halves can in principle describe different snapshots (DW-313).

**Approach:** Bring the drift breadcrumb under `warnOnceAbout`, keyed on the drifted identity rather than the per-query match count. Name the actual source (env or stored) in the provider-override warning and key on it. Thread the two effective embedding-model fields into the workbench payload and render the substitution on the canvas's model row. Give `getEmbeddingModelName` and `hasEmbeddingSupport` optional `cfg`-taking doors so `getEffectiveSettings` and `getWorkbenchSettings` resolve both halves against the one snapshot they already hold.

## Boundaries & Constraints

**Always:**
- `warnOnceAbout` keys carry the misconfiguration's IDENTITY, not its call site: a CHANGED misconfiguration is a new key and speaks again. The drift key is the active model name; the provider-override key is the source plus the rejected string.
- The drift sentence stops embedding the per-query `matches.length` — a count is why the line was "not literally the same each time", and keying on the count would defeat the throttle.
- `runWorkersAiEmbedding`'s unexpected-response-shape line stays UNGUARDED: it reports a per-call event, not standing state.
- Provider-override resolution is UNCHANGED — `process.env.EMBEDDING_PROVIDER ?? cfg.embeddingProvider`, env still wins, and an empty env value still falls through the falsy check exactly as today. Only the SENTENCE and the KEY learn where the value came from.
- The `cfg`-taking parameter is OPTIONAL and defaults to `loadConfigSync()`, so every existing caller of `getEmbeddingModelName`/`hasEmbeddingSupport` is untouched and behaviour outside the two settings resolvers is byte-identical.
- `getEffectiveSettings` and `getWorkbenchSettings` derive `embeddingModelInEffect`/`embeddingModelOverridden` through ONE shared helper in `config.ts`, not two expressions that agree today.
- `workbench-settings.ts` stays client-safe: it may gain payload FIELDS, guard clauses and copy, but imports nothing from `embeddings.ts`, `config.ts` or any Node builtin.
- On the canvas the substitution is DESCRIBED, never MARKED: no `aria-invalid`, no `disabled`, no blocked save. It rides on the Embedding model row's own `aria-describedby`, composed with the row's existing parts.
- NO KEY IS EVER IN THE PAYLOAD. The two new fields are model names and a boolean.

**Block If:** naming the override's source would require changing which value wins at runtime.

**Never:**
- Do not change `resolveEmbeddingProvider`'s priority order, the auto-detect legs, or `embeddingModelMatchesProvider`.
- Do not replace `/settings`'s JSX override note with the canvas's plain-string copy, and do not change `EmbeddingSettings.tsx`'s wording or props.
- Do not lock the canvas's Embedding model box to a forced value — that is a `/settings` behaviour and DEPLOY.md says so.
- Do not clear or re-arm `warnedMisconfigurations` when a misconfiguration goes away; that trade-off is already recorded and stays.
- Do not widen `EffectiveSettings`, `useSettings`'s duplicated type, or the flat legacy wire shape.
- Do not delete any test to accommodate the change.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Drifted corpus, many queries | store returns hits, model filter drops all, active model constant | ONE `embeddings` warning naming the active model; every query still returns `[]` | No error expected |
| Drift, then the active model changes and still drifts | active model `a` then `b`, both dropping all hits | TWO warnings, one per active model | No error expected |
| Some matches kept | store returns hits, at least one survives the filter | NO drift warning; kept hits returned | No error expected |
| Store returns nothing | `queryEmbeddings` → `[]` | NO drift warning, `[]` returned | No error expected |
| Bad override from ENV | `EMBEDDING_PROVIDER=deepseek` | one warning naming `EMBEDDING_PROVIDER="deepseek"` and telling the owner to unset it; embeddings disabled | Returns `null`, no fall-through |
| Bad override from STORE | `cfg.embeddingProvider = "deepseek"`, env unset | one warning naming the STORED embedding provider and pointing at Settings — no `EMBEDDING_PROVIDER=` and no "unset"; embeddings disabled | Returns `null`, no fall-through |
| Same bad value, both sources in turn | stored `deepseek`, then `EMBEDDING_PROVIDER=deepseek` | TWO warnings — the source is part of the identity | Returns `null` both times |
| Canvas, stored model the provider cannot serve | payload `embeddingModelOverridden: true`, `embeddingModelInEffect: "@cf/baai/bge-m3"` | the Embedding model row announces the substitution naming the in-effect model, beside whatever else the row already says; box not marked invalid by the note | No error expected |
| Canvas, auto-detected provider, substitution running | provider unset in the draft (vector gate produces only the provider leg) | the substitution note still appears on the model row — this is the state the canvas said nothing about before | No error expected |
| Canvas, nothing overridden | `embeddingModelOverridden: false` | the row renders exactly as before: no note, no extra description | No error expected |
| Canvas, half-wired payload | `embeddingModelOverridden: true`, `embeddingModelInEffect: null` | no note — a sentence with a hole where the model name goes is worse than no sentence | No error expected |
| Payload shape guard | `workbench` body missing the two fields, or `embeddingModelOverridden` non-boolean | `isWorkbenchSettingsPayload` returns `false` | Canvas shows its failed-read sentence |
| `getEffectiveSettings` on a cold cache | `loadConfigSync()` returns `{}` | both halves resolve against that same `{}`; no "set but not in effect" note about a substitution that is not happening | No error expected |

</intent-contract>

## Code Map

- `src/lib/embeddings.ts:26-58` -- the `warnedMisconfigurations` doc block. `:55-58` states that `searchByVector`'s breadcrumb is "left UNGUARDED on purpose and should stay that way" — DW-310 falsifies exactly half of that paragraph; the `runWorkersAiEmbedding` half stays.
- `src/lib/embeddings.ts:59-66` -- `warnedMisconfigurations` and `warnOnceAbout(key, message)`. Unchanged; the drift breadcrumb becomes its fourth caller.
- `src/lib/embeddings.ts:69-79` -- `_resetEmbeddingWarnings()`, already wired into `embeddings.test.ts`'s top-level `beforeEach` (`:126`) and `settings-runtime-wiring.test.ts:732`. The new drift key resets with it — no test wiring needed.
- `src/lib/embeddings.ts:148-186` -- `resolveEmbeddingProvider(cfg)`. `:150` `const override = process.env.EMBEDDING_PROVIDER ?? cfg.embeddingProvider`; the refusal warning at `:155-163` with key `provider-override:${override}`; `embeddingApiKeyFor(override)` at `:169` and `embeddingApiKeyFor(cfg.provider)` at `:177` are the re-entries DW-313 closes.
- `src/lib/embeddings.ts:210-220` -- `embeddingApiKeyFor(provider)`; `:211` `loadConfigSync().embeddingApiKey` is the only config read in it. Third call site: `:328` inside `getEmbeddingModel`, which already holds a `cfg`.
- `src/lib/embeddings.ts:303-309` -- `getEmbeddingModelName()`; `:372-376` -- `hasEmbeddingSupport()`. These are DW-313's two doors.
- `src/lib/embeddings.ts:656-686` -- `searchByVector`. `currentModel` at `:662`; the bare `logger.warn` at `:670-676` with `matches.length` in the sentence.
- `src/lib/config.ts:2` -- already imports `getEmbeddingModelName, hasEmbeddingSupport` from `./embeddings`, so DW-312/DW-313 add no new edge to the import graph.
- `src/lib/config.ts:82` `SettingSource`; `:96-116` the `embeddingModel*` fields of `EffectiveSettings` including the two DW-274 fields and their doc comments — the source of truth for the shared helper's wording.
- `src/lib/config.ts:250-252` -- `getEmbeddingModelOverride()` (`nonEmpty(process.env.EMBEDDING_MODEL)`), the accessor both halves must keep using.
- `src/lib/config.ts:558-578` -- `loadConfigSync()` and `CACHE_TTL_MS = 5_000`; `:571-577` is the cold-cache `{}` branch DW-313 is about.
- `src/lib/config.ts:1008-1051` -- `getWorkbenchSettings(hasWorkersAiBinding)`. It already opens with `const cfg = loadConfigSync()`; the return object is where the two new fields go.
- `src/lib/config.ts:1153-1303` -- `getEffectiveSettings()`. `:1156` `const cfg = loadConfigSync()`; `:1235-1250` the set/source pair; `:1252-1278` the DW-274 block whose comment must survive the move into the shared helper; `:1285` `embeddingSupport: hasEmbeddingSupport()`.
- `src/lib/workbench-settings.ts:189-262` -- the copy block (`SETTINGS_VECTOR_PROVIDER_COPY`, `SETTINGS_VECTOR_ENV_MODEL_NOTE`, `settingsEnvOverrideCopy`, `settingsEnvKeyCopy`). The new substitution copy belongs here.
- `src/lib/workbench-settings.ts:294-381` -- `WorkbenchSettingsPayload`; `:334-345` the stored embedding fields, `:346-360` the env fields. `:391` `WorkbenchSettingsValues = Omit<…, "version">` is what `getWorkbenchSettings` returns.
- `src/lib/workbench-settings.ts:436-480` -- `isWorkbenchSettingsPayload`; `:460-465` the `nullableString` list, `:468-476` the required booleans with the comment explaining why `hasWorkersAiBinding` has no safe default.
- `src/lib/workbench-settings.ts:882-928` -- `vectorSearchFieldIssue`. Read-only here: the gate complaint and the substitution note are different facts and both may ride on the model row.
- `src/components/workbench/SettingsCanvas.tsx:231` -- `const stored: WorkbenchSettingsPayload = payload`; `:302-306` `describedBy`; `:314-357` `textRow(key, label, hint?, invalid?)` — the hint is a plain string, so the note joins the existing `.filter(...).join(" ")`.
- `src/components/workbench/SettingsCanvas.tsx:553-573` -- the Embedding model row: the comment block stating the current two-part order, and the `[envSentence, vectorModelIssue?.copy]` composition.
- `src/components/EmbeddingSettings.tsx:12-26, 38, 59, 107-117` -- the `/settings` sibling: props, `OVERRIDE_NOTE_ID`, `showOverrideNote = overridden && modelInEffect !== null` (the guard the canvas mirrors), and the JSX note. READ-ONLY — do not edit.
- `src/app/api/settings/route.ts:94-108` and `:465-480` -- the two `getWorkbenchSettings(hasWorkersAiBinding)` call sites. The `PUT` one runs after `saveConfig` re-primes the cache, so a landed save re-seeds the note from fresh state. No change needed.
- `src/lib/__tests__/embeddings.test.ts:110-137` (env reset + `_resetEmbeddingWarnings`), `:154-169` `withWarnSpy`, `:661-755` the `searchByVector` suite (`:723-737` is the all-dropped case, currently asserting only `[]`), `:1551-1700` the `misconfiguration warnings are said once` suite — the model for the new DW-310/DW-311 cases.
- `src/lib/__tests__/workbench-settings.test.ts:250-280` `emptyPayload()`; `:1195` a hand-written full payload literal; `:2592-2620` the `isWorkbenchSettingsPayload` field cases; `:3700-3736` the SettingsCanvas source-shape guard.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx:35-62` `payload()`; `:302-345` the model-row description cases, two of which use exact `toBe` equality on the announced string and so pin that the note is ABSENT for `overridden: false`.
- `src/components/workbench/__tests__/settings-read-only.test.tsx:38-66` `payload()`.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:640-700, 780-808` -- the `getWorkbenchSettings(false)` payload assertions and the env-origin route wiring.
- `DEPLOY.md:220-247` -- the substitution-warning section (the quoted sentence, the `LOG_LEVEL` caveat, "It is said once, not once per embed"). `:249-290` -- "the flat `/settings` page answers directly", the three-states paragraph, and "This is a `/settings` behaviour and not a general one. The **Workbench** Settings canvas deliberately does the opposite" — that last claim is about the LOCKED BOX and must survive, but the note's `/settings`-only framing is falsified by DW-312.

## Tasks & Acceptance

**Execution:**
- `src/lib/embeddings.ts` -- put `searchByVector`'s drift breadcrumb under `warnOnceAbout`, keyed `drift:<active model>`, and drop `matches.length` from the sentence so the line is one fixed sentence per drifted identity (DW-310). Rewrite the `warnedMisconfigurations` doc block's last paragraph so only `runWorkersAiEmbedding`'s response-shape line is named as deliberately unguarded, and say why standing drift belongs with the other three.
- `src/lib/embeddings.ts` -- in `resolveEmbeddingProvider`, capture whether the override came from `EMBEDDING_PROVIDER` or from the store WITHOUT changing which one wins, and make the refusal name that source: the env wording stays exactly as today, the stored wording names the stored embedding provider and points at Settings instead of telling the owner to unset a variable they never set. Fold the source into the warn key so the same bad value arriving from the other source is a new identity (DW-311).
- `src/lib/embeddings.ts` -- give `getEmbeddingModelName` and `hasEmbeddingSupport` an OPTIONAL `cfg` parameter defaulting to `loadConfigSync()`, and thread the snapshot through the private path those doors traverse: `embeddingApiKeyFor` takes the `cfg` its callers already hold instead of re-entering the cache (DW-313). Document on both doors what passing a `cfg` buys.
- `src/lib/config.ts` -- add one private helper that derives the embedding-model answer (what is set, its source, what is in effect, whether it is being substituted) from a given `cfg`, calling `getEmbeddingModelName(cfg)`; move the DW-227/DW-274 reasoning comments onto it intact. Have `getEffectiveSettings` use it and pass its own `cfg` to `hasEmbeddingSupport` as well, so every half of its answer describes one snapshot.
- `src/lib/config.ts` -- have `getWorkbenchSettings` return `embeddingModelInEffect`/`embeddingModelOverridden` from that same helper, using the `cfg` it already read (DW-312/DW-313).
- `src/lib/workbench-settings.ts` -- add the two fields to `WorkbenchSettingsPayload` with doc comments saying what each answers and that neither is editable; require them in `isWorkbenchSettingsPayload` on the same argument the `hasWorkersAiBinding` comment makes; add the canvas's substitution sentence as an exported copy function beside the other embedding copy, documenting why it is worded for the row it rides on rather than shared verbatim with `EmbeddingSettings.tsx`.
- `src/components/workbench/SettingsCanvas.tsx` -- compose the substitution note into the Embedding model row's hint, guarded on BOTH payload fields the way the `/settings` sibling guards, and rewrite the row's order comment to state the three parts and why the note is described but not marked.
- `src/lib/__tests__/embeddings.test.ts` -- add cases for the I/O matrix's drift and override-source rows: repeated queries against a drifted corpus warn once; a changed active model warns again; a partial match and an empty store stay silent; a stored bad provider gets the stored sentence and an env bad provider gets the env sentence; the same value from both sources warns twice. Extend the existing all-dropped `searchByVector` case to assert the warning rather than only `[]`.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- pin that `getWorkbenchSettings` and `getEffectiveSettings` answer the substitution question identically for the same config, and add the cold-cache case DW-313 is about: with the cache empty, the set half and the in-effect half agree rather than reporting a substitution that is not happening.
- `src/lib/__tests__/workbench-settings.test.ts` -- extend `emptyPayload()` and the payload literal with the two new fields; add `isWorkbenchSettingsPayload` cases for both (absent → false, non-boolean flag → false, `null` in-effect model → true); repin the source-shape guard if the model row's part count is asserted there.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- extend the fixture, then add mounted cases for the canvas rows of the matrix: the note appears naming the in-effect model, it survives beside the env sentence and the gate complaint, it appears with no provider selected (where the gate produces no model complaint at all), it is absent when nothing is overridden, and it is withheld when the payload is half-wired.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- extend the fixture with the two fields.
- `DEPLOY.md` -- record that the substitution note now rides on BOTH Settings surfaces (keeping the locked-box distinction, which is unchanged); that the drift breadcrumb is throttled per drifted model the same way the substitution warning is; and that an unservable embedding provider taken from Settings is now named as stored rather than as `EMBEDDING_PROVIDER`.

**Acceptance Criteria:**
- Given a drifted corpus, when N searches run in one process, then the `embeddings` log holds exactly one drift line for that active model and it names no match count.
- Given `workbench-settings.ts` after the change, when its imports and exports are inspected, then it still imports nothing from `embeddings.ts`, `config.ts` or any Node builtin, and no payload field carries a stored key.
- Given the whole suite, when `npx tsc --noEmit`, `npm run lint` and `npm test` run, then all pass with no test deleted to accommodate the change.
- Given `getEffectiveSettings` and `getWorkbenchSettings` on the same config, when both are read, then they report the same in-effect model and the same overridden flag.

## Spec Change Log

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 1, low 6)
- defer: 6: (high 0, medium 1, low 5)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` `searchByVector` resolved the query embedding and the filter's model name from two separate config reads with a network round-trip between them, so crossing the 5 s TTL there embedded with one model and filtered against another — a false drift line that DW-310's throttle then made permanent, burning the `drift:<model>` key and silencing a later real drift under that name. `embedText`, `embedTexts` and `getEmbeddingModel` gained the same optional `cfg` door, `_createEmbeddingModel` takes the snapshot for its base-URL read, and `searchByVector` now passes ONE snapshot to both halves. Covered by a case that turns the cache over during `embed()`.
  - `[low]` `[patch]` `getEffectiveProvider` held a `cfg` and still called `hasEmbeddingSupport()` bare — the same re-entry DW-313 closes, on the sibling `ProviderInfo` served by `/api/status`, `POST /api/settings/test` and `PUT /api/settings`'s `effective`. Threaded, and `embeddingSupport` given its first assertion anywhere.
  - `[low]` `[patch]` Reverting all three DW-313 threading points left the whole suite green: the cold-cache test cannot catch it, because `loadConfigSync` re-primes `{data:{}, ts:now}` before returning, so a second read in the same tick is the same snapshot. Added pins in `embeddings.test.ts` where the PASSED snapshot disagrees with the mocked cache, across the provider, key and model legs, asserting the answer follows the argument and `loadConfigSync` is not called at all — plus that the bare default still follows the cache.
  - `[low]` `[patch]` The "appears with NO provider selected" canvas case set `embeddingModelOverridden: true` with `embeddingModelInEffect` equal to the fixture's `embeddingModel` — a payload `embeddingModelAnswer` cannot produce, since `overridden` requires the two to differ. Made coherent.
  - `[low]` `[patch]` The `settings-route.test.ts` mock comment asserted a call path that does not exist (`getWorkbenchSettings` reaching `hasEmbeddingSupport`; it reaches only `getEmbeddingModelName`, via `embeddingModelAnswer`). Corrected, with the defensive entry labelled as such.
  - `[low]` `[patch]` Five DEPLOY.md corrections caused by the change: the "grep for the `embeddings` warning above" paragraph had its antecedent stolen by the inserted drift block; the two-feeder sentence implied one deployment hears both sentences when a set `EMBEDDING_PROVIDER` shadows the store entirely; the claim that the canvas note "appears in one state the flat page never reaches" was false (`EmbeddingSettings.tsx` gates on `overridden && modelInEffect !== null`, with no provider term) and is now the true, narrower claim about the canvas model row; the quoted canvas sentence was silently truncated; and the drift block carried none of the `LOG_LEVEL` / single-occurrence caveats its throttled sibling needs.
  - `[low]` `[patch]` Nothing read the two new payload fields off a real `GET`/`PUT /api/settings` — `settings-route.test.ts` mocks the resolution to `null`/`false`. Added route-level cases with the real resolvers: a `GET` serving the pair beside the flat page's top-level fields on the same body, and a landed `PUT` re-seeding it on the write response.

## Design Notes

**Why the drift key is the active model alone.** The identity of the misconfiguration is "the active model name has drifted from every stored vector". The query is not part of it, and neither is how many hits that query happened to return — which is exactly why the sentence has to stop naming the count. Keying on the SET of dropped models would be truer still, but it is per-query state again and the corpus is the thing that is wrong, not the query.

**Why the override source joins the key, not just the sentence.** `warnedMisconfigurations` keys are identities so a changed misconfiguration speaks again. Two identical bad strings from different sources now produce two different sentences with two different remedies, so they are two identities; keying only on the string would let whichever arrived first silence the other's remedy for the life of the process.

**Why the canvas note is payload-derived while the gate complaint beside it is draft-derived.** They answer different questions. `vectorSearchFieldIssue` says why the vector switch cannot be turned on, computed from what the owner is currently typing. The substitution note says what this deployment is embedding with right now, which only the server can know — and it is the state the canvas was silent about whenever no provider is selected, because the gate returns the provider leg early and never produces a model complaint at all. The note refreshes on save, since `PUT` re-seeds the payload from a cache `saveConfig` just re-primed.

**Why the `cfg` door is optional.** Every caller outside the two settings resolvers wants "resolve against whatever is current", which is `loadConfigSync()` — the default. The parameter exists so a caller that already holds a snapshot can say "resolve against THIS one", which is the whole of DW-313:

```ts
export function getEmbeddingModelName(cfg = loadConfigSync()): string | null {
  const provider = resolveEmbeddingProvider(cfg);
  return provider ? resolveEmbeddingModelName(provider, cfg) : null;
}
```

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: no errors.
- `npm run lint` -- expected: clean apart from the three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices.
- `npm test` -- expected: all suites pass, no test removed.

## Auto Run Result

Status: done

### Summary

Four embedding-diagnostics defects, one bundle.

**DW-310** — `searchByVector`'s model-drift breadcrumb now goes through `warnOnceAbout`, keyed `drift:<active model>`. The drift is standing state that holds until the corpus is rebuilt, but the door it is logged from runs once per search, so a drifted corpus emitted the line for every query anyone ran. The sentence dropped `matches.length`: the count belongs to the query, not to the misconfiguration, and keying on it would have re-armed the warning for every distinct number of hits. `runWorkersAiEmbedding`'s response-shape line stays unguarded — it reports a per-call event.

**DW-311** — the non-embedding-capable override refusal names its source. The env sentence is unchanged; a value taken from the store gets its own sentence naming the stored provider and pointing at Settings, with no `EMBEDDING_PROVIDER=` and no instruction to unset a variable nobody set. Which value wins is untouched. The source joins the warn key, because the two sentences carry different remedies and a shared key would let whichever arrived first silence the one the owner can act on.

**DW-312** — `getWorkbenchSettings` now serves `embeddingModelInEffect`/`embeddingModelOverridden`, and the canvas's Embedding model row says what this deployment actually embeds with, as a third part of the row's own description. Described, never marked. Both Settings surfaces derive the pair from one new helper, `embeddingModelAnswer(cfg)`, so they cannot answer the DW-274 question differently. The canvas sentence is worded for the row it rides on — its box is empty whenever `EMBEDDING_MODEL` owns the value, so it names "the model that is set" rather than pointing at a control.

**DW-313** — `getEmbeddingModelName` and `hasEmbeddingSupport` take an optional `cfg` defaulting to `loadConfigSync()`, and the snapshot is threaded through the private path they traverse. Review widened this to the three sibling re-entries the door made visible: `getEffectiveProvider`, and the embed path itself, where the drift key's trustworthiness depends on the model that embedded and the model the filter compares against coming from one read.

### Files changed

- `src/lib/embeddings.ts` -- drift breadcrumb throttled and de-parameterised; override refusal names env vs stored and keys on it; `cfg` doors on `getEmbeddingModelName`, `hasEmbeddingSupport`, `getEmbeddingModel`, `embedText`, `embedTexts`, with `embeddingApiKeyFor` and `_createEmbeddingModel` taking the caller's snapshot; `warnedMisconfigurations` doc block rewritten to four standing warnings and one deliberate exception.
- `src/lib/config.ts` -- new private `embeddingModelAnswer(cfg)` carrying the DW-227/DW-274 reasoning; both Settings resolvers derive the embedding answer from it; `getEffectiveSettings` and `getEffectiveProvider` pass their own `cfg` to `hasEmbeddingSupport`.
- `src/lib/workbench-settings.ts` -- the two payload fields, required in `isWorkbenchSettingsPayload`; `settingsModelSubstitutedCopy` beside the other embedding copy. Still imports only `./providers` and `./write-precondition`, and no field carries a stored key.
- `src/components/workbench/SettingsCanvas.tsx` -- the model row's hint is three parts; the substitution note is guarded on both payload fields, as the flat page guards the same note.
- `DEPLOY.md` -- the stored-provider refusal, the drift line and its throttle with the `LOG_LEVEL` and single-occurrence caveats, and the note now riding on both Settings surfaces while the locked box stays `/settings`-only.
- Tests -- `embeddings.test.ts` (drift throttle and silence cases, override-source cases, explicit-snapshot pins), `settings-runtime-wiring.test.ts` (the two resolvers agree, cold cache, real-route `GET`/`PUT` serving the pair), `workbench-settings.test.ts` (payload guard), `settings-vector-namespace.test.tsx` (five mounted canvas cases), `config.test.ts` (`getEffectiveProvider().embeddingSupport`), `settings-read-only.test.tsx` and `settings-route.test.ts` (fixture/mock).

### Review findings breakdown

- Patches applied: 7 (high 0, medium 1, low 6) -- see the Review Triage Log.
- Items deferred: 6 (high 0, medium 1, low 5) -- the drift key never re-arming after an in-process rebuild; whitespace-only `EMBEDDING_PROVIDER`; `getEffectiveSettings`'s non-embedding legs still re-entering the cache; the canvas fixture encoding a payload the server cannot produce; the two hand-maintained substitution sentences; the note's payload-derived freshness beside draft-derived siblings.
- Items rejected: 11 (all low) -- the double `getEmbeddingModelName` resolution inside `getEffectiveSettings` (the door IS the rule, and the two cannot disagree); `isWorkbenchSettingsPayload` requiring the new fields (the argued `hasWorkersAiBinding` convention, tested); the test's local copy of the sentence (this file's convention is to type announced strings out); quoting or mono-spacing the model id in a flat hint; the note being announced third; the drift sentence's rewording beyond dropping the count; DW-311's key widening (deliberate, in Design Notes); an empty-string `embeddingModelInEffect` (the server cannot produce one and the sibling surface has the identical guard); the `/\b\d+ match/` assertion (the byte-identity comparison after growing the corpus is the real pin); the pre-accepted lint notices; and the spec's own `multiple-goals`/`oversized` warnings and empty log scaffolding.

### Follow-up review recommendation

`true`. Patched findings this pass: high 0, medium 1, low 6. Score = 3x0 + 3x1 + 1x6 = 9, which is >= 5.

### Verification

- `npx tsc --noEmit` -- exit 0, no output.
- `npm run lint` -- clean; only the three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices.
- `npm test` -- 256 files, 5536 tests, all passing (5515 at baseline). `git diff` confirms no `it(` block was deleted; the one removed line is a rename.
- Matrix test audit: all thirteen I/O matrix rows are covered by tests that ran and passed -- the four drift rows and three override-source rows in `embeddings.test.ts`, the four canvas rows in `settings-vector-namespace.test.tsx`, the payload-guard row in `workbench-settings.test.ts`, and the cold-cache row in `settings-runtime-wiring.test.ts`.
- The review pass mutation-checked the DW-313 threading (reverting it left the suite green before the patch, and fails three tests after) and the payload fields (hardcoding them fails three more, including the new route case).

### Residual risks

- The `drift:<model>` key is consumed for the life of the process. The patched snapshot threading removes the realistic way it could be burned by a false positive, but a rebuild that fixes drift and a later re-drift under the same active model is still silent until restart. Deferred, because re-arming contradicts the module's recorded trade-off and the intent does not decide it.
- Requiring the two new fields in `isWorkbenchSettingsPayload` means a canvas served a payload from an older build fails its read entirely rather than degrading one row. This is the existing `hasWorkersAiBinding` convention and is argued in-comment, but it is a wire-shape narrowing on a rolling deploy.
- The canvas note describes server state, so it is stale against an unsaved edit until a `PUT` lands. Documented in code and in DEPLOY.md; deferred as a decision the intent does not contain.

