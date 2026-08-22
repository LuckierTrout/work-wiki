---
title: 'DW-222 — The vector refusal calls the provider what the picker calls it'
type: 'bugfix'
created: '2026-08-20'
baseline_revision: '55769109249eb86438e161b9f3639e36d31cd4f0'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** The embedding-provider picker renders `embeddingProviderLabel("workers-ai")` — "Cloudflare Workers AI" (`src/lib/providers.ts:193-196`, rendered at `src/components/workbench/SettingsCanvas.tsx:518`) — while the vector-gate refusal two rows below types the name by hand as "Workers AI" in four places: the two model-mismatch phrases in `vectorSearchMissingLegs` (`src/lib/workbench-settings.ts:654-655`) and both binding notes it attaches (`SETTINGS_VECTOR_BINDING_NOTE` at `:212-213`, `SETTINGS_VECTOR_BINDING_ENV_NOTE` at `:233-234`). The owner reads one selection under two names on one screen, and the two names can drift again because nothing ties them together.

**Approach:** Per the 2026-08-19 DW-222 decision, derive the name once in `workbench-settings.ts` from `embeddingProviderLabel("workers-ai")` and interpolate it into all four strings, so the refusal and the picker cannot disagree. The decision explicitly authorises updating `spec-dw-73-workers-ai-embedding-namespace.md`'s frozen I/O matrix text in the same change; that spec records the renegotiation rather than silently absorbing it.

## Boundaries & Constraints

**Always:**
- One derivation, not four literals: every occurrence of the provider name in vector-gate copy resolves through `embeddingProviderLabel` so the picker is the single source of the name.
- Only the provider NAME changes. Leg order, leg fields, sentence assembly (`vectorSearchLegSentence`, `withLegNotes`), the on-but-inactive frame, `vectorSearchFieldIssue`, and which control each note rides on are all untouched.
- `SETTINGS_VECTOR_BINDING_NOTE` and `SETTINGS_VECTOR_BINDING_ENV_NOTE` stay exported string constants with the same names, so every test and `DEPLOY.md` reference that already points at them keeps pointing at them.
- The frozen I/O matrix in `spec-dw-73-workers-ai-embedding-namespace.md` is edited for the provider name only, with a dated note beneath it saying the frozen expectation was renegotiated deliberately for copy consistency under DW-222.

**Block If:**
- Honouring the parity would require `providers.ts` to import from `workbench-settings.ts` (a cycle) or would change what `embeddingProviderLabel` returns for any provider.

**Never:**
- Do not rename `workers-ai` itself, change `PROVIDER_INFO`, `EMBEDDING_PROVIDERS`, or `embeddingProviderLabel`'s return values.
- Do not touch the legacy `src/components/EmbeddingSettings.tsx`, the `src/lib/embeddings.ts` runtime error strings, or the `src/lib/vision.ts` copy — none of them sit beside the picker and none are vector-gate refusals.
- Do not edit the frozen I/O matrix of any spec other than `spec-dw-73-workers-ai-embedding-namespace.md`, and do not rewrite DW-220's supersession of that matrix's row 2 while updating the name.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Workers AI, unsupported `@cf/` id | `{ provider: "workers-ai", model: "@cf/llava-hf/llava-1.5-7b-hf", hasWorkersAiBinding: true }` | `vectorSearchMissingCopy`: `Vector search needs a supported Cloudflare Workers AI model id (@cf/baai/bge-small-en-v1.5, @cf/baai/bge-base-en-v1.5, @cf/baai/bge-large-en-v1.5, @cf/baai/bge-m3) before it can be turned on.` | PUT with `vectorSearchEnabled: true` → 400 carrying that same sentence |
| Keyed provider holding a `@cf/` id | `{ provider: "openai", baseUrl: "https://e", model: "@cf/baai/bge-m3", hasKey: true }` | copy: `Vector search needs a model id outside the Cloudflare Workers AI @cf/ namespace before it can be turned on.` | Same 400 path |
| Binding missing, selection stored | `{ provider: "workers-ai", model: "@cf/baai/bge-m3", hasWorkersAiBinding: false, providerOrigin: "config" }` | copy ends with `SETTINGS_VECTOR_BINDING_NOTE`, which now opens `Cloudflare Workers AI embeds through the Cloudflare AI binding…`; rest of the sentence byte-identical to before | Same 400 path |
| Binding missing, `EMBEDDING_PROVIDER` owns it | same but `providerOrigin: "env"` | copy ends with `SETTINGS_VECTOR_BINDING_ENV_NOTE`, now opening `Cloudflare Workers AI embeds through…`; the `unset EMBEDDING_PROVIDER` way out is unchanged | Same 400 path |
| Parity invariant | every refusal `vectorSearchMissingCopy` / `vectorSearchInactiveCopy` can produce | wherever the string names the provider it is exactly `embeddingProviderLabel("workers-ai")`; no bare `Workers AI` occurrence lacking a preceding `Cloudflare ` survives | Fails loudly as a test, not silently as drifted copy |
| Non-Workers refusal | `{ provider: "openai", baseUrl: "https://e", model: "text-embedding-3-small", hasKey: false }` | `Vector search needs an API key before it can be turned on.` — unchanged, no provider name introduced | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts` -- the only change site. Imports from `./providers` at `:22-30` (add `embeddingProviderLabel`). Four hand-typed occurrences: `SETTINGS_VECTOR_BINDING_NOTE` `:212-213`, `SETTINGS_VECTOR_BINDING_ENV_NOTE` `:233-234`, and the two model phrases inside `vectorSearchMissingLegs` at `:654-655`. `vectorSearchMissingLegs` is at `:632`; its callers `vectorSearchMissingCopy` `:694` and `vectorSearchInactiveCopy` `:721` assemble through `withLegNotes` `:731` / `vectorSearchLegSentence` `:750` and need no change.
- `src/lib/providers.ts:184-196` -- `embeddingProviderLabel`, the picker's own door; returns `"Cloudflare Workers AI"` for `workers-ai` and delegates to `providerLabel` otherwise. Read-only here. `providers.ts` imports nothing from `workbench-settings.ts`, so the new import direction is already the existing one.
- `src/components/workbench/SettingsCanvas.tsx:518` -- renders the `<option>` list through `embeddingProviderLabel(option)`; `:245`/`:263` compute the refusal and inactive sentences and `:600-615` renders them into the switch hint; `:277` already derives the env-key hint from the same helper. Read-only evidence that all of it lands on one screen; no edit needed.
- `src/lib/__tests__/workbench-settings.test.ts` -- the node suite pinning this copy. Literals to update: `:380` (`UNSUPPORTED_WORKERS_MODEL`), `:494`, `:585`, `:595`, `:607`, `:621`, `:666`, `:757`, `:851`, `:955`, `:2523`, `:3159`, `:3229`. Cases referencing the notes by CONSTANT (`:721`, `:760`, `:778-800`, `:853-856`, `:978`, `:996`, `:1721`, `:2732`) need no edit. `:3499-3510` is the existing picker-label test — the natural neighbour for the parity test.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- the DOM suite. Literals at `:132`, `:134`, `:142`; `:228` asserts the ABSENCE of the pre-DW-220 phrase and must keep matching the current text.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:786` -- composes the binding refusal from the exported constant; no literal to change, but it must still pass.
- `_bmad-output/implementation-artifacts/spec-dw-73-workers-ai-embedding-namespace.md:236-242` -- the frozen I/O matrix. Rows 2-4 quote the copy verbatim; row 2's sentence was ALREADY superseded by DW-220 (it says "a model id in the Workers AI @cf/ namespace", which no code path produces today) — leave that divergence alone and change only the provider name.
- `DEPLOY.md:92-95` -- block-quotes `SETTINGS_VECTOR_BINDING_ENV_NOTE` verbatim. Lines `:103`, `:130`, `:137` are narrative prose, not quoted copy — out of scope.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- import `embeddingProviderLabel`, declare one module-level `WORKERS_AI_LABEL = embeddingProviderLabel("workers-ai")` above the vector copy block, and interpolate it into all four strings -- one derivation is what makes the two surfaces unable to drift; a comment at the declaration should say that is the point (DW-222).
- `src/lib/__tests__/workbench-settings.test.ts` -- update the copy literals listed in the Code Map and add the parity case beside the existing picker-label test: every provider-naming refusal string equals/contains `embeddingProviderLabel("workers-ai")`, and none contains a `Workers AI` occurrence without a preceding `Cloudflare ` -- a literal-by-literal rename would pass again the next time someone types the short name.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- update the three announced-copy literals and confirm `:228`'s negative assertion still refers to text no code produces -- this is the suite that proves what the mounted surface actually announces.
- `_bmad-output/implementation-artifacts/spec-dw-73-workers-ai-embedding-namespace.md` -- rename the provider in the frozen matrix rows and append a dated note beneath the matrix recording that DW-222's 2026-08-19 decision renegotiated the frozen expectation deliberately, for copy consistency with the picker -- a frozen expectation edited without a record is indistinguishable from one edited to match changed code.
- `DEPLOY.md` -- update the block quote at `:92-95` so the documented sentence is the sentence the deployment now shows -- an operator comparing the doc to the screen must find them identical.

**Acceptance Criteria:**
- Given the Workbench Settings surface with `Cloudflare Workers AI` selected, when the vector switch is refused for any reason that names the provider, then the name in the refusal is character-for-character the name in the picker above it.
- Given a future edit that reintroduces a hand-typed provider name in vector-gate copy, when the suite runs, then the parity test fails.
- Given `vitest run`, `tsc --noEmit`, and `eslint` over the repo, when run, then all pass with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 3, low 5)
- defer: 0
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` The parity test only caught the SHORT name, so hand-typing `Cloudflare Workers AI` into the module left the suite green while the spec's AC promises any hand-typed name fails. The test now also scans `src/lib/workbench-settings.ts` source: the full name may not appear in it at all, and the `WORKERS_AI_LABEL = embeddingProviderLabel("workers-ai")` declaration must be present.
  - `[medium]` `[patch]` Every parity assertion lived at the module seam, where both sides resolve through the same `embeddingProviderLabel` call and cannot disagree by construction — nothing compared the RENDERED picker to the RENDERED refusal, which is the surface the intent names ("the picker two rows above"). Added a mounted case reading the `<option>` text out of the select and asserting the announced refusal carries that exact string and no second spelling.
  - `[medium]` `[patch]` `DEPLOY.md`'s block quote of `SETTINGS_VECTOR_BINDING_ENV_NOTE` was joined to the constant only by someone remembering — the same unguarded drift this story exists to end. Added a node-suite test that un-wraps the doc's block quotes and asserts one contains the constant verbatim.
  - `[low]` `[patch]` `settings-vector-namespace.test.tsx:228`'s `not.toContain("in the Workers AI @cf/ namespace")` could no longer fail: a reintroduced pre-DW-220 sentence would now say "Cloudflare Workers AI". The phrase is derived the way the copy is, so the guard guards again.
  - `[low]` `[patch]` The parity test's closing comment claimed the binding notes were unreachable by the sweep; they are attached as leg notes and appear in 128 swept copies. Rewritten to say what the constant loop actually adds — that each note OPENS with the derived name.
  - `[low]` `[patch]` The sweep's `named.length > 0` floor let three of the four naming phrases silently stop being exercised, the label itself was unpinned (deleting `embeddingProviderLabel`'s branch would have left every assertion true against the raw slug), the residual missed slug/casing variants, and the title's "every vector refusal" excluded `vectorSearchFieldIssue`. All four addressed: per-family reach assertions, `expect(label).toBe("Cloudflare Workers AI")`, a `/workers[\s-]?ai/i` residual, and the field-issue copy folded into the sweep.
  - `[low]` `[patch]` `DEPLOY.md:103` — the prose explaining the quote four lines above it still said "the sentence beside it is about Workers AI". Updated; `:130`, `:137`, `:204` left as generic prose about the provider.
  - `[low]` `[patch]` `spec-dw-73`'s Design Notes still quoted the composed sentence with the short name, so the one spec being renegotiated named the same selection two ways inside itself. Updated the prose quote; the code snippet recording the pre-DW-220 implementation left intact.

## Design Notes

```ts
/**
 * The ONE name this module gives `workers-ai` (DW-222).
 *
 * The picker renders `embeddingProviderLabel(option)`, so a refusal that typed
 * the name instead described the same selection under a second name on the same
 * screen. Deriving it means the two cannot drift.
 */
const WORKERS_AI_LABEL = embeddingProviderLabel("workers-ai");
```

The notes stay `export const` strings rather than becoming functions: the value is fixed at module load, `DEPLOY.md` quotes them, and three suites compose expected sentences from them by name.

## Verification

**Commands:**
- `node_modules/.bin/vitest run src/lib/__tests__/workbench-settings.test.ts src/components/workbench/__tests__/settings-vector-namespace.test.tsx src/lib/__tests__/settings-runtime-wiring.test.ts` -- expected: all pass, including every matrix row and the new parity case.
- `node_modules/.bin/vitest run` -- expected: no new failures anywhere.
- `node_modules/.bin/tsc --noEmit` -- expected: exit 0.
- `node_modules/.bin/eslint` -- expected: clean apart from the pre-existing `jsx-ast-utils` "TSNonNullExpression could not be resolved" noise.
- `grep -rn "Workers AI" src/lib/workbench-settings.ts` -- expected: no user-visible string literal types the short name; remaining hits are prose in doc comments.

**Note:** `pnpm <script>` fails repo-wide with `ERROR packages field missing or empty` (pre-existing workspace-config issue). Invoke the binaries from `node_modules/.bin` instead.

## Auto Run Result

Status: done

**Implemented change.** `workers-ai` now has exactly one name on the Workbench Settings screen (DW-222). `src/lib/workbench-settings.ts` derives it once — `const WORKERS_AI_LABEL = embeddingProviderLabel("workers-ai")`, the same helper the embedding-provider picker renders its `<option>` text from — and interpolates it into all four places that typed "Workers AI" by hand: both model-mismatch phrases in `vectorSearchMissingLegs` and both binding notes it attaches (`SETTINGS_VECTOR_BINDING_NOTE`, `SETTINGS_VECTOR_BINDING_ENV_NOTE`). `SETTINGS_VECTOR_BINDING_ENV_NOTE` is not named in the ledger entry — it did not exist when DW-222 was filed — but it is emitted by the same function onto the same control, so leaving it would have closed half the defect. Nothing else moved: leg order, leg fields, sentence assembly, the on-but-inactive frame and which control each note rides on are unchanged, and `embeddingProviderLabel` itself returns exactly what it returned before.

Per the 2026-08-19 decision, `spec-dw-73-workers-ai-embedding-namespace.md`'s frozen I/O matrix was edited in the same change, with a dated note beneath it recording that the frozen expectation was renegotiated deliberately for copy consistency with the picker. Only the provider NAME moved there: row 2's "a model id **in** the … @cf/ namespace" remains superseded by DW-220 and is left as recorded, so this change is not mistaken for absorbing that one.

**Files changed.**
- `../../src/lib/workbench-settings.ts` -- the one derivation and its four interpolations, with the rationale recorded at the declaration.
- `../../src/lib/__tests__/workbench-settings.test.ts` -- 13 copy literals renamed; a parity sweep over the full `VectorSearchInputs` cross-product through `vectorSearchMissingCopy`, `vectorSearchInactiveCopy` and `vectorSearchFieldIssue`, plus a source scan of the module; and a `DEPLOY.md`-to-constant drift guard.
- `../../src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- three announced-copy literals renamed, the DW-220 negative guard re-derived so it can fail again, and a mounted rendered-picker-to-rendered-refusal parity case.
- `../../DEPLOY.md` -- the block-quoted refusal now matches the shipped sentence, and the prose explaining it agrees.
- `spec-dw-73-workers-ai-embedding-namespace.md` -- frozen matrix rows 2-4 renamed, the renegotiation recorded beneath the matrix, and the Design Notes prose quote brought in line.

**Review findings breakdown.** 8 patches applied (medium 3, low 5); 0 deferred; 8 rejected. Rejected, with reasons: the spelled-out id lists at `:585`/`:666` deliberately pin the catalog a derived constant would follow silently; the renegotiation note belongs beneath the matrix a reader consults, not in a done spec's own review-loop change log; the DW-222 matrix's `providerOrigin: "config"` is a cosmetic slip in a row whose meaning ("selection stored") is unambiguous and covered; `DEPLOY.md` quoting only the env-owned note is a deliberate doc structure; the sweep's redundancy costs nothing measurable; the test's placement in the source-scan `describe` is now correct since it reads source; `SETTINGS_INVALID_EMBEDDING_PROVIDER_COPY` lists accepted VALUES, where the slug is the right token; and closing DW-222 in the ledger is the orchestrator's job, explicitly forbidden here.

**Follow-up review recommendation.** true. Patched this pass: high 0, medium 3, low 5 -> 3x3 + 1x5 = 14, at or above the threshold of 5.

**Verification performed.**
- `node_modules/.bin/vitest run` (full): 254 files / 5396 tests, all passing.
- `node_modules/.bin/tsc --noEmit`: exit 0. `node_modules/.bin/eslint`: exit 0, apart from the pre-existing `jsx-ast-utils` TSNonNullExpression noise.
- `grep -rn "Workers AI" src/lib/workbench-settings.ts`: two hits, both doc-comment prose; no user-visible literal.
- Matrix audit: all six rows covered by tests that ran and passed -- the unsupported-`@cf/` row at `workbench-settings.test.ts:582`/`:663` with its 400 path at `:2500`; the keyed-provider row at `:592` with `:2523`; the stored-binding row at `:721`/`:978`; the env-binding row at `:778`/`:996` and `settings-runtime-wiring.test.ts:786`; the parity invariant by the new sweep; and the non-Workers refusal at `:555`/`:1345`.
- Mutation checks run and reverted: hand-typing the full name fails the source scan; reintroducing the pre-DW-220 sentence fails the re-derived DOM guard; drifting the `DEPLOY.md` quote by a word fails the new doc guard; reverting the refusal to the short name while the picker keeps the full one fails the rendered-parity case.

**Residual risks.**
- The rendered-parity case uses `toContain`, so a refusal that named the provider "Cloudflare Workers AI Embeddings" would pass it -- inherent to comparing a name embedded in a sentence. The node suite's per-family reach assertions catch that shape, so the pair covers it.
- The DW-222 matrix's third row writes `providerOrigin: "config"`, which is not a member of the `"env" | "stored"` union. The row describes the stored-selection case and its covering tests use `"stored"`; the text sits inside the read-only intent contract and was left as written.
- `DEPLOY.md`'s narrative at `:130`, `:137` and `:204` still uses the short form. It is prose about the provider rather than about a quoted refusal, so it is outside what the decision authorised.
