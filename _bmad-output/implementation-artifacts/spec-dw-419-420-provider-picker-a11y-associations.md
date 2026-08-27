---
title: 'DW-419/DW-420: associate the provider picker with its Ollama Cloud note and its credential-status line'
type: 'bugfix'
created: '2026-08-27'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'c5429f9e47c4e9365b97b43c443b6977b24e2cdc'
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Selecting the blank "— Select provider —" option leaves the picker
      announcing the STORED provider's credential state.
    evidence: |-
      `ProviderForm.tsx:96` derives `effectiveProvider = provider ||
      settings?.provider || null`, so clearing the select to `""` falls back to
      the stored provider. The credential line — and now, through
      `aria-describedby`, the picker itself — keeps reporting that provider's
      key state while the control visibly shows no selection. Pre-existing: the
      fallback and the line's copy both predate this change, which only made
      the sentence audible. Deliberate for the notes (the file's :110-113
      comment argues a deployment already STORING `custom` needs the pointer on
      first paint), but never reasoned about for the credential line, and no
      test covers the blank-option state.
    location: >-
      src/components/ProviderForm.tsx:96
    severity: medium
  - summary: >-
      The model input's "Leave empty to use the default model" hint is the same
      unassociated-sibling shape, four lines from the two this story fixed.
    evidence: |-
      `ProviderForm.tsx:288-290` renders that sentence directly under
      `#model` with no `id`, and the input's `aria-describedby` is still
      `readOnly ? describedBy : undefined` — it never composes. It is the same
      harm class as DW-400/DW-419/DW-420: a hint beside a control is invisible
      to a screen reader, which is the convention `SettingsCanvas.tsx:346-362`
      states. `EmbeddingSettings.tsx:213` has the identical shape. Out of scope
      here on the intent's own authority — the bundle names only the two
      picker-adjacent nodes — and the spec's Never clause repeats that.
    location: >-
      src/components/ProviderForm.tsx:288
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Two sentences in `ProviderForm` sit beside the `#provider` select with nothing associating them, so a screen-reader owner who moves to the control hears the option name and neither. The credential-status line (`ProviderForm.tsx:198-206` — "✓ API key configured on server" / "⚠ No API key — set via server environment variables" / "Save this selection to check its server credential") is the selected provider's credential state, and the Ollama Cloud note (`:312-321` — where the API key actually lives) is the same shape of picker-conditional pointer as the custom-endpoint note four lines above it, which DW-400 already associated.

**Approach:** Give both nodes ids and contribute them to the existing `providerDescribedBy` composition at `:158-162`, using the filter/join idiom already in this file — the credential id whenever the line renders (`settings` non-null), the Ollama Cloud id only while `showOllamaCloud`. Ids join in DOM reading order so the announced description matches what is on screen.

## Boundaries & Constraints

**Always:** Ids are contributed only while their node actually renders, so the attribute never points at an absent element. `aria-describedby` resolves to `undefined` when nothing applies, never `""`. `describedBy` (the page's read-only sentence) stays FIRST, matching the order DW-400 and DW-402 established for the other controls on this page. Every id in the emitted list resolves to a node in the document. The custom-endpoint and Ollama Cloud notes are mutually exclusive by construction (`effectiveProvider` cannot be both), so at most three ids are ever emitted.

**Block If:** Nothing here requires a human decision.

**Never:** No change to when either node renders (the `settings &&` gate on the credential line, the `showOllamaCloud` gate on the note), no change to their copy, no `aria-invalid` and no `aria-live`/`role="status"` on either — these describe standing state, they do not announce an event. No change to the model input's or the Ollama endpoint input's descriptions, and no change to `StructuredKnowledgeSettings` (its picker has no credential line and no Ollama Cloud note).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Credential known, writable | `settings` non-null, provider matches with a key, not `custom`/`ollama-cloud` | Picker `aria-describedby` is exactly the credential-status id; that node reads "✓ API key configured on server" | No error expected |
| Credential unknown | `settings` non-null, `settings.provider !== effectiveProvider` | Same single id; node reads "Save this selection to check its server credential" | No error expected |
| Ollama Cloud picked | `showOllamaCloud` true, `settings` non-null | Picker lists BOTH the credential id and the Ollama Cloud note id, credential first; both resolve | No error expected |
| Custom picked, read-only | `showCustom` true, `readOnly` true, `describedBy` supplied | Picker lists three ids in order: read-only, credential, custom-endpoint | No error expected |
| Ollama Cloud on a settings-less first paint | `settings` null, `provider` = `ollama-cloud`, writable | Picker names the Ollama Cloud note alone; no credential id, because no credential line rendered | No error expected |
| Nothing to say | `settings` null, writable, plain provider | Picker emits no `aria-describedby` attribute at all | No error expected |

</intent-contract>

## Code Map

- `src/components/ProviderForm.tsx` -- the only file changing in `src/`. `providerDescribedBy` at :158-162 is the composition to extend; `customEndpointId` at :158 and the `ollamaIssueId`/`ollamaDescribedBy` pair at :131-135 are the golden idiom (filter + `join(" ") || undefined`) with the comment explaining why ids are joined rather than chosen. Credential line (DW-420): `<p>` at :198-206, gated on `settings &&`, three-way ternary on `selectedProviderHasKey` (:115-116) — do not touch the gate or the ternary. Ollama Cloud note (DW-419): `<div>` at :312-321, gated on `showOllamaCloud` (:98). The `showCustom` note at :302-310 already renders `id={customEndpointId}` — mirror that "id literal lives in the const, JSX reads it" shape, which the DW-400 review specifically patched in.
- `src/app/settings/page.tsx:227-241` -- the sole mount site; passes the loaded `settings` and one `useId()`-minted `describedBy`. This is why hardcoded ids are safe (one mount per page) and why `settings` is non-null after load — the credential line, and therefore its id, is present on every loaded `/settings` render.
- `src/components/__tests__/provider-form.test.tsx` -- mounted-DOM suite. `props()`/`settings()` builders at :29-58; the DW-400 describe at :216-302 is the block to extend, and its `picker()` helper at :227-229. **Its :288-294 case ("emits no attribute at all when neither applies") passes `settings()` and so will now legitimately emit the credential id — it must be re-pinned on `settings: null`, which is the only state with genuinely nothing to say.**
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` -- `body()` at :111+ seeds `provider: "openai"`, so the credential line always renders. Three assertions need re-pinning against the new, correct output: :293 (`document.querySelector("[aria-describedby]")` null across the whole page), :478 (primary picker exactly `providerCustomEndpoint`), :513 (primary picker exactly 2 ids). Their claims are about the vector notice and the custom-note association respectively — narrow them, do not delete them.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx:260-277` -- "refuses nothing, describes nothing" asserts a null `aria-describedby` on `field("provider")` for a writable deployment. The claim is about REFUSAL description; the picker now legitimately describes its credential state, so this row needs splitting out.
- `src/components/StructuredKnowledgeSettings.tsx` -- read-only reference. Its picker composes the same way but has neither of these two nodes; nothing changes here.

## Tasks & Acceptance

**Execution:**
- `src/components/ProviderForm.tsx` -- derive `credentialStatusId` (DW-420 — `"providerCredentialStatus"` when `settings` is non-null, else `undefined`) and `ollamaCloudId` (DW-419 — `"providerOllamaCloud"` when `showOllamaCloud`), render both nodes with `id={...}` from those consts, and extend `providerDescribedBy` to `[readOnly ? describedBy : undefined, credentialStatusId, customEndpointId, ollamaCloudId]` through the existing filter/join. Extend the existing DW-400 comment block rather than adding a second one: say WHY DOM reading order is the ordering rule, and that the credential line is contributed on the `settings` gate rather than a provider gate because that is exactly when it renders.
- `src/components/__tests__/provider-form.test.tsx` -- extend the picker describe with the matrix rows: credential known / credential unknown, `ollama-cloud` composing two ids in order, the three-id read-only+custom row, `ollama-cloud` with `settings: null` naming the note alone, and the no-attribute case re-pinned on `settings: null`. Assert each emitted id resolves to a node and that the credential node carries the exact served sentence -- "the picker points at the sentence" is not something a source scan can check.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` -- re-pin the three assertions named in the Code Map against the composed page: the vector case scoped to the embedding input and the absent `embeddingVectorNotice` node rather than the whole document, and the two DW-400 cases asserting the picker's full list (the DW-420 credential id included, in order) rather than a single id. Keep each case's original claim intact.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` -- keep the null-description loop for the controls that still describe nothing, and assert separately that the writable primary picker names exactly the credential id and that it reaches no node mentioning "Read-only mode". The suite is about refusal, and that must stay the thing it pins.

**Acceptance Criteria:**
- Given `/settings` loaded on any deployment, when the owner moves to the provider picker, then the credential state of the selected provider is announced with the control rather than left to be found by browsing.
- Given a deployment on `ollama-cloud`, when the picker receives focus, then the note saying the API key is a Worker secret never returned to the page is announced with it, the same way `custom`'s pointer already is.
- Given any combination of the read-only sentence, credential line, and a picker-conditional note, when the picker renders, then the ids appear in the order the nodes appear on screen and each one resolves to a rendered element.
- Given the whole repository test suite, when it runs after this change, then every suite passes -- including the four pre-existing assertions this change makes newly wrong, re-pinned rather than deleted.

## Spec Change Log

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 2, low 6)
- defer: 2: (high 0, medium 2, low 0)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[low]` `[patch]` Every DW citation in the code, the tests and the spec prose named the wrong entry: the ledger has DW-419 as the Ollama Cloud note and DW-420 as the credential-status line, and all nine sites had them swapped. Retagged each site beside the node it actually describes; `<intent-contract>`, the filename and the frontmatter `title` untouched.
  - `[low]` `[patch]` The credential line's render condition was written twice — `settings ? …` in the id const and `{settings && …}` in the JSX — which is the exact drift `EmbeddingSettings.tsx:112` states the rule against ("ONE condition, read by both the note and the `aria-describedby` that points at it"). Introduced `showCredentialStatus`, read by both, mirroring `showCustom`/`showOllamaCloud`. Emitted DOM unchanged.
  - `[low]` `[patch]` The `"⚠ No API key — set via server environment variables"` branch — named verbatim in DW-420's ledger entry, and the one branch that reports a problem — was asserted nowhere in the repo. Added a component case pinning the picker's id and that exact sentence.
  - `[low]` `[patch]` `ollamaCloudId` is last in the composition array and its position relative to `describedBy` and the credential id was unexercised. Added the read-only + `ollama-cloud` row asserting the full ordered three-id list.
  - `[medium]` `[patch]` The vector case's page-wide `document.querySelector("[aria-describedby]")` net was narrowed to two scoped assertions with nothing put back, leaving the spec's own page-level invariant ("every id in the emitted list resolves") untested. Added `expectEveryDescribedIdResolves()` to the parity suite — it walks every `[aria-describedby]` on the page and resolves every token — and called it from the narrowed case and both DW-400 picker cases.
  - `[medium]` `[patch]` `providerOllamaCloud` appeared nowhere under `src/app/settings/`, so DW-419's note had no proof at the surface where the ids are minted for real — the surface the DW-400 docstring argues is the only one where the claim means anything, and whose absence the ledger entry itself named ("No test anywhere renders that note"). Added a page-level `ollama-cloud` case.
  - `[low]` `[patch]` Two nits in the rewritten read-only block: the exclusion predicate re-queried the DOM and leaned on node identity (now `c.id !== "provider"`), and the new assertion messages passed `control.id`, empty for the two buttons (now the file's own `control.id || control.textContent || ""` idiom).
  - `[low]` `[patch]` The page-level credential assertion was only negative — the resolved node does not say "Read-only mode" — in the one suite where the real payload flows through. Added the positive assertion that it carries the sentence the fixture implies.

## Design Notes

The composition already in this file is the golden example; this only lengthens its array. The ordering rule is DOM reading order, which makes the announced description match the visual one:

```ts
const credentialStatusId = settings ? "providerCredentialStatus" : undefined;
const ollamaCloudId = showOllamaCloud ? "providerOllamaCloud" : undefined;
const providerDescribedBy =
  [readOnly ? describedBy : undefined, credentialStatusId, customEndpointId, ollamaCloudId]
    .filter((id): id is string => Boolean(id))
    .join(" ") || undefined;
```

`credentialStatusId` (DW-420) is gated on `settings`, not on the provider, because that is precisely the `<p>`'s own gate — deriving it from anything else would let the two drift and leave the attribute pointing at nothing. `customEndpointId` (DW-400) and `ollamaCloudId` (DW-419) are mutually exclusive, so their relative order is never observed; it is written in DOM order anyway so the rule reads as one rule.

## Verification

**Commands:**
- `./node_modules/.bin/vitest run src/components/__tests__/provider-form.test.tsx src/app/settings` -- expected: all cases pass, including the new and re-pinned ones
- `./node_modules/.bin/vitest run` -- expected: no suite regressed anywhere else in the repo
- `./node_modules/.bin/tsc --noEmit` -- expected: exit 0, no output
- `./node_modules/.bin/eslint src/components/ProviderForm.tsx src/components/__tests__/provider-form.test.tsx src/app/settings` -- expected: exit 0

Run the binaries from `node_modules/.bin`: `pnpm vitest` / `pnpm exec` abort in this working copy with `ERR_PNPM_...packages field missing or empty`, a pre-existing workspace-config problem (DW-411) unrelated to this change.

## Auto Run Result

Status: done

**Implemented change.** The `/settings` provider picker now points at the two sentences that were sitting beside it unreachable: the credential-status line under the select (DW-420) and the Ollama Cloud note (DW-419), the latter the same shape of picker-conditional pointer DW-400 already associated for `custom`. Both nodes gained ids, and `providerDescribedBy` composes them into its existing filter/join list rather than choosing between them — ordered by DOM reading order, with the page's read-only sentence still first, so the announced description matches the visual one. Each id is derived from the node's own render gate (`showCredentialStatus`, `showOllamaCloud`), so the attribute can never name an element that is not in the document.

**Files changed**
- `src/components/ProviderForm.tsx` — `showCredentialStatus` (one condition read by both the JSX gate and the id), `credentialStatusId`, `ollamaCloudId`, and the extended `providerDescribedBy` composition; `id={...}` on the credential `<p>` and the Ollama Cloud `<div>`, each reading its literal from the const.
- `src/components/__tests__/provider-form.test.tsx` — the picker describe extended to 12 cases covering every matrix row: the three credential branches, `ollama-cloud` composing two ids in order, read-only + `custom` and read-only + `ollama-cloud` three-id rows, `ollama-cloud` with `settings: null`, and the no-attribute case re-pinned on `settings: null`.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` — the two DW-400 cases re-pinned against the composed page; a new page-level `ollama-cloud` case; `expectEveryDescribedIdResolves()`, a page-wide walk restoring the dangling-pointer net the vector case's narrowing gave up.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` — the writable "describes nothing" loop keeps its claim for the controls that still describe nothing; the picker is pinned separately at exactly the credential id, resolving to a node carrying the served sentence and not the read-only one.

**Review findings breakdown.** 8 patches applied (2 medium, 6 low), 2 items deferred (both medium, both pre-existing), 10 rejected. No intent gaps and no spec repairs; `review_loop_iteration` stayed 0.

**Follow-up review recommendation:** true. Patched findings: high 0, medium 2, low 6 — score `3x2 + 1x6 = 12`, at or above the threshold of 5. No patched finding was high severity; the count is driven by breadth of small test-surface repairs, not by any single serious defect.

**Verification**
- `./node_modules/.bin/vitest run src/components/__tests__/provider-form.test.tsx src/app/settings` — 5 files, 50 tests, all passed.
- `./node_modules/.bin/vitest run` — 330 files, 7615 passed / 1 skipped, no regressions anywhere in the repo.
- `./node_modules/.bin/tsc --noEmit` — exit 0, no output.
- `./node_modules/.bin/eslint src/components/ProviderForm.tsx src/components/__tests__/provider-form.test.tsx src/app/settings` — exit 0.
- Every I/O matrix row is covered by a test that ran and passed: credential known, credential unknown, `ollama-cloud` with settings, read-only + `custom` three ids, `ollama-cloud` with `settings: null`, and nothing-to-say.
- An independent mutation check during review confirmed the cases are not vacuous: dropping the credential `id` fails 8, reordering the array fails 5, blanking `ollamaCloudId` fails 2, and re-gating the credential id on `selectedProviderHasKey` fails 4.
- `pnpm vitest` / `pnpm exec` still abort with `ERR_PNPM_...packages field missing or empty` in this working copy (DW-411, pre-existing and unrelated); the binaries were run from `node_modules/.bin`.

**Residual risks**
- The four ids are hardcoded literals rather than `useId()`, correct only while `ProviderForm` mounts at most once per page. `src/app/settings/page.tsx:227` remains the sole mount site, and the parity suite's distinctness assertions would fail on a duplicate mount — but nothing in the component warns a future second caller.
- The picker's description is no longer conditional: on every loaded `/settings` render it names at least the credential line. Two pre-existing assertions whose subject was not the picker had to be narrowed to keep saying what they meant, and a third suite gained an exception for it. Their original claims are intact, but a future reader will find "describes nothing" cases that carve the picker out.
- The credential sentence's TEXT changes when the owner moves the select, while the description stays statically associated. Deliberate — the spec's Never clause refuses `aria-live` on the grounds that this is standing state, not an event — but a screen reader will not re-announce the changed sentence until the control is revisited.
- Two picker-adjacent behaviours remain unaddressed and are recorded in frontmatter `deferred`: the blank-option fallback, and the model input's own unassociated hint.
