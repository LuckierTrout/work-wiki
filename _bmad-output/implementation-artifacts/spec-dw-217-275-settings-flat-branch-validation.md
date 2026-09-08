---
title: 'Flat PUT /api/settings validates and normalizes what it stores (DW-217, DW-275)'
type: 'bugfix'
created: '2026-08-20'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The flat branch can now be refused for vector legs no flat field can satisfy
      (endpoint, API key, Workers AI binding), and the legacy /settings page has no
      control for any of them.
    evidence: |-
      `vectorSearchMissingLegs` reads provider, endpoint, model, key and binding, but the
      flat vocabulary carries only `embeddingProvider` and `embeddingModel`, and
      `src/hooks/useSettings.ts` renders no embedding-provider, endpoint or key control at
      all. On a deployment already storing an unsatisfied vector config (say openai with no
      endpoint), an owner editing the embedding model from /settings now gets "Vector
      search needs an endpoint and an API key before it can be turned on." from a page with
      no endpoint box. The Workbench surface is the way out, so it is not a dead end, but
      the refusal names fields the surface that produced it cannot show. Closing it would
      mean either scoping the flat refusal to legs the request could have moved, or serving
      `VectorSearchLeg.field` on the response so the surface can say something actionable.
    location: >-
      src/app/api/settings/route.ts:390-410
    severity: medium
  - summary: >-
      The flat `ollamaBaseUrl` is stored with no absolute-http validation, unlike every
      endpoint in the `workbench` patch.
    evidence: |-
      `validateWorkbenchSettingsPatch` refuses `customBaseUrl`, `embeddingBaseUrl` and
      `firecrawlBaseUrl` unless `isAbsoluteHttpUrl(raw.trim())`. The flat branch type-checks
      only, so `"not-a-url"` or a `file:` URL is stored and `getOllamaBaseUrl()`
      (src/lib/config.ts:239) hands it straight to the provider SDK. Pre-existing; this
      bundle's intent named only the trim.
    location: >-
      src/app/api/settings/route.ts:311-327
    severity: medium
  - summary: >-
      `structuredKnowledgeModel` is the one flat text field still deciding its delete on the
      literal empty string rather than on the trimmed value.
    evidence: |-
      It already trims on store, and the non-empty check above answers 400 for a
      whitespace-only value, so there is no observable difference today. It is a uniformity
      gap rather than a defect: `model`, `ollamaBaseUrl` and `embeddingModel` now all decide
      the delete on `trimmed.length === 0`.
    location: >-
      src/app/api/settings/route.ts:290-305
    severity: low
  - summary: >-
      A body carrying BOTH a flat legacy field and a `workbench` key -- the only case
      `validateWorkbenchSettingsPatch`'s `baseline` parameter exists for -- has no test at
      any surface.
    evidence: |-
      DW-219 added the third `baseline` argument precisely so a flat move in the same request
      is measured against what the store held BEFORE the request rather than against itself.
      Every test in `settings-route.test.ts` and `workbench-settings.test.ts` sends the flat
      move and the nested move as separate requests, so the argument that justifies the
      parameter is unexercised. Pre-existing since DW-219; this change widened the
      parameter's role without adding the case.
    location: >-
      src/lib/workbench-settings.ts:790
    severity: medium
baseline_revision: '4e526563fbcdf75ea253085c9d34fbfe89656fa9'
---

<intent-contract>

## Intent

**Problem:** The legacy flat branch of `PUT /api/settings` writes `embeddingModel` and `embeddingProvider` straight into the config while the vector gate runs only inside `if (body.workbench !== undefined)`, so a flat-only save can move a vector input into a state `canEnableVectorSearch` rejects, answer 200, and silently switch effective vector search off (DW-217). In the same branch `body.model` and `body.ollamaBaseUrl` are still stored raw where every neighbouring text field now trims, and `getOllamaBaseUrl()` reads the padded value back (DW-275).

**Approach:** Run the one existing vector rule over the post-legacy-merge config on the flat path too — validate with an empty `workbench` patch when the key is absent, keeping `existing` as the DW-219 baseline so only a request that actually MOVES a vector input is gated — and trim `model` and `ollamaBaseUrl` at the door exactly as `embeddingModel` and `structuredKnowledgeModel` already do.

## Boundaries & Constraints

**Always:** Reuse `validateWorkbenchSettingsPatch` / `canEnableVectorSearch` — the refusal sentence must be the one the Workbench surface shows, produced by `vectorSearchMissingCopy`, never re-typed at the route. Keep `existing` (pre-request state) as the third `baseline` argument so DW-219's "only when the request moves a vector input" skip still holds. Keep `applyWorkbenchSettings` conditional on `body.workbench !== undefined`, so a flat body that passes still saves a byte-identical object. Refuse before `saveConfig` — a rejected flat save leaves the store untouched. Whitespace-only trims to a DELETE, matching `embeddingModel`'s existing branch.

**Block If:** The gate cannot be re-run over the flat path without duplicating the rule or without changing what a `workbench`-carrying body does.

**Never:** Do not touch `src/hooks/useSettings.ts` or the `/settings` page — DW-61's 2026-08-18 decision keeps that surface. Do not add a second copy of the refusal wording. Do not widen the gate to fields the flat branch cannot move (`embeddingBaseUrl`, `embeddingApiKey`). Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DW-217 repro | Stored `{vectorSearchEnabled:true, embeddingProvider:"workers-ai", embeddingModel:"@cf/baai/bge-m3"}`, binding present; flat PUT `{embeddingModel:"text-embedding-3-small"}`, no `workbench` key | 400 with `vectorSearchMissingCopy` of the merged inputs (names a supported Workers AI model id); `saveConfig` never called | 400, store unchanged |
| Flat move that still satisfies the gate | Same stored state; flat PUT `{embeddingModel:"@cf/baai/bge-large-en-v1.5"}` | 200, saved with the new model | No error expected |
| Untouched vector inputs | Stored state with a vector mismatch already on disk; flat PUT `{model:"gpt-4o"}` | 200 — no vector input moved, so the gate is skipped (DW-219) | No error expected |
| Vector search off | Stored `{vectorSearchEnabled:false}` or absent; flat PUT `{embeddingModel:"anything"}` | 200, saved | No error expected |
| Workbench body unchanged | Body carrying a `workbench` key | Identical behavior and identical refusals to today | Unchanged |
| DW-275 model trim | Flat PUT `{model:"  gpt-4o  "}` | 200, saved as `model: "gpt-4o"` | Whitespace-only already refused 400 by the existing non-empty check |
| DW-275 ollamaBaseUrl trim | Flat PUT `{ollamaBaseUrl:"  http://h:11434/api "}` | 200, saved as `"http://h:11434/api"` | — |
| DW-275 blank ollamaBaseUrl | Stored `ollamaBaseUrl`; flat PUT `{ollamaBaseUrl:"   "}` | 200, key DELETED (as `""` and `null` already do) | — |

</intent-contract>

## Code Map

- `src/app/api/settings/route.ts` -- the whole change. Flat merge branches: `model` :278-284, `ollamaBaseUrl` :306-312, `embeddingModel` :314-333 (the trim precedent, with its non-string 400 at :218-226). The gate lives at :360-374 inside `if (body.workbench !== undefined)`; `hasWorkersAiBinding` is read once at :127.
- `src/lib/workbench-settings.ts` -- `validateWorkbenchSettingsPatch(value, stored, baseline = stored)` :790; the vector rule and the DW-219 move-comparison at :896-918; `vectorSearchMissingCopy` :645; `canEnableVectorSearch` :557; `mergedVectorInputs` :967. An empty patch `{}` passes every field check and falls straight through to the vector rule — that is the reuse point.
- `src/lib/config.ts` -- `workbenchSettingsStored(cfg, hasWorkersAiBinding)` :1042 builds the gate's view of a config; `applyWorkbenchSettings` :1074 (`setText` :1080 is the trim precedent DW-275 mirrors); `getOllamaBaseUrl()` :239 reads `cfg.ollamaBaseUrl` back with no trim.
- `src/lib/embeddings.ts` -- `getWorkersAiBinding()` :56 returns `null` off Workers, so the route's `hasWorkersAiBinding` is `false` under vitest unless the module is mocked. The DW-217 route test must mock `@/lib/embeddings` to keep the refusal about the MODEL leg rather than the binding leg.
- `src/lib/__tests__/settings-route.test.ts` -- where the reproduction is pinned. Mocks `@/lib/auth`, `@/lib/owner` and partially `@/lib/config` (real `workbenchSettingsStored`); `request(body, {ifMatch})` helper :56, `STORED_VERSION` :44. Existing flat `embeddingModel` trim/delete tests :237-296 must keep passing.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- exercises the `workbench` PUT path (`turnVectorSearchOn` :183-196); read-only evidence that the nested path must not change.
- `src/hooks/useSettings.ts` :225-260 -- READ ONLY. Sends the flat shape and already trims client-side; only sends `embeddingModel` when non-empty and never sends `embeddingProvider`, so an unrelated `/settings` save leaves the vector inputs equal and skips the gate.

## Tasks & Acceptance

**Execution:**
- `src/app/api/settings/route.ts` -- trim `body.model` and `body.ollamaBaseUrl` in their merge branches the way `embeddingModel` does (whitespace-only deletes the key), and comment why, naming `getOllamaBaseUrl()` -- DW-275: the store must not hold a padded value the reader takes literally.
- `src/app/api/settings/route.ts` -- always call `validateWorkbenchSettingsPatch`, passing `{}` when `body.workbench` is absent, with `workbenchSettingsStored(updated, hasWorkersAiBinding)` as `stored` and `workbenchSettingsStored(existing, hasWorkersAiBinding)` as `baseline`; return 400 with `validation.error` on failure; call `applyWorkbenchSettings` only when the key was present -- DW-217: one rule, both branches, and a flat body that passes still saves the identical object.
- `src/lib/__tests__/settings-route.test.ts` -- add tests for every I/O Matrix row, mocking `@/lib/embeddings`'s `getWorkersAiBinding` so binding presence is chosen per test -- pins the DW-217 reproduction and the DW-275 normalization.

**Acceptance Criteria:**
- Given a config storing a satisfied vector configuration, when a flat PUT moves a vector input into a state `canEnableVectorSearch` rejects, then the response is 400 carrying exactly `vectorSearchMissingCopy` of the merged inputs and `saveConfig` was not called.
- Given the same refusal, when the identical body is sent as a `workbench` patch instead, then the error sentence is byte-identical.
- Given a stored config that already fails the gate, when a flat PUT changes only a non-vector field, then the response is 200 and the save lands.
- Given a body carrying a `workbench` key, when it is PUT, then status, error sentence and saved object are unchanged from before this change.
- Given `pnpm test` and `pnpm lint`, when run, then both pass.

## Spec Change Log

## Review Triage Log

### 2026-08-20 -- Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 4: (high 0, medium 3, low 1)
- reject: 11: (high 0, medium 2, low 9)
- addressed_findings:
  - `[medium]` `[patch]` The removal half of the closed hole was unpinned -- the gate now refuses a flat `embeddingModel`/`embeddingProvider` DELETION while vector search is on, where all four previously answered 200, and every new test moved a vector input to a non-empty value instead. Added three cases in the DW-217 describe (deletion refused for null, empty and whitespace; provider deletion refused; both allowed once vector search is off) and annotated the two pre-existing delete tests to say they land because their store has no `vectorSearchEnabled`.
  - `[medium]` `[patch]` The real-store test had been re-scenarioed away from the ledger's verbatim reproduction. Added "REFUSES the ledger's verbatim DW-217 reproduction against the real store" in `workbench-settings.test.ts` -- `onWorkers()`, the exact stored `workers-ai`/`@cf/baai/bge-m3` config, the exact flat PUT, asserting 400, an unchanged store and `getVectorSearchSettings().enabled` still `true`.
  - `[low]` `[patch]` `src/lib/embeddings.ts` justified `resolveEmbeddingModelName`'s silent fallback by naming the flat branch as an ungated path -- stale as of this change. Rewritten so the paragraph rests on the two entries that stay true.
  - `[low]` `[patch]` `body.workbench === undefined` was written twice, inverted. Hoisted to one `hasWorkbenchKey` const.
  - `[low]` `[patch]` Test hermeticity: `envEmbeddingApiKeyProviders()` reads `OPENAI_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY`, which a developer's shell could set and move the key leg. Both now stubbed alongside the two `EMBEDDING_*` vars, and `{} as never` replaced with a typed `Ai` cast.

## Design Notes

The two branches collapse into one call rather than two:

```ts
const validation = validateWorkbenchSettingsPatch(
  body.workbench === undefined ? {} : body.workbench,
  workbenchSettingsStored(updated, hasWorkersAiBinding),
  workbenchSettingsStored(existing, hasWorkersAiBinding),
);
if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 });
const merged =
  body.workbench === undefined ? updated : applyWorkbenchSettings(updated, validation.patch);
```

An empty patch clears every field check in `validateWorkbenchSettingsPatch` (each one `continue`s on `undefined`) and reaches the vector rule with `enabled = stored.vectorSearchEnabled` — the flat branch cannot move that flag. `turningOn` is therefore always `false` on this path, so the gate fires purely on `!vectorInputsEqual(current, merged)`: exactly "this flat request moved something the rule reads".

## Verification

**Commands:**
- `pnpm test src/lib/__tests__/settings-route.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/workbench-settings.test.ts` -- expected: all pass, including the new DW-217 and DW-275 cases
- `pnpm test` -- expected: full suite passes with no new failures
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done

**Implemented change.** `PUT /api/settings` now runs the ONE vector rule over the post-legacy-merge config on both branches. `validateWorkbenchSettingsPatch` is called unconditionally with `{}` as the patch when the body carries no `workbench` key, `workbenchSettingsStored(updated, …)` as `stored` and `workbenchSettingsStored(existing, …)` as the DW-219 `baseline`; a failure answers 400 with `validation.error` before `saveConfig`. `applyWorkbenchSettings` stays conditional on the key, so a flat body that passes saves the byte-identical object it did before. The legacy `model` and `ollamaBaseUrl` fields now trim on the way in, whitespace-only deleting the key, matching `embeddingModel`'s branch.

**Files changed.**
- `src/app/api/settings/route.ts` -- gate hoisted out of the `workbench` branch (DW-217); `model` and `ollamaBaseUrl` trimmed at the door (DW-275).
- `src/lib/embeddings.ts` -- `resolveEmbeddingModelName`'s fallback comment no longer names the flat branch as an ungated path; it was closed by this change.
- `src/lib/__tests__/settings-route.test.ts` -- `getWorkersAiBinding` mocked per test, env stubbed for the four variables the gate reads, and two new describes covering every I/O-matrix row plus the deletion refusals.
- `src/lib/__tests__/workbench-settings.test.ts` -- the flat-branch characterization test rewritten as a refusal, the ledger's verbatim reproduction pinned against the real store, and a DW-219 pass-through case added.

**Review findings.** 5 patches applied (2 medium, 3 low -- see the Review Triage Log), 4 items deferred (3 medium, 1 low -- see frontmatter `deferred`), 11 rejected. Notable rejections: the claim that trim normalization could itself register as a vector-input "move" is false -- `workbenchSettingsStored` projects both sides through `nonEmpty`, which trims; the "before it can be turned on" tense complaint would break the parity with the Workbench sentence the intent explicitly demands; and extracting `applyWorkbenchSettings`'s `setText` for the flat fields is a pre-existing shape DW-221 chose deliberately.

**Follow-up review recommendation.** true. Patched counts: high 0, medium 2, low 3. Score = 3 x 2 + 1 x 3 = 9, which is >= 5.

**Verification.** `./node_modules/.bin/vitest run` -- 252 files / 5341 tests passed, 0 failures. `./node_modules/.bin/eslint` -- exit 0. `./node_modules/.bin/tsc --noEmit` -- exit 0. The spec's literal `pnpm test` / `pnpm lint` cannot run on this machine: a stray `/Users/christianlee/pnpm-workspace.yaml` makes pnpm treat the repo as part of an empty workspace and both fail with `ERROR packages field missing or empty`. Pre-existing and unrelated to this change; the same commands were run through the local binaries instead.

**Residual risks.** A `/settings` save that edits the embedding model on a deployment whose stored vector configuration was already unsatisfied now answers 400 naming legs that page has no control for -- deferred above as the one behavioural sharp edge. Clearing `embeddingModel` or `embeddingProvider` from the flat branch while the vector switch is stored on is likewise now a 400 where it was a 200; that is the same answer the Workbench branch already gave, and it is pinned by test.
