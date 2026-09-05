---
title: 'Settings payload fixture fidelity (DW-335, DW-727)'
type: 'refactor'
created: '2026-09-04'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
baseline_revision: 'e379d898c24cf14c78c45af0a5d88a1623d3ddc3'
---

<intent-contract>

## Intent

**Problem:** `settings-vector-namespace.test.tsx`'s local `payload()` fixture describes a `workers-ai` + `text-embedding-3-small` config while reporting `embeddingModelOverridden: false, embeddingModelInEffect: null`, but `embeddingModelAnswer` (`src/lib/config.ts:2101-2135`) would report `overridden: true, inEffect: "@cf/baai/bge-m3"` for that config — so exact-equality assertions on the model row pin a description the wire never serves (DW-335); separately `epic8-skills-canvas.test.tsx:63-112` still carries a verbatim ~50-field `WorkbenchSettingsPayload` literal that `settingsPayload()` already covers (DW-727).

**Approach:** Make every fixture in `settings-vector-namespace.test.tsx` state the substitution pair its own config actually implies — the substituting base in `payload()`, an explicit "no substitution" spread at the call sites whose overrides remove it — and repin the two model-row announcements that legitimately gain the substitution sentence. Replace `epic8-skills-canvas.test.tsx`'s literal with `settingsPayload()` plus its four deltas.

## Boundaries & Constraints

**Always:**
- `embeddingModelOverridden` must be the answer `embeddingModelAnswer` would give for the config that fixture describes, walking `resolveEmbeddingProvider` (env provider -> stored provider -> Workers AI auto-detect via the binding -> LLM provider with a key) and then `resolveEmbeddingModelName` (env model -> stored model -> provider default, substituting the default when `embeddingModelMatchesProvider` is false).
- `embeddingModelInEffect` must name the real model in effect wherever `embeddingModelOverridden` is `true`. Where `overridden` is `false` the field renders nothing (`SettingsCanvas.tsx:567-572` guards on `overridden` first), so the harness's existing `null` default stands — this spec does not widen DW-312's documented simplification.
- Every changed fixture keeps the case's existing subject: repin only the announcements that move, never delete or weaken an assertion.
- `epic8-skills-canvas.test.tsx` imports `settingsPayload` alone from `@/test/settings-harness` — no `installSettingsFetchMock`, no `mountSettings`. It keeps its own `fetch` stub and its own `send` mock exactly as they are.

**Block If:**
- A fixture's truthful `overridden` value would contradict what its case is demonstrating in a way that cannot be resolved by adjusting a field the case does not assert on.

**Never:**
- Do not add a copy of `resolveEmbeddingProvider` / `resolveEmbeddingModelName` to test code, and do not import `@/lib/embeddings` from a `dom`-project suite. The pair is stated per fixture as a literal, the way the harness says per-file deltas are stated.
- Do not change `src/test/settings-harness.tsx`, `src/lib/config.ts`, `src/lib/embeddings.ts`, `src/lib/providers.ts`, `src/lib/workbench-settings.ts`, or `src/components/workbench/SettingsCanvas.tsx`. This is fixture fidelity, not a behaviour change.
- Do not touch the two deliberately unmintable payloads that exist to pin a component guard: `settings-vector-namespace.test.tsx`'s "WITHHOLDS the note on a half-wired payload" (`overridden: true, inEffect: null`) and "lets the PIN win over an invalid value if a payload ever carries both". Their incoherence is the case.
- Do not fold any of the other four harness-backed Settings suites, and do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Base fixture | `payload()` — `workers-ai`, binding on, stored `text-embedding-3-small` | `overridden: true`, `inEffect: "@cf/baai/bge-m3"`; model row announces the gate complaint then the substitution note | No error expected |
| Mirror case | `payload({ embeddingProvider: "openai", embeddingModel: "@cf/baai/bge-m3", hasEmbeddingApiKey: true })` | `overridden: true`, `inEffect: "text-embedding-3-small"` (the OpenAI default) | No error expected |
| Matching id | `payload({ embeddingModel: "@cf/baai/bge-m3" })` | No substitution; model row stays silent | No error expected |
| Provider unresolvable | stored `workers-ai` with `hasWorkersAiBinding: false`, or an invalid `EMBEDDING_PROVIDER` | Nothing embeds: `overridden: false`, `inEffect: null` | No error expected |
| Nothing chosen | `embeddingProvider: null` with the binding OFF | Auto-detect finds nothing and no key is stored, so `overridden: false`; the model row keeps no description at all | No error expected |
| Skills fixture | `settingsPayload({ hasEmbeddingApiKey: true, apiEnabled: true, hasLoopbackApiToken: true, loopbackTokenSource: "store" })` | Byte-identical `workbench` object to today's literal | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- DW-335's file. `payload()` at :52-58 is the local fixture (`settingsPayload` + `embeddingProvider: "workers-ai"` + `hasWorkersAiBinding: true`); ~34 call sites. Only `announcedFor(modelInput())` assertions can move — the substitution note reaches the MODEL row only.
- `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` -- DW-727's file. `SETTINGS_BODY` literal at :63-112; read at :132, :139, and `.workbench.version` at :209.
- `src/test/settings-harness.tsx` -- `settingsPayload(overrides)` at :49-127. Base is `openai`/`text-embedding-3-small`, `hasEmbeddingApiKey: false`, `apiEnabled: false`, `hasLoopbackApiToken: false`, `loopbackTokenSource: "none"`, `embeddingModelInEffect: null`, `embeddingModelOverridden: false`. READ-ONLY here.
- `src/components/workbench/SettingsCanvas.tsx:567-572` -- `modelSubstitution` is `stored.embeddingModelOverridden && stored.embeddingModelInEffect !== null && !draftEmbeddingIdentityDirty(...)`. :1157-1181 joins the model row's description as `[env sentence, gate complaint, substitution].filter(...).join(" ")`; `describedBy` (:620-623) APPENDS the read-only sentence after that, so a read-only mismatch reads `<gate> <substitution> <read-only>`.
- `src/lib/config.ts:2101-2135` -- `embeddingModelAnswer`: `overridden = model !== null && inEffect !== null && inEffect !== model`.
- `src/lib/embeddings.ts:546-618` -- `resolveEmbeddingProvider` ladder; `:805-847` -- `resolveEmbeddingModelName`; `:483-489` -- `DEFAULT_EMBEDDING_MODELS` (`openai: text-embedding-3-small`, `google: gemini-embedding-001`, `workers-ai: @cf/baai/bge-m3`). Not exported — read for truth, do not import.
- `src/lib/providers.ts:149-155` -- `embeddingModelMatchesProvider`: `workers-ai` requires membership in `WORKERS_AI_EMBEDDING_DIMENSIONS`; every other provider requires the id NOT to start with `@cf/`.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx:78-94` -- the shape DW-727 asks `epic8-skills-canvas.test.tsx` to copy: `settingsPayload({ ...deltas })` behind a documented wrapper, `settingsPayload` imported alone.

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- add `embeddingModelOverridden: true, embeddingModelInEffect: "@cf/baai/bge-m3"` to `payload()`'s base (before `...overrides`) and extend its doc comment to say why the base config substitutes -- the base config is `workers-ai` holding an OpenAI id, which is exactly what `resolveEmbeddingModelName` replaces.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- introduce one documented `NO_SUBSTITUTION` spread (`embeddingModelOverridden: false, embeddingModelInEffect: null`) and apply it at every call site whose overrides make the base pair untrue: the matching-`@cf/` fixtures, the binding-off fixtures (nothing resolves), the stored-`openai`-with-a-key fixtures, the invalid-`EMBEDDING_PROVIDER` fixture, and the `envEmbeddingProvider: "google"` fixtures -- a fixture must not claim a substitution its own config does not produce.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- give the MIRROR case (`embeddingProvider: "openai"`, `embeddingModel: "@cf/baai/bge-m3"`, `hasEmbeddingApiKey: true`) its own `embeddingModelOverridden: true, embeddingModelInEffect: "text-embedding-3-small"` -- OpenAI cannot serve a `@cf/` id, so it substitutes with its own default rather than with the Workers AI one.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- in "says nothing while the provider is still unchosen", add `hasWorkersAiBinding: false` alongside `...NO_SUBSTITUTION`, with a comment -- with the binding ON and nothing chosen the resolver auto-detects `workers-ai` and the row WOULD carry the note, which is the state the DW-312 case at "appears with NO provider selected" already owns.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- repin the two model-row exact-equality assertions that legitimately gain the sentence: "marks the box invalid and describes it when the STORE holds the wrong id" and "describes but does NOT mark on a read-only deployment" -- both mount the base fixture, whose real payload carries the substitution note.
- `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` -- replace the `SETTINGS_BODY` literal with `{ workbench: settingsPayload({ hasEmbeddingApiKey: true, apiEnabled: true, hasLoopbackApiToken: true, loopbackTokenSource: "store" }) }`, importing `settingsPayload` from `@/test/settings-harness`, and keep a comment stating the four deltas and why the loopback door is open here -- the rail's scan only answers with the door on.

**Acceptance Criteria:**
- Given `settings-vector-namespace.test.tsx`, when each `payload(...)` call site is read against `embeddingModelAnswer`'s rule, then every fixture except the two documented component-guard payloads reports the `embeddingModelOverridden` value its own config implies.
- Given the base fixture, when the embeddings category is mounted, then the model row announces the gate complaint followed by `settingsModelSubstitutedCopy("@cf/baai/bge-m3")`, and on a read-only deployment the read-only sentence follows both.
- Given a fixture whose id matches its provider or whose provider cannot resolve, when the embeddings category is mounted, then the model row carries no substitution sentence and the previously-null `aria-describedby` assertions still hold.
- Given `epic8-skills-canvas.test.tsx`, when `SETTINGS_BODY.workbench` is compared field-by-field with the pre-change literal, then it is identical, and no verbatim `WorkbenchSettingsPayload` literal remains in the file.
- Given the repository, when `pnpm test` and `pnpm lint` run, then both pass with no new failures.

## Spec Change Log

No bad_spec loopback occurred; this section is empty.

## Review Triage Log

### 2026-09-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 0
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[low]` `[patch]` `NO_SUBSTITUTION` set `embeddingModelInEffect: null` at every site, but most of those configs DO resolve a provider that serves the stored id — so the constant introduced the same "a payload the wire never serves" defect in the other field of the pair, and left the file carrying two conventions for one state. Split into `NOTHING_EMBEDS` (nothing resolves) and `servesAsSet(model)` (a provider resolves and serves the id as set), and re-mapped all 17 sites — 8 and 9 respectively. No assertion changed; `SettingsCanvas` guards on `overridden` first, so nothing rendered moves.
  - `[low]` `[patch]` The base `payload()` doc claimed the pin-beats-invalid fixture's inherited pair is one "nothing there reads". The note does render in that mount; only no assertion reads it. Reworded to say that precisely, to state that the truthful pair there would be `servesAsSet("text-embedding-3-small")`, and that the fixture is left alone because it is out of scope rather than because the pair is right.
  - `[low]` `[patch]` `epic8-skills-canvas.test.tsx`'s header called the removed literal the "fifth" verbatim copy (DW-228 folded four, DW-471 the fifth — this is the sixth), said "FOUR DELTAS ... one fact each" above two bullets, and asserted an ongoing byte-identity guarantee. All three corrected.
  - `[low]` `[patch]` After the base gained the pair, the DW-223 "ENV-owned mismatch" case and the DW-312 "rides BESIDE" case mount identical payloads with nothing saying so. Added a cross-reference explaining why neither is redundant.

## Design Notes

The substitution note reaches the MODEL row only (`SettingsCanvas.tsx:1157-1181`), never the vector checkbox — so the many `announcedFor(checkbox)` exact-equality assertions in this file are untouched by the fidelity fix even where the fixture beneath them changes. Only two `announcedFor(modelInput())` `toBe` assertions and a handful of null-`aria-describedby` assertions are in play.

Truth is stated per fixture as a literal rather than derived, because deriving it needs the whole `resolveEmbeddingProvider` ladder — env-vs-stored precedence, the invalid-override refusal, the binding requirement, the per-vendor key check, the auto-detect leg — and a second copy of that ladder living in a test helper is a worse fidelity risk than the one being fixed.

Worked example of the shape, `payload()`'s base:

```ts
return settingsPayload({
  embeddingProvider: "workers-ai",
  hasWorkersAiBinding: true,
  // Workers AI cannot serve `text-embedding-3-small`, so the resolver
  // substitutes its own default and the GET body says so (DW-335).
  embeddingModelOverridden: true,
  embeddingModelInEffect: "@cf/baai/bge-m3",
  ...overrides,
});
```

## Verification

**Commands:**
- `pnpm vitest run src/components/workbench/__tests__/settings-vector-namespace.test.tsx src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` -- expected: all cases pass.
- `pnpm test` -- expected: the full suite passes, no new failures.
- `pnpm lint` -- expected: clean.
- `grep -c "version: \"s1:" src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` -- expected: `0`; no payload literal survives.

## Auto Run Result

Status: done

**Implemented change.** Both Settings fixtures named by the bundle now describe payloads `GET /api/settings` could actually serve. In `settings-vector-namespace.test.tsx` the local `payload()` base carries the substitution pair its own config implies (`workers-ai` holding an OpenAI id resolves to `@cf/baai/bge-m3`, so `overridden: true`), and every call site whose overrides remove that substitution states which of the two no-substitution shapes it is: `NOTHING_EMBEDS` where `resolveEmbeddingProvider` returns `null` (8 sites) or `servesAsSet(model)` where a provider resolves and serves the id as set (9 sites). Two exact-equality model-row announcements were repinned to the sentence the real payload emits, and two assertions were added — the mirror direction (OpenAI substituting with its OWN default, the only case in the file that would catch a note hardcoded to the Workers AI id) and a full `aria-describedby === null` where nothing embeds. In `epic8-skills-canvas.test.tsx` the sixth verbatim ~50-field `WorkbenchSettingsPayload` literal is now `settingsPayload()` plus its four deltas, with `settingsPayload` imported alone.

**Files changed.**
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- faithful substitution pair on the base fixture and on all 17 call sites that diverge from it; two announcements repinned, two added; `substituted()` hoisted to module scope so the DW-223 block can use it.
- `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` -- payload literal replaced by `settingsPayload({ hasEmbeddingApiKey: true, apiEnabled: true, hasLoopbackApiToken: true, loopbackTokenSource: "store" })`; its own `fetch` and `send` stubs untouched.

**Review findings breakdown.** 4 patches applied (all low severity), 0 deferred, 7 rejected. The patches were: splitting the single `NO_SUBSTITUTION` constant into `NOTHING_EMBEDS`/`servesAsSet` so the `inEffect` half of the pair is faithful too; correcting a doc claim that an inherited pair is "not read" (it renders, it is merely unasserted); three comment errors in the epic8 header (fifth vs sixth copy, a delta/fact count mismatch, an overstated byte-identity guarantee); and a cross-reference between two cases that now mount identical payloads. Rejected findings were out-of-scope asks the intent-contract forecloses (a derived-fixture or round-trip drift guard, folding the node-project `emptyPayload()` literal the `dom` harness cannot reach) or pre-existing conditions this change did not cause.

**Follow-up review recommendation.** false. Patched findings by severity: high 0, medium 0, low 4. No high-severity patch, so no further iteration is warranted.

**Verification performed.**
- `npx vitest run` on both suites -- 48/48 pass.
- `pnpm test` -- 386 files, 9623 passed / 1 skipped; no new failures.
- `pnpm lint` -- exit 0.
- `npx tsc --noEmit` -- exit 0.
- `grep -c 'version: "s1:' src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` -- 0.
- Byte identity of the epic8 fold was proven mechanically, not by eye: the pre-change literal was extracted from `e379d898` and compared to the new `settingsPayload(...)` result by `toEqual`, sorted-key equality and canonical `JSON.stringify`; the temporary probe passed and was removed.

**Residual risks.**
- The pin-beats-invalid fixture ("lets the PIN win over an invalid value if a payload ever carries both") still inherits the base's substituting pair while its own config (a `google` pin over `text-embedding-3-small`) substitutes nothing. The intent-contract's Never clause put that fixture out of scope; the file now says so explicitly and names the truthful pair for whoever takes it in scope. Nothing asserts on its model row, so no assertion is affected.
- Every pair is a hand-derived literal, because the intent-contract forbids re-deriving the resolver ladder in test code. If `DEFAULT_EMBEDDING_MODELS` or a rung of `resolveEmbeddingProvider` moves, the fixtures go stale silently. `src/lib/__tests__/settings-runtime-wiring.test.ts` pins both substitution directions on the real route, so a resolver change fails there rather than nowhere, but nothing ties those pins to these fixtures.
