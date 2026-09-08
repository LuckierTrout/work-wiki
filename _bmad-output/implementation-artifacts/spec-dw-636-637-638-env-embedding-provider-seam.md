---
title: 'DW-636/637/638: converge the env embedding-provider seam'
type: 'refactor'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
baseline_revision: '317bac91a6b22b09445019ca1aa1eedb6b4555e2'
---

<intent-contract>

## Intent

**Problem:** Three follow-ons to DW-552 on one seam. (a) `vectorSearchMissingLegs`' `provider` leg early-returns with no `note`, so on a deployment with a junk `EMBEDDING_PROVIDER` the refusal says "needs an embedding provider … supply what is missing" while the only fix is the variable. (b) `resolveEnvEmbeddingProvider` exists nowhere: "the env value wins, then the store" is spelled independently in `getVectorSearchSettings`, `mergedVectorInputs` and `draftVectorInputs`, and the raw `process.env.EMBEDDING_PROVIDER` read is spelled four times in `config.ts` — the same copy-drift shape that caused DW-552. (c) The DW-552 doc comments call `envEmbeddingProviderInvalid` and `envResearchProviderInvalid` "exact mirrors", which overstates it: the vector half joins and reports the junk value, the research half early-returns `false`.

**Approach:** Add one provider-leg env note (and suppress it on the provider row, which already names the variable). Extract one pure join helper used by both feeder halves, over one raw reader and one filtered/invalid split in `config.ts`. Qualify the mirror comments to state why the research predicate cannot join.

## Boundaries & Constraints

**Always:**
- The join stays `filtered ?? invalid` — filtered FIRST, so a supported value is unchanged in every existing situation and the wire-anomaly precedence (pin wins) is preserved.
- The provider-leg note appears only when `providerOrigin === "env"`, exactly as the model leg's note is gated on `modelOrigin`.
- The new note names `EMBEDDING_PROVIDER` and rides the refusal sentence; it is APPENDED, never substituted.
- `getVectorSearchSettings` keeps reading the variable RAW; only the spelling of that read is shared.

**Block If:**
- Removing a spelling would change any feeder's answer for any of the four variable states (unset, blank/whitespace, supported, junk).

**Never:**
- Do not change `settingsEnvProviderInvalidCopy`, `settingsEnvProviderPinCopy`, `SETTINGS_VECTOR_BINDING_ENV_NOTE` or the provider row's hint ladder.
- Do not change `draftResearchProvider`'s `ResearchProviderId` return type or the research predicate's behaviour — DW-637 is a comment change (see Design Notes).
- Do not touch `src/lib/embeddings.ts`' `resolveEmbeddingProvider` ladder, `envPinned` in `SettingsCanvas`, or the route's env-pin save refusal.
- Do not fold `envEmbeddingProviderInvalid` into `envEmbeddingProvider` on either the payload or the store.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Junk env provider, switch off | `EMBEDDING_PROVIDER=deepseek`, complete stored OpenAI config | `vectorSearchMissingCopy` = provider-leg sentence + the new note naming `EMBEDDING_PROVIDER`; route's 400 body carries both sentences | Route still refuses, now actionably |
| Junk env provider, switch already on | same, `vectorSearchEnabled: true` stored | `vectorSearchInactiveCopy` (both surfaces) = its own frame + the same note | Unchanged verdict |
| Junk env provider, provider ROW | same, `vectorSearchFieldIssue(v, "provider")` | `copy` is the leg sentence ALONE — the row already renders `settingsEnvProviderInvalidCopy`; `invalid` stays `false` | No duplicate variable sentence |
| Unset / stored-origin provider | `EMBEDDING_PROVIDER` unset, no stored provider | Every sentence byte-identical to today (no note) | No error expected |
| `workers-ai` from env, no binding | `EMBEDDING_PROVIDER=workers-ai`, no `AI` binding | Binding leg still carries `SETTINGS_VECTOR_BINDING_ENV_NOTE` on the provider control | Suppression must not reach the binding leg |
| Blank / whitespace variable | `EMBEDDING_PROVIDER=" "` | Both halves resolve `null`, `providerOrigin: "stored"` — `nonEmpty` is the single raw reader | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts:433` -- `EMBEDDING_PROVIDER_ENV`, the one variable-name constant the env sentences share. The new note must be declared AFTER it (module-init order); place it beside `settingsEnvProviderInvalidCopy` (:468).
- `src/lib/workbench-settings.ts:356` -- `SETTINGS_VECTOR_ENV_MODEL_NOTE`. The exact shape to model the new `SETTINGS_VECTOR_PROVIDER_ENV_NOTE` on: "That value comes from X, so …cannot lift this until that variable is unset."
- `src/lib/workbench-settings.ts:1571` -- `vectorSearchMissingLegs`. The provider leg early-returns at :1572; attach the note with the same `...(cond ? {note} : {})` spread the model leg uses at :1598. `providerOrigin === "env"` here implies a junk value, because a filtered env provider always passes `isEmbeddingProvider`.
- `src/lib/workbench-settings.ts:1920` -- `vectorSearchFieldIssue`. `copy` currently drops the note only for `control === "model"`. The `binding` leg ALSO maps to the `provider` control (`VECTOR_LEG_CONTROL`, :1753) and its note must survive — so the suppression must key on `leg.field`, not on `control`.
- `src/lib/workbench-settings.ts:1885` -- the JSDoc that states the "except for `model`" rule; extend it to name the provider leg and why (`settingsEnvProviderInvalidCopy` is already on that row).
- `src/components/workbench/SettingsCanvas.tsx:1117` -- the provider row hint: `settingsEnvProviderInvalidCopy(envInvalid)` joined with `vectorProviderIssue?.copy`. READ-ONLY evidence for the suppression above.
- `src/lib/workbench-settings.ts:2504` and `:3070` -- the two `filtered ?? invalid` joins (`mergedVectorInputs`, `draftVectorInputs`). Both call the new helper; both keep deriving `providerOrigin` from its result.
- `src/lib/workbench-settings.ts:2016` and `:1072` -- the two "exact mirror" doc comments (store field, payload field) to qualify.
- `src/lib/workbench-settings.ts:2974` -- `draftResearchProviderConfigured`'s `if (payload.envResearchProviderInvalid) return false`. The site that needs the "why it differs" comment.
- `src/lib/workbench-settings.ts:3005` -- `draftResearchProvider` returns `ResearchProviderId` (closed union) and its consumers branch on the value; that type is WHY no join exists. READ-ONLY.
- `src/lib/config.ts:1671`, `:1788`, `:2121`, `:2294` -- the four raw `nonEmpty(process.env.EMBEDDING_PROVIDER)` reads. Collapse to one reader plus one filtered/invalid pair builder; `getVectorSearchSettings` (:1658) keeps the raw read through the reader.
- `src/lib/config.ts:2116`/`:2176` and `:2274`/`:2293` -- the two constructors whose split expressions differ in spelling but are pinned equal by `settings-runtime-wiring.test.ts`; both become one `envEmbeddingProviderPair()` call.
- `src/lib/__tests__/workbench-settings.test.ts:2682`, `:2788` -- the DW-552 junk-provider assertions whose expected sentences gain the note.
- `src/lib/__tests__/settings-route.test.ts:1630` -- the handler's junk-variable refusal; gains the note. `:737` is stored-origin and must stay byte-identical.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx:863` -- the rendered switch's announcement on the junk deployment; gains the note. `:312`, `:740` are stored-origin and must not move.
- `src/lib/__tests__/workbench-settings.test.ts:1440`, `:1454` -- `vectorSearchFieldIssue` provider cases, both stored-origin; the reuse point for a new env-origin case.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- add `SETTINGS_VECTOR_PROVIDER_ENV_NOTE` and attach it to the `provider` leg when `providerOrigin === "env"` -- an env-owned refusal must name the only thing that can lift it.
- `src/lib/workbench-settings.ts` -- in `vectorSearchFieldIssue`, suppress a leg's note when the leg's OWNING ROW already carries the same variable's sentence (`model` today, `provider` now), keyed on `leg.field` so the `binding` leg's note still reaches the provider control -- one fact, once per screen.
- `src/lib/workbench-settings.ts` -- add `resolveEnvEmbeddingProvider(filtered, invalid)` and call it from `mergedVectorInputs` and `draftVectorInputs`, moving the join rationale onto the helper -- one expression, so the next edit cannot move one copy.
- `src/lib/config.ts` -- collapse the four raw reads to one `envEmbeddingProviderRaw()`, add `envEmbeddingProviderPair()` for the filtered/invalid split, and use it in both `getWorkbenchSettings` and `workbenchSettingsStored` -- the exclusivity the `??` join relies on becomes structural rather than pinned by test.
- `src/lib/workbench-settings.ts` -- qualify the two "exact mirror" comments and comment `draftResearchProviderConfigured`'s early return with why the research half cannot join -- the mirror claim is true of the WIRE fields, not of their consumers.
- `src/lib/__tests__/workbench-settings.test.ts` -- update the junk-provider expectations to include the note; add cases for every I/O matrix row (env-origin note present, stored-origin unchanged, provider-row suppression, binding-leg note survival, blank variable); pin `resolveEnvEmbeddingProvider` against both feeders.
- `src/lib/__tests__/settings-route.test.ts`, `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- update the two env-junk refusal strings; assert the provider row does NOT say the variable twice.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- pin `filtered ?? invalid` equal to the raw variable across all four states, through the two constructors and `getVectorSearchSettings`.

**Acceptance Criteria:**
- Given `EMBEDDING_PROVIDER=deepseek` over a complete stored OpenAI config, when the route refuses a vector turn-on, then the error names `EMBEDDING_PROVIDER`.
- Given the same state, when the provider row's hint is assembled, then `EMBEDDING_PROVIDER` appears exactly once in it.
- Given any state where `providerOrigin` is `"stored"`, when any vector sentence is produced, then it is byte-identical to before this change.
- Given both feeders and the runtime, when the env variable is unset, blank, supported or junk, then all three still resolve the same provider and the same gate verdict.
- Given the codebase after the change, when `process.env.EMBEDDING_PROVIDER` is grepped in `src/lib/config.ts`, then exactly one read remains.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 0, low 11)
- defer: 0
- reject: 14: (high 0, medium 0, low 14)
- addressed_findings:
  - `[low]` `[patch]` `SETTINGS_VECTOR_PROVIDER_ENV_NOTE` opened "That value comes from…" with no antecedent — the leg sentence it rides on names an absence, not a value. Reworded to "The provider comes from EMBEDDING_PROVIDER, …"; JSDoc records why it diverges from the model note's wording.
  - `[low]` `[patch]` `SettingsCanvas.tsx`'s provider-row comment still claimed the row's complaint carries the leg's note — false for the `provider` leg after the suppression. Rewritten to state the suppression and why `binding`'s note survives.
  - `[low]` `[patch]` The `SETTINGS_VECTOR_BINDING_ENV_NOTE` JSDoc cited a `"model"` exception that no longer exists under that name; repointed at `NOTE_ON_OWNING_ROW`.
  - `[low]` `[patch]` A new component-test comment claimed "ONCE PER SCREEN" while asserting once per description; rescoped, and the screen-wide double naming named as the design.
  - `[low]` `[patch]` `announced.match(/…/g)` would throw a `null`-deref TypeError instead of failing readably; replaced with a `split` shape that fails with a count.
  - `[low]` `[patch]` Two new imports broke otherwise-sorted import lists; reordered.
  - `[low]` `[patch]` A rename edit left an over-long JSDoc line in `settingsEnvProviderInvalidCopy`; re-wrapped.
  - `[low]` `[patch]` `envEmbeddingProviderRaw`'s "four hand-written copies" claim silently excluded `embeddings.ts:311`; scoped to the module and pointed at the resolver's own read.
  - `[low]` `[patch]` The runtime-wiring four-state loop pinned no gate VERDICT — the stored config never set `vectorSearchEnabled`, so `getVectorSearchSettings().enabled` was `false` in every state. Config now stores `true`, each state asserts the runtime's verdict against the browser's, and a row pins that the verdict actually varies.
  - `[low]` `[patch]` `DEPLOY.md`'s junk-`EMBEDDING_PROVIDER` section describes exactly this deployment and is held to the surface by a DW-222 parity test, but did not quote the new sentence. Block-quoted it, noted the route returns the same body, and extended the parity test to both notes.
  - `[low]` `[patch]` DW-637's documented asymmetry had no test; added a pin that `draftResearchProviderConfigured` returns `false` by early return over a credential that is present, while `draftResearchProvider` still reports the selected provider.

## Design Notes

**DW-637 resolves as a comment, not a convergence.** The ledger sanctions either. The vector half CAN join because `VectorSearchInputs.provider` is `string | null` and the gate's first leg refuses whatever it does not recognise — the junk value is representable and useful. The research half cannot: `draftResearchProvider` returns `ResearchProviderId`, a closed union, and its consumers branch on the value (`provider === "searxng"`, `tavily` vs `serpApi` key selection); a junk string has no representation there and the predicate's only output is a boolean. So the two WIRE fields really are mirrors and their two CONSUMERS must differ — that is what the comments should say.

The note, modelled on `SETTINGS_VECTOR_ENV_MODEL_NOTE`:

```ts
export const SETTINGS_VECTOR_PROVIDER_ENV_NOTE =
  `That value comes from ${EMBEDDING_PROVIDER_ENV}, so a provider chosen in the ` +
  `Embedding provider select cannot lift this until that variable is unset or corrected.`;
```

`resolveEnvEmbeddingProvider(filtered, invalid)` takes `invalid` as `string | null | undefined` so the browser's optional payload field normalises inside the helper rather than at one of the two call sites — the asymmetry that made the two expressions differ in the first place.

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: clean
- `npx vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-route.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- expected: all pass
- `npm run lint` -- expected: exit 0
- `npx vitest run` -- expected: no new failures across the suite
- `grep -c "process.env.EMBEDDING_PROVIDER" src/lib/config.ts` -- expected: `1`

## Auto Run Result

Status: done

### Implemented change

Three DW-552 follow-ons on one seam.

**DW-636** — `vectorSearchMissingLegs`' `provider` leg now carries `SETTINGS_VECTOR_PROVIDER_ENV_NOTE` when `providerOrigin === "env"`, gated exactly as the model leg's note is gated on `modelOrigin`. An env origin on that leg can only mean a junk variable — a filtered `EMBEDDING_PROVIDER` always passes `isEmbeddingProvider` — so the refusal that used to read "needs an embedding provider … supply what is missing" on a deployment whose store was complete now names the one thing that can lift it. The refusal, both switched-on frames and the route's 400 body all carry it. The provider ROW does not: `vectorSearchFieldIssue`'s note suppression was generalised from `control === "model"` to a `NOTE_ON_OWNING_ROW` set keyed on `leg.field`, because that row already renders `settingsEnvProviderInvalidCopy` about the same variable — and keying on the leg rather than the control is what keeps `SETTINGS_VECTOR_BINDING_ENV_NOTE`, whose leg shares the provider control.

**DW-638** — `config.ts` now has one `envEmbeddingProviderRaw()` and one `envEmbeddingProviderPair()`; the four hand-written raw reads are gone and both payload constructors take the filtered/invalid split from the same branch, so the exclusivity the `??` join depends on is structural rather than pinned by test alone. `getVectorSearchSettings` still reads the variable RAW, through that one reader.

**DW-637** — `resolveEnvEmbeddingProvider(filtered, invalid)` is the one join both feeders read the variable through, absorbing the payload/store optionality asymmetry that made the two call sites spell it differently. The research half stays an early return, and the "exact mirror" comments are qualified: the two WIRE fields are mirrors, their consumers cannot be — `VectorSearchInputs.provider` is `string | null` and the gate refuses what it does not recognise, while `draftResearchProvider` returns a closed `ResearchProviderId` its consumers branch on, so a junk string has nothing to be joined into and a boolean cannot report an origin.

### Files changed

- `src/lib/workbench-settings.ts` -- the new note and its leg gate; `NOTE_ON_OWNING_ROW` and the leg-keyed suppression; `resolveEnvEmbeddingProvider` and both feeders' calls to it; the qualified mirror comments and the research early return's rationale.
- `src/lib/config.ts` -- `envEmbeddingProviderRaw` / `envEmbeddingProviderPair` replace four raw reads and two independently written split expressions; `envEmbeddingProvider()` retired.
- `src/components/workbench/SettingsCanvas.tsx` -- comments only: the provider row's note contract and two identifier references.
- `DEPLOY.md` -- the junk-`EMBEDDING_PROVIDER` section quotes the switch's new announcement and notes the route returns it too.
- `src/lib/__tests__/workbench-settings.test.ts` -- the env-owned provider-leg note across both frames and both surfaces, stored-origin byte-identity, the provider-row suppression, the binding-leg survival guard, the `resolveEnvEmbeddingProvider` state table against both feeders, the DW-637 research-asymmetry pin, and the extended DEPLOY.md parity test.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- `filtered ?? invalid` pinned equal to the raw variable across all four states through both constructors, the browser's feeder and the runtime, with the gate verdict pinned beside the provider.
- `src/lib/__tests__/settings-route.test.ts`, `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- the two env-junk refusal strings, and that the provider row still names the variable exactly once.

### Review findings

- Patches applied: 11 (high 0, medium 0, low 11) — one user-visible copy fix, four stale or overstated comments, three test-hygiene fixes, one real verification gap (the runtime verdict was pinned against a gate answering a constant), one doc-parity gap, one missing DW-637 pin.
- Items deferred: 0.
- Items rejected: 14 (all low) — chiefly the ledger and spec files this run is forbidden or scheduled to handle elsewhere; `SettingsCanvas`' `envInvalid` expression and the three `providerOrigin` ternaries (sibling call sites the ledger did not name, and the first is the PIN read the design deliberately keeps separate from the RULE read); typing `filtered` as `EmbeddingProvider | null` (the store's field is `string | null`, so it would not compile); extending the note to the endpoint and key legs (those legs ARE actionable from the boxes); quoting the junk value in the note (the sibling env note does not, and the row does); and a full-suite flake in `storage-fs.test.ts`.

Follow-up review recommended: **true** — patched findings were 0 high, 0 medium, 11 low; score `3x0 + 1x11 = 11`, at or over the threshold of 5.

### Verification performed

- `npx tsc --noEmit` -- clean.
- `npm run lint` -- exit 0 (three pre-existing `jsx-ast-utils` notices, not errors).
- `npx vitest run` over the four spec'd files -- 464 passed.
- `npx vitest run` (full) -- 361 files. Green on two of the three runs made with this change in place (8890 passed, 1 skipped, 0 failed). The third failed only `storage-fs.test.ts > reapStrandedScratchFiles > stops at STRANDED_SCRATCH_CANDIDATE_CAP` on a 5s timeout; that file passes 95/95 in isolation, the same test failed on the stashed baseline, and nothing in this diff is on its dependency path. Treated as a pre-existing load-timing flake, not a regression.
- `grep -c "process.env.EMBEDDING_PROVIDER" src/lib/config.ts` -- `1`.
- Matrix audit: all six I/O rows are covered by tests that ran and passed -- the two junk-env frames, the provider-row suppression, the stored-origin byte-identity, the `workers-ai` binding-note survival on the provider control, and the blank/whitespace variable under real env stubbing.
- Mutation-checked rather than trusted green (review layer): removing the `providerOrigin` gate fails 8 tests; dropping `"provider"` from `NOTE_ON_OWNING_ROW` fails 2 and adding `"binding"` fails 6; flipping the join to invalid-first fails 3; breaking the pair's exclusivity fails 2; swapping `getVectorSearchSettings` onto the filtered half fails 4.

### Residual risks

- **A new user-visible sentence on three surfaces.** The checkbox description, both switched-on frames and the `PUT /api/settings` 400 body grew a second sentence on env-owned junk-provider deployments. It names the Embedding provider select, which the flat `/settings` page does not render — the same shape `SETTINGS_VECTOR_ENV_MODEL_NOTE` already has, and the flat frame's own action clause already points at the Workbench, so the reference is coherent rather than misdirection.
- **The note does not quote the offending value.** On the Workbench the provider row's `settingsEnvProviderInvalidCopy` quotes it; on the flat page and to an API caller the owner learns the variable but not what it is set to. Deliberate: the sibling env note takes the same shape, and every remedy the sentence names works without knowing the value.
- **The precedence rule still has a second home.** `SettingsCanvas`' `envInvalid` reads the same field pair with the complementary expression. That is the PIN read, which DW-398 requires be a separate read from the RULE — converging them is forbidden by this spec, and the disagreement case is pinned by its own test.
- **The join's soundness rests on `filtered ?? invalid === raw`.** True by construction now that one branch produces both halves, and pinned across all four variable states — but any future reader that mints the pair another way re-opens it.
