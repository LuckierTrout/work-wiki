---
title: 'Vector-gate surface completeness: field-level complaints, provider origin, on-but-inactive copy, text-row read-only sentence (DW-277, DW-279, DW-280, DW-281)'
type: 'bugfix'
created: '2026-08-20'
status: 'done'
baseline_revision: 'a5a50aaea879490f26ed72017dbba1df72f249ef'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      `secretRow` never routes its description through `describedBy()`, so the
      three API-key rows are the last controls on the Settings surface that a
      read-only deployment refuses without saying why.
    evidence: |-
      DW-280 closed this for `textRow`, and the two provider pickers and the
      vector checkbox already wrap their hint id in `describedBy(...)`. But
      `secretRow` still hardcodes `aria-describedby={hintId}` while setting
      `readOnly={stored.readOnly || removing}` and dropping its Remove button
      under `readOnly` — so on a `YOPEDIA_READONLY` deployment a keyboard user
      reaches Custom / Embedding / Firecrawl API key, finds a box that will not
      take a keystroke and an affordance that has vanished, and is told only "A
      key is stored." No test in the repo mounts a password field on a read-only
      deployment, and the source-shape guard in `workbench-settings.test.ts`
      pins the `describedBy(` call-site count at exactly 4, so adopting it in
      `secretRow` also means bumping that count to 5. This bundle's intent names
      "all seven text rows" and DW-280's location is `textRow`, so the key rows
      are a separate decision rather than part of this change.
    location: >-
      src/components/workbench/SettingsCanvas.tsx:secretRow with
      src/lib/__tests__/workbench-settings.test.ts (describedBy call-site count)
    severity: low
  - summary: >-
      The route's 400 body still frames an already-on deployment as
      un-turn-on-able, so the two halves of the one rule now describe the same
      state with different sentences.
    evidence: |-
      DW-279 was closed on the client only: `vectorSearchInactiveCopy` is
      selected by `SettingsCanvas`, while `validateWorkbenchSettingsPatch`
      returns `vectorSearchMissingCopy(merged)` — "…before it can be turned
      on" — for every refusal. The path is reachable: with the switch stored ON
      and a save that MOVES a vector input into an unmet state, the owner gets a
      400 whose sentence lands in the save bar beside a still-ticked box, which
      is the exact mismatch DW-279 argues against. `validateWorkbenchSettingsPatch`
      already reads `baseline.vectorSearchEnabled`, so it could pick the frame —
      but whether an ERROR response should describe a state rather than a
      refusal is a distinct decision, and DW-279's location names the
      `vectorSearchEnabled` hint only.
    location: >-
      src/lib/workbench-settings.ts:validateWorkbenchSettingsPatch (the
      `vectorSearchMissingCopy(merged)` refusal) with
      src/components/workbench/SettingsCanvas.tsx (save bar)
    severity: low
  - summary: >-
      DEPLOY.md still says the legacy flat `/settings` branch never enters the
      vector gate, which DW-217 made false.
    evidence: |-
      Two sentences claim it: "the older `/settings` page saves the embedding
      provider through a flat request that never enters this gate" and "saves
      the embedding model through a flat request that never runs this check".
      `src/app/api/settings/route.ts` now calls `validateWorkbenchSettingsPatch`
      for a flat-only body (its comment spells out that "the flat branch cannot
      move that flag, so `turningOn` is always `false`"), and
      `settings-route.test.ts` carries a suite for the vector rule on the flat
      branch. Stale as of the DW-217 sweep (commit a5a50aa, this change's
      baseline), so pre-existing here — but this change rewrites the paragraphs
      immediately above and below both sentences, which is how it surfaced.
    location: >-
      DEPLOY.md (the two "flat request" caveats) with
      src/app/api/settings/route.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** The vector-gate surface refuses in four places where the control that produced the state says nothing. `VectorSearchLegField` enumerates `provider | endpoint | model | key | binding`, but only the `model` leg has a consumer, so selecting Workers AI on a deployment with no `AI` binding leaves the embedding-provider select with no complaint and no `aria-invalid` (DW-277). `SETTINGS_VECTOR_BINDING_NOTE` advises "choose another embedding provider" even when `EMBEDDING_PROVIDER` owns that select and the owner cannot (DW-281). A switch stored ON whose legs are unmet renders checked beside a sentence saying vector search cannot be turned on (DW-279). And `textRow` hardcodes `aria-describedby={hint ? hintId : undefined}`, so none of the seven text rows appends `SETTINGS_READ_ONLY_COPY` the way `providerRow` and the two refusable controls do (DW-280).

**Approach:** Generalize the existing `vectorSearchModelIssue` into `vectorSearchFieldIssue(v, control)`, keyed by the CONTROL that owns a leg (the binding leg maps to the provider select, which is the only thing on this surface that can move it), and wire the embedding-provider select through it for both description and `aria-invalid`. Give `VectorSearchInputs` a `providerOrigin` beside `modelOrigin`, derived from the same `envEmbeddingProvider ??` precedence both feeders already spell, and select an env variant of the binding note from it. Add `vectorSearchInactiveCopy` for the checkbox's third state. Route `textRow`'s description through `describedBy()`, widened to answer for a row that has no hint of its own.

## Boundaries & Constraints

**Always:**
- `canEnableVectorSearch` stays the ONE rule with two callers answering identically for identical situations; the client/server agreement table keeps passing for every situation, including the new `providerOrigin` field.
- `workbench-settings.ts` stays client-safe: it imports nothing from `embeddings.ts`, `config.ts` or any Node builtin, and gains no new payload field — `providerOrigin` derives from `envEmbeddingProvider`, which every feeder already reads.
- Every constructor of `VectorSearchInputs` sets `providerOrigin` explicitly; it has no default, for the same reason `modelOrigin` has none. `VECTOR_INPUT_KEYS` must list it (the `satisfies` clause enforces this).
- A field issue exists only where the control's OWN value is present-and-wrong — a mismatched model, an unrecognized provider, `workers-ai` on a deployment with no binding. A merely ABSENT value produces no field issue, exactly as `vectorSearchModelIssue` already answers `null` for an empty model box.
- `aria-invalid` marks a control only when that control's value is the wrong one AND the origin is `"stored"` AND the deployment is writable. An env-owned value is described without being marked.
- The vector checkbox's refusal sentence (`vectorSearchMissingCopy`) is unchanged in shape and still carries every leg's note; it is the string the route returns on a 400.
- Turning the vector switch OFF stays always allowed, and `vectorRefused` keeps its current definition.

**Block If:** the client and the route would have to disagree for any situation in the agreement table.

**Never:**
- Do not change env-over-typed precedence in either feeder, and do not add a `providerOrigin` field to `WorkbenchSettingsPayload` or `WorkbenchSettingsStored` — `envEmbeddingProvider` is already there.
- Do not widen the owner gate, the read-only switch, or the write-precondition vocabulary.
- Do not teach `hasEmbeddingSupport()` or the embed path the vector gate (Stories 2.9 / 3.4 own that), and do not give `getVectorSearchSettings` a runtime parameter.
- Do not add a second embedding-model or embedding-provider field, and do not disable any control (`aria-disabled` only).
- Do not change `vectorSearchMissingCopy`'s sentence for the switch-off case, and do not make `vectorSearchModelIssue`'s existing three answers behave differently under a new name.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Workers AI, no binding, stored provider | provider `workers-ai`, supported id, `hasWorkersAiBinding: false`, `providerOrigin: "stored"` | provider select is `aria-invalid="true"` and described with the binding leg sentence plus `SETTINGS_VECTOR_BINDING_NOTE` | No error expected |
| Same, env-owned provider | plus `EMBEDDING_PROVIDER=workers-ai` (`providerOrigin: "env"`) | described with the binding leg sentence plus `SETTINGS_VECTOR_BINDING_ENV_NOTE`, which names unsetting the variable and NOT "choose another provider"; NOT `aria-invalid` | 400 on save carries the env note |
| Workers AI with a binding | `hasWorkersAiBinding: true`, supported id | provider select has no complaint and no `aria-invalid` | No error expected |
| Provider unset | provider `null` | no provider field issue (absence, not a wrong value); the standing `SETTINGS_VECTOR_PROVIDER_COPY` hint and the checkbox refusal carry it | No error expected |
| Endpoint or key leg unmet | provider `openai`, no base URL, no key | `vectorSearchFieldIssue(v, "endpoint")` and `(v, "key")` are `null` — absence only | No error expected |
| Model leg, stored mismatch | provider `workers-ai`, stored `text-embedding-3-small` | unchanged from today: model row described with the model leg sentence ALONE and marked `aria-invalid` | No error expected |
| Switch stored ON, legs unmet | `vectorSearchEnabled: true`, `vectorAllowed` false | checkbox hint is the on-but-inactive sentence naming the unmet legs plus their notes — not "before it can be turned on"; checkbox stays checked and turn-off-able | No error expected |
| Switch OFF, legs unmet | `vectorSearchEnabled: false`, `vectorAllowed` false | checkbox hint is `vectorSearchMissingCopy` exactly as today | No error expected |
| Switch ON and allowed | legs met | `SETTINGS_VECTOR_HINT_COPY`, unchanged | No error expected |
| Text row on a read-only deployment, with a hint | `readOnly: true`, LLM timeout row | `aria-describedby` resolves to the hint AND `SETTINGS_READ_ONLY_COPY` | No error expected |
| Text row on a read-only deployment, no hint | `readOnly: true`, Chat model row | `aria-describedby` resolves to `SETTINGS_READ_ONLY_COPY` alone | No error expected |
| Text row on a writable deployment, no hint | `readOnly: false`, Chat model row | no `aria-describedby` at all | No error expected |
| Read-only deployment, wrong stored value | `readOnly: true`, provider or model mismatch | described, never `aria-invalid` — the same suppression `textRow` already applies | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts:206-213` -- `SETTINGS_VECTOR_BINDING_NOTE`; the env variant belongs beside it in the same copy block (`:165-230`). `SETTINGS_VECTOR_ENV_MODEL_NOTE` at `:196-205` is the precedent for an origin-selected note.
- `src/lib/workbench-settings.ts:467-501` -- `VectorSearchInputs`; gains `providerOrigin: "env" | "stored"`, documented like `modelOrigin` at `:479-489`.
- `src/lib/workbench-settings.ts:562-568` -- `VectorSearchLegField`; `:570-600` `VectorSearchLeg`. `:601-639` `vectorSearchMissingLegs` — the binding leg at `:632-638` picks its note by `providerOrigin`.
- `src/lib/workbench-settings.ts:641-665` -- `vectorSearchMissingCopy` and the private `vectorSearchLegSentence`. Split the list-forming out of the sentence so the on-but-inactive sentence reuses it.
- `src/lib/workbench-settings.ts:667-699` -- `vectorSearchModelIssue`; becomes `vectorSearchFieldIssue(v, control)`. Its three documented answers for the model control must not change.
- `src/lib/workbench-settings.ts:928-935` -- `VECTOR_INPUT_KEYS` with `satisfies Record<keyof VectorSearchInputs, true>`: adding the field to the interface without adding it here is a type error, and the comment at `:941-947` counts the non-patchable fields.
- `src/lib/workbench-settings.ts:970-999` -- `mergedVectorInputs` (route half); `:1166-1189` `draftVectorInputs` (browser half). Both already read `envEmbeddingProvider` at their first line — `providerOrigin` is the same `??` read as a question about origin.
- `src/lib/config.ts:816-853` -- `getVectorSearchSettings`; sets `modelOrigin` at `:826` and needs `providerOrigin` from `envEmbeddingProvider()` (`:868`). Keeps returning its four declared fields explicitly at `:844-851`.
- `src/components/workbench/SettingsCanvas.tsx:272-285` -- `readOnlyNoteId` and `describedBy(hintId)`; widen to accept `string | undefined` and return `string | undefined`. Existing callers (`:365`, `:466`, `:549`) pass a definite string and are unaffected.
- `src/components/workbench/SettingsCanvas.tsx:287-330` -- `textRow`; already has the `invalid` parameter and the read-only `aria-invalid` suppression at `:325`. Only `aria-describedby` at `:317` changes.
- `src/components/workbench/SettingsCanvas.tsx:241-256` -- `vectorInputs` / `vectorAllowed` / `vectorBlocked` / `vectorModelIssue` / `vectorRefused`. `:249` becomes the provider and model issues; the inactive copy joins them.
- `src/components/workbench/SettingsCanvas.tsx:462-497` -- the embedding-provider `<select>` and its hint span; `:498-522` the embedding-model row; `:549-558` the checkbox `aria-describedby` and `:559-566` its hint span (the DW-279 site).
- `src/lib/__tests__/workbench-settings.test.ts:344-349` -- `VectorLegs` / `vectorInputs()` helper defaulting the origin fields; `:751-820` the `vectorSearchModelIssue` suite; `:700-750` the binding-leg suite; `:960-1010` the client/server agreement table; `:1400-1480` the draft/payload wiring cases.
- `src/lib/__tests__/settings-route.test.ts:369-376, 500-535` -- three inline `VectorSearchInputs` literals needing the new field.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:640-650` -- `getWorkbenchSettings` binding assertions; the `getVectorSearchSettings` suite nearby covers the new origin field.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx:28-58` (payload fixture), `:78-90` (`announcedFor`), `:295-306` (the read-only model-row case whose announced string grows by the read-only sentence), `:335-368` (the binding-leg mounted cases).
- `src/components/workbench/__tests__/settings-read-only.test.tsx:28-58` (payload fixture, `readOnly: true`, `embeddingProvider: "openai"`), `:129-152` (the append-the-sentence assertions for `providerRow`) -- the model for the new text-row assertions.
- `DEPLOY.md:68-81` -- quotes the binding refusal and its "two ways out"; `:112-152` states the box-marked-invalid rule and the effective-switch caveat. Both need the env-provider variant and the generalization from "the box" to "the control that holds the wrong value".

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- add `providerOrigin` to `VectorSearchInputs` and to `VECTOR_INPUT_KEYS`; add `SETTINGS_VECTOR_BINDING_ENV_NOTE` and select it in the binding leg when `providerOrigin === "env"` -- advice the env-locked select cannot follow is worse than no advice (DW-281).
- `src/lib/workbench-settings.ts` -- split the leg LIST out of `vectorSearchLegSentence` and add exported `vectorSearchInactiveCopy(v)`: the unmet legs said as an "on but inactive" state, with the same notes appended, and with turning it off named as the available action -- a checked box beside "before it can be turned on" describes a state that is not the one the surface is in (DW-279).
- `src/lib/workbench-settings.ts` -- replace `vectorSearchModelIssue` with `vectorSearchFieldIssue(v, control)` over a `"provider" | "endpoint" | "model" | "key"` control type, mapping the `binding` leg to the provider control, returning the leg sentence (plus the leg's note for every control except `model`, whose row already carries `settingsEnvOverrideCopy` for the same variable), with `invalid` true only when that control's origin is `"stored"`; return `null` for a leg that is pure ABSENCE -- one rule for every refusable control instead of a model-shaped special case (DW-277).
- `src/lib/workbench-settings.ts` -- set `providerOrigin` in `mergedVectorInputs` and `draftVectorInputs` from `envEmbeddingProvider !== null`, beside the `provider` line each already computes -- both halves of the one rule must read the same origin or they answer differently.
- `src/lib/config.ts` -- set `providerOrigin` in `getVectorSearchSettings` from `envEmbeddingProvider()`, and keep the explicit four-field return so the new input does not leak onto `VectorSearchSettings`.
- `src/components/workbench/SettingsCanvas.tsx` -- widen `describedBy` to `(hintId: string | undefined) => string | undefined` and route `textRow`'s `aria-describedby` through it, so a read-only deployment appends the sentence to all seven rows including the hintless ones (DW-280).
- `src/components/workbench/SettingsCanvas.tsx` -- compute the provider and model field issues; append the provider issue's copy to the embedding-provider hint span and give the `<select>` `aria-invalid` under the same read-only suppression `textRow` applies; switch the checkbox hint to the three-way choice (allowed / stored-on-but-inactive / refused) -- the control that produced the state has to be the one that explains it (DW-277, DW-279).
- `src/lib/__tests__/workbench-settings.test.ts` -- add `providerOrigin` to the `VectorLegs` helper and the agreement table; cover the env/stored binding-note split, `vectorSearchFieldIssue` for all four controls (including the two that are always `null`), and `vectorSearchInactiveCopy` with and without notes; keep the existing model-control answers asserted verbatim.
- `src/lib/__tests__/settings-route.test.ts`, `src/lib/__tests__/settings-runtime-wiring.test.ts` -- add the new field to the inline literals; pin that `EMBEDDING_PROVIDER=workers-ai` with no binding produces the env note end to end through the route.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- add mounted cases for the provider select's description and `aria-invalid` in the stored, env-owned, and bound cases, and for the on-but-inactive checkbox hint; update the read-only model-row assertion to the description that now carries the read-only sentence -- a node suite cannot observe which span reaches which control.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- assert a hinted text row (LLM timeout) announces both its hint and `SETTINGS_READ_ONLY_COPY`, a hintless one (Chat model) announces the sentence alone, and a writable deployment leaves the hintless row with no `aria-describedby`.
- `DEPLOY.md` -- record the `EMBEDDING_PROVIDER`-owned variant of the binding refusal, that the provider select is marked invalid on the same stored-only rule as the model box, and that a stored-on switch reports itself inactive rather than un-turn-on-able.

**Acceptance Criteria:**
- Given `workbench-settings.ts` after the change, when its import graph is inspected, then it still imports nothing from `embeddings.ts`, `config.ts` or any Node builtin, and `WorkbenchSettingsPayload` has gained no field.
- Given the client/server agreement table, when each situation is evaluated on both halves, then the browser's answer equals the route's for every one, including the provider-origin situations.
- Given a writable deployment on the Embeddings category with an unmet leg that is pure absence (no endpoint, no key, no provider), when the surface renders, then no control carries `aria-invalid` and no row repeats the checkbox's refusal.
- Given the whole suite, when `npx eslint`, `npx tsc --noEmit` and `npx vitest run` run, then all pass with no test deleted to accommodate the change.

## Spec Change Log

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 3: (high 0, medium 0, low 3)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[low]` `[patch]` `SETTINGS_VECTOR_BINDING_ENV_NOTE`'s tail ("which forces this selection and wins over the Embedding provider box") restated `settingsEnvOverrideCopy`, which is already the provider row's standing hint — the same duplication the `control === "model"` exception exists to prevent. Trimmed to "…or unset EMBEDDING_PROVIDER to choose another embedding provider", with the doc comment saying why the clause is not repeated; three assertions repinned.
  - `[low]` `[patch]` `vectorSearchInactiveCopy` asserted a fact about the RUNNING deployment ("Vector search is on but inactive") while the component selects it from draft-derived terms — an unsaved provider change on a working deployment claimed it had gone inactive. Reworded to "Vector search is switched on, but it needs … before it can run. Turn it off, or supply what is missing." and corrected both comments that claimed the selector reads the stored flag.
  - `[low]` `[patch]` `vectorControlOrigin` fell through to `"stored"` — the value that MARKS a control `aria-invalid` — so a future control would silently inherit "the owner is at fault". Rewritten as an exhaustive `switch` with no default, matching `vectorControlHasValue`.
  - `[low]` `[patch]` DEPLOY.md claimed "every row on the surface now also announces that settings are read-only here", which is false for the three API-key rows. Corrected to name the rows it holds for and state the key rows as the exception.
  - `[low]` `[patch]` DEPLOY.md presented a fragment of the binding note as a verbatim quote, with backticks the constant does not contain and without the refusal sentence it rides on. Replaced with a block quote matching the constants.
  - `[low]` `[patch]` Two untested combinations of the features this change adds: read-only + stored-on + unmet legs, and an env provider that DIFFERS from the stored one. Both added as mounted cases.

## Design Notes

**Which control owns a leg.** The `binding` leg has no control of its own — nothing on this surface binds `ai` in `wrangler.jsonc` — so it maps to the provider select, which is the only control that can move it. Every other leg maps to its namesake:

```ts
const VECTOR_LEG_CONTROL = {
  provider: "provider", endpoint: "endpoint", model: "model",
  key: "key", binding: "provider",
} satisfies Record<VectorSearchLegField, VectorSearchControl>;
```

At most one leg reaches any control: the provider leg returns early and excludes the binding leg, and the model leg is produced once.

**Absence is not a field issue.** `vectorSearchModelIssue` already answers `null` for an EMPTY model box, on the argument that the box holds no wrong value. Generalized, that keeps a fresh deployment from rendering three boxes each repeating a leg the checkbox already lists in one sentence — and it means the endpoint and key legs, which are pure presence tests, produce no field issue at all. That silence is the rule's answer, not an omission, so it is pinned by a test rather than left to be re-derived. The provider select's standing hint (`SETTINGS_VECTOR_PROVIDER_COPY`) is already the complaint for an unset provider.

**Notes on the field.** A leg's `note` names what OWNS the problem. It rides on the owning control except for the model leg, whose row already carries `settingsEnvOverrideCopy("model", …)` naming `EMBEDDING_MODEL` — a second sentence about the same variable would only repeat it. The binding note is the opposite case: without it, "Vector search needs the Cloudflare AI binding before it can be turned on" on a provider select names no action at all, and the action it names is precisely what this control does.

**`providerOrigin` needs no payload field.** `WorkbenchSettingsPayload.envEmbeddingProvider` and `WorkbenchSettingsStored.envEmbeddingProvider` are already served and already read as the first term of the `??` in both feeders. The origin is that same read, asked as a question — the identical shape `modelOrigin` takes.

## Verification

**Commands:**
- `npx eslint` -- expected: clean (exit 0; three pre-existing `jsx-ast-utils` TSNonNullExpression notices are the baseline). NOT `pnpm lint`: `pnpm run` fails in this repo with `ERROR packages field missing or empty`.
- `npx tsc --noEmit` -- expected: no errors.
- `npx vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/settings-route.test.ts src/components/workbench/__tests__/settings-vector-namespace.test.tsx src/components/workbench/__tests__/settings-read-only.test.tsx` -- expected: all pass.
- `npx vitest run` -- expected: the full suite passes with no new failures against the baseline (`pnpm test` fails for the same `packages field missing or empty` reason).

## Auto Run Result

Status: done

### Summary

Every refusable control on the vector-gate surface now explains itself.
`vectorSearchModelIssue` became `vectorSearchFieldIssue(v, control)`, keyed by
the CONTROL that owns a leg rather than by the model field alone, with the
`binding` leg mapped to the embedding-provider select — the one control on the
surface that can move it. Selecting Workers AI on a deployment with no `AI`
binding now marks and describes that select instead of leaving the complaint on
a checkbox three rows down (DW-277). `VectorSearchInputs` gained `providerOrigin`
beside `modelOrigin`, read from the `envEmbeddingProvider ??` precedence both
feeders already spell, so a refusal the environment owns stops advising "choose
another embedding provider" — advice the env-locked select cannot follow — and
names the variable instead (DW-281). A switch stored ON whose legs went missing
is now addressed as a switch that is on rather than as one that cannot be turned
on (DW-279). And `textRow`'s description routes through `describedBy()`, widened
to answer for a row with no hint of its own, so all seven text rows carry the
read-only sentence (DW-280).

The generalization keeps one rule with no per-field exceptions: a control speaks
only when its OWN value is present-and-wrong. A merely absent value produces
nothing — which is what `vectorSearchModelIssue` already answered for an empty
model box, and what keeps a fresh deployment from rendering three rows each
repeating a leg the checkbox lists once. The endpoint and key legs are pure
presence tests, so those two controls never produce an issue; that silence is the
rule's answer and is pinned by a test rather than left to be re-derived.

### Files changed

- `src/lib/workbench-settings.ts` -- `providerOrigin` on `VectorSearchInputs` and
  `VECTOR_INPUT_KEYS`; `SETTINGS_VECTOR_BINDING_ENV_NOTE` selected by the binding
  leg; `vectorSearchLegList` split out of `vectorSearchLegSentence` and
  `withLegNotes` factored out; `vectorSearchInactiveCopy`; `vectorSearchFieldIssue`
  over a `VectorSearchControl` type driven by `VECTOR_LEG_CONTROL`; both feeders
  set the new origin.
- `src/lib/config.ts` -- `getVectorSearchSettings` hoists `envEmbeddingProvider()`
  and sets `providerOrigin`; its explicit field-by-field return is unchanged, so
  the gate-only inputs still do not leak onto `VectorSearchSettings`.
- `src/components/workbench/SettingsCanvas.tsx` -- `describedBy` widened to
  `string | undefined` in and out; `textRow` routed through it; the
  embedding-provider select gained `aria-invalid` and the field issue's copy; the
  checkbox hint became a three-way choice.
- `DEPLOY.md` -- the provider select carrying the binding refusal, the
  `EMBEDDING_PROVIDER`-owned variant with its different second way out, the
  generalized invalid rule, which rows announce the read-only sentence (and the
  three API-key rows that do not), and the on-but-switched-on state.
- `src/lib/__tests__/workbench-settings.test.ts`,
  `src/lib/__tests__/settings-runtime-wiring.test.ts`,
  `src/lib/__tests__/settings-route.test.ts`,
  `src/components/workbench/__tests__/settings-vector-namespace.test.tsx`,
  `src/components/workbench/__tests__/settings-read-only.test.tsx` -- the new
  input on every fixture, plus coverage for every I/O matrix row.

### Review findings breakdown

- Patches applied: 6 (high 0, medium 0, low 6)
- Items deferred: 3 (all low) -- recorded in frontmatter `deferred`
- Items rejected: 10
- Follow-up review recommended: **true** -- patched severities high 0, medium 0,
  low 6; score `3 × 0 + 1 × 6 = 6`, which is at or above 5.

### Verification performed

- `npx tsc --noEmit` -- exit 0, no output.
- `npx eslint` -- exit 0 (three pre-existing `jsx-ast-utils` TSNonNullExpression
  notices, unchanged from the baseline).
- `npx vitest run` -- 252 files / 5367 tests, all pass. No test deleted; three
  existing assertions were rewritten in place where the change intentionally
  moves the announced string (the `describedBy` call-site count 3→4, the
  already-on checkbox's announcement, and the read-only model row, which now also
  announces the read-only sentence).
- Matrix audit: every I/O row has at least one covering test that ran and passed.
  The "switch ON and allowed" row had no covering case until one was added --
  without it, ordering the component's ternary the other way round would announce
  "switched on, but it needs …" over a vector search that is running.
- Two mutation checks: reverting `textRow`'s `aria-describedby` to the old
  hardcode fails the three DW-280 cases and the read-only model row; making the
  checkbox hint select on `values.vectorSearchEnabled` ahead of `vectorAllowed`
  fails the ON-and-allowed case.

### Residual risks

- **The route and the surface now frame the same state differently.**
  `vectorSearchInactiveCopy` is client-only, so a save that moves a vector input
  into an unmet state on an already-on deployment still answers 400 with "…before
  it can be turned on". Deferred rather than closed: whether an error RESPONSE
  should describe a state rather than a refusal is a distinct decision, and
  DW-279's location names the checkbox hint.
- **The inactive sentence is draft-derived, like every other term on this
  surface.** `vectorAllowed`, `vectorRefused` and `vectorBlocked` all read the
  draft, and the checkbox is bound to it, so an unsaved edit that breaks a leg
  changes the sentence before anything is saved. The copy was written to describe
  the settings as they stand rather than to assert what the deployment is doing,
  and the save bar's standing sentence is what qualifies unsaved edits — but a
  reader who takes it as a claim about the running deployment would be misled.
- **`endpoint` and `key` are unreachable arms of the new generalization.** Both
  legs fire only on absence and `vectorControlHasValue` requires presence, so
  those two controls can never produce an issue today. Deliberate and pinned, but
  it means "one rule for every refusable control" currently has two controls it
  says nothing to.
- **The three API-key rows still do not announce the read-only sentence**, which
  makes `secretRow` the last control on this surface a read-only deployment
  refuses in silence. Deferred: this bundle's intent names the text rows.
