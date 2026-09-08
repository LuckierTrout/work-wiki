---
title: 'DW-400: associate the custom-endpoint note with both provider pickers'
type: 'bugfix'
created: '2026-08-22'
status: 'done'
baseline_revision: 'f2458e1844b0b2db7377b2b027f67a63431a0fc1'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      The Ollama Cloud note is the same shape of picker-conditional pointer as the
      custom-endpoint note and is still unassociated with the provider picker.
    evidence: |-
      `ProviderForm.tsx:312-321` renders the `showOllamaCloud` note in the same
      wrapper as the `showCustom` note four lines above it, saying where the rest
      of the provider's configuration lives ("The API key stays encrypted as a
      Cloudflare Worker secret and is never returned to this page"). It carries no
      `id` and `providerDescribedBy` contributes none for it, so selecting
      `ollama-cloud` still announces only the option name. Pre-existing: DW-400's
      intent names only the custom-endpoint pointer, so this was out of scope.
      No test anywhere renders that note.
    location: >-
      src/components/ProviderForm.tsx:312
    severity: medium
  - summary: >-
      The primary picker's credential-status line sits beside the control with
      nothing associating it.
    evidence: |-
      `ProviderForm.tsx:197-205` renders "✓ API key configured on server",
      "⚠ No API key — set via server environment variables", or "Save this
      selection to check its server credential" directly under `#provider`. It
      has no `id` and the picker does not reference it, so the credential state
      of the selected provider is invisible to a screen reader — the same harm
      class DW-400 fixed for the custom-endpoint pointer. Pre-existing and
      outside DW-400's stated scope.
    location: >-
      src/components/ProviderForm.tsx:197
    severity: medium
---

<intent-contract>

## Intent

**Problem:** On both settings surfaces the "Custom provider" note that says where the base URL and API key are actually configured sits *beside* the provider picker with nothing associating the two, so a screen-reader owner who selects `custom` hears the option name and never the sentence telling them the configuration is only half done. `StructuredKnowledgeSettings.tsx` gives the note an id but its picker sets `aria-describedby` only when `readOnly`; `ProviderForm.tsx`'s note carries no id at all.

**Approach:** Give `ProviderForm`'s note an id, and have both pickers *compose* their `aria-describedby` — the endpoint-note id when the note is showing, merged with the existing read-only `describedBy` rather than replacing it — following the `hint`/`hintId` composition convention already stated at `SettingsCanvas.tsx:346-362` and already implemented for the Ollama endpoint input at `ProviderForm.tsx:118-135`.

## Boundaries & Constraints

**Always:** Both pickers keep the existing read-only sentence in their description when `readOnly` — the endpoint-note id is appended, never substituted. The endpoint-note id is contributed only while the note is actually rendered (`showCustom`), so the attribute never points at an absent element. `aria-describedby` resolves to `undefined` when nothing applies, never `""`. The two ids stay distinct: `/settings` mounts both components on one page.

**Block If:** Nothing here requires a human decision.

**Never:** No change to when the note renders (`showCustom` gating on either surface), no change to its copy (`SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY` stays the single shared sentence), no `aria-invalid` on either picker, no new base-URL/API-key inputs on either surface, and no change to the model inputs' descriptions — the note is about the provider choice.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Custom picked, writable | `showCustom` true, `readOnly` false | Picker `aria-describedby` is exactly the endpoint-note id; an element with that id exists and carries the shared copy | No error expected |
| Custom picked, read-only deployment | `showCustom` true, `readOnly` true, `describedBy="readOnlyNote"` | Picker `aria-describedby` lists BOTH ids — read-only sentence and endpoint note | No error expected |
| Read-only, non-custom provider | `showCustom` false, `readOnly` true, `describedBy` supplied | Picker `aria-describedby` is the read-only id alone; no endpoint-note id | No error expected |
| Nothing to say | `showCustom` false, `readOnly` false | Picker emits no `aria-describedby` attribute at all | No error expected |
| Extraction inherits a custom primary | `usesPrimary` true, primary `custom` | Extraction picker gains no endpoint-note id (the note does not render) | No error expected |

</intent-contract>

## Code Map

- `src/components/ProviderForm.tsx` -- primary provider picker. `#provider` select at :148-170 currently sets `aria-describedby={readOnly ? describedBy : undefined}`. The `showCustom` note at :275-280 is an id-less `<div>`. `showCustom` derived at :114. **Reuse:** `ollamaIssueId`/`ollamaDescribedBy` at :118-135 is the exact composition idiom to copy (filter + `join(" ") || undefined`), with its comment explaining why ids are joined rather than chosen.
- `src/components/StructuredKnowledgeSettings.tsx` -- extraction provider picker. `#structuredKnowledgeProvider` select at :132-153 has the same `readOnly ? describedBy : undefined`. The note already has `id="structuredKnowledgeCustomEndpoint"` at :190-197. `showCustom` (inherit-aware) derived at :77 — do not touch that derivation.
- `src/components/workbench/SettingsCanvas.tsx:346-362` -- `describedBy(hintId)` helper: the repo's stated convention that a hint beside a control is invisible to a screen reader and that the read-only sentence is *appended* to a control's own description. Read-only reference; do not modify.
- `src/app/settings/page.tsx:60-61, 170-197` -- mounts both components on one page and passes one shared `readOnlyNoteId` as `describedBy`. This is why the two note ids must differ. Read-only reference.
- `src/components/__tests__/provider-form.test.tsx` -- existing mounted-DOM suite for this component; `props()`/`settings()` builders at :26-55, and the DW-402 composition cases at :104-131 are the pattern to mirror.
- `src/components/__tests__/structured-knowledge-settings.test.tsx` -- existing mounted-DOM suite; `props()`/`settings()` builders at :24-63, `customPointer()` helper at :66-68.

## Tasks & Acceptance

**Execution:**
- `src/components/ProviderForm.tsx` -- add `id="providerCustomEndpoint"` to the `showCustom` note `<div>`; derive `customEndpointId` (that id when `showCustom`, else `undefined`) and a composed `providerDescribedBy` alongside the existing `ollamaDescribedBy`, using the same filter/join idiom; apply it to the `#provider` select in place of `readOnly ? describedBy : undefined`. Comment WHY composition rather than choice, pointing at the `SettingsCanvas` convention -- the note is currently unreachable by screen reader and the read-only sentence must survive the merge.
- `src/components/StructuredKnowledgeSettings.tsx` -- derive the same `customEndpointId` (`"structuredKnowledgeCustomEndpoint"` when `showCustom`) and composed `providerDescribedBy`, and apply it to the `#structuredKnowledgeProvider` select. Leave the note's existing id and the `showCustom` derivation untouched -- the defect here is only that the picker never pointed at the note outside the read-only case.
- `src/components/__tests__/provider-form.test.tsx` -- add a describe block covering the matrix rows for the primary picker: custom+writable, custom+read-only composition, read-only+non-custom, and the no-attribute case. Assert against the rendered DOM, since "the picker points at the sentence" is not something a source scan can check.
- `src/components/__tests__/structured-knowledge-settings.test.tsx` -- add the equivalent block for the extraction picker, including the inherited-custom-primary row where the note does not render and the id must not appear.

**Acceptance Criteria:**
- Given `/settings` on a writable deployment, when the owner selects `custom` in either the primary or the extraction picker, then that picker's accessible description is the custom-provider sentence, announced with the control rather than left to be found by browsing.
- Given a read-only deployment already storing `custom`, when either picker receives focus, then both the read-only refusal sentence and the custom-provider sentence are announced, in that order, neither displacing the other.
- Given any provider other than `custom` on a writable deployment, when either picker renders, then it emits no `aria-describedby` attribute.
- Given both components mounted on the same page, when the DOM is inspected, then the two note ids are distinct and each picker references only its own note.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 2: (high 0, medium 2, low 0)
- reject: 20: (high 0, medium 0, low 20)
- addressed_findings:
  - `[medium]` `[patch]` The fourth acceptance criterion — both components on one page, ids distinct, each picker referencing only its own note — was pinned nowhere; every new case rendered one component in isolation with a synthetic `describedBy` no page passes. Added a `/settings` describe block to `settings-page-legacy-surface-parity.test.tsx` covering the writable case (each picker points at its own note, both notes resolve to distinct nodes carrying the shared copy) and the read-only case (both pickers carry two ids, the page's real `useId()`-minted read-only note first and identical on both, each picker's own note second).
  - `[low]` `[patch]` The note id literal was written twice per component (the `customEndpointId` const and the JSX `id=` attribute), so a rename of one would break the association silently. Both components now render the note with `id={customEndpointId}`; emitted ids unchanged.

## Design Notes

The composition idiom already in this file (`ProviderForm.tsx:131-135`) is the golden example — reuse its shape rather than inventing a second one:

```ts
const customEndpointId = showCustom ? "providerCustomEndpoint" : undefined;
const providerDescribedBy =
  [readOnly ? describedBy : undefined, customEndpointId]
    .filter((id): id is string => Boolean(id))
    .join(" ") || undefined;
```

Order matters for what a screen reader reads first: the read-only sentence explains why the control refuses, the endpoint note explains what is still unconfigured. Keeping `describedBy` first matches the Ollama input's existing order, so the two controls on one page do not announce their shared read-only sentence in different positions.

## Verification

**Commands:**
- `pnpm vitest run src/components/__tests__/provider-form.test.tsx src/components/__tests__/structured-knowledge-settings.test.tsx` -- expected: all cases pass, including the new ones
- `pnpm exec tsc --noEmit` -- expected: no type errors
- `pnpm lint` -- expected: no new errors

## Auto Run Result

Status: done

**Implemented change.** Both provider pickers on `/settings` now point at the "Custom provider" note that explains where the base URL and API key are actually configured, instead of leaving it visually adjacent and unreachable by screen reader. `ProviderForm`'s note gained an id; both pickers compose `aria-describedby` from the page's read-only sentence plus the note id when the note is showing, joining them rather than choosing one — the idiom the Ollama endpoint input already used for DW-402, and the convention `SettingsCanvas.tsx`'s `describedBy(hintId)` helper states.

**Files changed**
- `src/components/ProviderForm.tsx` — `id={customEndpointId}` on the `showCustom` note; `customEndpointId` + composed `providerDescribedBy` applied to `#provider`.
- `src/components/StructuredKnowledgeSettings.tsx` — same composition applied to `#structuredKnowledgeProvider`; the note's existing id and the inherit-aware `showCustom` gate untouched.
- `src/components/__tests__/provider-form.test.tsx` — new describe covering custom+writable, custom+read-only composition and order, read-only+non-custom, the no-attribute case, and no `aria-invalid`.
- `src/components/__tests__/structured-knowledge-settings.test.tsx` — the equivalent block plus the inherited-custom-primary row, where the note does not render and the id must not appear.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` — new describe pinning the composed-page claim: both notes on screen at once, each picker referencing only its own, and the page's real `useId()` read-only note id first and identical on both.

**Review findings breakdown.** 2 patches applied (1 medium, 1 low), 2 items deferred (both medium, both pre-existing and outside this intent's scope), 20 rejected. No intent gaps and no spec repairs; `review_loop_iteration` stayed 0.

**Follow-up review recommendation:** false. Patched findings: high 0, medium 1, low 1 — score `3x1 + 1x1 = 4`, below the threshold of 5, and no patched finding was high severity.

**Verification**
- `./node_modules/.bin/vitest run src/components/__tests__/provider-form.test.tsx src/components/__tests__/structured-knowledge-settings.test.tsx src/app/settings` — 5 files, 48 tests, all passed (12 and 13 in the two component suites, 14 in the parity suite).
- `./node_modules/.bin/tsc --noEmit` — exit 0, no output.
- `./node_modules/.bin/eslint` — exit 0, no warnings or errors.
- Every I/O matrix row is covered by a test that ran and passed: custom+writable, custom+read-only, read-only+non-custom, nothing-to-say, and the extraction picker inheriting a custom primary.
- `pnpm vitest` / `pnpm exec` abort with `ERR_PNPM_...packages field missing or empty` in this working copy — a pre-existing pnpm workspace-config problem unrelated to this change; the binaries were run from `node_modules/.bin` instead.

**Residual risks**
- The note ids are hardcoded literals rather than `useId()`, which is correct only while each component is mounted at most once per page. `src/app/settings/page.tsx` is the sole mount site for each today, and the new page-level case would fail on a duplicate mount.
- `settings-page-read-only-controls.test.tsx`'s "refuses nothing, describes nothing" case asserts a null `aria-describedby` on both pickers for a writable deployment. It still passes, but only because its fixture stores `ollama`; with `custom` stored the writable page now legitimately emits the attribute. Behavior is correct; the older assertion is simply narrower than its name suggests.
- Two other picker-adjacent sentences in `ProviderForm` remain unassociated and are recorded in frontmatter `deferred`.
