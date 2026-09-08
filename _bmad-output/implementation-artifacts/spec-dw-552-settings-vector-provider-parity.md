---
title: 'DW-552: align both vector-gate feeders on the RAW EMBEDDING_PROVIDER'
type: 'bugfix'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The vector rule's `provider` leg carries no note naming `EMBEDDING_PROVIDER`,
      so an env-owned refusal tells the owner to supply a provider through a select
      that cannot supply it.
    evidence: |-
      `vectorSearchMissingLegs` attaches `SETTINGS_VECTOR_BINDING_ENV_NOTE` to the
      `binding` leg exactly when `providerOrigin === "env"` (DW-281), but the
      `provider` leg early-returns `{field: "provider", phrase: "an embedding
      provider"}` with no note at all. DW-552 makes `providerOrigin === "env"`
      reachable for the provider leg for the first time, so the refusal now reads
      "…needs an embedding provider…" / "Turn it off, or supply what is missing."
      on a deployment where the only fix is correcting the variable. Partly
      mitigated today: the provider ROW already renders
      `settingsEnvProviderInvalidCopy`, which does name the variable — so the fact
      is on screen, just not in the refusal. Adding the note is a new user-visible
      sentence and a copy decision, which is why it was not taken here.
    location: >-
      src/lib/workbench-settings.ts:1530
    severity: medium
  - summary: >-
      The embedding half refuses a junk env provider by JOINING and rewriting
      `provider`/`providerOrigin`, while the research twin in the same file refuses
      its own junk variable by an early return — two mechanisms for one problem.
    evidence: |-
      `draftResearchProviderConfigured` (src/lib/workbench-settings.ts:2873) does
      `if (payload.envResearchProviderInvalid) return false` and leaves the reported
      provider untouched; `draftVectorInputs`/`mergedVectorInputs` instead join the
      filtered and invalid fields and derive the origin from the join. The DW-552
      doc comments call the two fields "exact mirrors", which now overstates the
      symmetry. Either converge the mechanisms or say in the comment why they must
      differ (the vector rule reports a provider and an origin; the research
      predicate reports only a boolean).
    location: >-
      src/lib/workbench-settings.ts:2873
    severity: low
  - summary: >-
      "raw EMBEDDING_PROVIDER wins, then the store" is now spelled independently in
      three places, which is the same copy-drift shape DW-552 exists to close.
    evidence: |-
      `getVectorSearchSettings` (src/lib/config.ts:1623) reads the variable raw;
      `mergedVectorInputs` (src/lib/workbench-settings.ts:2463) and
      `draftVectorInputs` (:2969) each re-join the filtered and invalid halves in
      their own expression. DW-552 was caused by exactly this: one of three copies
      moved. A shared helper — `resolveEnvEmbeddingProvider(filtered, invalid)` used
      by both halves, over a single raw reader — would remove the remaining chances
      to drift. Today only the tests hold them together.
    location: >-
      src/lib/workbench-settings.ts:2463
    severity: low
baseline_revision: '9338ea6c9f28b31c275f564d4abba2d77f832fda'
---

<intent-contract>

## Intent

**Problem:** DW-509 changed `getVectorSearchSettings` to read the RAW `EMBEDDING_PROVIDER`, so a junk value such as `deepseek` now fails the gate there. The other two feeders of the same one rule — `mergedVectorInputs` (the route's half) and `draftVectorInputs` (the browser's half) — still read the `isEmbeddingProvider`-FILTERED `envEmbeddingProvider`, which is `null` for junk, and fall through to the stored provider. On a deployment with `EMBEDDING_PROVIDER=deepseek` and a complete stored OpenAI config the Workbench switch reads as satisfiable and `PUT /api/settings` answers 200 storing `vectorSearchEnabled: true`, while `getVectorSearchSettings()` answers `{provider: "deepseek", enabled: false}` — the three feeders the repo's own comments promise are identical now disagree.

**Approach:** Carry the rejected raw value to both feeders and let it win over the stored provider exactly as the filtered value already does. The payload already serves `envEmbeddingProviderInvalid`; `WorkbenchSettingsStored` gains the same field from the same one place that builds it. Then pin all three feeders against one junk-provider fixture.

## Boundaries & Constraints

**Always:**
- The env value that wins is `envEmbeddingProvider ?? envEmbeddingProviderInvalid` — the filtered one first, so a supported value is unchanged in every existing situation.
- `providerOrigin` is `"env"` whenever that combined value is non-null, matching `getVectorSearchSettings`' own `providerOrigin: envProvider !== null ? "env" : "stored"` over the raw read.
- `workbenchSettingsStored` is the ONE place that reads the environment for the route's half, exactly as it is today for `envEmbeddingProvider`.
- Both feeders keep answering identically to each other for every situation the existing parity suite already covers.

**Block If:**
- Aligning the two feeders would require changing `getVectorSearchSettings`, `canEnableVectorSearch`, or `vectorSearchMissingLegs` — the runtime's answer is the target, not a party to the negotiation.

**Never:**
- Do not PIN the provider select on a junk value. `SettingsCanvas`' `envPinned` reads `stored.envEmbeddingProvider` directly and must stay filtered (DW-398's boundary: an unsupported value names no vendor, so the store is what applies once the variable is corrected).
- Do not fold the invalid value into the payload's or the store's `envEmbeddingProvider` field, and do not touch the route's env-pin save refusal at `src/app/api/settings/route.ts:414`.
- Do not change `settingsEnvProviderInvalidCopy` or the provider row's hint ladder.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Junk env over a complete stored config | `EMBEDDING_PROVIDER=deepseek`; stored `openai` + endpoint + model + key | All three feeders read `provider: "deepseek"`, `providerOrigin: "env"`; the gate refuses; `draftCanEnableVectorSearch` is `false` and the route refuses the turn-on | Route answers the provider-leg refusal sentence, not 200 |
| Supported env provider | `EMBEDDING_PROVIDER=openai` | Unchanged: `provider: "openai"`, `providerOrigin: "env"` | No error expected |
| Blank / unset env provider | `EMBEDDING_PROVIDER` unset, `""` or whitespace | Unchanged: falls through to the stored provider, `providerOrigin: "stored"` | No error expected |
| Junk env, save that moves no vector input | `EMBEDDING_PROVIDER=deepseek`, store already has `vectorSearchEnabled: true`, patch touches only e.g. `llmTimeoutSeconds` | Still 200 — `turningOn` is false and `vectorInputsEqual(current, merged)` holds, so the gate is never entered | Owner is not locked out of unrelated saves |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts:1967` -- `WorkbenchSettingsStored`. Server-side view the route validates a patch against. Carries `envEmbeddingProvider` (filtered) but no invalid twin; add `envEmbeddingProviderInvalid: string | null` as a REQUIRED field — one constructor exists, so requiring it makes an omission a compile error.
- `src/lib/workbench-settings.ts:2409` -- `mergedVectorInputs`. The route's half. `provider = stored.envEmbeddingProvider ?? storedProviderAfter` (line ~2431) and `providerOrigin` (line ~2462) are the two reads to change. `hasKey`'s env-credential branch already reads `provider`, so it follows for free (`deepseek` is in no `envEmbeddingApiKeyProviders` list).
- `src/lib/workbench-settings.ts:2929` -- `draftVectorInputs`. The browser's half. Same two reads off `payload.envEmbeddingProvider` (line ~2935, ~2956). `WorkbenchSettingsPayload.envEmbeddingProviderInvalid` is OPTIONAL (`?: string | null`, declared at :1048), so normalise with `?? null`.
- `src/lib/workbench-settings.ts:2969` -- `storedVectorInputs`. Composed from `draftVectorInputs`; inherits the fix, no edit. Read-only evidence that the flat `/settings` page moves in step.
- `src/lib/config.ts:2201` -- `workbenchSettingsStored`. The ONE constructor of the type above. Add the field using the same expression `getWorkbenchSettings` already uses at :2112: raw `nonEmpty(process.env.EMBEDDING_PROVIDER)` when the filtered `envEmbeddingProvider()` is `null`, else `null`.
- `src/lib/config.ts:1607` -- `getVectorSearchSettings`. READ-ONLY. The runtime answer being aligned to: raw read at :1623, `providerOrigin` at :1638.
- `src/lib/config.ts:1739` -- `envEmbeddingProvider()`, the `isEmbeddingProvider` filter. READ-ONLY.
- `src/components/workbench/SettingsCanvas.tsx:883` -- `envPinned` reads `stored.envEmbeddingProvider` directly, NOT `providerOrigin`, so the junk case stays unpinned. READ-ONLY evidence for the "Never" above.
- `src/lib/workbench-settings.ts:1826` -- `vectorControlOrigin`/`vectorSearchFieldIssue`: `invalid` is `providerOrigin === "stored"`, so the junk case now DESCRIBES the provider select without marking it `aria-invalid` — which is the deliberate reading (the row already carries `settingsEnvProviderInvalidCopy`).
- `src/lib/__tests__/workbench-settings.test.ts:2468` -- `describe("the client and the route read the same vector rule")`, the `situations` table and its per-situation assertion. The reuse point for the new fixture.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:1050` -- existing junk-`EMBEDDING_PROVIDER` payload coverage; the seam where a three-feeder pin can reach `getVectorSearchSettings` alongside the payload.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- add `envEmbeddingProviderInvalid: string | null` to `WorkbenchSettingsStored`, documented as the exact mirror of the payload field it copies -- the route's half cannot read the raw value it does not carry.
- `src/lib/config.ts` -- populate that field in `workbenchSettingsStored` with the same expression `getWorkbenchSettings` uses -- one reading of "what the filter threw away" for both consumers.
- `src/lib/workbench-settings.ts` -- in `mergedVectorInputs`, resolve the env provider once as `stored.envEmbeddingProvider ?? stored.envEmbeddingProviderInvalid` and use it for both `provider` and `providerOrigin` -- the route's half now refuses the same junk the runtime refuses.
- `src/lib/workbench-settings.ts` -- in `draftVectorInputs`, resolve the same way off `payload.envEmbeddingProvider ?? payload.envEmbeddingProviderInvalid ?? null` -- the browser's half stops offering a switch the route will refuse.
- `src/lib/__tests__/workbench-settings.test.ts` -- add the junk-provider situation to the `situations` table, and extend the per-situation assertion to pin `getVectorSearchSettings()`'s `provider` and gate answer beside the client's and the route's -- the two-feeder pin could not have caught this, because the two agreed with each other and only the runtime dissented.
- `src/lib/__tests__/workbench-settings.test.ts` -- cover the "junk env, save that moves no vector input" row -- so the fix cannot become a lockout on unrelated saves.

**Acceptance Criteria:**
- Given `EMBEDDING_PROVIDER=deepseek` and a stored OpenAI provider, endpoint, model and key, when the browser evaluates `draftCanEnableVectorSearch`, then it is `false`.
- Given the same state, when `validateWorkbenchSettingsPatch` is handed the body that draft would send with `vectorSearchEnabled: true`, then it refuses with the sentence naming the embedding-provider leg.
- Given the same state, when all three feeders are read, then each reports `provider: "deepseek"` and `providerOrigin: "env"` (the two that carry the field), and none reports the gate as satisfiable.
- Given every situation already in the parity suite, when the suite runs, then the client's and the route's answers are unchanged from before this change.
- Given `EMBEDDING_PROVIDER` unset or blank, when either feeder resolves the provider, then it is the stored value with `providerOrigin: "stored"`.

## Design Notes

The three feeders are the route's `mergedVectorInputs`, the browser's `draftVectorInputs` and the runtime's `getVectorSearchSettings`, all pouring into the one `canEnableVectorSearch`. The runtime's ladder is `nonEmpty(process.env.EMBEDDING_PROVIDER) ?? nonEmpty(cfg.embeddingProvider)` — no filter, because `vectorSearchMissingLegs`' first leg already refuses an unrecognised provider. The other two split that same variable into a filtered field plus an invalid twin, for a surface reason (DW-398: a junk value must not pin the select). So the alignment is a re-JOIN at the point of use, not a change of ladder:

```ts
// mergedVectorInputs — the route's half
const envProvider = stored.envEmbeddingProvider ?? stored.envEmbeddingProviderInvalid;
const provider = envProvider ?? storedProviderAfter;
// …
providerOrigin: envProvider !== null ? "env" : "stored",
```

The two fields are exclusive as both builders produce them, so the `??` is a join and never a precedence question.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/settings-route.test.ts` -- expected: all pass, including the new junk-provider fixture
- `npx tsc --noEmit` -- expected: clean; a missed `WorkbenchSettingsStored` constructor would surface here
- `npm run lint` -- expected: clean
- `npx vitest run` -- expected: no new failures across the suite (the flat `/settings` and Workbench canvas suites read `storedVectorInputs`/`draftVectorInputs`)

## Auto Run Result

Status: done

### Implemented change

The one vector rule has three feeders. DW-509 moved the runtime's (`getVectorSearchSettings`) onto the RAW `EMBEDDING_PROVIDER`; the route's and the browser's still read the `isEmbeddingProvider`-filtered field, which is `null` for junk, and fell through to the stored provider. Both feeders now re-JOIN the filtered field with the invalid twin the payload already carried (`envEmbeddingProvider ?? envEmbeddingProviderInvalid`), filtered first, and derive `providerOrigin` from the join — so a deployment with `EMBEDDING_PROVIDER=deepseek` over a complete stored OpenAI config reads `deepseek` and refuses on all three, instead of the switch reading satisfiable and `PUT /api/settings` storing `vectorSearchEnabled: true` behind a runtime that answers `enabled: false`.

The pin and the rule stay separate reads: `SettingsCanvas`' `envPinned` still tests the filtered field alone, so DW-398's boundary holds — a junk value leaves the provider select editable, because the store is what applies the moment the variable is corrected.

### Files changed

- `src/lib/workbench-settings.ts` -- `WorkbenchSettingsStored` gains a required `envEmbeddingProviderInvalid`; `mergedVectorInputs` and `draftVectorInputs` resolve the env provider from the join for both `provider` and `providerOrigin`. `storedVectorInputs` inherits it by composition.
- `src/lib/config.ts` -- `workbenchSettingsStored` populates the new field from one hoisted `envEmbeddingProvider()` read, matching the payload's own expression.
- `src/lib/__tests__/workbench-settings.test.ts` -- the parity table gains the junk-provider situation and a third-feeder assertion on every row; new tests for the three-feeder refusal, the workbench/flat-page verdict split, the two-constructor equality, and the both-halves-non-null precedence.
- `src/lib/__tests__/settings-route.test.ts` -- the ledger's symptom at the real `PUT`: 400, the provider-leg sentence, no write.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- the junk-provider test now separates the pin from the rule; blank-variable case pinned at the feeder.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- the rendered switch on the ledger's deployment: disabled, announcing the provider leg, refusing a real click, beside a select that still writes.

### Review findings

- Patches applied: 7 (high 2, medium 3, low 2) — all test-surface and one mechanical hoist; no production logic was revised.
- Items deferred: 3 (medium 1, low 2) — see frontmatter `deferred`.
- Items rejected: 5 (all low) — chiefly a claimed loss of the `workers-ai` binding note (unreachable: the provider leg early-returns before the binding leg on a junk value), an untrimmed-wire-value guard (the sibling `envEmbeddingProvider` field is read the same way, so a one-sided trim would be the inconsistency), extending the third-feeder pin to `baseUrl`/`model`/`hasKey`, adding `resolveEmbeddingProvider` as a fourth feeder to the parity loop, and comment density.

Follow-up review recommended: **true** — 2 of the patched findings were high severity (score rule short-circuits on any high; the medium/low score was 3x3 + 1x2 = 11, also over the threshold of 5).

### Verification performed

- `npx tsc --noEmit` -- clean.
- `npm run lint` -- exit 0 (three pre-existing `jsx-ast-utils` notices, not errors).
- `npx vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/settings-route.test.ts` -- pass.
- `npx vitest run` -- 353 files, 8231 passed, 1 skipped, 0 failed.
- Matrix audit: all four I/O rows are covered by tests that ran and passed — the junk-env three-feeder pin, the supported and unset/blank env rows in the parity table plus the feeder-level blank assertion, and the no-vector-input-moved row as (a) of the workbench/flat verdict test.
- Mutation-checked rather than trusted green: reverting the join fails 6 tests; flipping the `??` to invalid-first fails exactly the two precedence tests; diverging the route constructor's expression fails exactly the two-constructor equality test.

### Residual risks

- **A real behaviour change, now pinned in both directions.** On a deployment with a junk `EMBEDDING_PROVIDER` and `vectorSearchEnabled` already stored `true`, a Workbench save that MOVES an embedding field is now refused where it previously returned 200. That is the gate working as designed — the configuration genuinely cannot embed — and the owner's remedies are to correct the variable or turn the switch off, which the refusal names. The flat `/settings` page is unaffected: DW-303's suppression carries it, since the request broke nothing and the provider leg is not one that surface can move.
- **The refusal sentence does not name `EMBEDDING_PROVIDER`.** The provider leg carries no env note (deferred, medium). The provider ROW does render `settingsEnvProviderInvalidCopy`, so the variable is named on screen — just not inside the refusal.
- **Wire asymmetry.** The field is required on `WorkbenchSettingsStored` and optional on `WorkbenchSettingsPayload`, so a browser holding a payload built before DW-508 falls back to pre-fix behaviour in `draftVectorInputs`. The route is unaffected, and the route is what decides.
