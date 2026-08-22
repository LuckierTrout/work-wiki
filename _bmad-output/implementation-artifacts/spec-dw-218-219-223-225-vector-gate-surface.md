---
title: 'Vector gate on the surface: origin-aware refusal, model-field complaint, patch-scoped re-check, binding leg'
type: 'bugfix'
created: '2026-08-19'
status: 'done'
baseline_revision: '1aa4d906394885f940f863c4a929062a23a46da4'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The new Cloudflare-binding refusal is announced only on the vector
      checkbox; the embedding-provider select that produces the state carries no
      complaint and no `aria-invalid`.
    evidence: |-
      DW-223's own argument is that "the ordinary way into that state is
      changing the provider select, which touches neither control" — and
      selecting Workers AI on a deployment with no binding is exactly that
      shape. `VectorSearchLegField` now enumerates `provider | endpoint | model
      | key | binding`, but only the `model` leg has a consumer
      (`vectorSearchModelIssue`); the provider, endpoint and key rows stay
      silent. The bundle's intent names only the embedding-model field, so
      wiring a second field-level complaint is new scope rather than part of
      this change.
    location: >-
      src/components/workbench/SettingsCanvas.tsx (embeddingProvider select) with
      src/lib/workbench-settings.ts:vectorSearchModelIssue
    severity: low
  - summary: >-
      Every settings read and save now calls `getWorkersAiBinding()`, so a
      Workers deployment with `AI` unbound emits one WARN per settings request
      on a path that previously logged nothing.
    evidence: |-
      `getWorkersAiBinding()` warns when it is ON the Workers runtime with the
      binding missing (`src/lib/embeddings.ts:64-71`), and the route now calls
      it unconditionally in `GET` and in `PUT`. The amplification is the same
      shape as the already-deferred "warnings fire per resolution rather than
      once per distinct misconfiguration" item from the DW-220 bundle, and
      closing it means a once-per-misconfiguration guard in `embeddings.ts`
      rather than a change to this seam.
    location: >-
      src/app/api/settings/route.ts with src/lib/embeddings.ts:56-73
    severity: low
  - summary: >-
      There is no copy for the "stored on, effectively off" state the DW-219
      scoping makes durable — the checkbox renders checked and unrefused beside
      a sentence saying vector search cannot be turned on.
    evidence: |-
      `vectorRefused` is `stored.readOnly || (!vectorAllowed &&
      !values.vectorSearchEnabled)`, so an already-on switch stays operable by
      design (an owner must be able to undo it). Pre-existing — the mounted case
      "leaves an ALREADY-ON switch checked, refused, and turn-off-able" pinned
      it before this bundle — but DW-219 makes the state survivable across
      unrelated saves rather than being cleared at the next one. Closing it
      means a distinct sentence for "on but inactive", which is a copy decision
      no ledger entry in this bundle asks for.
    location: >-
      src/components/workbench/SettingsCanvas.tsx (vectorSearchEnabled hint)
    severity: low
  - summary: >-
      `textRow` never appends the read-only sentence through `describedBy()`,
      unlike every other refusable control on the surface.
    evidence: |-
      `providerRow`, the embedding-provider select and the vector checkbox all
      wrap their hint id in `describedBy(...)`, which appends
      `SETTINGS_READ_ONLY_COPY` on a read-only deployment; `textRow` hardcodes
      `aria-describedby={hint ? hintId : undefined}`. Pre-existing for all seven
      text rows. This bundle made the gap slightly more visible by giving the
      embedding-model row a complaint (the mark itself is now suppressed under
      `readOnly`), but the fix belongs to every text row at once.
    location: >-
      src/components/workbench/SettingsCanvas.tsx:textRow
    severity: low
  - summary: >-
      With `EMBEDDING_PROVIDER=workers-ai` the binding refusal advises choosing
      another embedding provider, which the env-locked select cannot do.
    evidence: |-
      `mergedVectorInputs` and `draftVectorInputs` both take
      `envEmbeddingProvider` ahead of anything stored or typed, so the provider
      leg can be owned by the environment exactly as the model leg can —
      but `VectorSearchInputs` gained an origin field for the MODEL only, which
      is what this bundle's intent asked for. Naming `EMBEDDING_PROVIDER` in the
      binding note would need a second origin field, the same shape change
      DW-218 made for the model.
    location: >-
      src/lib/workbench-settings.ts (SETTINGS_VECTOR_BINDING_NOTE) with
      mergedVectorInputs
    severity: low
---

<intent-contract>

## Intent

**Problem:** The vector-search gate refuses on a surface that cannot act on the refusal. An `EMBEDDING_MODEL` override wins over anything typed or stored in all three feeders, yet the sentence names only the namespace, never the variable, so a typed `@cf/` id cannot lift the refusal and nothing tells the owner why (DW-218). Because `settingsSaveBody` always carries `vectorSearchEnabled`, `validateWorkbenchSettingsPatch` re-runs the whole rule on every save, so a deployment already storing a mismatch is answered 400 for a chat-model or timeout edit (DW-219). The complaint is announced only as the vector checkbox's `aria-describedby`, while the embedding-model input that holds the wrong value carries no `aria-invalid` and no description — and changing the provider select, which touches neither, is the ordinary way into the state (DW-223). And `vectorSearchMissingLegs` treats `workers-ai` as self-transporting with no binding leg, so on Docker the switch turns on for a deployment where `resolveEmbeddingProvider` always returns `null` (DW-225).

**Approach:** Give `VectorSearchInputs` two new inputs — `modelOrigin` (`"env" | "stored"`) and `hasWorkersAiBinding` (`boolean | null`, `null` = not knowable here) — and turn `vectorSearchMissingLegs` into structured legs carrying a field id, a phrase and an optional note. The refusal sentence then appends an `EMBEDDING_MODEL` note when the env owns the mismatch and a binding note when Workers AI cannot reach one; a new `vectorSearchModelIssue` lets the model input carry its own description and `aria-invalid`. `validateWorkbenchSettingsPatch` re-runs the predicate only when the patch actually MOVES a vector input or turns the switch on. The binding fact is server-known: the settings route reads `getWorkersAiBinding()` and hands it to `getWorkbenchSettings`/`workbenchSettingsStored`, so both halves of the one rule see it.

## Boundaries & Constraints

**Always:**
- `canEnableVectorSearch` stays the ONE rule with two callers answering identically for identical situations; the client/server agreement test keeps passing for every situation in its table.
- `workbench-settings.ts` stays client-safe: it imports nothing from `embeddings.ts`, `config.ts` or any Node builtin. The binding fact arrives as data on the payload, never as a call.
- `config.ts` does not import `embeddings.ts` — that is a cycle. The route is the one caller that knows the binding, and it passes it in.
- Every constructor of `VectorSearchInputs` sets both new fields explicitly; neither has a default. `hasWorkersAiBinding: null` means "not knowable here" and the binding leg is NOT applied.
- The binding leg fires only for `provider === "workers-ai"` with `hasWorkersAiBinding === false`.
- Turning the vector switch OFF is always allowed, and an unrelated edit never rewrites the stored flag.
- `aria-invalid` marks the embedding-model input only when the box's OWN value is the wrong one — a mismatch with `modelOrigin: "stored"`. An env-owned mismatch describes without marking, because the box is not what is wrong.
- The model-field description is the model leg's sentence only; the `EMBEDDING_MODEL` note stays on the checkbox sentence, since the model row already carries `settingsEnvOverrideCopy`.

**Block If:** the client and the route would have to disagree for any situation in the agreement table — that is the invariant this seam exists to hold, and it cannot be traded unattended.

**Never:**
- Do not teach `hasEmbeddingSupport()` or the embed path the vector gate — Story 2.9 and Story 3.4 own that.
- Do not move `getWorkersAiBinding` out of `embeddings.ts`, and do not add a runtime parameter to `getVectorSearchSettings` — it passes `null` and documents why.
- Do not change env-over-typed precedence in either feeder; DW-218 is a shape and copy change, not a precedence change.
- Do not decide "touched a vector field" by key PRESENCE — `settingsSaveBody` always sends every non-secret field, so presence would fix nothing.
- Do not widen the owner gate, the read-only switch, or the write-precondition vocabulary.
- Do not add a second embedding-model field, and do not show an env value in an editable box.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Env owns the mismatch | `EMBEDDING_MODEL=text-embedding-3-small`, provider `workers-ai` | refusal names the supported ids AND `EMBEDDING_MODEL` | 400 on a save that turns it on |
| Typed id cannot lift it | same, plus a typed `@cf/baai/bge-m3` | still refused, same sentence — precedence unchanged | 400 |
| Stored owns the mismatch | config `embeddingModel: "text-embedding-3-small"`, provider `workers-ai`, no env | refusal names the supported ids and NOT `EMBEDDING_MODEL` | 400 |
| Unrelated edit over a stored mismatch | stored: vector on + mismatch; patch moves only `chatModel` | 200, saved; stored flag unchanged | No 400 |
| Edit that moves a vector input | same stored state; patch changes `embeddingProvider` | gate re-runs; refused while still unmet | 400 with the sentence |
| Turning it on | stored flag `false`, patch `true`, legs unmet | gate runs, refused | 400 |
| Turning it off over a mismatch | stored: vector on + mismatch; patch `false` | 200, saved | No 400 |
| Workers AI without a binding | provider `workers-ai`, supported id, `hasWorkersAiBinding: false` | refused, sentence names the Cloudflare AI binding | 400 on save |
| Workers AI with a binding | same, `hasWorkersAiBinding: true` | allowed, ordinary hint | No error expected |
| Binding unknown | `getVectorSearchSettings()` inputs (`hasWorkersAiBinding: null`) | binding leg not applied — today's answer exactly | No error expected |
| Model field, stored mismatch | rendered Embeddings category | model input has `aria-invalid="true"` and a description carrying the model sentence | No error expected |
| Model field, env mismatch | `envEmbeddingModel` set and mismatched | model input described with the model sentence beside the env sentence, NOT `aria-invalid` | No error expected |
| Model field, matching id | provider and id agree | no `aria-invalid`, no complaint in the description | No error expected |
| Missing provider | provider unset, anything else | one leg only ("an embedding provider"); no model complaint, no `aria-invalid` | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts:421-427` -- `VectorSearchInputs`; gains `modelOrigin` and `hasWorkersAiBinding`.
- `src/lib/workbench-settings.ts:477-540` -- `canEnableVectorSearch`, `vectorSearchMissingLegs` (private, returns `string[]` today), `vectorSearchMissingCopy`. Legs become structured; copy appends notes; `vectorSearchModelIssue` is added beside them. `SELF_TRANSPORTING_EMBEDDING_PROVIDERS` at `:435-441` still exempts `workers-ai` from endpoint/key — the binding leg is separate.
- `src/lib/workbench-settings.ts:165-199` -- the copy block (`SETTINGS_VECTOR_HINT_COPY`, `SETTINGS_VECTOR_PROVIDER_COPY`, `settingsEnvOverrideCopy`); the two new notes belong here.
- `src/lib/workbench-settings.ts:583-592` -- `WorkbenchSettingsStored` gains `hasWorkersAiBinding: boolean`; `:275-311` `WorkbenchSettingsPayload` gains the same, and `isWorkbenchSettingsPayload` at `:365-402` must require it as a boolean.
- `src/lib/workbench-settings.ts:686-696` -- the `enabled` branch in `validateWorkbenchSettingsPatch`: the DW-219 site. `mergedVectorInputs` at `:705-745` is the private route-half feeder.
- `src/lib/workbench-settings.ts:901-925` -- `draftVectorInputs`, the browser half; reads `payload.envEmbeddingModel` (origin) and will read `payload.hasWorkersAiBinding`.
- `src/lib/config.ts:948-987` -- `getWorkbenchSettings()`: takes the runtime fact as a parameter and reports it. `:998-1011` `workbenchSettingsStored(cfg)`: same, second parameter.
- `src/lib/config.ts:815-826` -- `getVectorSearchSettings` builds a `VectorSearchInputs` literal; add `modelOrigin` (env-over-config, matching its own `??`) and `hasWorkersAiBinding: null`. Return the four declared fields explicitly rather than spreading the inputs, so the new ones do not leak onto `VectorSearchSettings`.
- `src/app/api/settings/route.ts:87, 333-336, 361` -- the two payload spreads and the validator call; the one place `getWorkersAiBinding()` is read. Import it from `@/lib/embeddings` (server-only route; no cycle).
- `src/lib/embeddings.ts:56-73` -- `getWorkersAiBinding()`: `null` off the Workers runtime, silent by design; warns when on Workers with `AI` unbound.
- `src/components/workbench/SettingsCanvas.tsx:280-311` -- `textRow`; gains an `invalid` argument driving `aria-invalid`. `:240-247` computes `vectorInputs`/`vectorAllowed`/`vectorBlocked`/`vectorRefused` — `vectorSearchModelIssue(vectorInputs)` joins them. `:470-484` is the `embeddingModel` row with its env hint. `:519` is the checkbox hint span.
- `src/lib/__tests__/workbench-settings.test.ts:214-241` (`emptyPayload`), `:742-747` (`storedState`), `:960-1005` (client/server agreement table), `:1016-1103` (env-override suite, asserts the refusal verbatim) -- every fixture and assertion touched by the new fields and copy.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:485-530, 580-607` -- `getVectorSearchSettings`/`getWorkbenchSettings` call sites needing the new argument.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx:23-47` -- the DOM payload fixture (provider `workers-ai`) needs `hasWorkersAiBinding: true`; `announcedFor` is the helper to reuse for the model input. `src/components/workbench/__tests__/settings-read-only.test.tsx` carries a second payload fixture.
- `DEPLOY.md:60-67, 100-112` -- states the off-Workers binding is dropped silently and lists what the Settings surface refuses; both change.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- add `modelOrigin` and `hasWorkersAiBinding` to `VectorSearchInputs`; make `vectorSearchMissingLegs` return `{ field, phrase, note? }`; add the binding leg and the two note constants; have `vectorSearchMissingCopy` append the notes; export `vectorSearchModelIssue(v): { copy, invalid } | null` -- the refusal has to name the thing that owns it and the field that holds it (DW-218/223/225).
- `src/lib/workbench-settings.ts` -- add `hasWorkersAiBinding` to `WorkbenchSettingsPayload`, `WorkbenchSettingsStored` and `isWorkbenchSettingsPayload`; set both new inputs in `mergedVectorInputs` and `draftVectorInputs` -- both halves of the one rule must see the same two facts or they answer differently (DW-225).
- `src/lib/workbench-settings.ts` -- in `validateWorkbenchSettingsPatch`, run the gate only when the switch is turning ON or the merged vector inputs differ from the stored-only ones (compare field by field) -- a timeout edit must not be refused by a mismatch it did not create (DW-219).
- `src/lib/config.ts` -- take the runtime fact as a parameter on `getWorkbenchSettings` and `workbenchSettingsStored`; set `modelOrigin` and `hasWorkersAiBinding: null` in `getVectorSearchSettings`, documenting why it cannot know -- the cycle is what keeps the binding read in the route (DW-225).
- `src/app/api/settings/route.ts` -- read `getWorkersAiBinding() !== null` once per request and pass it to both resolvers, on GET and on PUT -- the server knows; the browser cannot.
- `src/components/workbench/SettingsCanvas.tsx` -- give `textRow` an `invalid` argument wired to `aria-invalid`, and pass the model issue's copy (appended to the env hint) and invalid flag on the `embeddingModel` row -- the ordinary way into this state is an edit to a control that shows no error at all (DW-223).
- `src/lib/__tests__/workbench-settings.test.ts` -- update the fixtures and the env-override assertions to the new copy; add cases for the binding leg (both directions), the env-owned note, `vectorSearchModelIssue`'s three answers, and the DW-219 rows (unrelated edit accepted, vector-field edit still refused, turning on still refused, turning off accepted).
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- update the call sites; pin that a `workers-ai` deployment with no binding is refused end to end through the route.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- add `hasWorkersAiBinding` to the fixture; add mounted cases asserting the model input's `aria-invalid` and announced description for the stored-mismatch, env-mismatch and matching cases -- a node suite reading source cannot observe which span reaches which control.
- `DEPLOY.md` -- record that the Workbench vector switch now refuses `workers-ai` off Workers by naming the Cloudflare AI binding, and that a refusal owned by `EMBEDDING_MODEL` says so -- this is the document that currently promises the drop is silent.

**Acceptance Criteria:**
- Given `workbench-settings.ts` after the change, when its import graph is inspected, then it still imports nothing from `embeddings.ts`, `config.ts` or any Node builtin, and `config.ts` still imports nothing from `embeddings.ts`.
- Given the client/server agreement table, when each situation is evaluated on both halves, then the browser's answer equals the route's for every one, including the binding and origin situations.
- Given a deployment storing a namespace mismatch with vector search on, when a save moves only `chatModel` or `llmTimeoutSeconds`, then it is answered 200 and the stored flag is unchanged; and when the same save also moves an embedding field, then it is answered 400 with the refusal sentence.
- Given the whole suite, when `pnpm test`, `pnpm lint` and `npx tsc --noEmit` run, then all pass with no test deleted to accommodate the change.

## Design Notes

"Touches a vector-relevant field" cannot be read as key presence: `settingsSaveBody` sends `vectorSearchEnabled`, `embeddingProvider`, `embeddingModel` and `embeddingBaseUrl` on every save, so a presence test would re-run the gate exactly as often as today. It is a VALUE test — the merged inputs against the stored-only ones:

```ts
const before = mergedVectorInputs({}, stored);      // what the store already holds
const after = mergedVectorInputs(patch, stored);    // what it will hold
const turningOn = enabled && !stored.vectorSearchEnabled;
if ((turningOn || !vectorInputsEqual(before, after)) && !canEnableVectorSearch(after)) {
  return { ok: false, error: vectorSearchMissingCopy(after) };
}
```

Nothing escapes through the skip: `getVectorSearchSettings()` still intersects the stored flag with the predicate, so a mismatch that stays stored still reads as OFF to consumers.

`hasWorkersAiBinding` is tri-state on `VectorSearchInputs` and two-state everywhere else. The route and the browser both know the answer; `getVectorSearchSettings` reads the config cache inside `config.ts`, which cannot import `embeddings.ts` without a cycle, so it passes `null` and the leg does not apply there — the embed path already refuses independently, since `resolveEmbeddingProvider` returns `null` with no binding.

## Verification

**Commands:**
- `npx eslint` -- expected: clean (exit 0). NOT `pnpm lint`: `pnpm run` fails in this repo with `ERROR packages field missing or empty`.
- `npx tsc --noEmit` -- expected: no errors.
- `npx vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/settings-route.test.ts src/components/workbench/__tests__/settings-vector-namespace.test.tsx src/components/workbench/__tests__/settings-read-only.test.tsx` -- expected: all pass.
- `npx vitest run` -- expected: the full suite passes with no new failures against the baseline (`pnpm test` fails for the same `packages field missing or empty` reason).

## Auto Run Result

Status: done

### Summary

The vector-search gate now explains itself where the owner can act on it, and
refuses one state it used to wave through. `VectorSearchInputs` gained two
inputs — `modelOrigin` (`"env" | "stored"`) and `hasWorkersAiBinding`
(`boolean | null`, `null` = not knowable here) — and `vectorSearchMissingLegs`
returns structured legs (`{ field, phrase, note? }`) instead of bare phrases. A
refusal the environment owns now names `EMBEDDING_MODEL`, so an owner stops
typing into a box the gate never reads (DW-218). The model leg is offered
separately through `vectorSearchModelIssue`, so the embedding-model input
carries its own description and — only when the box's OWN value is the wrong
one, and only on a writable deployment — `aria-invalid`, instead of the
complaint living solely on a checkbox three rows down (DW-223).
`validateWorkbenchSettingsPatch` re-runs the predicate only when the save turns
the switch on or actually MOVES one of the values the rule reads, compared
against the pre-request store, so a chat-model or timeout edit is no longer
answered 400 by a mismatch it did not create (DW-219). And `workers-ai` now
carries a binding leg: the route reads `getWorkersAiBinding()` once per request
and hands the same boolean to both halves of the one rule, so the switch cannot
be turned on for a deployment where `resolveEmbeddingProvider` returns `null`
forever (DW-225).

### Files changed

- `src/lib/workbench-settings.ts` -- the two new inputs, structured legs, the
  binding leg, the two note constants, `vectorSearchModelIssue`, the
  patch-scoped gate with its `baseline` parameter, and `hasWorkersAiBinding` on
  the payload/stored types and the type guard.
- `src/lib/config.ts` -- `getWorkbenchSettings` and `workbenchSettingsStored`
  take the runtime fact as a required parameter; `getVectorSearchSettings`
  spells `hasWorkersAiBinding: null` and returns its four declared fields
  explicitly.
- `src/app/api/settings/route.ts` -- one `getWorkersAiBinding()` read per
  request on GET and PUT, handed to both resolvers, plus the pre-request
  baseline for the patch-scoped gate.
- `src/components/workbench/SettingsCanvas.tsx` -- `textRow` gained an `invalid`
  argument wired to `aria-invalid` (suppressed on a read-only deployment); the
  embedding-model row composes the env sentence with the model complaint.
- `DEPLOY.md` -- the Workbench refusal for a missing `AI` binding, the
  `EMBEDDING_MODEL`-owned refusal, the DW-219 scoping, and the legacy-flat-path
  caveats.
- `src/lib/__tests__/workbench-settings.test.ts`,
  `src/lib/__tests__/settings-runtime-wiring.test.ts`,
  `src/components/workbench/__tests__/settings-vector-namespace.test.tsx`,
  `src/components/workbench/__tests__/settings-read-only.test.tsx` -- fixtures
  for the new field and coverage for every I/O matrix row plus the review's
  patches.

### Review findings breakdown

- Patches applied: 12 (high 0, medium 4, low 8)
- Items deferred: 5 (all low) — recorded in frontmatter `deferred`
- Items rejected: 7
- Follow-up review recommended: **true** — patched severities high 0, medium 4,
  low 8; score `3 × 4 + 1 × 8 = 20`, which is at or above 5.

### Verification performed

- `npx tsc --noEmit` -- exit 0, no output.
- `npx eslint` -- exit 0 (three pre-existing `jsx-ast-utils` TSNonNullExpression
  notices, unchanged from the baseline).
- `npx vitest run` -- 246 files / 5201 tests, all pass. No test deleted; one
  pre-existing case (`refuses an UNRELATED edit while the STORED config holds a
  mismatch`) was rewritten in place to the behaviour DW-219 asks for.
- Matrix audit: every I/O row has at least one covering test that ran and
  passed, including the DOM cases for the model input's `aria-invalid` and
  announced description.
- Two review findings were mutation-checked: hardcoding `false` for the GET
  binding read, and dropping the new `baseline` argument, each now fail a test.

### Residual risks

- **The spec's import-graph acceptance criterion is not literally satisfiable.**
  It says `config.ts` still imports nothing from `embeddings.ts`, but
  `src/lib/config.ts:2` has imported `hasEmbeddingSupport` from `./embeddings`
  since long before this bundle. The behavioural constraint the criterion stood
  for was honoured — no new coupling, `getVectorSearchSettings` takes no runtime
  parameter — and the in-code rationale was rewritten to the true one (a sync
  cache read may run outside a Workers request scope, where
  `getCloudflareContext()` throws and `false` would be a misleading answer). The
  `<intent-contract>` bullet stating the cycle claim is read-only and was left
  as written.
- **`isWorkbenchSettingsPayload` now requires `hasWorkersAiBinding`.** A browser
  bundle running against an older server build rejects the payload and shows the
  load-failed sentence. Deliberate — neither default is safe — but it makes
  client and server non-interchangeable across this change.
- **The binding leg has no effective-read counterpart.** `getVectorSearchSettings`
  passes `null`, so a stored `workers-ai` + switch-on Docker deployment still
  reads `enabled: true` there. Harmless today (that resolver has no production
  consumer; Stories 2.9 and 3.4 own the embed and search paths, and the embed
  path refuses independently), and pinned by a test so the boundary is visible
  rather than accidental.
- **The legacy flat `PUT /api/settings` path never enters this gate**, so a
  `workers-ai` selection or a mismatched model saved from the older `/settings`
  page is still stored silently. Pre-existing, now documented in DEPLOY.md for
  the binding rule as well as the model rule.
