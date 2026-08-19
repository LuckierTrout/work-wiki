---
title: 'DW-73 — Workers AI embedding model namespace at the vector gate'
type: 'bugfix'
created: '2026-08-18'
status: 'blocked' # draft | ready-for-dev | in-progress | in-review | done | blocked
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The legacy flat `PUT /api/settings` branch writes `embeddingModel` without
      running the vector gate, so a flat-only save can now silently switch
      effective vector search off.
    evidence: |-
      `src/app/api/settings/route.ts:243-256` writes `body.embeddingModel`
      unconditionally; the gate runs only inside `if (body.workbench !== undefined)`
      at :270. The live `/settings` page sends exactly that flat shape
      (`src/hooks/useSettings.ts:245`) and DW-61's 2026-08-18 decision keeps that
      page. Verified against the real route: store
      `{ vectorSearchEnabled: true, embeddingProvider: "workers-ai", embeddingModel: "@cf/baai/bge-m3" }`,
      then PUT `{ embeddingModel: "text-embedding-3-small" }` with no `workbench`
      key -> 200, and `getVectorSearchSettings().enabled` drops to false. Before
      DW-73 the same write was harmless (the resolver fell back). The flat branch
      has never validated anything by explicit design ("a body with no `workbench`
      produces byte-identically the same saved object"), so closing it is a
      decision about legacy compatibility, not a patch.
    location: >-
      src/app/api/settings/route.ts:243-270
    severity: medium
  - summary: >-
      An `EMBEDDING_MODEL` env override in the wrong namespace refuses vector
      search with a sentence the owner cannot act on from the Settings box.
    evidence: |-
      All three feeders take the env value ahead of anything typed or stored
      (`mergedVectorInputs`, `draftVectorInputs`, `src/lib/config.ts:512`), so the
      refusal stands even after the owner types a `@cf/` id and saves — pinned by
      the new test "does not let a TYPED matching id lift a refusal the env
      override owns". The copy names the namespace but never names the variable,
      and `VectorSearchInputs` carries no origin field, so an origin-aware
      sentence ("unset EMBEDDING_MODEL") is a shape change to the predicate's
      inputs rather than a wording fix. Pre-DW-73 that deployment ran with the
      provider default instead.
    location: >-
      src/lib/workbench-settings.ts (vectorSearchMissingCopy) with src/lib/config.ts:512
    severity: medium
  - summary: >-
      A deployment already storing a namespace mismatch with vector search on now
      gets a 400 on EVERY Workbench settings save, including edits to unrelated
      fields.
    evidence: |-
      `settingsSaveBody` always carries `vectorSearchEnabled`
      (`src/lib/workbench-settings.ts`), and `validateWorkbenchSettingsPatch`
      re-runs the vector rule whenever the resulting flag is true, so a chat-model
      or timeout edit is refused with the namespace sentence until the model is
      fixed or the switch unchecked. The mechanism is pre-existing and identical
      for the endpoint/key legs; DW-73 adds one more state that triggers it. The
      owner can recover (the switch may always be turned OFF), so this is
      friction, not a trap.
    location: >-
      src/lib/workbench-settings.ts (validateWorkbenchSettingsPatch)
    severity: medium
  - summary: >-
      The gate checks the namespace but not that the id is a usable Workers AI
      EMBEDDING model, so a bare `@cf/` or a vision id passes.
    evidence: |-
      `"@cf/".startsWith("@cf/")` is true, and `@cf/llava-hf/llava-1.5-7b-hf`
      (`src/lib/vision.ts:19`) satisfies the leg for `workers-ai`; both fail at
      `ai.run()` instead. `WORKERS_AI_EMBEDDING_DIMENSIONS`
      (`src/lib/embeddings.ts:35-43`) already enumerates the four supported ids
      and could back a membership check, but it is unexported and lives in a
      module client-safe code cannot import. Pre-existing: both inputs were
      accepted before DW-73 too.
    location: >-
      src/lib/providers.ts (embeddingModelMatchesProvider)
    severity: low
  - summary: >-
      The gate reads a trimmed model while `resolveEmbeddingModelName` reads the
      raw stored string, so a stored id with leading whitespace passes the gate
      and is still dropped at resolution.
    evidence: |-
      `getVectorSearchSettings` reads `nonEmpty(cfg.embeddingModel)`
      (`src/lib/config.ts:512`, trims) and both feeders trim, while
      `resolveEmbeddingModelName` tests `override.startsWith(...)` on the raw
      value (`src/lib/embeddings.ts:180-186`). The legacy flat branch stores
      `body.embeddingModel` untrimmed (`src/app/api/settings/route.ts:247`), so a
      stored `" @cf/baai/bge-m3"` under `workers-ai` satisfies the gate and is
      then replaced by the default — the exact substitution DW-73 exists to
      prevent. Reachable only by a direct API call, since both UIs trim.
    location: >-
      src/app/api/settings/route.ts:247 with src/lib/embeddings.ts:180-186
    severity: low
  - summary: >-
      The refusal calls the provider "Workers AI" while the picker two rows above
      calls the same selection "Cloudflare Workers AI".
    evidence: |-
      `embeddingProviderLabel("workers-ai")` returns "Cloudflare Workers AI" and
      populates the embedding-provider `<option>` (`SettingsCanvas.tsx:451-455`),
      while the namespace sentence types "Workers AI". Deriving the name from
      `embeddingProviderLabel` was implemented during review and then reverted:
      the frozen I/O matrix in this spec's intent-contract pins the sentence text
      verbatim, and step-03's matrix audit forbids editing an expectation to
      match changed code. Worth doing as its own change, matrix text included.
    location: >-
      src/lib/workbench-settings.ts (vectorSearchMissingLegs)
    severity: low
  - summary: >-
      The namespace complaint is announced on the vector checkbox, not on the
      embedding-model field that actually holds the wrong value.
    evidence: |-
      `SettingsCanvas.tsx:519` renders `vectorSearchMissingCopy` as the
      checkbox's `aria-describedby` hint; the model input built by `textRow` has
      no `aria-invalid` and no description tying the failure to it. Changing the
      provider select (`:445-448`) leaves the model untouched, so the ordinary way
      into this state is an edit to a control that shows no error at all.
    location: >-
      src/components/workbench/SettingsCanvas.tsx (textRow "embeddingModel")
    severity: low
baseline_revision: 'da113a34d74406bad6e684f073a507325729a5d8'
---

<intent-contract>

## Intent

**Problem:** `vectorSearchMissingLegs` (`src/lib/workbench-settings.ts:455-468`) asks the selected embedding provider for a provider, an endpoint, a model and a key, but never asks whether the model id belongs to that provider's namespace — so `{ provider: "workers-ai", model: "text-embedding-3-small" }` turns the vector switch on, and `resolveEmbeddingModelName` (`src/lib/embeddings.ts:176-186`) then discards exactly that value for a namespace mismatch and embeds with `@cf/baai/bge-m3` instead. The owner's model choice is replaced without a word.

**Approach:** Teach the one vector predicate the namespace rule `resolveEmbeddingModelName` already enforces — a model id is a Workers AI id (`@cf/…`) if and only if the provider is `workers-ai` — so the mismatch is refused at the Settings surface with an explanatory sentence from `vectorSearchMissingCopy` rather than accepted and silently overridden later. Promote the `@cf/` prefix constant to the client-safe `providers.ts` so both modules read one declaration.

## Boundaries & Constraints

**Always:**
- The prefix literal is declared ONCE. Move `WORKERS_AI_MODEL_PREFIX` into `src/lib/providers.ts` (already the client-safe "provider/model constants — single source of truth" module) and import it in both `embeddings.ts` and `workbench-settings.ts`.
- `workbench-settings.ts` stays client-safe: it must NOT import `embeddings.ts`, which pulls in the AI SDK, `@opennextjs/cloudflare` and storage.
- The gate's rule is the rule `resolveEmbeddingModelName` applies, in both directions: `model.startsWith(prefix)` must equal `provider === "workers-ai"`. Half a rule would leave the mirror case (an `@cf/…` id selected for OpenAI/Google/Ollama) silently overridden in exactly the way this fixes.
- The namespace check runs only when a model is present; a missing model keeps saying "a model" and nothing else.
- The refusal sentence derives the literal `@cf/` from the constant, the way `SETTINGS_TIMEOUT_HINT_COPY` derives its numerals, so the copy cannot outlive the prefix.
- One rule, every caller: the browser hint (`SettingsCanvas` vector switch), the route's 400 sentence, and `getVectorSearchSettings().enabled` all move together because they all call `canEnableVectorSearch`. Do not special-case any of them.

**Block If:**
- Honouring the rule turns out to require changing `resolveEmbeddingModelName`'s fallback behaviour (it must keep falling back to the provider default for values that reach it).

**Never:**
- Do not rewrite, normalize, or auto-prefix the owner's model value, and do not narrow the model field to a picker — the recorded decision is "refuse and explain".
- Do not touch `hasEmbeddingSupport()`, the ingest/search consumers, or the legacy `src/components/EmbeddingSettings.tsx`.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Workers AI, in namespace | `{ provider: "workers-ai", baseUrl: null, model: "@cf/baai/bge-m3", hasKey: false }` | `canEnableVectorSearch` true; `vectorSearchMissingCopy` `""` | No error expected |
| Workers AI, out of namespace | `{ provider: "workers-ai", baseUrl: null, model: "text-embedding-3-small", hasKey: false }` | false; copy: `Vector search needs a model id in the Workers AI @cf/ namespace before it can be turned on.` | PUT with `vectorSearchEnabled: true` → 400 carrying that same sentence, nothing written |
| Keyed provider, Workers AI id | `{ provider: "openai", baseUrl: "https://e", model: "@cf/baai/bge-m3", hasKey: true }` | false; copy: `Vector search needs a model id outside the Workers AI @cf/ namespace before it can be turned on.` | Same 400 path |
| Namespace plus another missing leg | `{ provider: "openai", baseUrl: "https://e", model: "@cf/baai/bge-m3", hasKey: false }` | false; copy names both, in leg order: `…needs a model id outside the Workers AI @cf/ namespace and an API key before it can be turned on.` | Same 400 path |
| No model at all | `{ provider: "workers-ai", baseUrl: null, model: null, hasKey: false }` | false; copy unchanged: `Vector search needs a model before it can be turned on.` | No namespace clause |
| Stored config already mismatched | config `{ vectorSearchEnabled: true, embeddingProvider: "workers-ai", embeddingModel: "text-embedding-3-small" }` | `getVectorSearchSettings().enabled` is false | Reads as off rather than embedding with a model the owner did not choose |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts` — the change site. `VectorSearchInputs`, `canEnableVectorSearch`, `vectorSearchMissingLegs`, and `vectorSearchMissingCopy` form the client-safe vector gate. It imports both the shared predicate and the prefix used in refusal copy from `./providers`.
- `src/lib/providers.ts` — client-safe provider constants module and home of both `WORKERS_AI_MODEL_PREFIX` and `embeddingModelMatchesProvider`, so the resolver and vector gate cannot encode different namespace rules.
- `src/lib/embeddings.ts` — `resolveEmbeddingModelName` calls the shared `embeddingModelMatchesProvider` predicate while preserving its existing provider-default fallback behaviour.
- `src/components/workbench/SettingsCanvas.tsx:231,519` — renders `vectorSearchMissingCopy(vectorInputs)` as the vector switch's `aria-describedby` hint whenever the gate refuses. Read-only for this change: the new sentence surfaces here with no edit.
- `src/lib/workbench-settings.ts:640-694` — `validateWorkbenchSettingsPatch` + `mergedVectorInputs`: the route's half, env model wins over the patch. Read-only.
- `src/lib/workbench-settings.ts:846-882` — `draftCanEnableVectorSearch` / `draftVectorInputs`: the browser's half. Read-only; both feeders already trim, so `model` arrives trimmed or null.
- `src/lib/config.ts:506-518` — `getVectorSearchSettings` intersects the stored flag with the same predicate: the third caller, which is why the last matrix row holds. Read-only.
- `src/lib/__tests__/workbench-settings.test.ts:278-380` — `describe("canEnableVectorSearch")`. Line 314's "needs only a model from a provider that carries its own transport" loop feeds `model: "m"` for both `ollama` and `workers-ai`; `workers-ai` must move to a `@cf/` id or it fails. The copy assertions live at :336-378.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` — mounts the real Embeddings settings category, verifies the namespace sentence is the switch's accessible description, and exercises refused and allowed clicks.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:455-472` and `workbench-settings.test.ts:1255-1290` — existing route/runtime vector cases, all `openai` + `text-embedding-3-small`; unaffected by the symmetric rule.

## Tasks & Acceptance

**Execution:**
- `src/lib/providers.ts` — export `WORKERS_AI_MODEL_PREFIX = "@cf/"` and the client-safe `embeddingModelMatchesProvider(provider, model)` helper that states the resolver/vector-gate biconditional once.
- `src/lib/embeddings.ts` — delete the private prefix declaration and call the shared helper from `resolveEmbeddingModelName`; keep its provider-default fallback behaviour verbatim.
- `src/lib/workbench-settings.ts` — import the helper and the prefix used in copy; in `vectorSearchMissingLegs`, keep `!v.model → "a model"` and otherwise push the namespace leg when the shared helper returns false — `a model id in the Workers AI ${WORKERS_AI_MODEL_PREFIX} namespace` for `workers-ai`, `a model id outside the Workers AI ${WORKERS_AI_MODEL_PREFIX} namespace` otherwise. Update the `canEnableVectorSearch` doc block's leg list so the documented rule matches the code.
- `src/lib/__tests__/workbench-settings.test.ts` — change the `workers-ai` arm of the self-transporting loop to a `@cf/` id (leave `ollama` on `"m"`), and add cases for every I/O matrix row: both mismatch directions, the composed sentence, the unchanged "a model" sentence, the in-namespace pass, and a `getVectorSearchSettings().enabled === false` case for a stored mismatched config.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` — mount the Embeddings settings category and prove a mismatched switch stays unchecked when clicked while a matching Workers AI selection can be enabled.
- `DEPLOY.md` — document `EMBEDDING_PROVIDER` and describe `EMBEDDING_MODEL` as the binary Workers AI `@cf/` namespace boundary the resolver actually enforces.

**Acceptance Criteria:**
- Given the Settings surface with embedding provider `Cloudflare Workers AI` and embedding model `text-embedding-3-small`, when the owner reads the vector switch, then it is refused and its description is the namespace sentence naming `@cf/` — not "needs a model".
- Given a PUT that would store `vectorSearchEnabled: true` with a provider/model namespace mismatch, when the route validates it, then it answers 400 with that same sentence and writes nothing.
- Given `@cf/` appears as a string literal anywhere in `src/lib`, when the repo is grepped, then the only declaration is the one in `providers.ts` (existing default-model and example ids in `embeddings.ts`/`vision.ts`/`cloudflare-types.ts` are values and prose, not the prefix constant).
- Given a `workers-ai` selection with a `@cf/` model and no key and no endpoint, when the gate runs, then vector search is still allowed — the self-transporting exemption is untouched.

## Spec Change Log

## Review Triage Log

### 2026-08-18 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 7: (high 0, medium 3, low 4)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[low]` `[patch]` The prefix literal was shared but the RULE was still written twice, in two shapes (`overrideIsWorkersAi === providerIsWorkersAi` vs an inline `startsWith(...) !==`). Extracted `embeddingModelMatchesProvider` into `providers.ts` and called it from both `resolveEmbeddingModelName` and `vectorSearchMissingLegs`; behaviour unchanged.
  - `[low]` `[patch]` The new constant's JSDoc illustrated the namespace with `@cf/llava-hf/...`, a VISION id, in a constant whose readers are both about embedding selection. Replaced with `@cf/baai/...` ids.
  - `[medium]` `[patch]` Verification gaps on paths the new leg governs: no coverage of a mismatch arriving via `EMBEDDING_MODEL` (env wins in all three feeders), no `ollama`/`google` cases, and both route directions packed into one `it`. Added env-override tests (browser feeder, route 400, `getVectorSearchSettings().enabled`, plus a pin that a typed matching id does NOT lift an env-owned refusal), added the two missing providers, split the route test.
  - `[medium]` `[patch]` The spec's first acceptance criterion is a rendering statement but coverage stopped at the library seam. Added `src/components/workbench/__tests__/settings-vector-namespace.test.tsx`, which mounts the embeddings category and asserts the vector checkbox is refused and its accessible description IS the namespace sentence, for both directions plus the passing case.
  - `[low]` `[patch]` `DEPLOY.md:55` still described `EMBEDDING_MODEL` as merely falling back to the provider default. Amended the row and added a note that a wrong-namespace id now refuses vector search outright.

### 2026-08-18 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 0
- reject: 24: (high 4, medium 6, low 14)
- addressed_findings:
  - `[medium]` `[patch]` The mounted Settings test asserted `aria-disabled` and the refusal copy but never exercised the checkbox handler. It now clicks a mismatched switch and proves it stays unchecked, then clicks the matching Workers AI case and proves it can be enabled.
  - `[low]` `[patch]` The new helper and deployment copy could be read as validating every provider's full model catalog even though the resolver rule is only the Workers AI `@cf/` boundary. Clarified both without changing behaviour.
  - `[low]` `[patch]` `DEPLOY.md` told operators that `EMBEDDING_MODEL` depends on the selected embedding provider but omitted the `EMBEDDING_PROVIDER` override that can select it. Added the variable and its supported values to the table.
  - `[low]` `[patch]` The canonical Code Map, execution tasks, design example, and targeted verification command still described the pre-review inline rule. Synchronized those non-contract sections with the shared helper, mounted interaction test, and deployment documentation.

## Design Notes

The namespace test is one equality in the client-safe `embeddingModelMatchesProvider` helper rather than two branches or two independently maintained copies. Both `resolveEmbeddingModelName` and the vector gate call it:

```ts
export function embeddingModelMatchesProvider(provider: string, model: string): boolean {
  return model.startsWith(WORKERS_AI_MODEL_PREFIX) === (provider === "workers-ai");
}

if (!v.model) {
  missing.push("a model");
} else if (!embeddingModelMatchesProvider(v.provider, v.model)) {
  missing.push(
    v.provider === "workers-ai"
      ? `a model id in the Workers AI ${WORKERS_AI_MODEL_PREFIX} namespace`
      : `a model id outside the Workers AI ${WORKERS_AI_MODEL_PREFIX} namespace`,
  );
}
```

It is a leg rather than a separate sentence because the leg list is what the surface, the route and the runtime already share: a namespace complaint then composes with a missing key ("…needs a model id outside the Workers AI @cf/ namespace and an API key…") instead of hiding it.

The gate widens for an already-stored mismatched config, which is deliberate: `getVectorSearchSettings` documents `enabled` as "the STORED flag intersected with the predicate" precisely so bytes that arrived another way get the same answer as a save. Such a deployment reads as vector-off and the Settings sentence says why, instead of embedding with a model nobody selected.

## Verification

**Commands:** (run through `npx`: `pnpm test` / `pnpm vitest` fail in this checkout with a pre-existing `ERROR packages field missing or empty` workspace error, unrelated to this change.)
- `npx vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/embeddings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/config.test.ts src/components/workbench/__tests__/settings-vector-namespace.test.tsx` — expected: all pass, including the namespace cases and mounted switch interaction.
- `npx vitest run` — expected: no new failures against the pre-change baseline.
- `npx eslint` — expected: clean (exit 0; the `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing).
- `npx tsc --noEmit` — expected: no new type errors.

## Auto Run Result

Status: blocked
Blocking condition: finalization left repository dirty
Reviewed commit: `d40dae9e05fd08468c0223751a0222527e69fd1b`

**Implemented change.** The vector-search gate applies the same Workers AI
`@cf/` namespace boundary as `resolveEmbeddingModelName`, so a mismatched model
is refused at the Workbench Settings switch, by the nested settings route, and
when reading the effective vector-search state instead of being silently
replaced at embed time. This follow-up review added direct switch-interaction
proof and tightened the operator/spec documentation without changing runtime
behaviour.

**Files changed**
- `src/lib/providers.ts` — owns the shared prefix and namespace predicate; the
  predicate documentation now states its deliberately binary scope.
- `src/lib/embeddings.ts` — reads the shared predicate while preserving its
  provider-default fallback.
- `src/lib/workbench-settings.ts` — refuses both directions of the namespace
  mismatch and produces the shared Settings/route sentence.
- `src/lib/__tests__/workbench-settings.test.ts` — covers the predicate, copy,
  route, environment-override, and stored-runtime paths.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` —
  mounts the Settings surface, checks the accessible description, and now proves
  refused clicks stay off while an allowed click turns the switch on.
- `DEPLOY.md` — documents `EMBEDDING_PROVIDER` and the precise Workers AI
  namespace boundary enforced for `EMBEDDING_MODEL`.
- `_bmad-output/implementation-artifacts/spec-dw-73-workers-ai-embedding-namespace.md`
  — records this review pass and synchronizes its non-contract implementation
  notes with the reviewed code.

**Review findings.** 4 patches applied (1 medium, 3 low), 0 newly deferred, and
24 rejected. The seven previously recorded deferred items remain unchanged in
frontmatter and were not reopened or copied into the deferred-work ledger.

**Follow-up review recommended: true.** Patched findings only: high 0, medium 1,
low 3 → `3 × 1 + 3 = 6`, which is at least 5.

**Verification**
- Targeted Vitest command from `## Verification` — 5 files, 288 tests, all
  passing.
- `npx vitest run` — 228 files, 4,793 tests, all passing. Logged stderr is from
  tests that deliberately exercise failure paths; the command exited 0.
- `npx eslint` — exit 0; only the documented `jsx-ast-utils`
  `TSNonNullExpression` notices appeared.
- `npx tsc --noEmit` — exit 0 with no output.

**Residual risks.** The seven already-recorded deferred observations remain for
orchestrator-owned follow-up, including the legacy flat settings write path.
This run did not modify, reopen, rewrite, or commit any existing deferred-work
ledger entry. The working copy also contains unrelated orchestrator-owned
artifacts; the final cleanliness gate determines whether they prevent a terminal
`done` result.
