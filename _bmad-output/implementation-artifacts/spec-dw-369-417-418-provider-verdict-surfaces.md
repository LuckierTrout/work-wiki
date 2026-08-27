---
title: 'Provider verdict surfaces: reason on the mounted page and the CLI, derived Settings pointer'
type: 'bugfix'
created: '2026-08-27'
status: 'done'
baseline_revision: '2c2909bfa6347ae4c78a5999f449d6b43ab04d71'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `runStatus()` never awaits `loadConfig()`, so `yopedia status` reports
      env-only settings and is blind to anything the owner stored.
    evidence: |-
      `src/cli.ts:558-571` calls `getEffectiveSettings()` without a preceding
      `loadConfig()`. `loadConfigSync()` returns `{}` on a cold cache
      (`src/lib/config.ts:937-946`), so on a fresh CLI process the store leg of
      every ladder is empty. This predates and outlives this change: the
      `LLM provider:` verdict itself, not only the new endpoint line, cannot
      see a stored provider or a stored refused base URL.
    location: >-
      src/cli.ts:558-571
    severity: medium
  - summary: >-
      `getConfiguredModel`'s pre-switch guard refuses a keyless Custom provider
      with no Settings destination, unlike its five sibling refusals.
    evidence: |-
      `src/lib/llm.ts:404` throws "The custom provider is not configured on this
      server." - lowercase provider id, no remedy - where the five sites DW-369
      covers now all end in the derived "Set it in Settings -> <category>." That
      guard is reached before the `custom` case, so some keyless calls get the
      un-pointed sentence. Pre-existing; outside the five literals the intent
      named.
    location: >-
      src/lib/llm.ts:404
    severity: low
  - summary: >-
      Three constants in `chat-agent.ts` hand-type "Settings -> API + MCP", the
      same drift class DW-369 removed from `llm.ts`.
    evidence: |-
      `SKILLS_SCAN_FAILED_COPY` (`src/lib/chat-agent.ts:376`),
      `CHAT_API_DISABLED_COPY` (`:490`) and `CHAT_API_UNAUTHORIZED_COPY` (`:494`)
      spell the `api-mcp` category label, whose owner is
      `src/lib/workbench-settings.ts:97`. They render through `SkillsCanvas` and
      `ChatCanvas`, and no test derives them, so renaming that category leaves
      three user-facing sentences naming a nav row the surface no longer shows.
      Pre-existing and outside this bundle's named sites; `settingsPointer` is
      now exported, so the fix is the same one-line derivation.
    location: >-
      src/lib/chat-agent.ts:376, :490, :494
    severity: low
---

<intent-contract>

## Intent

**Problem:** The sentence explaining why a set `OLLAMA_BASE_URL` was refused exists on the wire (`ProviderInfo.ollamaBaseUrlIssue`, `EffectiveSettings.ollamaBaseUrlIssue`) but reaches no surface an operator actually stands on: `/settings` renders a bare "No LLM provider configured" (DW-417), `yopedia status` prints the provider verdict with no reason (DW-418), and the one component that does render it (`StatusBadge`) is mounted nowhere. Separately, five runtime errors in `src/lib/llm.ts` hand-type "Settings → LLM Models", so renaming that category leaves five messages naming a nav row that no longer exists (DW-369).

**Approach:** Read the field that is already carried on both surfaces — the unconfigured branch of the `/settings` status block, and one conditional line in `runStatus` — and derive the category half of the llm.ts pointers from `SETTINGS_CATEGORIES` by exporting `settingsPointer` with an optional surface-label parameter, so llm.ts keeps its deliberately shorter wording while the category name stops being hand-typed.

## Boundaries & Constraints

**Always:**
- The llm.ts messages keep the SHORT form "Settings → LLM Models" (no "Workbench" prefix). That difference is deliberate and documented at `src/lib/workbench-settings.ts:148-168`; only the CATEGORY half becomes derived. The two existing `settingsPointer` call sites (`:261`, `:1520`) must keep producing "Workbench Settings → …" byte-for-byte.
- The reason is DESCRIBING COPY, never an alert and never a control: no `role="alert"`, nothing gated on it, no value a save could write back.
- `src/lib/workbench-settings.ts` stays client-safe and pure. Verify by inspection that adding the `llm.ts → workbench-settings.ts` import creates no cycle (`workbench-settings` imports only `providers`, `v1-contract`, `workbench-request`, `write-precondition`; none reaches `llm.ts`).
- Update the stale doc comment on `settingsPointer` that asserts llm.ts "keeps its shorter" hand-typed string, so the comment still describes what the code does.

**Block If:**
- Deriving the pointer would require `workbench-settings.ts` to import from `config.ts`, `llm.ts`, or any server-only module.

**Never:**
- Do not mount `StatusBadge`. It stays unmounted; the mounted `/settings` status block is the surface this fix targets. Do not delete it either.
- Do not change the CONFIGURED branch of the `/settings` status block, and do not touch `ProviderForm`'s endpoint block — a refused endpoint alongside a working non-Ollama provider is a different state than the one DW-417 names.
- Do not change the wording of the issue sentence itself (`ollamaBaseUrlIssue`), the resolver ladder in `config.ts`, or the `/api/status` payload shape.
- No new env vars, no new API fields, no restructuring of `useSettings`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Refused endpoint, no provider (web) | `/api/status` → `configured: false`, `ollamaBaseUrlIssue: "<sentence>"` | `/settings` status block renders "No LLM provider configured" AND the sentence beneath it | No error expected |
| No endpoint set, no provider (web) | `configured: false`, `ollamaBaseUrlIssue: null` | Status block renders exactly as today — amber row only, no extra node | No error expected |
| Status still loading (web) | `status` and `settings` both null | Unchanged "Checking provider…" shimmer; no reason node | No error expected |
| Refused endpoint (CLI) | `getEffectiveSettings()` → `provider: null`, `ollamaBaseUrlIssue: "<sentence>"` | `yopedia status` prints its existing four lines plus one line carrying the sentence | No error expected |
| Clean config (CLI) | `ollamaBaseUrlIssue: null` | `yopedia status` prints exactly the four lines it prints today | No error expected |
| Category renamed | `SETTINGS_CATEGORIES` entry `llm-models` label changed | All five llm.ts messages and both existing pointers name the new label | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts:104` -- `settingsCategory(id)`, already exported; the derivation source.
- `src/lib/workbench-settings.ts:142-168` -- `settingsPointer(id)`, module-private, returns `` `${WORKBENCH_SETTINGS_LABEL} → ${label}` ``. Export it and add an optional label parameter defaulting to `WORKBENCH_SETTINGS_LABEL`. Its doc block currently states llm.ts deliberately keeps hand-typed literals — amend that paragraph.
- `src/lib/workbench-settings.ts:122` -- `SETTINGS_LABEL = "Settings"`, exported; the short label llm.ts passes.
- `src/lib/workbench-settings.ts:178` -- `WORKBENCH_SETTINGS_LABEL`, declared AFTER `settingsPointer`; safe as a default parameter (evaluated at call time), and the only top-level call (`:261`) runs after it.
- `src/lib/workbench-settings.ts:261`, `:1520` -- the two existing `settingsPointer` call sites; must be unchanged in output.
- `src/lib/llm.ts:295, :300, :309, :410, :415` -- the five `"… Set it in Settings → LLM Models."` literals (Custom provider: base URL / API key / model, in both `modelFor`-style paths).
- `src/lib/llm.ts:1-33` -- import block; add the `workbench-settings` import here.
- `src/app/settings/page.tsx:130-136` -- the unconfigured branch of the status block ("No LLM provider configured"). `status` comes from `useSettings()` and is typed `ProviderStatus`.
- `src/hooks/useSettings.ts:82-97` -- `ProviderStatus.ollamaBaseUrlIssue: string | null`, REQUIRED on the type; already carried, read by nothing on the page.
- `src/components/StatusBadge.tsx:95-101` -- the existing (unmounted) render of the same sentence; the placement precedent — beneath the verdict, as a correction to it.
- `src/cli.ts:558-571` -- `runStatus()`; prints four `Label:\tvalue` lines from `getEffectiveSettings()`.
- `src/lib/config.ts:2059-2111` -- where `EffectiveSettings.ollamaBaseUrlIssue` is minted; read-only for this change.
- `src/lib/__tests__/cli.test.ts:422-467` -- existing `runStatus()` test with a whole-object `getEffectiveSettings` fixture including `ollamaBaseUrlIssue: null`; extend, do not rewrite.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` -- existing `/settings` DOM suite; the pattern for mocking `useSettings`/status.
- `src/lib/__tests__/workbench-settings.test.ts` -- node suite for this module; where pointer-derivation assertions belong.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- export `settingsPointer` and give it an optional second parameter for the leading surface label (default `WORKBENCH_SETTINGS_LABEL`); amend the doc block's llm.ts paragraph to say the category half is now derived there too, and why the short label is still passed. -- So one rename of a category cannot leave any pointer naming a row the nav no longer shows.
- `src/lib/llm.ts` -- import `SETTINGS_LABEL` and `settingsPointer` from `./workbench-settings`, mint one module-level constant for the "Settings → LLM Models" pointer, and interpolate it into all five Custom-provider error messages. -- Five copies of one destination become one derived value; the messages' wording is otherwise unchanged.
- `src/app/settings/page.tsx` -- in the unconfigured branch of the status block, render `status.ollamaBaseUrlIssue` beneath the "No LLM provider configured" row when it is non-null, as plain describing copy. -- The one deployment state DW-402 describes finally reaches a mounted surface.
- `src/cli.ts` -- in `runStatus()`, print one additional labelled line carrying `settings.ollamaBaseUrlIssue` when it is non-null. -- The headless operator gets the reason beside the verdict instead of a bare "not configured".
- `src/lib/__tests__/workbench-settings.test.ts` -- assert the exported `settingsPointer` derives the category label from `SETTINGS_CATEGORIES` and that the default label still yields the "Workbench Settings → …" form. -- Locks the derivation and the two existing call sites' output.
- `src/lib/__tests__/llm.test.ts` -- assert the Custom-provider errors name the current `llm-models` category label and carry no "Workbench" prefix. -- Proves derivation without freezing the label text.
- `src/lib/__tests__/cli.test.ts` -- extend the `runStatus()` coverage with the refused-endpoint case (issue printed) and keep the existing clean case asserting no extra line. -- Covers both CLI rows of the I/O matrix.
- `src/app/settings/__tests__/` -- add or extend a DOM test covering the three web rows of the I/O matrix. -- Covers the mounted surface, which is the whole point of DW-417.

**Acceptance Criteria:**
- Given `SETTINGS_CATEGORIES`' `llm-models` label is changed, when the Custom-provider errors and the two existing `settingsPointer` call sites are produced, then all seven strings name the new label and no source file outside `workbench-settings.ts` spells the category name.
- Given `src/lib/llm.ts` now imports `src/lib/workbench-settings.ts`, when the project is type-checked and built, then no import cycle or client/server boundary violation is introduced.
- Given a deployment that set `OLLAMA_BASE_URL` to a value the resolver refused and set nothing else, when the owner opens `/settings`, then the status block shows the amber "No LLM provider configured" row and, beneath it, the sentence naming the refused value and the shape that would be accepted.
- Given the same deployment, when the operator runs `yopedia status`, then the output contains the same sentence beside the `LLM provider` verdict.
- Given a deployment with no `OLLAMA_BASE_URL` set, when either surface renders, then neither emits any node or line that did not exist before this change.

## Spec Change Log

No bad_spec loopback occurred. Empty by design.

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 3: (high 0, medium 1, low 2)
- reject: 14: (high 0, medium 0, low 14)
- addressed_findings:
  - `[medium]` `[patch]` `/settings` rendered only the ENV-leg `status.ollamaBaseUrlIssue`, so a refusal that came from the stored config — and any state where `/api/status` failed while `/api/settings` succeeded — still showed the bare verdict, the exact DW-417 harm. It now renders the first non-null of `status?.ollamaBaseUrlIssue` and `settings?.ollamaBaseUrlIssue`, as one node.
  - `[low]` `[patch]` The new DOM fixture's `/api/settings` body omitted `ollamaBaseUrlIssue`, which the real route always serves. Field added, plus three cases: store-leg refusal, status-door failure, and both legs set asserting the sentence renders exactly once.
  - `[low]` `[patch]` The CLI row was labelled `Provider note:` and fires whenever the issue is non-null, so it could follow a successful `LLM provider:` line and read as annotating it. Relabelled `Ollama endpoint:` so it names its own subject; still unconditional, since a headless operator has no Settings screen to go look at. Case added pinning it beside a configured non-Ollama provider.
  - `[low]` `[patch]` `effectiveSettings()` in `cli.test.ts` returned through `as EffectiveSettings`, which permits a missing required property just as silently as the partial its doc block claimed to prevent. Now `satisfies EffectiveSettings`.
  - `[low]` `[patch]` `pl-[18px]` on the reason node was an undocumented magic number in an otherwise fully commented block; it now states that it is the 10px dot plus the row's 8px `gap-2`.

## Design Notes

`settingsPointer` gains a label parameter rather than a second exported function, because the two forms differ in exactly one leading word and splitting them would reintroduce the drift the helper exists to prevent:

```ts
export function settingsPointer(
  id: SettingsCategoryId,
  surfaceLabel: string = WORKBENCH_SETTINGS_LABEL,
): string {
  return `${surfaceLabel} → ${settingsCategory(id).label}`;
}
```

llm.ts then holds one constant, not five interpolations at the throw sites:

```ts
const LLM_MODELS_POINTER = settingsPointer("llm-models", SETTINGS_LABEL);
// → "Settings → LLM Models"
```

Placement of the reason on `/settings` follows `StatusBadge`'s precedent: beneath the verdict row, so it reads as a correction to it rather than a second, competing complaint.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/llm.test.ts src/lib/__tests__/cli.test.ts` -- expected: all pass, including the new cases.
- `pnpm vitest run src/app/settings/__tests__` -- expected: all pass, including the new status-block cases.
- `pnpm lint` -- expected: no new findings.
- `npx tsc --noEmit` -- expected: clean; in particular no circular-import or type error from llm.ts's new import.
- `grep -rn "Settings → LLM Models" src/lib/llm.ts` -- expected: no matches (the literal is gone).

## Auto Run Result

Status: done

**Implemented change.** The refused-`OLLAMA_BASE_URL` sentence now reaches both surfaces an operator actually stands on — the mounted `/settings` status block and `yopedia status` — and the five `llm.ts` runtime refusals derive their category name from `SETTINGS_CATEGORIES` instead of spelling it.

**Files changed:**
- `src/lib/workbench-settings.ts` — `settingsPointer` exported and given an optional `surfaceLabel` parameter (default `WORKBENCH_SETTINGS_LABEL`); its doc block no longer claims `llm.ts` hand-types the destination.
- `src/lib/llm.ts` — one derived `LLM_MODELS_POINTER = settingsPointer("llm-models", SETTINGS_LABEL)` interpolated into all five Custom-provider refusals; wording otherwise byte-identical, short surface form preserved.
- `src/app/settings/page.tsx` — the unconfigured status branch now renders the refusal beneath the verdict, from `status?.ollamaBaseUrlIssue ?? settings?.ollamaBaseUrlIssue`, as describing copy.
- `src/cli.ts` — `runStatus()` prints a conditional `Ollama endpoint:` row carrying the sentence.
- `src/lib/__tests__/workbench-settings.test.ts` — derivation and both label forms asserted.
- `src/lib/__tests__/llm.test.ts` — all five refusals asserted against the derived label, plus a source-byte guard that no throw site re-types it.
- `src/lib/__tests__/cli.test.ts` — refused / clean / configured-with-issue cases behind a `satisfies EffectiveSettings` fixture.
- `src/app/settings/__tests__/settings-page-provider-verdict-reason.test.tsx` (new) — eight cases covering the web rows of the I/O matrix plus both refusal legs and the status-door failure.

**Review findings breakdown:** 5 patches applied (1 medium, 4 low); 3 items deferred (1 medium, 2 low); 14 rejected; 0 intent gaps; 0 spec repairs.

**Follow-up review recommendation:** `true`. Patched this pass: high 0, medium 1, low 4 → 3×1 + 4 = 7, which is ≥ 5.

**Verification performed:**
- `npx vitest run src/lib/__tests__/{workbench-settings,llm,cli}.test.ts src/app/settings/__tests__` — 7 files, 398 passed.
- Full suite `npx vitest run` — 330 files, 7608 passed, 1 skipped.
- `npx tsc --noEmit` — exit 0; no cycle from `llm.ts`'s new import (`workbench-settings` reaches only `providers`, `v1-contract`, `workbench-request`, `write-precondition`).
- `pnpm lint` — no findings; the three `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing.
- `grep -c "Settings → LLM Models" src/lib/llm.ts` — 0.
- Matrix audit: all six I/O rows are covered by tests that ran and passed.

**Residual risks:**
- `yopedia status` gains a fifth row on deployments with a refused endpoint; any parser assuming exactly four `Label:\tvalue` lines would see it. The clean case is pinned by a test.
- The CLI row prints even when a provider IS configured, where the web deliberately stays silent (the web has `ProviderForm`'s endpoint block for that state; the CLI has nowhere else to say it). Asymmetry is intentional and documented at both sites.
- `StatusBadge` remains unmounted, per the intent's reading that the fix belongs on the reachable twin. It is now a second, unreachable renderer of the same sentence.
- Two existing tests still pin the full pointer literal (`workbench-settings.test.ts`, `settings-page-legacy-surface-parity.test.tsx`), so a category rename still requires editing those assertions — no source string.
