---
title: 'DW-73 — Workers AI embedding model namespace at the vector gate'
type: 'bugfix'
created: '2026-08-18'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
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

- `src/lib/workbench-settings.ts` — the change site. `VectorSearchInputs` (:403), `SELF_TRANSPORTING_EMBEDDING_PROVIDERS` (:418), `canEnableVectorSearch` (:450), `vectorSearchMissingLegs` (:455 — the `if (!v.model) missing.push("a model")` line is what grows the namespace branch), `vectorSearchMissingCopy` (:476, joins legs into one sentence). Module header declares it client-safe and Node-import-free; it already imports `EMBEDDING_PROVIDERS`, `PROVIDER_INFO`, `isEmbeddingProvider`, `VALID_PROVIDERS` from `./providers`.
- `src/lib/providers.ts` — client-safe constants module (96 lines, no Node imports by design). New home for the exported `WORKERS_AI_MODEL_PREFIX`; sits naturally beside `EMBEDDING_PROVIDERS` and `embeddingProviderLabel`.
- `src/lib/embeddings.ts:41` — current private `const WORKERS_AI_MODEL_PREFIX = "@cf/"`; its only reader is `resolveEmbeddingModelName` (:176-186), whose behaviour must not change. Already imports from `./providers` at :11.
- `src/components/workbench/SettingsCanvas.tsx:231,519` — renders `vectorSearchMissingCopy(vectorInputs)` as the vector switch's `aria-describedby` hint whenever the gate refuses. Read-only for this change: the new sentence surfaces here with no edit.
- `src/lib/workbench-settings.ts:640-694` — `validateWorkbenchSettingsPatch` + `mergedVectorInputs`: the route's half, env model wins over the patch. Read-only.
- `src/lib/workbench-settings.ts:846-882` — `draftCanEnableVectorSearch` / `draftVectorInputs`: the browser's half. Read-only; both feeders already trim, so `model` arrives trimmed or null.
- `src/lib/config.ts:506-518` — `getVectorSearchSettings` intersects the stored flag with the same predicate: the third caller, which is why the last matrix row holds. Read-only.
- `src/lib/__tests__/workbench-settings.test.ts:278-380` — `describe("canEnableVectorSearch")`. Line 314's "needs only a model from a provider that carries its own transport" loop feeds `model: "m"` for both `ollama` and `workers-ai`; `workers-ai` must move to a `@cf/` id or it fails. The copy assertions live at :336-378.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:455-472` and `workbench-settings.test.ts:1255-1290` — existing route/runtime vector cases, all `openai` + `text-embedding-3-small`; unaffected by the symmetric rule.

## Tasks & Acceptance

**Execution:**
- `src/lib/providers.ts` — export `WORKERS_AI_MODEL_PREFIX = "@cf/"` with a one-line comment naming it as the Workers AI id namespace both the embedding resolver and the vector gate read — the constant must be reachable from client-safe code.
- `src/lib/embeddings.ts` — delete the private declaration at :41 and import the constant from `./providers` (extend the existing import at :11); `resolveEmbeddingModelName` keeps its current behaviour verbatim.
- `src/lib/workbench-settings.ts` — import the constant from `./providers`; in `vectorSearchMissingLegs`, keep `!v.model → "a model"` and add an `else if` that pushes the namespace leg when `v.model.startsWith(WORKERS_AI_MODEL_PREFIX) !== (v.provider === "workers-ai")` — `a model id in the Workers AI ${WORKERS_AI_MODEL_PREFIX} namespace` for `workers-ai`, `a model id outside the Workers AI ${WORKERS_AI_MODEL_PREFIX} namespace` otherwise. Update the `canEnableVectorSearch` doc block's leg list so the documented rule matches the code.
- `src/lib/__tests__/workbench-settings.test.ts` — change the `workers-ai` arm of the self-transporting loop to a `@cf/` id (leave `ollama` on `"m"`), and add cases for every I/O matrix row: both mismatch directions, the composed sentence, the unchanged "a model" sentence, the in-namespace pass, and a `getVectorSearchSettings().enabled === false` case for a stored mismatched config.

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

## Design Notes

The namespace test is written as one equality rather than two branches so it reads as the same rule `resolveEmbeddingModelName` states (`overrideIsWorkersAi === providerIsWorkersAi`) rather than as a second, independently maintained rule:

```ts
if (!v.model) {
  missing.push("a model");
} else if (v.model.startsWith(WORKERS_AI_MODEL_PREFIX) !== (v.provider === "workers-ai")) {
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
- `npx vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/embeddings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/config.test.ts` — expected: all pass, including the new namespace cases.
- `npx vitest run` — expected: no new failures against the pre-change baseline.
- `npx eslint` — expected: clean (exit 0; the `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing).
- `npx tsc --noEmit` — expected: no new type errors.

## Auto Run Result

Status: done

**Implemented change.** The vector-search gate now applies the same
provider/namespace rule `resolveEmbeddingModelName` applies, so a model id that
belongs to the wrong provider is refused at the Settings surface with an
explanatory sentence instead of enabling the switch and being silently replaced
at embed time (DW-73). The rule is stated once, in client-safe code, and read by
both the resolver and the gate.

**Files changed**
- `src/lib/providers.ts` — new `WORKERS_AI_MODEL_PREFIX` and
  `embeddingModelMatchesProvider(provider, model)`: the one statement of the
  namespace rule, in the module both a client component and the server can import.
- `src/lib/embeddings.ts` — dropped the private prefix constant and the inline
  comparison; `resolveEmbeddingModelName` now calls the shared predicate.
  Behaviour unchanged.
- `src/lib/workbench-settings.ts` — `vectorSearchMissingLegs` grew a namespace
  leg beside the model leg, so `vectorSearchMissingCopy` names the namespace and
  composes with the other legs; `canEnableVectorSearch`'s doc block documents it.
- `src/lib/__tests__/workbench-settings.test.ts` — namespace cases for the
  predicate, the copy (including the composed sentence), the route in both
  directions, the env-override path, all four embedding providers, and a stored
  mismatch reading as vector-off.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` (new) —
  the surface criterion: the vector checkbox is refused and its accessible
  description is the namespace sentence.
- `DEPLOY.md` — `EMBEDDING_MODEL` must match the embedding provider's namespace;
  a mismatch refuses vector search rather than quietly falling back.

**Review findings.** 5 patches applied (2 medium, 3 low), 7 deferred (3 medium,
4 low — see frontmatter `deferred`), 7 rejected (case-sensitivity of the prefix,
which the gate and resolver already agree on; `VISION_MODEL` having no namespace
check; an unexported-defaults invariant test; the model field's missing
placeholder; test placement inside the PUT describe; cross-provider model-name
validity for openai/google/ollama, which no layer checks; and echoing the typed
id back in the copy). No intent gaps, no spec repairs, no loopbacks.

**Follow-up review recommended: true.** Patched findings only: high 0, medium 2,
low 3 → 3 × 2 + 3 = 9, which is ≥ 5.

**Verification** (through `npx`; `pnpm test`/`pnpm vitest` fail in this checkout
with a pre-existing `ERROR packages field missing or empty` workspace error):
- `npx vitest run` — 228 files, 4793 tests, all passing (baseline before the
  change: 227 files, 4786 tests).
- `npx vitest run` over the five affected suites — 288 tests, all passing.
- `npx tsc --noEmit` — clean.
- `npx eslint` — exit 0 (only the pre-existing `jsx-ast-utils`
  `TSNonNullExpression` notices).
- Every row of the I/O & Edge-Case Matrix is covered by a test that ran and
  passed in that output.

**Residual risks**
- The rule is applied by all three callers of `canEnableVectorSearch`, so an
  existing deployment storing a mismatch reads as vector-off at runtime rather
  than embedding with a substituted model. That is the recorded decision's
  intent, but it is a behaviour change for installs that were quietly working.
- The intent's example names only the `workers-ai` direction; the implemented
  rule is the resolver's biconditional, so a `@cf/` id under OpenAI/Google/Ollama
  is now refused too. Refusing half the rule would have left the same silent
  substitution intact in mirror image, so the wider reading was taken
  deliberately and is stated in the spec's Boundaries.
- A copy improvement (calling the provider what the picker calls it) was
  implemented during review and reverted, because the intent-contract's matrix
  pins the sentence text verbatim and that block is read-only. It is recorded in
  `deferred` instead.
- The legacy flat `/api/settings` branch still writes `embeddingModel` without
  the gate; the highest-severity deferred item.
