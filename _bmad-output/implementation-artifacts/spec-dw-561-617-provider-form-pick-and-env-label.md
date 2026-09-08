---
title: 'ProviderForm: blank-pick model placeholder and the env-locked endpoint box name'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Every `SourceBadge`-bearing label on /settings computes an accessible name
      with no separating space, so a screen reader announces "Modelfrom
      environment" and "Ollama Base URLfrom environment".
    evidence: |-
      `SourceBadge.tsx` relies on the badge span's `ml-2` class for visual
      spacing only, and the labels in `ProviderForm.tsx` render `{settings && <SourceBadge …/>}`
      directly after the label text with no whitespace node between them. The
      accessible name is therefore the two strings run together, which both
      `provider-form.test.tsx` cases now pin verbatim ("Modelfrom environment",
      "Ollama Base URLfrom environment") as the name a browser computes.
      `EmbeddingSettings.tsx` already writes `Embedding Model{" "}` before its
      span, so the repo carries both spellings and the fix pattern is settled.
      Pre-existing and repo-wide across Provider, Model and Ollama Base URL;
      surfaced here because DW-617 pinned a second instance of it.
    location: >-
      src/components/SourceBadge.tsx and the SourceBadge-bearing labels in src/components/ProviderForm.tsx
    severity: low
baseline_revision: '4cbab4f9172f1175f84eea32654d8d326dd3076b'
---

<intent-contract>

## Intent

**Problem:** Two ProviderForm defects. (DW-561) The model box's placeholder reads `DEFAULT_MODELS[effectiveProvider]`, so a blank picker over a stored `openai` shows `gpt-4o` one line below the credential line's "Select a provider to check its server credential" — two statements about the same selection disagreeing. (DW-617) The `settings?.ollamaBaseUrlSource === "env"` branch renders a bare `<div>` under an unconditional `<label htmlFor="ollamaBaseUrl">`, so on an `OLLAMA_BASE_URL`-pinned deployment the label names an id nothing carries and the locked value is announced with no accessible name — the exact state DW-562 removed from `#model` and `#embeddingModel`.

**Approach:** Read the model placeholder off `selectedProvider` (the picker's own value) instead of `effectiveProvider`, so a blank pick falls to the existing "Select a provider first" copy and the credential line and the placeholder make the same statement in every pick state. Swap the Ollama env branch's `<div>` for the same `<output id="ollamaBaseUrl" aria-live="off">` treatment DW-562 gave the model boxes, and add mounted cases for both — no suite renders that env branch today.

## Boundaries & Constraints

**Always:**
- The placeholder change touches ONLY the blank-pick case. With any provider picked, `selectedProvider === provider === effectiveProvider`, so the rendered placeholder must be byte-identical to today's.
- `effectiveProvider` keeps the stored-provider fallback for `showOllamaUrl`, `showOllamaCloud` and `showCustom` — DW-505 drew that boundary and this bundle does not move it.
- The Ollama env box carries `id="ollamaBaseUrl"`, `aria-live="off"`, and `block w-full` added to the existing class string so the rendered box looks identical to the `<div>` it replaces.
- No `role`, no `tabIndex`, no `aria-describedby` on the Ollama `<output>` — the same three abstentions DW-562 argued for `#model`, for the same reasons.
- Update the DW-562 comment block in the model `<output>` that says the Ollama block "still renders a bare `<div>` on its own env branch": it stops being true in this change.

**Block If:**
- The blank-pick placeholder needs copy that does not already exist on this surface (i.e. `"Select a provider first"` turns out to be wrong for the blank-pick case rather than the copy DW-561's decision points at).

**Never:**
- Do not touch `EmbeddingSettings.tsx`, `#embeddingModel`, or the `ollamaBaseUrlIssue` sentence and its `aria-describedby` composition.
- Do not add an `aria-describedby` to either locked box, do not make either focusable, and do not change `/settings`' keyboard order.
- Do not change the credential-line branches, `showCredentialStatus`, or `providerDescribedBy`.
- Do not widen the change to the Ollama Cloud / Custom notes' `effectiveProvider` reads.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Blank pick over stored provider | `provider: ""`, `settings.provider: "openai"`, `modelSource` not `env` | `input#model` placeholder is `"Select a provider first"`; `gpt-4o` appears nowhere in the document | No error expected |
| Blank pick, nothing stored | `provider: ""`, `settings.provider: null` | Same placeholder `"Select a provider first"` | No error expected |
| Provider picked, known default | `provider: "openai"` | Placeholder `"gpt-4o"` — unchanged | No error expected |
| Provider picked, no default entry | `provider: "custom"` | Placeholder `"Enter model name"` — unchanged | No error expected |
| Endpoint pinned by env | `provider: "ollama"`, `ollamaBaseUrlSource: "env"`, `ollamaBaseUrl: "http://pinned:11434/api"` | `#ollamaBaseUrl` is an `OUTPUT` holding the value, named by `label[for="ollamaBaseUrl"]` (`"Ollama Base URLfrom environment"`), `aria-live="off"`, no `role`/`tabindex`/`aria-describedby`; no `input#ollamaBaseUrl` | No error expected |
| Endpoint editable | `ollamaBaseUrlSource: "config" \| "default" \| "none"` | `#ollamaBaseUrl` is an `INPUT` with its existing placeholder, `readOnly` and `aria-describedby` composition untouched; no `aria-live` | No error expected |
| Env-pinned endpoint with a refusal sentence | `ollamaBaseUrlSource: "env"` and `ollamaBaseUrlIssue` set | The `<p id="ollamaBaseUrlIssue">` still renders inside the block; the `<output>` still carries no `aria-describedby` | No error expected |

</intent-contract>

## Code Map

- `src/components/ProviderForm.tsx` -- the only production file to change.
  - `:96` `const effectiveProvider = provider || settings?.provider || null` -- unchanged; still feeds `showOllamaUrl` / `showOllamaCloud` / `showCustom`.
  - `:138` `const selectedProvider = provider || null` -- the picker's own value, already the credential line's source. The placeholder becomes its second reader.
  - `:405-411` the editable model `<input>`'s `placeholder={effectiveProvider ? DEFAULT_MODELS[effectiveProvider] ?? "Enter model name" : "Select a provider first"}` -- the DW-561 edit: `effectiveProvider` → `selectedProvider`. The env branch renders no placeholder, so it is untouched.
  - `:347-390` the model `<output>` (DW-562) -- the exact shape to mirror, and its trailing paragraph ("The `Ollama Base URL` block below still renders a bare `<div>`…") is the comment this change invalidates.
  - `:452-472` the Ollama Base URL block: unconditional `<label htmlFor="ollamaBaseUrl">` with `SourceBadge`, then the `env` ternary whose true branch (`:461-463`) is the bare `<div>` to replace.
  - `:475-489` the `ollamaBaseUrlIssue` `<p>` -- read-only here; it renders outside the ternary and stays put.
- `src/components/__tests__/provider-form.test.tsx` -- the mounted suite to extend.
  - `:27-57` `settings()` / `props()` factories -- reuse; default `provider: "ollama"`, `ollamaBaseUrlSource: "none"`.
  - `:59-73` `ollamaBlock()` uses `screen.getByText("Ollama Base URL")`; that resolves only while the badge renders nothing. On an `env` source the label's textContent is `"Ollama Base URLfrom environment"`, so new env cases must reach the label via `document.querySelector("label[for='ollamaBaseUrl']")` instead.
  - `:452-614` the DW-505 blank-selection describe -- where the DW-561 cases belong.
  - `:683-751` the DW-562 `NAMES the ENV-LOCKED box…` case -- the twin to write for the endpoint box.
- `src/lib/providers.ts:166-173` `DEFAULT_MODELS` -- read-only evidence: `openai: "gpt-4o"`, `ollama: "llama3.2"`, and `custom` deliberately absent (that absence is what produces `"Enter model name"`).
- `src/components/SourceBadge.tsx` -- read-only; `env` renders `from environment`, `none` renders nothing. This is why the accessible name is pinned exactly.
- Read-only evidence that nothing else pins these: no test in `src/` asserts a model placeholder, and `ollamaBaseUrlSource: "env"` appears only in `src/lib/__tests__/config.test.ts` (a server-side resolver test that renders nothing). `settings-page-read-only-controls.test.tsx` and `settings-page-legacy-surface-parity.test.tsx` mount over `config` sources and are unaffected.

## Tasks & Acceptance

**Execution:**
- `src/components/ProviderForm.tsx` -- change the model `<input>`'s `placeholder` to branch on `selectedProvider` rather than `effectiveProvider`, and add a short comment saying why (the credential line and the placeholder are both statements about the SELECTION, so they read the same value; the Custom/Ollama notes keep the fallback) -- so a blank pick shows no stored provider's default.
- `src/components/ProviderForm.tsx` -- replace the `ollamaBaseUrlSource === "env"` branch's bare `<div>` with `<output id="ollamaBaseUrl" aria-live="off">`, adding `block w-full` to the existing classes, and carry a comment pointing at the DW-562 rationale rather than restating it -- so the unconditional label names a labelable element.
- `src/components/ProviderForm.tsx` -- amend the model `<output>`'s closing comment paragraph, which asserts the Ollama env branch is still a bare `<div>` -- so the file does not document a state it no longer has.
- `src/components/__tests__/provider-form.test.tsx` -- add the blank-pick placeholder cases to the DW-505 describe (blank over a credentialed store, blank over an empty store, and the picked-provider cases that must not move) -- covering the first four I/O rows.
- `src/components/__tests__/provider-form.test.tsx` -- add a DW-617 describe mirroring the DW-562 model-box case: the env branch's `OUTPUT`, its accessible name computed from the label's own text, `aria-live="off"`, no `role`/`tabindex`/`aria-describedby`, no surviving `input#ollamaBaseUrl`, plus the editable-branch and refusal-sentence rows -- covering the last three I/O rows.

**Acceptance Criteria:**
- Given a mounted `ProviderForm` with `provider: ""` and `settings.provider: "openai"`, when the model box renders, then its placeholder is `Select a provider first` and the string `gpt-4o` appears nowhere in the document.
- Given a mounted `ProviderForm` with `provider: "openai"`, when the model box renders, then its placeholder is `gpt-4o` — the blank-pick rule changes only the blank case.
- Given a mounted `ProviderForm` with `provider: "ollama"` and `ollamaBaseUrlSource: "env"`, when the endpoint box renders, then `document.getElementById("ollamaBaseUrl")` is an `OUTPUT`, `screen.getByRole("status", { name })` and `screen.getByLabelText(name)` both resolve to it for the label's exact text, and `document.querySelector("input#ollamaBaseUrl")` is `null`.
- Given the same env-pinned mount, when the box's attributes are inspected, then `aria-live` is `off`, and `role`, `tabindex` and `aria-describedby` are all absent.
- Given a mounted `ProviderForm` with `ollamaBaseUrlSource: "config"`, when the endpoint box renders, then it is an `INPUT` with no `aria-live`, and its `readOnly` and `aria-describedby` behaviour is exactly what the existing DW-402 cases already assert.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 17: (high 0, medium 0, low 17)
- addressed_findings:
  - `[medium]` `[patch]` DW-561's decision asks that the credential line and the model placeholder be pinned as making the same statement for EVERY pick state, but only the blank-over-stored mount co-asserted both nodes; picked≠stored had no placeholder assertion at all. Extended the existing picked-provider credential-line case so all three non-blank mounts assert the placeholder alongside the line, and added the line to the blank-nothing-stored case — all five pick states now assert both nodes in one mount. No production behaviour changed.
  - `[low]` `[patch]` The DW-561 cases hardcoded `"gpt-4o"`, so `expect(document.body.innerHTML).not.toContain("gpt-4o")` would go vacuously green the day `DEFAULT_MODELS.openai` changed. Both the negative assertion and the picked-provider expectation now derive from `DEFAULT_MODELS.openai`.
  - `[low]` `[patch]` The DW-617 naming case asserted `aria-describedby === null` on a mount that passed no `describedBy`, so the locked box's deliberate abstention was unobservable. That case now mounts with `readOnly: true, describedBy: "readOnlyNote"`.
  - `[low]` `[patch]` Rewording the DW-402 "NOT the `env` source" paragraph left a sentence fragment orphaned on its own line. Reflowed, and pointed at the new DW-617 constructed-payload case that demonstrates the exception.

## Design Notes

The placeholder edit is one identifier. `selectedProvider` is already declared and documented at `:138` as "the PICKER's own value, and the deliberate exception to `:110-113`"; DW-561's decision extends that exception from one node to two, so the placeholder joins the credential line as a reader rather than a new const being minted.

```tsx
placeholder={
  selectedProvider
    ? DEFAULT_MODELS[selectedProvider] ?? "Enter model name"
    : "Select a provider first"
}
```

The endpoint swap is the DW-562 element change verbatim, one control over:

```tsx
<output
  id="ollamaBaseUrl"
  aria-live="off"
  className="mt-1.5 block w-full rounded-md border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground/60 font-mono"
>
  {settings.ollamaBaseUrl}
</output>
```

`block w-full` is not cosmetic drift: `<output>` is inline by default and the `<div>` it replaces was block-level and full-width for free.

## Verification

**Commands:**
- `pnpm vitest run src/components/__tests__/provider-form.test.tsx` -- expected: all cases pass, including the new DW-561 and DW-617 ones.
- `pnpm vitest run src/app/settings/__tests__ src/components/__tests__` -- expected: no regressions in the page-level and sibling component suites.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Two ProviderForm corrections from bundle `provider-form-pick-and-env-label` (DW-561, DW-617). The model box's placeholder now reads `selectedProvider` — the picker's own value, already the credential line's source — instead of `effectiveProvider`, so a blank pick over a stored `openai` shows "Select a provider first" rather than offering `gpt-4o` one line under "Select a provider to check its server credential"; the stored-provider fallback is untouched for the Custom / Ollama Cloud / Ollama-endpoint notes. The `ollamaBaseUrlSource === "env"` branch's bare `<div>` is now `<output id="ollamaBaseUrl" aria-live="off">` with `block w-full` added to an otherwise identical class string, so the unconditional `<label htmlFor="ollamaBaseUrl">` names a labelable element — the DW-562 treatment, one control over, with the same abstentions from `role`, `tabIndex` and `aria-describedby`.

**Files changed.**
- `src/components/ProviderForm.tsx` — placeholder reads `selectedProvider`; Ollama env branch becomes a named `<output>`; the `#model` `<output>`'s closing comment, which asserted the Ollama branch was still a bare `<div>`, amended.
- `src/components/__tests__/provider-form.test.tsx` — four DW-561 placeholder cases in the DW-505 describe, the picked-provider case extended so all five pick states co-assert the credential line and the placeholder, and a new DW-617 describe (locked `<output>` named from its own label, editable branch across `config`/`default`/`none`, refusal sentence still rendered without the locked box pointing at it).

**Review findings breakdown.** 4 patches applied (1 medium, 3 low — all test-side), 1 item deferred (low), 17 rejected. No intent gaps and no spec repairs; the review loop ran once.

**Follow-up review recommendation:** `true`. Patched counts by severity: high 0, medium 1, low 3. Score = 3 x 1 + 1 x 3 = 6, which is 5 or more.

**Verification performed.**
- `pnpm vitest run src/components/__tests__/provider-form.test.tsx` — 37/37 pass.
- `pnpm vitest run src/app/settings/__tests__ src/components/__tests__` — 407/407 across 30 files, no regressions.
- `pnpm lint` — exit 0 (the three `jsx-ast-utils` "could not be resolved" notices are the pre-existing baseline count).
- `npx tsc --noEmit` — exit 0.
- Matrix audit: every row of the I/O & Edge-Case Matrix is covered by a case that ran and passed. Mutation checks confirmed the new cases fail when either production edit is reverted, and that the `aria-describedby` abstention and the `DEFAULT_MODELS`-derived assertion are non-vacuous.

**Residual risks.**
- Coverage closes at the component-props surface. The page-level suites still never mount an `env`-sourced `ollamaBaseUrl`, so an `OLLAMA_BASE_URL`-pinned `/settings` render remains untested end-to-end; the ledger prescribed a component-level twin, which is what landed.
- One DW-617 case mounts an `env` source paired with a refusal sentence, a payload `resolveOllamaBaseUrl` cannot emit. It is labelled constructed in-comment and justified as the only mount where a wrongly-composed `aria-describedby` on the locked box would be visible.
- Accessible-name evidence is jsdom's `dom-accessibility-api` computation, not a browser or a screen reader — the same limitation DW-562's case already accepted.
