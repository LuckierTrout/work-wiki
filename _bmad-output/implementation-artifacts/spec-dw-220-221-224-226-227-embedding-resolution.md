---
title: 'Embedding model resolution: catalog-backed namespace, consistent trim, audible fallback'
type: 'bugfix'
created: '2026-08-19'
status: 'done'
baseline_revision: '13a83706fa9312215fee1b0e11cccbc3f3053e83'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Both embedding-resolution warnings fire per resolution rather than once per
      distinct misconfiguration, so a rebuild or a large ingest emits the same
      sentence hundreds of times.
    evidence: |-
      `resolveEmbeddingModelName` is re-entered by every embed door, and
      `rebuildVectorStore` calls `getEmbeddingModelName()` once plus `embedText`
      per page, so a persistently mismatched `EMBEDDING_MODEL` produces roughly
      two identical WARN lines per page. Its sibling `resolveEmbeddingProvider`
      (`src/lib/embeddings.ts:93-99`) has exactly the same property and is the
      warning this bundle's intent asked the new one to mirror, so throttling
      only the new one would break the symmetry the intent bought. Closing it
      means a once-per-(provider, model) guard applied to BOTH warnings, which
      is a change to the module's logging convention rather than to this bundle.
    location: >-
      src/lib/embeddings.ts:resolveEmbeddingModelName and resolveEmbeddingProvider
    severity: low
  - summary: >-
      `getEffectiveSettings` reports a provider-mismatched embedding model as the
      effective one, so the Settings surface names a model nothing embeds with.
    evidence: |-
      The embedding-model branch reports `env ?? config` after trimming, but
      never runs `embeddingModelMatchesProvider`. With
      `EMBEDDING_MODEL=text-embedding-3-small` under `workers-ai`, `/settings`
      renders `text-embedding-3-small` in the locked "from env" box
      (`src/components/EmbeddingSettings.tsx:38-56`) while `embedText` runs on
      `@cf/baai/bge-m3`. Pre-existing — this bundle only changed which values
      count as SET on that branch — and now partly mitigated by the new WARN,
      but the one surface whose job is "what is in effect and where did it come
      from" still answers wrongly. Closing it means either resolving the reported
      model through `getEmbeddingModelName()` or adding an "overridden" flag the
      component can render.
    location: >-
      src/lib/config.ts:getEffectiveSettings
    severity: medium
  - summary: >-
      The legacy flat `PUT /api/settings` branch still stores `model` and
      `ollamaBaseUrl` untrimmed, the same gate/resolver split just closed for
      `embeddingModel`.
    evidence: |-
      `embeddingModel` and `structuredKnowledgeModel` now trim on the way in;
      `body.model` and `body.ollamaBaseUrl` are still written raw. `ollamaBaseUrl`
      is read back by `getOllamaBaseUrl()` without a trim and by the settings
      surfaces with one, which is the shape of DW-221 for a different field.
      Pre-existing and untouched by this bundle, whose intent names only the
      embedding model.
    location: >-
      src/app/api/settings/route.ts (legacy flat branch)
    severity: low
  - summary: >-
      A mismatched deployment still EMBEDS under the substituted default; this
      bundle ended the silence, not the substitution.
    evidence: |-
      DW-224's ledger coordinates are `hasEmbeddingSupport` with
      `src/lib/ingest.ts:989`, and neither file changed. Under the intent's
      reading ("stops embedding under the substituted default WITHOUT A WORD")
      the fix is the warning, and the spec's Never list pins that reading because
      `src/lib/workbench-settings.ts` and `src/lib/config.ts` both record that
      Story 2.9 (embed after ingest) and Story 3.4 (search merge) own teaching
      `hasEmbeddingSupport()` the vector gate. So the harm the ledger measured —
      a corpus quietly embedded with a model the owner did not choose — is now
      diagnosable but not prevented, and the tightened predicate moves two more
      inputs (a bare `@cf/`, a `@cf/` vision id) from "fails at ai.run()" into
      "substitutes the default". Closing it means refusing to embed on a
      mismatch, which belongs to those stories.
    location: >-
      src/lib/embeddings.ts:hasEmbeddingSupport with src/lib/ingest.ts:989
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `embeddingModelMatchesProvider` (`src/lib/providers.ts:92-97`) is a bare `startsWith("@cf/")` test, so the bare prefix `@cf/` and a vision id such as `@cf/llava-hf/llava-1.5-7b-hf` pass the vector gate under `workers-ai` and fail only at `ai.run()` (DW-220). The gate reads its model through `nonEmpty` while `resolveEmbeddingModelName` tests the RAW stored string, so a stored `" @cf/baai/bge-m3"` satisfies the gate and is then dropped for the provider default (DW-221), and a whitespace-only `EMBEDDING_MODEL` is truthy enough to be handed to the provider verbatim as the model name while the same var reads as absent to the gate (DW-227). The namespace fallback drops the owner's id with no log at all, where its sibling `resolveEmbeddingProvider` warns (DW-226) — so on every path the Settings gate does not cover (the legacy flat route branch, an env override, a vector-off deployment) the embed path substitutes a different model in silence (DW-224).

**Approach:** Make the ONE predicate a catalog membership test for `workers-ai` by moving the supported-id table into client-safe `providers.ts` and backing the Workers AI leg with it. Read the override through the same trim-and-null the gate uses, in `getEmbeddingModelOverride()` and in `resolveEmbeddingModelName`, so the two agree on both what is set and what is sent. Add the missing `logger.warn` at the fallback naming the dropped id and the model actually used, which is what makes the substitution audible on the embed path itself. Update the refusal copy and `DEPLOY.md` to match the tightened rule.

## Boundaries & Constraints

**Always:**
- `embeddingModelMatchesProvider` stays the SINGLE statement of the rule, still consumed by both `canEnableVectorSearch` and `resolveEmbeddingModelName`, and still client-safe: `providers.ts` imports nothing from `embeddings.ts`, `config.ts` or any Node module.
- The supported Workers AI embedding ids and their dimensions live in exactly ONE table. `embeddings.ts` keeps exporting `WORKERS_AI_EMBEDDING_DIMENSIONS` (re-export, not a copy) so its existing readers and the dimension check at `src/lib/embeddings.ts:383` are unchanged.
- The membership test is own-property only (`Object.hasOwn`), so `constructor`/`toString` are not model ids.
- Case sensitivity is preserved: `@CF/baai/bge-m3` is out of the namespace under every provider.
- The resolver honours the TRIMMED override and returns the trimmed value; env wins over config exactly as `getVectorSearchSettings` orders them (`nonEmpty(env) ?? nonEmpty(config)`).
- Exactly one `logger.warn` on the `embeddings` tag per fallback, naming the dropped id, the provider, and the model used instead. A log is not behaviour: the fallback still returns the provider default.
- The legacy flat `PUT /api/settings` `embeddingModel` branch trims like `applyWorkbenchSettings`'s `setText` does, so whitespace-only deletes the key.

**Block If:** the shipped Workers AI id table would have to lose an id currently accepted at `ai.run()` (it would not — the four ids in `WORKERS_AI_EMBEDDING_DIMENSIONS` are the only ones this repo ever sends or dimension-checks).

**Never:**
- Do not teach `hasEmbeddingSupport()` the vector gate, and do not make it consult `getVectorSearchSettings()` — Story 2.9 and Story 3.4 own that, and it would rewrite `embeddings.test.ts` on their behalf.
- Do not turn the predicate into a model-catalog validator for OpenAI / Google / Ollama; only the Workers AI leg gains a catalog.
- Do not make the fallback throw, disable embeddings, or otherwise change what it returns.
- Do not trim inside `embeddingModelMatchesProvider` — both callers hand it a trimmed value, and a trimming predicate would re-open the gate/resolver split from the other side.
- Do not widen the settings owner gate, the read-only switch, or the write-precondition vocabulary.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Bare prefix under Workers AI | `embeddingModelMatchesProvider("workers-ai", "@cf/")` | `false` — the gate refuses it and the resolver drops it for `@cf/baai/bge-m3` with a warn | No error expected |
| Vision id under Workers AI | `"@cf/llava-hf/llava-1.5-7b-hf"`, provider `workers-ai` | `false`; vector switch refused with copy naming the supported ids | No `ai.run()` call with the vision id |
| Supported ids under Workers AI | each key of `WORKERS_AI_EMBEDDING_DIMENSIONS` | `true` for all four | No error expected |
| Prototype key | `embeddingModelMatchesProvider("workers-ai", "constructor")` | `false` | No error expected |
| Leading-whitespace stored id | config `embeddingModel: " @cf/baai/bge-m3"`, provider `workers-ai` | `getEmbeddingModelName()` is `"@cf/baai/bge-m3"`; `ai.run` receives the trimmed id; NO warn | No error expected |
| Whitespace-only env override | `EMBEDDING_MODEL=" "`, provider `openai` | treated as unset: `getEmbeddingModelOverride()` is `undefined`, model resolves to `text-embedding-3-small`, `getEffectiveSettings().embeddingModelSource` is not `"env"` | Never sends a blank model name |
| Whitespace-only env with a stored id | `EMBEDDING_MODEL=" "`, config `embeddingModel: "nomic-embed-text"`, provider `ollama` | the stored id wins, same as `getVectorSearchSettings` | No error expected |
| Cross-namespace override | `EMBEDDING_MODEL=text-embedding-3-small`, provider `workers-ai` | returns `@cf/baai/bge-m3` AND emits one `logger.warn` naming both ids | No error expected |
| Warn on the embed path | mismatched override, `embedText`/`embedTexts` called | the binding/SDK is called with the default and the same warn is emitted | No error expected |
| Flat route write | `PUT /api/settings` body `{ embeddingModel: "  " }` | key deleted from the stored config | No error expected |
| Flat route padded write | `PUT /api/settings` body `{ embeddingModel: " @cf/baai/bge-m3 " }` | stored trimmed | No error expected |

</intent-contract>

## Code Map

- `src/lib/providers.ts:56-97` -- `WORKERS_AI_MODEL_PREFIX` and `embeddingModelMatchesProvider`, the single rule. Gains the moved `WORKERS_AI_EMBEDDING_DIMENSIONS` table, a `WORKERS_AI_EMBEDDING_MODEL_IDS` list for copy, and `isWorkersAiEmbeddingModel`. File is deliberately Node-free (header comment at `:1-7`) — the table is plain data, so moving it keeps that true.
- `src/lib/embeddings.ts:37-42` -- `WORKERS_AI_EMBEDDING_DIMENSIONS` today; becomes a re-export from `providers.ts`. Its only reader is the dimension check at `:383`.
- `src/lib/embeddings.ts:168-192` -- `resolveEmbeddingModelName`: the raw-string read at `:181` (DW-221/227) and the silent fallback at `:183-190` (DW-226/224). `nonEmpty` already exists at `:154-158`; `logger` is already imported at `:19`.
- `src/lib/embeddings.ts:93-99` -- `resolveEmbeddingProvider`'s existing warn: the wording and tag to mirror.
- `src/lib/embeddings.ts:230, 292, 318, 341` -- `getEmbeddingModel`, `embedText`, `embedTexts`, `runWorkersAiEmbedding`: every embed door routes through `resolveEmbeddingModelName`, which is why the warn covers the embed path (DW-224).
- `src/lib/config.ts:220-223` -- `getEmbeddingModelOverride()` returns `process.env.EMBEDDING_MODEL` raw (DW-227). `nonEmpty` is a module-private helper at `:822-826` (hoisted function declaration, callable from `:221`). Sole consumer is `embeddings.ts:181`.
- `src/lib/config.ts:1153-1163` -- `getEffectiveSettings`'s embedding-model branch, the other raw `process.env.EMBEDDING_MODEL` read; route it through the same accessor.
- `src/lib/config.ts:806-820` -- `getVectorSearchSettings`, the trim-and-null ordering the resolver must match.
- `src/lib/workbench-settings.ts:476-500` -- `vectorSearchMissingLegs`; the `workers-ai` copy at `:493` must stop promising that any `@cf/` id is enough. The out-of-namespace copy at `:494` is unchanged.
- `src/app/api/settings/route.ts:276-282` -- the legacy flat `embeddingModel` branch that writes untrimmed (DW-221). Mirror `applyWorkbenchSettings`'s `setText` (`src/lib/config.ts:1022-1033`), which already trims for the workbench path.
- `src/lib/__tests__/providers.test.ts:154-220` -- owns the predicate's boundary cases. The "accepts the BARE prefix" test at `:199-205` asserts the behaviour DW-220 removes and must be rewritten, not deleted.
- `src/lib/__tests__/workbench-settings.test.ts:502, 995, 1008, 1038` and `src/components/workbench/__tests__/settings-vector-namespace.test.tsx:113` -- assert the `workers-ai` refusal sentence verbatim; update to the new copy.
- `src/lib/__tests__/embeddings.test.ts:1152-1250` -- Workers AI suite with the `mockWorkersAi` helper; the existing override tests already use real ids and stay green. Logger spy pattern to copy: `src/lib/__tests__/wikis.test.ts:457`.
- `src/lib/__tests__/config.test.ts:756-768` -- `getEmbeddingModelOverride` suite.
- `DEPLOY.md:55-105` -- documents the boundary as prefix-only and the fallback as silent; both statements stop being true.

## Tasks & Acceptance

**Execution:**
- `src/lib/providers.ts` -- move `WORKERS_AI_EMBEDDING_DIMENSIONS` here, add `WORKERS_AI_EMBEDDING_MODEL_IDS` (derived from its keys) and `isWorkersAiEmbeddingModel` using `Object.hasOwn`, and rewrite `embeddingModelMatchesProvider` so the `workers-ai` leg is membership and every other provider is "outside the prefix" -- a namespace test the resolver honours but `ai.run()` rejects is a gate that approves an id nothing can serve (DW-220).
- `src/lib/embeddings.ts` -- re-export `WORKERS_AI_EMBEDDING_DIMENSIONS` from `providers.ts`; in `resolveEmbeddingModelName` read `nonEmpty(getEmbeddingModelOverride()) ?? nonEmpty(cfg.embeddingModel)` and emit one `logger.warn("embeddings", …)` naming the dropped id, the provider and the model used instead before returning the default -- one table, one trim rule, and a fallback the logs can see (DW-221/224/226).
- `src/lib/config.ts` -- return `nonEmpty(process.env.EMBEDDING_MODEL) ?? undefined` from `getEmbeddingModelOverride()`, and read `getEffectiveSettings`'s embedding-model env branch through it -- a blank env var must be "unset" to every reader, not "set to nothing" to some (DW-227).
- `src/lib/workbench-settings.ts` -- change the `workers-ai` missing-leg phrase to name the supported ids from `WORKERS_AI_EMBEDDING_MODEL_IDS` -- a refusal that says "in the `@cf/` namespace" is now wrong advice for an id that already is.
- `src/app/api/settings/route.ts` -- trim `body.embeddingModel` in the flat branch, deleting the key when the trimmed value is empty -- the one writer that could still store a padded id the gate accepts and the resolver drops (DW-221).
- `src/lib/__tests__/providers.test.ts` -- rewrite the bare-prefix case, add vision-id, prototype-key, and full-catalog cases, and pin `WORKERS_AI_EMBEDDING_MODEL_IDS` against `WORKERS_AI_EMBEDDING_DIMENSIONS` -- these boundary inputs have no other home.
- `src/lib/__tests__/embeddings.test.ts` -- cover the padded stored id, the whitespace-only env override, and the warn on `getEmbeddingModelName`, `embedText` and `embedTexts` (spying `logger.warn`), asserting no warn on the honoured paths -- the I/O matrix rows for the embed path.
- `src/lib/__tests__/config.test.ts` -- cover the blank/whitespace `EMBEDDING_MODEL` in `getEmbeddingModelOverride` and in `getEffectiveSettings`'s reported source.
- `src/lib/__tests__/workbench-settings.test.ts` and `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- update the `workers-ai` refusal copy, and add a case proving a `@cf/` id outside the catalog is refused.
- `src/lib/__tests__/settings-route.test.ts` -- add the padded and whitespace-only flat-write cases for `embeddingModel`.
- `DEPLOY.md` -- state that `EMBEDDING_MODEL` under `workers-ai` must be one of the supported ids (listing them), and that a dropped override now logs a warning naming both ids -- the deployment doc is the only place the flat route's silent acceptance is described.

**Acceptance Criteria:**
- Given `providers.ts` after the change, when its import graph is inspected, then it still imports nothing from `embeddings.ts`, `config.ts`, or any Node builtin, and `WORKERS_AI_EMBEDDING_DIMENSIONS` imported from `embeddings.ts` is the same object as the one exported from `providers.ts`.
- Given an owner with `embeddingProvider: "workers-ai"` and a `@cf/` id that is not in the catalog, when they try to enable vector search, then the save is refused with a sentence that names the supported ids rather than the namespace.
- Given any resolution where the override is dropped for the provider default, when it happens through `getEmbeddingModelName`, `getEmbeddingModel`, `embedText` or `embedTexts`, then exactly one `logger.warn` is emitted naming both the dropped id and the model used.
- Given the whole suite, when `npm test` and `npm run lint` run, then both pass with no test deleted to accommodate the change.

## Spec Change Log

## Review Triage Log

### 2026-08-19 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 2, low 9)
- defer: 4: (high 0, medium 2, low 2)
- reject: 8
- addressed_findings:
  - `[medium]` `[patch]` `isWorkersAiEmbeddingModel` used ES2022 `Object.hasOwn` in a module that ships to the browser (tsconfig targets ES2018, no down-levelling) — replaced with `Object.prototype.hasOwnProperty.call`, rationale recorded in the doc comment.
  - `[medium]` `[patch]` The flat `PUT /api/settings` branch was the only string field with no type guard, so a non-string `embeddingModel` DELETED the stored model and answered 200 — added a 400 guard beside its siblings, with a test over `42`/`true`/object/array asserting `saveConfig` is never called.
  - `[low]` `[patch]` `getEffectiveSettings` hardened its env leg but left the config leg reading `cfg.embeddingModel` raw, re-opening the DW-227 split — routed through `nonEmpty`, with a test for a blank stored value.
  - `[low]` `[patch]` `canEnableVectorSearch`'s doc comment still described the model rule as namespace membership — rewritten for the asymmetric legs.
  - `[low]` `[patch]` The "is CASE-SENSITIVE" test comment read as "refused under OpenAI" directly above an assertion that it is accepted — reworded to state both directions.
  - `[low]` `[patch]` Nothing tied `DEFAULT_EMBEDDING_MODELS` to the catalog, so a changed workers-ai default could return a value its own gate refuses — added a test walking every provider's default through the predicate.
  - `[low]` `[patch]` `DEPLOY.md`'s sample log line showed a `[WARN]` token `logger.warn` never emits — corrected to the actual `[embeddings] …` shape.
  - `[low]` `[patch]` `DEPLOY.md` told operators to rely on the new warning without mentioning `LOG_LEVEL`, which suppresses it — added to the settings table and to the warning paragraph.
  - `[low]` `[patch]` `DEPLOY.md` hard-coded "the four supported ids" beside a table the code derives its copy from — reworded to drop the count.
  - `[low]` `[patch]` The `EMBEDDING_MODEL` table row lost the biconditional, no longer telling a table-only reader that other providers' ids must stay outside `@cf/` — both directions restored.
  - `[low]` `[patch]` The `EMBEDDING_MODEL` section enumerated the accepted ids without saying they are case-sensitive, the most likely real typo — one sentence added.

## Design Notes

The table moves rather than being imported, because `providers.ts`'s no-Node contract is what lets the settings UI read the rule; importing `embeddings.ts` (which pulls `ai`, `@opennextjs/cloudflare` and the storage layer) would break every client consumer. Dimensions are inert data, so the move costs nothing and keeps ONE table.

The predicate loses its symmetry-by-construction (`startsWith(...) === (provider === "workers-ai")`) and gains an explicit two-branch body — the equality no longer holds once one side is a catalog:

```ts
export function embeddingModelMatchesProvider(
  provider: EmbeddingProvider,
  model: string,
): boolean {
  if (provider === "workers-ai") return isWorkersAiEmbeddingModel(model);
  return !model.startsWith(WORKERS_AI_MODEL_PREFIX);
}
```

Both directions are still guarded: an `@cf/` id under OpenAI is refused by the second branch exactly as before, and the first branch is now strictly narrower than it was.

## Verification

**Commands:**
- `npm run lint` -- expected: clean.
- `npx tsc --noEmit` -- expected: no errors.
- `npx vitest run src/lib/__tests__/providers.test.ts src/lib/__tests__/embeddings.test.ts src/lib/__tests__/config.test.ts src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- expected: all pass.
- `npm test` -- expected: the full suite passes with no new failures against the baseline.

## Auto Run Result

Status: done

### Summary

`embeddingModelMatchesProvider` — the one predicate the vector gate and the embed
resolver share — now backs its `workers-ai` leg with catalog membership instead of
a bare `@cf/` prefix test, so a bare prefix and a real-but-non-embedding Cloudflare
id (`@cf/llava-hf/llava-1.5-7b-hf`) are refused at the Settings surface rather than
at `ai.run()` (DW-220). The catalog moved to client-safe `providers.ts` and is
re-exported from `embeddings.ts`, so there is still exactly one table backing both
the gate and the returned-vector dimension check. `resolveEmbeddingModelName` now
reads both override legs through the same trim-and-null and env-over-config
ordering `getVectorSearchSettings` uses, so a stored `" @cf/baai/bge-m3"` is
honoured (trimmed) instead of accepted by the gate and dropped by the resolver
(DW-221), and a whitespace-only `EMBEDDING_MODEL` is unset to every reader rather
than a blank model name sent to the provider (DW-227). The namespace fallback
gained the `logger.warn` its sibling `resolveEmbeddingProvider` already had,
naming the dropped id, the provider, and the model used instead — and because every
embed door routes through that resolver, the substitution is now audible on the
embed path itself (DW-226, DW-224). Refusal copy and `DEPLOY.md` were updated to
match the tightened rule.

### Files changed

- `src/lib/providers.ts` -- owns `WORKERS_AI_EMBEDDING_DIMENSIONS`, adds `WORKERS_AI_EMBEDDING_MODEL_IDS` and `isWorkersAiEmbeddingModel` (own-property test, ES2018-safe spelling), and splits the predicate into its two asymmetric legs.
- `src/lib/embeddings.ts` -- re-exports the catalog; `resolveEmbeddingModelName` trims both legs and warns once per fallback before returning the provider default.
- `src/lib/config.ts` -- `getEmbeddingModelOverride()` is trim-and-null; `getEffectiveSettings` reports both the env and the config leg through the same rule.
- `src/lib/workbench-settings.ts` -- the `workers-ai` missing-leg sentence names the supported ids, derived from the catalog; `canEnableVectorSearch`'s doc comment describes the asymmetric legs.
- `src/app/api/settings/route.ts` -- the legacy flat `embeddingModel` branch validates type (400) and trims, matching `applyWorkbenchSettings`.
- `DEPLOY.md` -- supported-id table, case sensitivity, blank-is-unset, the WARN and `LOG_LEVEL`'s effect on it.
- `src/lib/__tests__/providers.test.ts`, `embeddings.test.ts`, `config.test.ts`, `workbench-settings.test.ts`, `settings-route.test.ts`, `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- catalog, trim, warn, flat-write, and refusal-copy coverage.

### Review findings

- Patches applied: 11 (medium 2, low 9)
- Items deferred: 4 (medium 2, low 2) — see frontmatter `deferred`
- Items rejected: 8
- Intent gaps: 0; spec repairs: 0
- Follow-up review recommended: **true** — patched severities were high 0, medium 2, low 9; score = 3x2 + 1x9 = 15, which is >= 5.

### Verification

- `npx tsc --noEmit` -- exit 0, no output.
- `npm run lint` -- exit 0 (only the pre-existing `jsx-ast-utils` informational notices, unchanged from baseline).
- `npm test` -- 246 files / 5163 tests passing (baseline 5160; +3 from the review patches). No test deleted; the one removed `it(` is the bare-prefix case the change required be rewritten.
- Targeted run over the seven touched suites -- 392 passing.
- Matrix test audit: every I/O row has a named test that ran and passed, verified by a `--reporter=verbose` run (catalog and prototype-key rows in `providers.test.ts`; trim, unset, warn and embed-path rows in `embeddings.test.ts`; env-source rows in `config.test.ts`; flat-write rows in `settings-route.test.ts`; the refusal-copy row in `settings-vector-namespace.test.tsx`).

### Residual risks

- The tightened predicate moves a bare `@cf/` and a `@cf/` vision id from "fails loudly at `ai.run()`" into "substitutes `@cf/baai/bge-m3`, with a warning". That is what DW-220 asks for, but on a deployment that had one of those ids set, embedding now succeeds under a model the owner did not name. The warning is the only signal, and `LOG_LEVEL=error` suppresses it.
- An owner running a Workers AI embedding id outside the shipped catalog will find vector search refusing to turn on where it previously accepted the id. That is the intended tightening; adding an id means adding it to `WORKERS_AI_EMBEDDING_DIMENSIONS`, which propagates to the gate, the refusal copy and the dimension check at once.
- The substitution itself survives on the embed path (deferred item 4): `hasEmbeddingSupport()` is still untaught about the vector gate, which the repo records as Story 2.9 / Story 3.4 work.
