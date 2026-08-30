---
title: 'One derivation behind every "go to Settings" sentence (DW-503, DW-504)'
type: 'bugfix'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
baseline_revision: '8449b177079ac1287bc84a1d36822a53ff5be4fa'
deferred:
  - summary: >-
      `sidecar/mcp.mjs`'s `MCP_INSTRUCTIONS` still hand-types the `api-mcp`
      category label, the last copy of the destination DW-504 derived.
    evidence: |-
      `sidecar/mcp.mjs:52-55` reads "the owner has switched the API off in
      Settings → API + MCP" — the same sentence as `CHAT_API_DISABLED_COPY`,
      still a literal. It is the standing instruction text every MCP client
      reads before its first call, so it is owner-facing. `grep -rn
      MCP_INSTRUCTIONS` returns only its definition (`:50`) and its
      `McpServer` registration (`:345`); no test asserts its content. Renaming
      `api-mcp` in `SETTINGS_CATEGORIES` now moves the three `chat-agent.ts`
      sentences automatically and leaves this one stale with the whole suite
      green. A plain import cannot fix it — AD-6 forbids the sidecar importing
      `src/lib` — so it needs a shared `.mjs` constant, or a node-project test
      that imports `MCP_INSTRUCTIONS` (the idiom `epic8-chat-agent.test.ts`
      already uses for `sidecar/shell.mjs`) and asserts it contains
      `settingsPointer("api-mcp", SETTINGS_LABEL)`.
    location: >-
      sidecar/mcp.mjs:54
    severity: low
  - summary: >-
      Two provider refusals send the owner to a bare "Settings" with no
      category, now less specific than the guard DW-503 just fixed.
    evidence: |-
      `src/lib/llm.ts:303-308` (`getModel`'s no-provider-at-all throw) ends
      "…or configure a provider in Settings.", and
      `src/lib/structured-knowledge.ts:299-301` throws "Structured Knowledge
      needs a configured extraction provider. Choose one in Settings;
      credentials stay in server secrets." Neither names a category, so
      neither can drift — but both are now WEAKER than the sentence thrown
      130 lines below the first one, which reads "Set it in Settings → LLM
      Models." The no-provider case is the most common keyless path, so the
      owner most in need of the pointer is the one who does not get it.
      Neither line contains "Set it in ", so the widened byte scan added in
      this bundle walks straight past both.
    location: >-
      src/lib/llm.ts:303, src/lib/structured-knowledge.ts:299
    severity: low
  - summary: >-
      `getModel`'s Ollama Cloud refusal hand-types the display label
      `providerLabel` owns and names no destination.
    evidence: |-
      `src/lib/llm.ts:378-382` throws "Ollama Cloud requires OLLAMA_API_KEY to
      be configured as a server secret." It spells "Ollama Cloud", which is
      `PROVIDER_INFO`'s label for `ollama-cloud` (`src/lib/providers.ts:17`)
      and is now derived through `providerLabel` at the sibling guard this
      bundle fixed — so the same rename that moves one leaves the other. It
      also names an env var and no Settings field, where the five DW-369
      refusals and the DW-503 guard all end in the derived pointer. Same
      `switch` the change touched; outside the intent's named sites.
    location: >-
      src/lib/llm.ts:380
    severity: low
  - summary: >-
      A keyless `custom` provider gets two different diagnoses depending on
      which resolution ladder it arrives on.
    evidence: |-
      Both ladders now end at the same derived destination, but they disagree
      on what is wrong. `getModel` (`src/lib/llm.ts:336-360`) checks the base
      URL first and then says "The Custom provider needs an API key.";
      `getConfiguredModel`'s pre-switch guard (`:433`) fires before the
      `custom` case and says "The Custom provider is not configured on this
      server." — reporting the missing key before the missing base URL, the
      reverse of its sibling's order. DW-503 asked only for the destination
      and the display label, both delivered; the diagnosis half is untouched
      and pre-existing. `llm.test.ts:544`'s cross-ladder parity test sets
      `LLM_CUSTOM_API_KEY` specifically to step past this guard, so the one
      Custom state where the two ladders disagree is the state it does not
      cover. Not already in the ledger: `deferred-work.md:3748` is DW-503
      itself, which names the ordering but does not record the divergence.
    location: >-
      src/lib/llm.ts:433
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two owner-facing surfaces still hand-type what DW-369 made derived. `getConfiguredModel`'s pre-switch keyless guard (`src/lib/llm.ts:433`) throws `The ${provider} provider is not configured on this server.` — a lowercased provider slug and no Settings destination — while the five sibling refusals around it end in the derived `Set it in Settings → <category>.`; and three constants in `src/lib/chat-agent.ts` (`:376`, `:490`, `:494`) spell the literal `Settings → API + MCP`, whose label is owned by `SETTINGS_CATEGORIES` in `src/lib/workbench-settings.ts:98`, so renaming that category leaves three rendered sentences naming a nav row the surface no longer shows.

**Approach:** Route both through the already-exported `settingsPointer(id, SETTINGS_LABEL)`: append `LLM_MODELS_POINTER` to the keyless guard and render the provider through `providerLabel`, and compose the three `chat-agent.ts` constants from a single derived `api-mcp` pointer. Pin each derivation with a parity test that asserts against the derived label and byte-scans the source so re-typing the literal fails.

## Boundaries & Constraints

**Always:**
- Derive every Settings destination from `settingsPointer(...)`; never re-type the surface word plus arrow plus category label.
- Keep the SHORT surface form (`SETTINGS_LABEL`, i.e. "Settings → …", not "Workbench Settings → …") at all four touched sites, matching the DW-369 sites and the current `chat-agent.ts` copy.
- The three `chat-agent.ts` sentences must render byte-identically to today for the current category label — this is a derivation change, not a copy change.
- `src/lib/chat-agent.ts` stays client-safe and pure: `workbench-settings.ts` is browser-importable (`SettingsCanvas` imports it) and pulls no Node built-ins, so the new import is allowed; add nothing else.

**Block If:**
- Importing `workbench-settings.ts` from `chat-agent.ts` would create an import cycle or drag a Node-only module into a `"use client"` component.

**Never:**
- Do not change `sidecar/mcp.mjs:54`'s literal — the sidecar may not import `src/lib` (AD-6) and it is outside the ledger's named sites.
- Do not reword the five DW-369 refusals, `chatDoorRefusalCopy`'s branching, or any category label.
- Do not touch `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Keyless workload-routed provider | `getConfiguredModel({ provider: "openai" })` with `OPENAI_API_KEY` unset | Throws `The OpenAI provider is not configured on this server. Set it in Settings → <llm-models label>.` | The throw IS the behaviour |
| Display label, not slug | Same, `provider: "ollama-cloud"` | Message reads `The Ollama Cloud provider …` — from `providerLabel`, never the raw slug | The throw IS the behaviour |
| `ollama` keeps its exemption | `getConfiguredModel({ provider: "ollama" })`, no key | No throw from this guard — self-hosted needs no key | n/a |
| Skills scan failed | `SKILLS_SCAN_FAILED_COPY` read | Ends with `check Settings → <api-mcp label>.`, composed from `settingsPointer("api-mcp", SETTINGS_LABEL)` | n/a — a constant |
| API off / token refused | `CHAT_API_DISABLED_COPY`, `CHAT_API_UNAUTHORIZED_COPY` | Same derived pointer inside each sentence; wording otherwise unchanged | n/a — constants |
| Category renamed | `SETTINGS_CATEGORIES` label for `api-mcp` or `llm-models` edited | All four sentences follow the rename with no source edit | n/a |

</intent-contract>

## Code Map

- `src/lib/llm.ts:54` -- `LLM_MODELS_POINTER = settingsPointer("llm-models", SETTINGS_LABEL)`, the existing derived constant; its doc block explains why the SHORT label is passed. Reuse, do not re-derive.
- `src/lib/llm.ts:433` -- the DW-503 guard, inside `getConfiguredModel`'s `if (provider)` block, before the `switch`. Currently `throw new Error(\`The ${provider} provider is not configured on this server.\`)`. Guarded by `provider !== "ollama" && !apiKey`.
- `src/lib/llm.ts:344,349,358,459,464` -- the five DW-369 refusals, all `... Set it in ${LLM_MODELS_POINTER}.`; the phrasing to match.
- `src/lib/llm.ts:6-19` -- the `./config` import block; `providerLabel` is re-exported there (`src/lib/config.ts:30`) alongside `DEFAULT_MODELS`, so add it to that same block rather than a new `./providers` import.
- `src/lib/providers.ts:179` -- `providerLabel(provider)`, `PROVIDER_INFO` lookup with raw-slug fallback. Labels: Anthropic / OpenAI / Google / DeepSeek / Ollama Cloud / Ollama (self-hosted) / Custom.
- `src/lib/workbench-settings.ts:98` -- `{ id: "api-mcp", label: "API + MCP" }`, the owner of the label DW-504 duplicates.
- `src/lib/workbench-settings.ts:123,180,193` -- `SETTINGS_LABEL = "Settings"`, `settingsPointer(id, surfaceLabel = WORKBENCH_SETTINGS_LABEL)`, and the "Workbench Settings" default. Both are already exported.
- `src/lib/chat-agent.ts:376,490,494` -- `SKILLS_SCAN_FAILED_COPY`, `CHAT_API_DISABLED_COPY`, `CHAT_API_UNAUTHORIZED_COPY`. File header declares it client-safe and pure; today it imports only `SIDECAR_ORIGIN` from `./sidecar` (line 20).
- READ-ONLY EVIDENCE (no cycle, client-safe): `workbench-settings.ts` imports only `./providers`, `./v1-contract`, `./workbench-request`, `./write-precondition`; `v1-contract` imports only `./chat-contract`; none imports `chat-agent` and none imports a Node built-in.
- `src/components/workbench/SkillsCanvas.tsx:59,71` and `src/lib/chat-pending-turn.ts:209` -- the render paths for the three constants. No change needed; they consume the constants.
- `src/lib/__tests__/llm.test.ts:454-576` -- the DW-369 parity describe. Extend here. Note `:560` byte-scans lines containing `The Custom provider needs` and asserts exactly 5 — the new guard does not contain that phrase, so that count stays 5.
- `src/lib/__tests__/llm.test.ts:16` -- already imports `settingsCategory` from `../workbench-settings`; `getConfiguredModel` is already imported at `:9`.
- `src/lib/__tests__/epic8-chat-agent.test.ts` -- node-project home for the DW-504 parity test (Epic 8 Agent/Skills vocabulary). It imports from `../../../sidecar/agent.mjs`, not from `../chat-agent`, so add a `../chat-agent` import.
- `src/lib/__tests__/chat-pending-turn.test.ts:233-234` and `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx:166` -- existing assertions that compare against the constants by reference; unaffected by a byte-identical derivation.

## Tasks & Acceptance

**Execution:**
- `src/lib/llm.ts` -- add `providerLabel` to the existing `./config` import; change the keyless guard at `:433` to `` `The ${providerLabel(provider)} provider is not configured on this server. Set it in ${LLM_MODELS_POINTER}.` `` -- DW-503: one destination, one derivation, display label instead of slug.
- `src/lib/chat-agent.ts` -- import `SETTINGS_LABEL, settingsPointer` from `./workbench-settings`, declare one module-level `API_MCP_POINTER = settingsPointer("api-mcp", SETTINGS_LABEL)` with a doc block saying why (label owner is `SETTINGS_CATEGORIES`; short surface form deliberate), and interpolate it into all three constants -- DW-504: removes the last three hand-typed copies of that nav row.
- `src/lib/__tests__/llm.test.ts` -- extend the DW-369 describe: assert the keyless guard's message equals the derived sentence for a non-`custom` provider, assert it uses the display label not the slug, assert `ollama` is still exempt, and widen the byte-scan so every line in `llm.ts` carrying `Set it in ` uses `${LLM_MODELS_POINTER}` -- pins DW-503 against re-typing.
- `src/lib/__tests__/epic8-chat-agent.test.ts` -- add a describe asserting the three constants contain `settingsPointer("api-mcp", SETTINGS_LABEL)` (derived, not literal), carry no `Workbench` prefix, and that `chat-agent.ts`'s source spells the `api-mcp` label nowhere -- pins DW-504.

**Acceptance Criteria:**
- Given `OPENAI_API_KEY` is unset and the config selects no provider, when `getConfiguredModel({ provider: "openai" })` is awaited, then it rejects with a message ending in `Set it in Settings → <the current llm-models label>.` and naming `OpenAI`, not `openai`.
- Given the `llm-models` or `api-mcp` category label is renamed in `SETTINGS_CATEGORIES`, when the suite runs, then no test asserts a stale literal and all four sentences carry the new label without a source edit.
- Given `src/lib/chat-agent.ts` is read as bytes, when scanned for the current `api-mcp` label, then it appears nowhere in the file.
- Given the full suite runs, when `pnpm test` completes, then it passes with no change to the existing DW-369 five-site count or to any consumer that compares the three constants by reference.

## Spec Change Log

_No bad_spec loopback occurred; the spec was not amended._

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 0, low 8)
- defer: 4: (high 0, medium 0, low 4)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[low]` `[patch]` `src/lib/chat-agent.ts`'s new doc block claimed `SETTINGS_CATEGORIES` was "the only place it is typed", which `sidecar/mcp.mjs:54` falsifies — scoped the claim to `src/lib` and named the AD-6-forced sidecar copy as the known exception.
  - `[low]` `[patch]` The same doc block duplicated `llm.ts`'s SHORT-label paragraph near-verbatim and gave "read without the prefix today" as its reason — compressed to one sentence stating the actual rule and pointing at `settingsPointer`'s canonical block.
  - `[low]` `[patch]` The DW-504 test comment carried the same false ownership claim — scoped identically.
  - `[low]` `[patch]` `settingsCategoryLabel()` rebuilt the label by slicing a known prefix off `pointer`, so a separator change would make `not.toContain` pass vacuously — it now reads `settingsCategory("api-mcp").label` from the owner and the helper is gone.
  - `[low]` `[patch]` The `${API_MCP_POINTER}` pin counted LINES, which a formatter wrap or a doc mention would move without any drift having happened — it now counts occurrences.
  - `[low]` `[patch]` Both `llm.ts` byte-scan loops key on English phrasing, so a differently-worded refusal escaped them — added the whole-file destination guard the DW-504 test already had.
  - `[low]` `[patch]` The DW-503 describe hard-typed the surface word, proving nothing about `settingsPointer` and breaking on a `SETTINGS_LABEL` rewording — it now builds every expected sentence from `settingsPointer("llm-models", SETTINGS_LABEL)`. Two cases were added with it: the keyless `custom` provider (DW-503's own headline, previously unasserted) and a real workload-routed call, which the describe's name claimed but no case walked.
  - `[low]` `[patch]` The ollama carve-out asserted only `toBeTruthy()`, which any object satisfies; it now asserts `modelId === DEFAULT_MODELS.ollama`.
  - `[low]` `[patch]` The new doc block newly claims a client-safe, pure posture for `chat-agent.ts` with nothing pinning it — added the byte scan `workbench-settings.test.ts` already runs over its own module.

## Design Notes

The two ledger entries are one fix applied twice: a Settings destination is `surfaceLabel + " → " + settingsCategory(id).label`, and the only sanctioned way to build one is `settingsPointer`. `llm.ts` and `llm-deadline.ts` already do it; the two remaining hand-typed classes are closed here.

Both sites keep the SHORT `SETTINGS_LABEL` form. For `llm.ts` the reason is DW-369's: a runtime error raised from the LLM call is rendered on neither Settings surface, so "Workbench" would be noise. For `chat-agent.ts` the reason is stability: the three sentences render in Workbench canvases and read "Settings → API + MCP" today, and this change must not move a byte of owner-visible copy.

```ts
// src/lib/chat-agent.ts
const API_MCP_POINTER = settingsPointer("api-mcp", SETTINGS_LABEL);

export const CHAT_API_DISABLED_COPY =
  `The local API is off. Turn it on in ${API_MCP_POINTER} to use Chat.`;
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/llm.test.ts src/lib/__tests__/epic8-chat-agent.test.ts src/lib/__tests__/chat-pending-turn.test.ts` -- expected: all pass, including the new parity describes.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` -- expected: passes; the Skills failure copy is unchanged bytes.
- `pnpm test` -- expected: full suite green.
- `pnpm exec tsc --noEmit` -- expected: clean; confirms the new `chat-agent.ts` import type-checks under the client-safe posture.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

### Summary

DW-503 and DW-504 closed: both remaining hand-typed "go to Settings" destinations now come from `settingsPointer`. `getConfiguredModel`'s pre-switch keyless guard names the provider by its display label and ends at the derived `Settings → LLM Models`, matching the five DW-369 siblings; the three `chat-agent.ts` constants compose one derived `api-mcp` pointer. Owner-visible copy is byte-identical for the current labels — this is a derivation change only, verified by a throwaway parity assertion against the pre-change literals.

### Files changed

- [src/lib/llm.ts](../../src/lib/llm.ts) — imports `providerLabel` from `./config`; the keyless guard throws `The <label> provider is not configured on this server. Set it in ${LLM_MODELS_POINTER}.`
- [src/lib/chat-agent.ts](../../src/lib/chat-agent.ts) — one module-level `API_MCP_POINTER = settingsPointer("api-mcp", SETTINGS_LABEL)` feeding `SKILLS_SCAN_FAILED_COPY`, `CHAT_API_DISABLED_COPY` and `CHAT_API_UNAUTHORIZED_COPY`; the category label is now absent from the file.
- [src/lib/__tests__/llm.test.ts](../../src/lib/__tests__/llm.test.ts) — widened the DW-369 byte scan (every `Set it in ` line, plus a whole-file guard on the destination) and added a five-case DW-503 describe: openai, ollama-cloud's display label, keyless custom, the workload ladder, and the ollama carve-out asserted by `modelId`.
- [src/lib/__tests__/epic8-chat-agent.test.ts](../../src/lib/__tests__/epic8-chat-agent.test.ts) — DW-504 parity describe: the three sentences equal their derived form, the label appears nowhere in the source, `${API_MCP_POINTER}` is used exactly three times, and `chat-agent.ts` still passes the client-safe import scan.

### Review findings breakdown

- Patches applied: 8 (all low severity) — see the Review Triage Log.
- Items deferred: 4 (all low) — the sidecar's `MCP_INSTRUCTIONS` copy, two bare-"Settings" refusals with no category, `getModel`'s hand-typed Ollama Cloud label, and the keyless-`custom` cross-ladder diagnosis divergence.
- Items rejected: 6 — a claim that the custom shadowing was already in the ledger (it is not; `deferred-work.md:3748` is DW-503 itself, and the divergence was deferred instead), the two now-overlapping scan loops in `llm.test.ts` (cosmetic; the `toHaveLength(5)` count still carries information), `providerLabel`'s slug fallback (unreachable — `ProviderValue` is derived from `PROVIDER_INFO`), a speculative client-bundle-size concern about the new transitive import (no evidence tree-shaking fails), a speculative future scan failure on a refusal aimed at a different category, and the `Settings → API + MCP` in `src/app/api/v1/loopback-settings/route.ts:19`, which is a code comment, not rendered copy.

### Follow-up review recommendation

`true`. Patched findings this pass: high 0, medium 0, low 8. Score = 3 × 0 + 1 × 8 = 8, which is ≥ 5.

### Verification performed

- `pnpm exec vitest run --project node src/lib/__tests__/llm.test.ts src/lib/__tests__/epic8-chat-agent.test.ts src/lib/__tests__/chat-pending-turn.test.ts` — 125 passed (llm 47, epic8 61, pending-turn 17).
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` — 7 passed.
- `pnpm test` — 350 files, 8180 passed, 1 skipped, 0 failed.
- `pnpm exec tsc --noEmit` — clean, exit 0.
- `pnpm lint` — clean; only the three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices remain, and no JSX was touched.
- Mutation checks: reverting the `llm.ts` guard fails 5 tests; disabling the workload branch fails exactly the one new workload case; re-typing one `chat-agent.ts` literal fails the occurrence count.
- I/O matrix audit: all six rows are covered by tests that ran and passed in the runs above.

### Residual risks

- The four deferred items above are pre-existing and untouched; the sidecar copy in particular means a category rename still has exactly one other place to visit, by design (AD-6), and no test will say so.
- `chat-agent.ts` now reaches `workbench-settings` and its transitive imports from the browser bundle. No Node built-in or cycle is reachable (pinned by the new scan and by `workbench-settings.test.ts`'s own), but bundle size depends on tree-shaking, which nothing verifies.
