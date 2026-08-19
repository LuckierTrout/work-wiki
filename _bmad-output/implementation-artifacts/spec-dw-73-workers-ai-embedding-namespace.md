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
      and could back a membership check, but although it IS exported
      (`export const` at `src/lib/embeddings.ts:38`) it lives in a module
      client-safe code cannot import. Pre-existing: both inputs were
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
  - summary: >-
      The path that actually embeds is untaught about the namespace rule, so the
      owner's model choice is still replaced without a word wherever the gate is
      not consulted.
    evidence: |-
      `getVectorSearchSettings()` has no production consumer — grepping `src/`
      returns only its own definition (`src/lib/config.ts:506`) and two comments.
      Ingest embeds on `hasEmbeddingSupport()` (`src/lib/ingest.ts:989`), which
      `src/lib/workbench-settings.ts:452` deliberately leaves untaught, so a
      mismatched deployment keeps embedding under the substituted provider
      default. DW-73 refuses the mismatch at the Settings surface, which is what
      the ledger decision asked for; the substitution the ledger described as the
      harm survives on the embed path. Out of scope on the intent's own
      authority ("the namespace guard is pre-existing"; the decision names the
      surface, not the resolver), and now documented in `DEPLOY.md` rather than
      hidden.
    location: >-
      src/lib/embeddings.ts (hasEmbeddingSupport) with src/lib/ingest.ts:989
    severity: medium
  - summary: >-
      The vector gate has no Cloudflare-binding leg, so `workers-ai` with a
      matching `@cf/` id passes on a deployment where nothing can ever embed.
    evidence: |-
      `resolveEmbeddingProvider` returns `getWorkersAiBinding() ? override : null`
      (`src/lib/embeddings.ts:100-102`), and `getWorkersAiBinding()` returns null
      off the Workers runtime — silently, by design. `vectorSearchMissingLegs`
      treats `workers-ai` as self-transporting and asks only for a provider and
      an in-namespace model, so on Docker the switch turns on and every embed
      resolves to no provider at all. Pre-existing: the same was true before
      DW-73 with any model id. Teaching the gate would mean giving a client-safe
      predicate a runtime-only fact, which is a shape change rather than a leg.
    location: >-
      src/lib/workbench-settings.ts (vectorSearchMissingLegs) with src/lib/embeddings.ts:55-72
    severity: medium
  - summary: >-
      `resolveEmbeddingModelName` drops a mismatched override with no log, while
      its sibling misconfiguration warns.
    evidence: |-
      `resolveEmbeddingProvider` emits a `logger.warn` naming the bad value when
      `EMBEDDING_PROVIDER` is not embedding-capable (`src/lib/embeddings.ts:93-99`),
      but the namespace fallback one function below is silent. Since DW-73 the
      fallback is reached only on paths the gate does not cover (the legacy flat
      route branch, an env override, a vector-off deployment), which is exactly
      where a one-line warn naming the dropped id and the model actually used
      would be diagnosable. Pre-existing silence; the spec's Never list also
      pins the fallback's behaviour, and a log is not behaviour.
    location: >-
      src/lib/embeddings.ts:180-192
    severity: low
  - summary: >-
      A whitespace-only `EMBEDDING_MODEL` is handed to the provider verbatim as
      the embedding model name, while the vector gate reads the same value as
      absent.
    evidence: |-
      `getEmbeddingModelOverride()` returns `process.env.EMBEDDING_MODEL` raw
      (`src/lib/config.ts:175-177`) with no `nonEmpty`, and
      `resolveEmbeddingModelName` guards on truthiness only, so `"   "` is
      truthy. `embeddingModelMatchesProvider(provider, "   ")` is TRUE for every
      non-`workers-ai` provider (`"   ".startsWith("@cf/")` is false, which
      equals `provider !== "workers-ai"`), so the blank string is returned as
      the model name and reaches the provider call. `getVectorSearchSettings`
      reads the same env var through `nonEmpty` (`src/lib/config.ts:512`), which
      trims it to null, so the gate reports "a model" missing while the resolver
      embeds with a blank id. Pre-existing: the pre-DW-73 resolver used the same
      truthiness guard. Distinct from the leading-whitespace item above — that
      one substitutes the provider default, this one sends an empty name.
    location: >-
      src/lib/config.ts:175-177 with src/lib/embeddings.ts:180-183
    severity: low
  - summary: >-
      The new mounted settings test duplicates about sixty lines of an existing
      workbench test's harness verbatim.
    evidence: |-
      `payload()`, the `fetchMock` `beforeEach`/`afterEach`, `announcedFor()`
      and `mount()` are copied word for word — doc comments included — from
      `src/components/workbench/__tests__/settings-read-only.test.tsx:26-101`.
      Two independently maintained copies of a screen-reader assertion helper is
      the same drift the shared `embeddingModelMatchesProvider` predicate exists
      to prevent on the production side. Extracting a shared workbench test
      helper edits a passing test file outside this story's surface, so it is a
      focused cleanup rather than an in-pass patch.
    location: >-
      src/components/workbench/__tests__/settings-vector-namespace.test.tsx
    severity: low
baseline_revision: '1a19dfdde7b067534c069032f59ff9cf642ffcac'
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
- `DEPLOY.md` — document `EMBEDDING_PROVIDER` (including that `workers-ai` needs the Cloudflare `AI` binding and so is unavailable in the Docker deployment this document describes) and describe `EMBEDDING_MODEL` as the binary Workers AI `@cf/` namespace boundary, naming both of its effects: the Settings surface refuses the mismatch, and the embedding path substitutes the provider default.

**Acceptance Criteria:**
- Given the Settings surface with embedding provider `Cloudflare Workers AI` and embedding model `text-embedding-3-small`, when the owner reads the vector switch, then it is refused and its description is the namespace sentence naming `@cf/` — not "needs a model".
- Given a PUT that would store `vectorSearchEnabled: true` with a provider/model namespace mismatch, when the route validates it, then it answers 400 with that same sentence and writes nothing.
- Given `@cf/` appears as a string literal anywhere in `src/lib`, when the repo is grepped, then the only declaration is the one in `providers.ts` (existing default-model and example ids in `embeddings.ts`/`vision.ts`/`cloudflare-types.ts` are values and prose, not the prefix constant).
- Given a `workers-ai` selection with a `@cf/` model and no key and no endpoint, when the gate runs, then vector search is still allowed — the self-transporting exemption is untouched.

## Spec Change Log

## Review Triage Log

### 2026-08-19 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 14: (high 0, medium 7, low 7)
- defer: 2: (high 0, medium 0, low 2)
- reject: 18: (high 0, medium 6, low 12)
- addressed_findings:
  - `[medium]` `[patch]` `.env.example` — the file operators actually copy was never
    updated for DW-73 and taught the opposite of the shipped rule: the gate
    sentence omitted the namespace leg, `EMBEDDING_PROVIDER` offered
    `workers-ai` with no Workers-only caveat, and `EMBEDDING_MODEL` showed
    `text-embedding-3-small` with nothing about the `@cf/` boundary. All three
    corrected in the file's own comment voice.
  - `[medium]` `[patch]` `DEPLOY.md` stated "The Settings surface refuses it"
    unqualified, which is wrong twice: it is the WORKBENCH surface only (the
    legacy `/settings` page sends a flat body the route writes past the gate),
    and the namespace is only named when an explicit provider is selected —
    under auto-detect the switch refuses for the missing provider instead.
    Both limits now stated.
  - `[medium]` `[patch]` `DEPLOY.md` stopped the substitution bullet at "content is
    still embedded", which reads as harmless. Added the expensive half: a
    different effective model generally means a different vector width, and a
    store holding two returns nothing until a full re-embed.
  - `[medium]` `[patch]` No route test drove the new leg from a mismatch that lives
    only in the STORED config, so narrowing the leg to fields present in the
    patch would have left every existing route case green. Added a case where
    the patch touches only `chatModel`: 400 with the namespace sentence and a
    byte-identical store.
  - `[medium]` `[patch]` Nothing pinned the flat-only `PUT` (no `workbench` key) —
    the existing legacy-field test passes only because its body also carries
    `workbench`, so it never reaches the branch skip. Added a characterization
    test recording today's answer (200, mismatch stored, effective vector
    search drops to false), commented as the first `deferred` entry so the
    future fix updates it deliberately. Route behaviour unchanged.
  - `[medium]` `[patch]` `settings-runtime-wiring.test.ts` is the one suite that
    cross-checks the gate and the resolver over a real stored config, and it
    had no `workers-ai` case at all, so the equivalence the shared predicate
    exists to guarantee was never asserted end to end. Added both halves, using
    `@cf/baai/bge-large-en-v1.5` rather than the Workers AI default so a
    resolver that dropped the stored value could not pass vacuously.
  - `[medium]` `[patch]` The mounted refusal tests asserted the control but never
    that a refused click writes nothing. Added that assertion. (The finding's
    stated mechanism was wrong — the switch edits draft state and saving is a
    separate button, so the existing assertions were not vacuous. The pin was
    kept anyway and its comment states the real mechanism.)
  - `[low]` `[patch]` `DEPLOY.md`'s `workers-ai` caveat was one-sided: it named
    `openai`/`google` as the safe Docker answer without saying they disable
    embeddings just as silently when their key is absent, since a forced
    provider does not fall back to auto-detect. Added.
  - `[low]` `[patch]` `DEPLOY.md` named two of the four provider defaults in a
    sentence sitting two lines under a table listing all four. Added the Google
    and Ollama defaults.
  - `[low]` `[patch]` `embeddingModelMatchesProvider` is the single statement of the
    rule and had no test in its own module's suite — every assertion reached it
    through `canEnableVectorSearch` or the route. Added seven direct cases in
    `providers.test.ts`, including `""`, the bare prefix, and a differently
    cased id.
  - `[low]` `[patch]` The mounted test's comment stated `vectorRefused` as
    `!vectorAllowed && !values.vectorSearchEnabled`, dropping the real
    predicate's leading `stored.readOnly ||`. Corrected.
  - `[low]` `[patch]` The mounted test's `mount()` waiter hardcoded `"Loading…"`
    though `SETTINGS_LOADING_COPY` is exported from a module the file already
    imports. Switched to the constant; the refusal sentences stay hardcoded,
    since asserting those against their own constant would be tautological.
  - `[low]` `[patch]` The `@cf/` comparison is case-sensitive — `@CF/…` under
    `workers-ai` is refused by a sentence naming `@cf/` — and nothing said so.
    Behaviour is correct (it mirrors the resolver exactly, which is the whole
    invariant); added the note to the `providers.ts` JSDoc.
  - `[low]` `[patch]` This spec's fourth `deferred` item claimed
    `WORKERS_AI_EMBEDDING_DIMENSIONS` "is unexported". It is `export const` at
    `src/lib/embeddings.ts:38`; only the client-safety half was true. Evidence
    corrected, every other item left byte-identical.

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

### 2026-08-18 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 3, low 4)
- defer: 3: (high 0, medium 2, low 1)
- reject: 19: (high 0, medium 4, low 15)
- addressed_findings:
  - `[medium]` `[patch]` `DEPLOY.md`'s new `EMBEDDING_PROVIDER` row offered `workers-ai` with no caveat, in a document whose whole subject is Docker/compose self-hosting. `resolveEmbeddingProvider` returns `getWorkersAiBinding() ? override : null` and the binding never resolves off the Workers runtime, so an operator following the table disabled embeddings entirely and silently. Marked the value Workers-only and added the `wrangler.jsonc` `AI`-binding paragraph with the Docker alternatives.
  - `[medium]` `[patch]` `DEPLOY.md`'s namespace paragraph promised a runtime consequence that does not occur: `getVectorSearchSettings()` has no production consumer (grep returns only its definition and two comments) and the embed path runs on `hasEmbeddingSupport()`, so a mismatched deployment keeps embedding under the substituted default. Rewrote the paragraph to split the two real effects and deleted the false "reads as off" symptom.
  - `[medium]` `[patch]` No mounted test covered stored `vectorSearchEnabled: true` with a mismatch — the state the deployment docs are about, where the payload serves the STORED flag so the switch renders checked while the gate refuses. Added it. The predicted assertion was wrong about the product and the real behaviour was pinned instead: `vectorRefused` is `!vectorAllowed && !values.vectorSearchEnabled`, so an already-on switch stays operable by design; the test proves it is checked, announces the refusal, can be turned off, and cannot be turned back on.
  - `[low]` `[patch]` The new comment in `resolveEmbeddingModelName` claimed the Settings gate refuses the combination outright, so reaching the fallback meant bytes that arrived some other way. The legacy flat `PUT /api/settings` branch, an `EMBEDDING_MODEL` override, and any vector-off deployment all reach it through supported paths. Reworded to name them and to state that the fallback is live behaviour.
  - `[low]` `[patch]` `embeddingModelMatchesProvider` took a bare `string` for a value both callers had already narrowed (`isEmbeddingProvider` at the gate, a typed parameter at the resolver), so a typo would read as a confident "not workers-ai" rather than a type error. Narrowed the parameter to `EmbeddingProvider`.
  - `[low]` `[patch]` The mirror-case mounted test asserted `aria-disabled` but never clicked, leaving "the owner cannot turn it on" proven in one direction only. Added the click and the `checked === false` assertion.
  - `[low]` `[patch]` Only the two-leg composition was asserted, which cannot tell the new leg's middle position from a trailing one. Added the three-leg case (`an endpoint, a model id outside … and an API key`), verified against real output before writing the expectation.

### 2026-08-18 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 0
- reject: 18: (high 0, medium 8, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The Design Notes collapsed three different surfaces into “reads as vector-off”: the effective config accessor returns off, the Workbench intentionally serves the stored flag and keeps an already-on switch checked so it can be turned off, and the embedding path still falls back to the provider default. Clarified the note to match the reviewed code and deployment guidance.
  - `[low]` `[patch]` The re-armed spec ended with an extra blank line and failed `git diff --check`. Removed the extra line.

## Design Notes

The namespace test is one equality in the client-safe `embeddingModelMatchesProvider` helper rather than two branches or two independently maintained copies. Both `resolveEmbeddingModelName` and the vector gate call it:

```ts
export function embeddingModelMatchesProvider(
  provider: EmbeddingProvider,
  model: string,
): boolean {
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

The gate widens for an already-stored mismatched config, which is deliberate: `getVectorSearchSettings` documents `enabled` as "the STORED flag intersected with the predicate" precisely so bytes that arrived another way get the same accessor-level answer as a save. The Workbench payload intentionally serves the stored flag instead, so an already-on switch remains checked, announces the refusal, can be turned off, and cannot be turned back on while the mismatch remains. The embedding path does not consume this accessor and still falls back to the provider default, as `DEPLOY.md` documents.

## Verification

**Commands:** (run through `npx`: `pnpm test` / `pnpm vitest` fail in this checkout with a pre-existing `ERROR packages field missing or empty` workspace error, unrelated to this change.)
- `npx vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/embeddings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/config.test.ts src/components/workbench/__tests__/settings-vector-namespace.test.tsx` — expected: all pass, including the namespace cases and mounted switch interaction.
- `npx vitest run` — expected: no new failures against the pre-change baseline.
- `npx eslint` — expected: clean (exit 0; the `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing).
- `npx tsc --noEmit` — expected: no new type errors.

