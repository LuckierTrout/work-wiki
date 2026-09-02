---
title: 'DW-616 — gate the Workers AI dimensions sentence on the PROVIDER, not the model name'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The `/settings` embedding hint claims "a 1,024-dimensional Vectorize index" on the
      strength of the resolved Workers AI provider alone, but the Vectorize binding is
      independently optional, so a deployment with the AI binding and no index still reads
      the claim.
    evidence: |-
      `resolveEmbeddingProvider` answers `workers-ai` when the Cloudflare `AI` binding is
      bound (src/lib/embeddings.ts); that says nothing about `YOPEDIA_VECTORIZE`.
      `R2Storage` holds `this.vectorize` as `VectorizeIndex | undefined`
      (src/lib/storage/r2.ts:86,91) and guards every vector operation on it (:404, :430,
      :454, :467, :477), so the index half of the sentence can be false while the provider
      half is true. Pre-existing and untouched by DW-616, which narrowed only the provider
      half. The settings route already resolves binding facts server-side
      (`getWorkersAiBinding()`, served as `hasWorkersAiBinding`), so the same door could
      answer this one.
    location: >-
      src/components/EmbeddingSettings.tsx:380
    severity: low
baseline_revision: 'df241213befd42f824b4a36e5abf34dd328d4046'
---

<intent-contract>

## Intent

**Problem:** `EmbeddingSettings.tsx:344` appends "This deployment uses Cloudflare Workers AI with a 1,024-dimensional Vectorize index." whenever `effectiveModel === "@cf/baai/bge-m3"`, with no provider term at all — and the component is never handed the embedding provider. So an `EMBEDDING_MODEL=@cf/baai/bge-m3` pin on a non-Workers-AI provider (where the resolver substitutes and the override note already fires) draws a claim about the deployment's infrastructure that does not hold.

**Approach:** Serve the RESOLVED embedding provider beside the resolved model on `EffectiveSettings`, thread it through `useSettings` → `/settings` page → `EmbeddingSettings` as a new prop, and gate the dimensions sentence on that provider being `workers-ai` as well as on the model name. Told nothing, the component makes no provider claim.

## Boundaries & Constraints

**Always:**
- The provider is RESOLVED server-side through the resolver's own door (`resolveEmbeddingProvider`), never re-derived in the browser from `embeddingProvider` / `envEmbeddingProvider`: the Workers AI auto-detect leg sets the provider with neither the variable nor the store set, so a browser-side env→store ladder would DROP the sentence on a genuine Workers AI deployment.
- Resolve it from the SAME `cfg` snapshot the rest of the answer is resolved against (DW-313), through ONE resolution — not a second walk of the same ladder.
- The dimensions sentence composes with the `EMBEDDING_MODEL` pin sentence exactly as it does today (DW-559); only its condition changes.
- The new component prop is OPTIONAL and defaults to "not told", and "not told" makes no Workers AI claim.
- `aria-describedby` composition, ids, and every other sentence in this component render byte-identically.

**Block If:**
- The resolved embedding provider cannot be reported without `config.ts` gaining a new edge into `embeddings.ts` beyond the two it already has (`getEmbeddingModelName`, `hasEmbeddingSupport`).

**Never:**
- Do not change WHICH model term the sentence reads (`effectiveModel`, i.e. what is SET). The inverse gap — Workers AI in effect under a non-Workers `EMBEDDING_MODEL` pin, where the sentence is absent — is not this entry's subject.
- Do not move the field onto the nested `workbench` payload; the consumer is the flat page and the flat object is where its siblings (`embeddingModelInEffect`, `embeddingModelOverridden`) already ride.
- Do not touch `SettingsCanvas`, `ProviderForm`, the vector gate, or `PUT /api/settings`.
- Do not reword any copy.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Genuine Workers AI pin | `modelSource: "env"`, `effectiveModel: "@cf/baai/bge-m3"`, `providerInEffect: "workers-ai"` | Hint reads the pin sentence + the dimensions sentence, unchanged from today | No error expected |
| The DW-616 state | `modelSource: "env"`, `effectiveModel: "@cf/baai/bge-m3"`, `providerInEffect: "openai"` | Hint reads the pin sentence ONLY — no "Vectorize", no "Workers AI" | No error expected |
| Caller told nothing | `modelSource: "env"`, `effectiveModel: "@cf/baai/bge-m3"`, prop absent | Hint reads the pin sentence only | No claim made on absent input |
| Workers AI, other model | `modelSource: "env"`, `effectiveModel: "text-embedding-3-small"`, `providerInEffect: "workers-ai"` | Hint reads the pin sentence only | No error expected |
| Editable branch | `modelSource` is `config` / `default` / `none`, any provider | "Leave empty to use the embedding provider default." unchanged | No error expected |
| Server answer | Store pins `embeddingProvider: "openai"` with `OPENAI_API_KEY` set | `getEffectiveSettings().embeddingProviderInEffect === "openai"`, and the same value rides at the top level of the `GET /api/settings` body | Null when nothing embeds |

</intent-contract>

## Code Map

- `src/components/EmbeddingSettings.tsx` -- THE defect. `EmbeddingSettingsProps` (l.28–85) takes no provider; the hint `<p>` (l.330–348) selects the dimensions sentence on `effectiveModel === "@cf/baai/bge-m3"` alone inside the `modelSource === "env"` branch. `MODEL_HINT_ID` (l.157) and the `notes` list (l.196–208) stay exactly as they are.
- `src/app/settings/page.tsx:276-289` -- the ONLY production caller; already threads `modelInEffect={settings?.embeddingModelInEffect ?? null}`. The new prop lands beside it in the same shape.
- `src/hooks/useSettings.ts:19-78` -- the hand-duplicated view of the route body. `embeddingModelInEffect` / `embeddingModelOverridden` (l.34–35) are the siblings to copy.
- `src/lib/config.ts:193-246` -- `EffectiveSettings`; `embeddingModelInEffect` (l.214) documents the "set vs in effect" split the new field extends.
- `src/lib/config.ts:2020-2048` -- `embeddingModelAnswer(cfg)`, the ONE helper both settings resolvers derive the in-effect answer from (DW-312/313). It calls `getEmbeddingModelName(cfg)` at l.2041; this is where one resolution must yield BOTH halves.
- `src/lib/config.ts:2556,2581-2583` -- `getEffectiveSettings`'s embedding legs, where the new field is returned.
- `src/lib/config.ts:2088-2090` -- `getWorkbenchSettings` calls the same helper and reads only `.inEffect` / `.overridden`; it must keep rendering identically.
- `src/lib/embeddings.ts:283-360` -- `resolveEmbeddingProvider(cfg)`, module-private. Priority: env/stored override → Workers AI binding auto-detect → LLM provider → any embedding-capable credential. The auto-detect leg is why the browser cannot derive this.
- `src/lib/embeddings.ts:600-626` -- `getEmbeddingModelName(cfg)`: `resolveEmbeddingProvider` then `resolveEmbeddingModelName`. This is the door to widen; `config.ts:3` already imports it.
- `src/components/__tests__/embedding-settings-override.test.tsx:299-467` -- the hint suite. `WORKERS_AI_COPY` (l.317), the locked-branch case that expects the composed sentence (l.396–423), and the non-Workers env model case (l.425–445). `props()` (l.21–35) is the prop factory.
- `src/app/settings/__tests__/settings-page-embedding-wiring.test.tsx` -- page↔hook↔component wiring, mounted, with an untyped `SUBSTITUTED` payload (l.38–61). The mutation guard for the new prop belongs here.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:1455-1480` -- real-resolver cases asserting `getEffectiveSettings()` and the route body together.
- READ-ONLY EVIDENCE (typed whole-object fixtures that will fail to compile until the new required field is added — this is by design, see `cli.test.ts:401-406`): `src/lib/__tests__/settings-route.test.ts:140-160`, `src/lib/__tests__/cli.test.ts:399-428` and `:621-640`. Every other settings fixture (`useSettings.test.tsx:32`, the page suites) is untyped and needs no edit.

## Tasks & Acceptance

**Execution:**
- `src/lib/embeddings.ts` -- export `getEmbeddingResolution(cfg = loadConfigSync()): { provider: EmbeddingProvider | null; model: string | null }` around `getEmbeddingModelName`, and reimplement `getEmbeddingModelName` as its `.model` -- so the provider and the model that go on one payload come from ONE walk of the ladder, rather than a second call that agrees today.
- `src/lib/config.ts` -- widen `embeddingModelAnswer`'s return with `providerInEffect`, sourced from the single `getEmbeddingResolution(cfg)` call that replaces its `getEmbeddingModelName(cfg)`; add `embeddingProviderInEffect: EmbeddingProvider | null` to `EffectiveSettings` and return it from `getEffectiveSettings` -- the flat page's siblings already ride here, so the route's `...settings` spread carries it with no route change.
- `src/hooks/useSettings.ts` -- add `embeddingProviderInEffect: string | null` to the client's `EffectiveSettings` mirror, documented as the provider half of the in-effect pair.
- `src/app/settings/page.tsx` -- pass `providerInEffect={settings?.embeddingProviderInEffect ?? null}` to `EmbeddingSettings`.
- `src/components/EmbeddingSettings.tsx` -- add the optional `providerInEffect?: string | null` prop (default `null`) with a doc comment saying why absent means "make no claim", and gate the dimensions sentence on `providerInEffect === "workers-ai" && effectiveModel === "@cf/baai/bge-m3"`; extend the existing `// The Workers AI dimensions sentence COMPOSES…` comment with the provider term's reason.
- `src/components/__tests__/embedding-settings-override.test.tsx` -- pass `providerInEffect: "workers-ai"` in the existing composed-sentence case, and add the I/O matrix's wrong-provider, not-told and Workers-AI-other-model cases.
- `src/app/settings/__tests__/settings-page-embedding-wiring.test.tsx` -- add a mounted case proving the page threads the SERVED provider: a payload with `embeddingModelSource: "env"`, `embeddingModel: "@cf/baai/bge-m3"` and `embeddingProviderInEffect: "openai"` renders no "Vectorize" sentence, and the same payload with `"workers-ai"` does.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- assert `getEffectiveSettings().embeddingProviderInEffect` reports the resolved provider and that the value rides at the top level of the `GET /api/settings` body.
- `src/lib/__tests__/settings-route.test.ts`, `src/lib/__tests__/cli.test.ts` -- add the new field to the three typed `EffectiveSettings` fixtures.

**Acceptance Criteria:**
- Given a deployment whose resolver answers a non-Workers-AI embedding provider, when `/settings` renders the env-locked embedding box for `EMBEDDING_MODEL=@cf/baai/bge-m3`, then the hint states the `EMBEDDING_MODEL` pin and makes no Workers AI or Vectorize claim.
- Given a Workers AI deployment with the same pin, when the same box renders, then the hint is character-identical to what it was before this change.
- Given any deployment, when `GET /api/settings` answers, then `embeddingProviderInEffect` names the provider the embed path would actually use — including the Workers-AI-by-auto-detect case where neither `EMBEDDING_PROVIDER` nor the stored provider is set — and is `null` exactly when nothing embeds.
- Given `getEffectiveSettings()`, when it resolves the embedding legs, then the provider and the in-effect model come from one resolution over the one `cfg` snapshot, so they cannot describe different config generations.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 1, low 2)
- defer: 1: (high 0, medium 0, low 1)
- reject: 12
- addressed_findings:
  - `[medium]` `[patch]` `settings-page-embedding-wiring.test.tsx`'s `pinned("openai")` fixture served a payload the route cannot produce (`embeddingModelInEffect: "@cf/baai/bge-m3"` with `embeddingModelOverridden: false` under OpenAI, where the real resolver substitutes and reports `overridden: true`), and no UI-level test rendered the ledger's actual DW-616 state. `pinned()` now derives the substitution from the provider, and the OpenAI case asserts the override note IS rendered naming `text-embedding-3-small` while the Vectorize/Workers AI sentence is withheld.
  - `[low]` `[patch]` The same file's mutation-guard comment named the wrong case: dropping the page's `providerInEffect` prop makes the component fall back to its `null` default, so the OpenAI case still passes; the `workers-ai` case is what fails. The comment now frames the pair by direction — one case requires the served value to arrive, the other requires it to be read — verified by running both mutations.
  - `[low]` `[patch]` `getEmbeddingModelName`'s JSDoc still claimed both settings resolvers thread `cfg` through it, which `config.ts` stopped doing; the DW-313 snapshot reasoning moved onto `getEmbeddingResolution`, and `hasEmbeddingSupport`'s back-reference was corrected to name the real chain.

## Design Notes

The one non-obvious call is WHERE the provider comes from. The browser already holds `workbench.embeddingProvider` (stored) and `workbench.envEmbeddingProvider` (env), and gating on `env ?? stored === "workers-ai"` looks equivalent — it is not. `resolveEmbeddingProvider` has an auto-detect leg (`if (getWorkersAiBinding()) return "workers-ai"`) that fires with BOTH of those unset, which is the normal shape of the deployment the sentence is about. Deriving in the browser would therefore silence the sentence on exactly the deployments where it is true, trading DW-616's wrong claim for a missing one.

The component's default is "make no claim", not "assume Workers AI": a claim about infrastructure is only worth rendering when something actually answered the question.

```tsx
// EmbeddingSettings.tsx, the env branch's tail
+ (providerInEffect === "workers-ai" && effectiveModel === "@cf/baai/bge-m3"
    ? " This deployment uses Cloudflare Workers AI with a 1,024-dimensional Vectorize index."
    : "")
```

## Verification

**Commands:**
- `pnpm exec vitest run src/components/__tests__/embedding-settings-override.test.tsx src/app/settings/__tests__/settings-page-embedding-wiring.test.tsx --project dom` -- expected: all pass, including the new wrong-provider cases.
- `pnpm exec vitest run src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/settings-route.test.ts src/lib/__tests__/cli.test.ts src/lib/__tests__/config.test.ts --project node` -- expected: all pass.
- `pnpm test` -- expected: the whole suite green (no fixture left un-widened).
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

The `/settings` embedding hint's Cloudflare Workers AI dimensions sentence is now gated on the RESOLVED embedding provider as well as on the pinned model id, so an `EMBEDDING_MODEL=@cf/baai/bge-m3` pin on a deployment that embeds through another provider no longer claims a Vectorize index it does not have. The provider is resolved server-side and served, because the resolver's Workers AI auto-detect leg fires with both `EMBEDDING_PROVIDER` and the stored provider unset — a browser-side ladder would have silenced the sentence on exactly the deployments it is true of.

### Files changed

- `src/lib/embeddings.ts` -- new exported `getEmbeddingResolution(cfg)` returning `{ provider, model }` from ONE walk of the ladder; `getEmbeddingModelName` is now its `.model`, and the DW-313 snapshot reasoning moved onto the new door.
- `src/lib/config.ts` -- `embeddingModelAnswer` takes both halves from that single call; `EffectiveSettings` gains `embeddingProviderInEffect`, returned flat by `getEffectiveSettings` so the route's `...settings` spread carries it with no route change.
- `src/hooks/useSettings.ts` -- `embeddingProviderInEffect: string | null` added to the client's mirror of the route body.
- `src/app/settings/page.tsx` -- threads it into `EmbeddingSettings` as `providerInEffect`.
- `src/components/EmbeddingSettings.tsx` -- optional `providerInEffect` prop (absent = make no claim); the dimensions sentence now requires `providerInEffect === "workers-ai"` as well as the model id.
- `src/components/__tests__/embedding-settings-override.test.tsx` -- three new cases: wrong provider, told nothing, and Workers AI pinned to another model.
- `src/app/settings/__tests__/settings-page-embedding-wiring.test.tsx` -- a mounted pair over one payload where only the provider moves, pinning both directions of the wire; the OpenAI leg is the real substituting deployment and asserts the override note beside the withheld sentence.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- the served field asserted from the real resolver on the Workers-AI-auto-detect deployment (with `EMBEDDING_PROVIDER` pinned unset), on the OpenAI substitution, and as `null` when nothing embeds.
- `src/lib/__tests__/settings-route.test.ts`, `src/lib/__tests__/cli.test.ts`, `src/components/__tests__/structured-knowledge-settings.test.tsx` -- typed `EffectiveSettings` fixtures widened; the route suite's `@/lib/embeddings` mock moved from `getEmbeddingModelName` to `getEmbeddingResolution`.

### Review findings

- Patches applied: 3 (1 medium, 2 low) -- see the Review Triage Log.
- Items deferred: 1 (low) -- the "Vectorize index" half of the same sentence is still asserted from the `AI` binding alone.
- Items rejected: 12 -- pre-existing residue (the inverse model-term gap, the `bge-large-en-v1.5` sibling id, copy-constant extraction, sibling untyped fixtures) and design choices the spec argues on the record (the `string | null` prop type, the workbench payload left alone, the ledger left to the orchestrator).
- Follow-up review recommended: true. Patched severities: high 0, medium 1, low 2; score = 3x1 + 1x2 = 5, which meets the threshold of 5.

### Verification

- `pnpm exec vitest run src/components/__tests__/embedding-settings-override.test.tsx src/app/settings/__tests__/settings-page-embedding-wiring.test.tsx --project dom` -- 22 passed.
- `pnpm exec vitest run settings-runtime-wiring / settings-route / cli / config / embeddings --project node` -- 580 passed.
- `pnpm test` -- 360 files, 8856 passed, 1 skipped, 0 failed.
- `pnpm exec tsc --noEmit` -- exit 0. `pnpm lint` -- exit 0.
- Matrix audit: every I/O row has a covering test that ran and passed (rows 1-5 in the component and page suites, row 6 in `settings-runtime-wiring.test.ts`).

### Residual risks

- The inverse gap is deliberately unclosed, per the spec's Never clause: a Workers AI deployment pinned to a non-Workers model still renders no dimensions sentence, because the sentence follows what is SET. A component case pins that as intended rather than leaving it undefended.
- `providerInEffect` is compared against the bare literal `"workers-ai"`; a rename of the provider id would not fail typecheck, only the two page cases that require the sentence to render.
