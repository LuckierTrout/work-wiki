---
title: 'Every provider refusal names its gap and its derived destination (DW-630, DW-631, DW-632)'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
baseline_revision: 'cb95a03f1272993a902421accc23051876eb7822'
deferred:
  - summary: >-
      `getConfiguredModel` never reads `cfg.model` or `LLM_MODEL`, so a stored
      primary model refuses a `custom` provider the primary ladder builds fine.
    evidence: |-
      DW-632 aligned the two ladders' KEYLESS diagnoses; the MODEL gap still
      diverges, and this one is not copy. `getResolvedCredentials`
      (`src/lib/config.ts:2613-2632`) resolves the model from `LLM_MODEL`, then
      `cfg.model`; `getConfiguredModel`'s explicit-provider branch
      (`src/lib/llm.ts:519-524`) resolves only `options.model`, the workload
      settings, `OLLAMA_MODEL` and `DEFAULT_MODELS[provider]` — and
      `DEFAULT_MODELS.custom` is deliberately absent. Verified with a seeded
      config `{provider: "custom", model: "my-model", customApiKey,
      customBaseUrl}`: `getModel` builds the client, while
      `getConfiguredModel({provider: "custom"})` throws "The Custom provider
      needs a model name." Reachable in production at
      `src/lib/agent-runtime.ts:156`, which spreads `provider` with no `model`
      when an agent carries no model override — so a correctly configured
      custom endpoint is refused for a model the owner did set. Pre-existing
      and outside this bundle's named sites; the new cross-ladder equality
      tests deliberately cover only the two keyless states for that reason.
    location: >-
      src/lib/llm.ts:519
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three provider refusals sit outside the derivation DW-369/DW-503 built. `getModel`'s no-provider throw (`src/lib/llm.ts:337-343`) ends "…or configure a provider in Settings." and `extractStructuredKnowledge` (`src/lib/structured-knowledge.ts:299-302`) ends "Choose one in Settings;" — a bare surface word with no category, weaker than the five sibling sentences in the same file; `getModel`'s `ollama-cloud` guard (`:412-416`) hand-types the display label `providerLabel` owns and names an env var instead of a Settings field; and `getConfiguredModel`'s pre-switch keyless guard (`:475-486`) fires for `custom` before the base-URL check at `:503`, so the same keyless-`custom` state is diagnosed "is not configured on this server" on one ladder and "needs a base URL" on the other.

**Approach:** Route the two bare-"Settings" sentences through the existing `settingsPointer("llm-models", SETTINGS_LABEL)` derivation; re-voice the `ollama-cloud` guard in `getModel`'s own gap-naming idiom with a `providerLabel`-derived name and the derived pointer; and exempt `custom` from the pre-switch guard so its own case names all three gaps in the base URL → API key → model order `getModel` already uses. Pin each with tests, and widen the existing byte scan's counts.

## Boundaries & Constraints

**Always:**
- Derive every Settings destination from `settingsPointer(...)`; never re-type surface + arrow + category label.
- Keep the SHORT surface form (`SETTINGS_LABEL`, i.e. "Settings → …") at every touched site — these are runtime errors rendered on neither Settings surface, matching the five DW-369 refusals and the DW-503 guard.
- Derive the `ollama-cloud` display name through `providerLabel`, never the literal "Ollama Cloud" and never the raw slug.
- Both ladders must diagnose a keyless `custom` provider identically, in `getModel`'s order: base URL, then API key, then model name.
- `getModel`'s existing enumeration of env var names in the no-provider throw stays — only its trailing destination changes.
- Keep `ollama`'s exemption from the pre-switch keyless guard exactly as it is.

**Block If:**
- Importing `./workbench-settings` into `src/lib/structured-knowledge.ts` would create an import cycle. (It should not: `workbench-settings.ts` is client-safe, pulls no Node built-ins, and imports nothing from `structured-knowledge.ts`.)

**Never:**
- Do not reword the five DW-369 `The Custom provider needs …` sentences or the DW-503 keyless-guard sentence; their wording is pinned and stays byte-identical for the current label.
- Do not rename any `SETTINGS_CATEGORIES` label, and do not add a category.
- Do not touch `sidecar/mcp.mjs` (AD-6 forbids the sidecar importing `src/lib`).
- Do not touch `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No provider at all | `callLLM()` with every provider env var unset and no stored `provider` | Message still enumerates the env var names, then ends `…, or configure a provider in Settings → <llm-models label>.` | The throw IS the behaviour |
| Keyless Ollama Cloud, primary ladder | stored `provider: "ollama-cloud"`, `OLLAMA_API_KEY` unset → `getModel()` | Throws `The Ollama Cloud provider needs an API key. Set it in Settings → <llm-models label>.` — label from `providerLabel`, never `ollama-cloud` | The throw IS the behaviour |
| Keyless custom, nothing set, workload ladder | `getConfiguredModel({ provider: "custom" })`, no base URL, no key | Throws `The Custom provider needs a base URL. Set it in Settings → <llm-models label>.` — the base-URL gap first, matching `getModel` | The throw IS the behaviour |
| Keyless custom, base URL set | Same plus `LLM_CUSTOM_BASE_URL` | Throws `The Custom provider needs an API key. Set it in Settings → <llm-models label>.` — the state the old guard hid | The throw IS the behaviour |
| Custom fully credentialed, no model | base URL + key set, no model | Unchanged: `The Custom provider needs a model name. Set it in Settings → <llm-models label>.` | The throw IS the behaviour |
| Keyless non-custom, workload ladder | `getConfiguredModel({ provider: "openai" })`, no key | Unchanged DW-503 sentence: `The OpenAI provider is not configured on this server. Set it in Settings → <llm-models label>.` | The throw IS the behaviour |
| `ollama` exemption | `getConfiguredModel({ provider: "ollama" })`, no key | No throw; model id is `DEFAULT_MODELS.ollama` | n/a |
| Unconfigured extraction provider | `extractStructuredKnowledge(owner, slug)` with no provider configured | Throws `Structured Knowledge needs a configured extraction provider. Choose one in Settings → <llm-models label>; credentials stay in server secrets.` | The throw IS the behaviour |
| Category renamed | `SETTINGS_CATEGORIES` label for `llm-models` edited | All touched sentences follow the rename with no source edit | n/a |

</intent-contract>

## Code Map

- `src/lib/llm.ts:55` -- `LLM_MODELS_POINTER = settingsPointer("llm-models", SETTINGS_LABEL)`, the one owned destination in this file. Reuse it; its docblock (`:36-54`) explains the SHORT surface form.
- `src/lib/llm.ts:336-343` -- `getModel`'s no-provider throw, a 4-line string concat. Only the final fragment changes: `"provider in Settings."` → a template fragment ending `` `provider in ${LLM_MODELS_POINTER}.` ``.
- `src/lib/llm.ts:411-417` -- `getModel`'s `case "ollama-cloud"` keyless guard. `creds.provider` is narrowed to `"ollama-cloud"` here; pass it to `providerLabel`.
- `src/lib/llm.ts:373-395` -- `getModel`'s `case "custom"`: the canonical gap order (base URL `:376`, API key `:381`, model `:390`). This is the order the other ladder must match.
- `src/lib/llm.ts:474-486` -- `getConfiguredModel`'s pre-switch keyless guard (`provider !== "ollama" && !apiKey`). Add the `custom` exemption here; leave the sentence itself untouched.
- `src/lib/llm.ts:503-518` -- `getConfiguredModel`'s `case "custom"`: has base-URL and model checks, no API-key check, and passes `apiKey!`. Insert the key check between them and drop the non-null assertion.
- `src/lib/providers.ts:12-24`, `:179-182` -- `PROVIDER_INFO` (`ollama-cloud` → `"Ollama Cloud"`) and `providerLabel`, re-exported through `src/lib/config.ts` and already imported by `llm.ts:18`.
- `src/lib/workbench-settings.ts:83-97`, `:119`, `:176-181` -- `SETTINGS_CATEGORIES`, `SETTINGS_LABEL`, `settingsPointer`. Client-safe, no Node built-ins, imports nothing from `structured-knowledge.ts` — safe to import there.
- `src/lib/structured-knowledge.ts:297-302` -- the extraction refusal. Imports at `:1-23` do not yet include `./workbench-settings`.
- `src/lib/__tests__/llm.test.ts:563-601` -- the byte scan. `throwSites` (lines containing `The Custom provider needs`) is pinned at 5 and becomes 6; `pointerSites` (lines containing `Set it in `) is `toBeGreaterThanOrEqual(6)` and becomes 8; the whole-file `not.toContain` check needs no change.
- `src/lib/__tests__/llm.test.ts:544-560` -- the cross-ladder parity test; sets `LLM_CUSTOM_API_KEY` only to step past the old guard.
- `src/lib/__tests__/llm.test.ts:686-694` -- the DW-503 test asserting keyless `custom` gets the generic guard sentence. This expectation inverts under DW-632.
- `src/lib/__tests__/llm.test.ts:601-712` -- the DW-503 describe, with `seedConfig`/`refusal` helpers and the derived `pointer` constant to reuse.
- `src/lib/__tests__/structured-knowledge.test.ts:41-52`, `:259-283` -- `beforeEach` deletes `OPENAI_API_KEY` and points `DATA_DIR` at a tmpdir; the parse-failure test shows the page-seeding idiom (`getStorage().writeFile(tenantWikiRelPath(...))`). A test that saves no config reaches the refusal directly.

## Tasks & Acceptance

**Execution:**
- `src/lib/llm.ts` -- end the no-provider throw at `${LLM_MODELS_POINTER}` instead of the bare surface word -- DW-630: the most common keyless path was the one with no pointer.
- `src/lib/llm.ts` -- re-voice the `ollama-cloud` guard as `` `The ${providerLabel(creds.provider)} provider needs an API key. Set it in ${LLM_MODELS_POINTER}.` `` -- DW-631: the display label and the destination both become derived, in `getModel`'s own gap-naming idiom.
- `src/lib/llm.ts` -- exempt `custom` from the pre-switch keyless guard and add the API-key check to `getConfiguredModel`'s `custom` case between the base-URL and model checks (reusing the sibling's exact sentence), replacing `apiKey!` with the now-checked `apiKey` -- DW-632: one diagnosis order across both ladders. Comment why `custom` is exempt.
- `src/lib/structured-knowledge.ts` -- import `SETTINGS_LABEL`/`settingsPointer` and derive the destination in the extraction refusal -- DW-630's second half.
- `src/lib/__tests__/llm.test.ts` -- update the byte-scan counts (5→6, ≥6→≥8); replace the DW-503 keyless-`custom` expectation with the base-URL sentence and add the base-URL-set/keyless case; add coverage for the no-provider pointer and the `ollama-cloud` refusal -- pins every I/O row on this file.
- `src/lib/__tests__/structured-knowledge.test.ts` -- add a test asserting the refusal against `settingsPointer("llm-models", SETTINGS_LABEL)` -- the derivation, not a hand-composed literal.

**Acceptance Criteria:**
- Given the `llm-models` category label is renamed in `SETTINGS_CATEGORIES`, when the suite runs, then no assertion and no source line has to be edited for the touched sentences to follow the rename.
- Given a keyless `custom` provider in an identical state, when it is resolved through `getModel` and through `getConfiguredModel`, then both throw the same sentence.
- Given the whole of `src/lib/llm.ts` and `src/lib/structured-knowledge.ts`, when scanned as bytes, then neither spells `Settings → <llm-models label>` as a literal.

## Spec Change Log

## Review Triage Log

### 2026-09-01 - Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 1, low 9)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` No positive-path test for the `custom` guard exemption - a broken exemption would refuse every working custom config with the suite green. Added a base URL + key + model case on the `getConfiguredModel` ladder asserting `modelId`.
  - `[low]` `[patch]` The `ollama-cloud` comment justified dropping `OLLAMA_API_KEY` with "the no-provider throw above still enumerates it", which is unreachable once the provider IS `ollama-cloud`. Replaced with the true reason: parity with the pre-switch guard's destination for the same state.
  - `[low]` `[patch]` Four comment counts made stale by this diff ("five sibling refusals", "The sixth destination", "a sixth sentence", "the five that happen to share a subject") corrected to the file's real counts (nine refusals, eight siblings, six `The Custom provider needs` lines, eight pointer lines).
  - `[low]` `[patch]` Both new tests threw their sentinel INSIDE their own `try`, so the sentinel string became the message under assertion. Extracted `primaryRefusal()` / `refusal(slug)` helpers matching the file's existing shape.
  - `[low]` `[patch]` Cross-ladder equality pinned only the base-URL state; extended it to the API-key state, the sentence this diff newly duplicated. The model state is deliberately excluded and now says why (see `deferred`).
  - `[low]` `[patch]` The new structured-knowledge test cleared only `OPENAI_API_KEY`, so any of the six other vars `detectEnvProvider` consults made the refusal unreachable. Moved into a nested describe that saves/deletes/restores all seven.
  - `[low]` `[patch]` `structured-knowledge.ts` derived the destination inline; hoisted a module-level `LLM_MODELS_POINTER` mirroring `llm.ts:55`.
  - `[low]` `[patch]` The spec's third acceptance criterion names both files but only `llm.ts` was byte-scanned. Added a scan over `structured-knowledge.ts` for the literal, plus a positive assertion that the derivation is present.
  - `[low]` `[patch]` The describe titled "the keyless guard points at the LLM Models category" held two tests whose point is that `custom` never reaches it. Retitled to cover DW-503 and DW-632.
  - `[low]` `[patch]` The no-provider test asserted with `toContain`, so a regrown bare "Settings." clause elsewhere in the string would pass. Switched to whole-message `toBe`, env-var-list assertions kept.
  - `[low]` `[patch]` The "guard's other side" comment on the `ollama-cloud` positive test named the ladder it does not exercise. Corrected, and it now points at `llm-ollama-cloud.test.ts` for the other leg.

## Design Notes

The `ollama-cloud` guard adopts `getModel`'s gap-naming voice ("needs an API key"), not `getConfiguredModel`'s generic one ("is not configured on this server"): `getModel` names the specific missing half at every one of its four other throw sites, and DW-632 is itself a ruling that the specific diagnosis beats the generic one. Dropping `OLLAMA_API_KEY` from the sentence loses nothing an owner can act on — the no-provider throw still enumerates it, and the sibling guard already sends a keyless `ollama-cloud` to the same derived destination (pinned at `llm.test.ts:674-679`).

Both bare-"Settings" sentences point at `llm-models`. That is where the Workbench renders provider selection and credentials, and the flat page's own `SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY` already sends owners there for exactly this class of gap.

The `custom` exemption, not a reordered guard:

```ts
// `custom` is exempt for the same reason `ollama` is, though not the same
// cause: its own case below names all three gaps in `getModel`'s order —
// base URL, API key, model — and routing it through this generic sentence
// reported the missing key BEFORE the missing endpoint, so one state got two
// diagnoses depending on the ladder it arrived on (DW-632).
if (provider !== "ollama" && provider !== "custom" && !apiKey) {
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/llm.test.ts src/lib/__tests__/structured-knowledge.test.ts` -- expected: all pass, including the new cases.
- `pnpm test` -- expected: green; `brand-copy.test.ts` and `settings-runtime-wiring.test.ts` in particular are unaffected.
- `pnpm exec tsc --noEmit` -- expected: clean, with no non-null assertion left on `apiKey` in the `custom` case.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** Three provider refusals were brought inside the derivation DW-369/DW-503 built. `getModel`'s no-provider throw and `extractStructuredKnowledge`'s unconfigured-provider throw now end at the derived `Settings -> LLM Models` pointer instead of a bare "Settings" (DW-630). `getModel`'s `ollama-cloud` guard now reads `The Ollama Cloud provider needs an API key. Set it in <pointer>.`, with the display label derived through `providerLabel` and the destination through `LLM_MODELS_POINTER` (DW-631). `custom` is now exempt from `getConfiguredModel`'s pre-switch keyless guard, and its own case gained the API-key check the guard used to swallow, so both ladders diagnose a keyless `custom` provider in one order - base URL, then API key, then model (DW-632).

**Files changed.**
- `src/lib/llm.ts` - the no-provider and `ollama-cloud` refusals derive their destination; `custom` exempted from the pre-switch guard and given an API-key check in its own case; `apiKey!` narrowed to `apiKey`.
- `src/lib/structured-knowledge.ts` - module-level `LLM_MODELS_POINTER` hoisted from `settingsPointer("llm-models", SETTINGS_LABEL)`; the extraction refusal consumes it.
- `src/lib/__tests__/llm.test.ts` - byte-scan counts widened (5 -> 6 exact, >=6 -> >=8); the DW-503 keyless-`custom` expectation inverted and its describe retitled; new cross-ladder equality tests for both keyless states; new describe covering the no-provider pointer, the `ollama-cloud` refusal, and positive paths for the `custom` exemption and the `ollama-cloud` guard.
- `src/lib/__tests__/structured-knowledge.test.ts` - hermetic nested describe asserting the extraction refusal against the derivation, plus a byte scan over `structured-knowledge.ts`.

**Review findings breakdown.** 10 patches applied, 1 item deferred, 8 rejected. The rejects were the remaining `ollama-cloud` cross-ladder wording difference (pre-existing; converging it would invert a DW-503 acceptance pin), the `>=8` vs `toHaveLength(8)` scan idiom (a deliberate existing choice), the unmocked `ai` module in `llm.test.ts` (pre-existing file idiom; the refusal states throw before any network call), the surviving `creds.model!` assertion (pre-existing, re-checked twelve lines later), the bare-"Settings" sibling call sites at `structured-knowledge.ts:344`, `error-hints.ts:85` and `workbench-modes.ts:92` (out of scope on the intent's authority - DW-630 names exactly two locations), and the file-level test env-cleanup gap (pre-existing).

**Follow-up review recommendation:** true. Patched findings this pass: high 0, medium 1, low 9. Score = 3 x 1 + 1 x 9 = 12, which is >= 5.

**Verification.**
- `pnpm exec vitest run --project node src/lib/__tests__/llm.test.ts src/lib/__tests__/structured-knowledge.test.ts` - 60 passed (llm 53, structured-knowledge 7).
- `pnpm exec tsc --noEmit` - exit 0.
- `pnpm lint` - exit 0.
- `pnpm test` - 8829 passed / 1 skipped on a green run. One later run failed `storage-fs.test.ts > reapStrandedScratchFiles > stops at STRANDED_SCRATCH_CANDIDATE_CAP` on a 5000 ms timeout; confirmed pre-existing by stashing every change in this run and re-running the full suite on the clean baseline, where it fails identically. It passes in isolation on both trees and touches none of these files.
- Matrix audit: all nine I/O rows are covered by tests that ran and passed in the runs above.
- Byte checks: `The Custom provider needs` appears 6 times in `llm.ts`, `Set it in ` 8 times, `${LLM_MODELS_POINTER}` at 9 throw sites; neither `llm.ts` nor `structured-knowledge.ts` contains the literal `Settings -> LLM Models`.
- Mutation checks by the implementer: reverting the `custom` exemption fails 3 tests; making the new API-key check unconditional fails 2, including the new positive-path test.

**Residual risks.**
- A keyless `ollama-cloud` provider still gets two differently-worded sentences across the two ladders (both now naming the same derived destination). Converging them would require rewording the DW-503 guard sentence, which this spec forbids.
- The `Settings -> LLM Models` category renders no Ollama Cloud key row, so that pointer is the same destination the shipped DW-503 guard already uses for this state - consistent, but not a field the owner can fill for this provider.
- The model-gap divergence between the two ladders is real and reachable from `agent-runtime.ts`; it is recorded in `deferred` rather than fixed here.
