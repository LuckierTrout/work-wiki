---
title: 'DW-505/DW-506: truthful credential line on a blank provider pick, and the two model hints associated'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Both model hints instruct the owner to empty a box that the env-locked
      branch renders as a non-editable div.
    evidence: |-
      `ProviderForm.tsx` renders "Leave empty to use the default model for the
      selected provider." below the model control on BOTH branches of the
      env/editable ternary, and `EmbeddingSettings.tsx`'s hint only swaps copy
      for `modelSource === "env" && effectiveModel === "@cf/baai/bge-m3"` — any
      other env-pinned embedding model falls through to "Leave empty to use the
      embedding provider default.". On an `LLM_MODEL`/`EMBEDDING_MODEL`
      deployment there is no input to empty, so the sentence is advice the
      control refuses. Pre-existing: the copy and its placement both predate
      this change, which only gave the node an id. Not fixed here because the
      intent scopes this bundle to ASSOCIATING the existing sentences, not to
      rewording them.
    location: >-
      src/components/ProviderForm.tsx:368 and src/components/EmbeddingSettings.tsx:284
    severity: medium
  - summary: >-
      The page's one read-only sentence is announced in opposite positions on
      the two model boxes of the same `/settings` page.
    evidence: |-
      `ProviderForm`'s compositions put `describedBy` FIRST (DW-400/DW-402/
      DW-419), while `EmbeddingSettings`' `notes` array puts `readOnlyNoteId`
      LAST. On a read-only deployment `#model` announces
      `readOnlyNote providerModelHint` and `#embeddingModel` announces
      `… embeddingModelHint readOnlyNote` — the same banner sentence, in two
      places. The divergence predates this change (the DW-402/DW-419 comments
      already claimed a page-wide ordering rule the embedding box never
      followed); this change only adds one more id after the banner there. The
      docstring at `ProviderForm.tsx:236` now scopes its claim and names the
      exception rather than asserting an invariant the page does not hold.
      Fixing it means moving `readOnlyNoteId` to the front of
      `EmbeddingSettings`' list, which is a change to a pre-existing ordering
      this bundle's Always clause forbade.
    location: >-
      src/components/EmbeddingSettings.tsx:190-200
    severity: medium
  - summary: >-
      On a blank pick the model placeholder still names the STORED provider's
      default model while the credential line beside it says nothing is
      selected.
    evidence: |-
      `ProviderForm.tsx:355-359` keeps `DEFAULT_MODELS[effectiveProvider]`, so
      a blank picker over a stored `openai` shows placeholder `gpt-4o` one line
      below "Select a provider to check its server credential". Two statements
      about the same control now disagree, which is the DW-505 harm shape
      applied to a different node. Out of scope on the intent's own authority —
      it says to keep the stored-provider fallback for everything but the
      credential line — so the disagreement is a consequence this bundle was
      told to accept, not a deviation from it.
    location: >-
      src/components/ProviderForm.tsx:355
    severity: medium
  - summary: >-
      The env-locked model boxes have no accessible NAME — their `<label
      htmlFor>` points at an id no element carries.
    evidence: |-
      `ProviderForm.tsx` always renders `<label htmlFor="model">` and
      `EmbeddingSettings.tsx` always renders `<label htmlFor="embeddingModel">`,
      but on the `modelSource === "env"` branch the control is a plain `<div>`
      with no id, so both labels dangle and the locked value is announced with
      no name at all. Both files spend paragraphs arguing why a DESCRIPTION on a
      non-focusable div would be decoration; the missing NAME is a separate and
      larger gap and is argued nowhere. Pre-existing on both branches and
      untouched by this change.
    location: >-
      src/components/ProviderForm.tsx:332 and src/components/EmbeddingSettings.tsx:210
    severity: medium
baseline_revision: '8855707906f31a85d5b3b15aae4a344eccb37067'
---

<intent-contract>

## Intent

**Problem:** Two shapes survive in `ProviderForm`. (DW-505) `effectiveProvider = provider || settings?.provider || null` (`ProviderForm.tsx:96`) treats the blank `— Select provider —` option as unset and falls back to the STORED provider, so the credential line — and, since DW-420 pointed `aria-describedby` at it, the picker itself — announces that provider's key state while the control visibly shows no selection; no test covers the blank-option state. (DW-506) The model input's "Leave empty to use the default model for the selected provider." hint at `:288-290` has no `id`, and the input's `aria-describedby` is `readOnly ? describedBy : undefined`, so it never composes — the same harm class as DW-400/DW-419/DW-420, and `EmbeddingSettings.tsx:250-254` has the identical shape.

**Approach:** Derive the credential line's subject from the picker's OWN value rather than from `effectiveProvider`, and give the blank state its own sentence in the line's existing three-way ternary. Keep `effectiveProvider` — and therefore the stored-provider fallback — for everything else it feeds (the Ollama, Ollama Cloud and Custom blocks and the model placeholder), which the file's `:110-113` comment argues for. Separately, give both model hints an `id` and compose each input's `aria-describedby` through the filter/join idiom already in these two files.

## Boundaries & Constraints

**Always:** The credential line's render gate stays `showCredentialStatus = settings !== null`, read by both the `<p>` and the id that points at it — one condition, never two. Ids are contributed only while their node renders; the two model-hint `<p>`s render unconditionally, so their ids are unconditional too. `aria-describedby` resolves to `undefined`, never `""`. The page's `describedBy` stays FIRST on `ProviderForm`'s controls, matching DW-400/DW-402/DW-419; in `EmbeddingSettings` the existing relative order of `OVERRIDE_NOTE_ID`, `VECTOR_NOTICE_ID` and `readOnlyNoteId` is preserved and the hint id is inserted in DOM reading order between the vector notice and the read-only id. Every emitted id resolves to a node in the document. DESCRIBES, does not mark: no `aria-invalid`, no `aria-live`/`role="status"`, no save blocked.

**Block If:** Nothing here requires a human decision.

**Never:** No change to `effectiveProvider` itself or to any other reader of it — the Ollama/Ollama Cloud/Custom gates and the model placeholder keep the stored-provider fallback. No change to the copy of the three existing credential branches, to the two hint sentences, or to when the credential line renders. No change to the provider picker's `aria-describedby` composition (DW-419/DW-420's, already correct). No change to `useSettings`' seeding of `provider`, to `StructuredKnowledgeSettings` (its extraction model has a placeholder, not a hint sibling), or to `SettingsCanvas`. No new component props.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Blank pick over a credentialed store | `provider: ""`, `settings.provider: "openai"`, `hasApiKey: true` | Credential line reads "Select a provider to check its server credential" — never "✓ API key configured on server"; picker still names `providerCredentialStatus` | No error expected |
| Blank pick over an uncredentialed store | `provider: ""`, `settings.provider: "openai"`, `hasApiKey: false` | Same blank sentence, not the "⚠ No API key" branch | No error expected |
| Blank pick, nothing stored | `provider: ""`, `settings.provider: null` | Same blank sentence — `null === null` must not reach the "⚠ No API key" branch | No error expected |
| Notes keep the fallback | `provider: ""`, `settings.provider: "custom"` | The Custom note still renders and its id is still announced by the picker; the credential line still reads the blank sentence | No error expected |
| Selection made | `provider: "openai"` | The three existing branches are unchanged, chosen off the picker's value | No error expected |
| Model hint, writable | `ProviderForm`, `modelSource: "config"` | `#model` `aria-describedby` is exactly `providerModelHint`, which resolves to the hint `<p>` | No error expected |
| Model hint, read-only | `readOnly: true`, `describedBy: "readOnlyNote"` | `#model` names `readOnlyNote providerModelHint`, in that order | No error expected |
| Model hint, env-locked | `settings.modelSource: "env"` | The locked `<div>` carries NO `aria-describedby` (not exposed on a plain div); the hint `<p>` and its id are still in the document | No error expected |
| Embedding hint composes | `EmbeddingSettings`, override + vector notice + read-only | `#embeddingModel` names `embeddingModelOverride embeddingVectorNotice embeddingModelHint <readOnly>` | No error expected |
| Embedding hint alone | No override, no vector notice, writable | `#embeddingModel` names exactly `embeddingModelHint` | No error expected |

</intent-contract>

## Code Map

- `src/components/ProviderForm.tsx` -- `effectiveProvider` at :96 (leave it; four other readers depend on the fallback — :97, :98, :114, :281). `selectedProviderHasKey` at :115-116 and the credential `<p>`'s three-way ternary at :246-254 are what change subject. `showCredentialStatus` at :127 and `credentialStatusId` at :191-193 stay exactly as they are. The model input is at :271-286 (`aria-describedby={readOnly ? describedBy : undefined}` at :279) and its hint `<p>` at :288-290, OUTSIDE the env/editable ternary so it renders on both branches. `ollamaDescribedBy` at :142-146 is the golden idiom to mirror for `modelDescribedBy`.
- `src/components/EmbeddingSettings.tsx` -- `OVERRIDE_NOTE_ID` (:96) and `VECTOR_NOTICE_ID` (:113) are module consts; add a third beside them. The `notes` composition is at :166-173 and the hint `<p>` at :250-254, again outside the branch, so its id is unconditional. The locked-branch comment at :182-190 states why the env `<div>` gets no attribute — the same reasoning applies to `ProviderForm`'s locked model box.
- `src/components/__tests__/provider-form.test.tsx` -- mounted-DOM suite; `settings()`/`props()` builders at :29-58, the picker describe at :216-449 with `picker()`/`describedIds()` helpers at :229-236. No existing case passes a blank `provider`, so DW-505 breaks nothing here; both DW ids need new cases.
- `src/components/__tests__/embedding-settings-override.test.tsx` -- six assertions become wrong once the hint id is composed: :105, :132, :154 (loop), :185, :207, :216, :234. Narrow each to its own claim rather than deleting it; :82 (locked `<div>` names nothing) stays true.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` -- `expectEveryDescribedIdResolves()` at :164-183 is the page-level invariant the new ids must satisfy. :254 (embedding input exactly `embeddingVectorNotice`) and :324 (embedding input `aria-describedby` null) need re-pinning; keep :326's `[aria-describedby~="embeddingVectorNotice"]` claim intact. `body()` at :111 seeds `providerSource: "config"`, so the picker is never blank here and the DW-400/419/420 cases at :476-610 are unaffected.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` -- the writable case's null-description loop at :380-388 currently excludes only `#provider`; `#model` and `#embeddingModel` now describe their hints too. The read-only case at :171-207 keeps passing (every control still reaches the banner) and :222's `describedIds[0]` is still the banner because `describedBy` stays first. :392-403's credential assertions are on a `config`-sourced `ollama` fixture, so they stay true.
- `src/hooks/useSettings.ts:232-235` -- read-only evidence for why the blank state is real: `provider` is seeded from the payload ONLY when `providerSource === "config"`, so an `env`- or `default`-sourced deployment paints the blank option with a stored provider behind it.
- `src/app/settings/page.tsx:137-160` -- read-only evidence: the page's status row already states the effective provider and its readiness ("Connected: … / No LLM provider configured"), so the blank sentence withholds nothing the page does not already say better.
- `src/components/workbench/SettingsCanvas.tsx:561,614` -- the convention DW-506 is measured against, in as many words.

## Tasks & Acceptance

**Execution:**
- `src/components/ProviderForm.tsx` -- (DW-505) derive `selectedProvider = provider || null` — the picker's own value — and rewrite `selectedProviderHasKey` to be guarded on it; put a fourth, FIRST branch in the credential ternary for `selectedProvider === null` reading "Select a provider to check its server credential". Comment WHY the fallback is kept for the notes and dropped here, citing the `:110-113` argument it is a deliberate exception to. (DW-506) add `const modelHintId = "providerModelHint"`, render the hint `<p>` with `id={modelHintId}`, and set the input's `aria-describedby` to a `modelDescribedBy` composed as `[readOnly ? describedBy : undefined, modelHintId]` through the existing filter/join.
- `src/components/EmbeddingSettings.tsx` -- add `MODEL_HINT_ID = "embeddingModelHint"` beside the other two note-id consts with the same docstring shape, render the hint `<p>` with it, and insert it into `notes` between `VECTOR_NOTICE_ID` and `readOnlyNoteId` — DOM reading order for the three nodes this component owns, with the page's banner id left in the position it already holds.
- `src/components/__tests__/provider-form.test.tsx` -- add a blank-selection describe covering the four blank rows of the matrix (credentialed store, uncredentialed store, nothing stored, notes-keep-the-fallback) asserting the exact sentence and that the picker still names `providerCredentialStatus`; add a model-hint describe covering the writable, read-only-composed and env-locked rows, resolving every emitted id.
- `src/components/__tests__/embedding-settings-override.test.tsx` -- re-pin the seven assertions named in the Code Map against the composed attribute, keeping each case's original claim (the vector/override cases scoped to their own ids rather than to "nothing describes anything"), and add the hint's own case: it is announced whenever the editable input renders, it resolves, and it carries whichever of the two sentences the branch selects.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` -- re-pin :254 and :324 against the composed embedding attribute; keep :326 and both `expectEveryDescribedIdResolves()` calls as they are.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` -- split the writable null-description loop: the controls that genuinely describe nothing keep the null assertion; `#provider`, `#model` and `#embeddingModel` instead assert that every id they name resolves and that none of those nodes says "Read-only mode" — the suite's claim is about refusal, and that must stay what it pins.

**Acceptance Criteria:**
- Given a loaded `/settings` whose picker shows `— Select provider —`, when a screen-reader owner reaches the picker, then the credential sentence they hear is about the absence of a selection, and names no stored provider's key state.
- Given any provider actually selected in the picker, when the credential line renders, then it reads exactly what it read before this change.
- Given either model box on `/settings`, when it receives focus, then its default-model hint is announced with it, composed with the read-only sentence when one applies rather than replaced by it.
- Given the whole repository test suite, when it runs after this change, then every suite passes — including the pre-existing assertions this change makes newly wrong, re-pinned rather than deleted.

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 4: (high 0, medium 4, low 0)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` Every DW-505 case handed `provider: ""` in as a prop, so the fix was proven only at the component-props surface while the defect's premise lives in the payload -> hook -> picker chain (`useSettings.ts:232-235` seeds `provider` only when `providerSource === "config"`). Added a page-level case to the parity suite stubbing `providerSource: "env"` with a credentialed store: the picker really renders blank, the credential node reads the blank sentence, and the page never says "API key configured on server". Mutation-checked — restoring the old subject fails it.
  - `[low]` `[patch]` `it("resolves every id the model box announces, on both deployments")` ran two identical iterations: without `describedBy`, `readOnly` true and false emit the same single id. The read-only iteration now passes the page's id and expects both, in order.
  - `[low]` `[patch]` Narrowing four component-wide `[aria-describedby]` nets to single-id queries dropped the "no node in this component carries a dangling describedby" claim they also covered. Added `expectNoDanglingDescribedIds()` — the component-level twin of the parity suite's `expectEveryDescribedIdResolves()` — and called it at each narrowed site.
  - `[low]` `[patch]` The new `modelDescribedBy` docstring claimed `describedBy` first means "one page announces its read-only sentence in one position", which the same page's embedding box contradicts. Scoped the claim to this form's own controls and named the exception; neither component's ordering moved.

## Design Notes

The blank state gets a SENTENCE rather than a hidden line. Hiding it would change when the node renders — the one thing DW-419/420 pinned as stable, and the gate `credentialStatusId` is derived from — and would drop the id from a composition the page-level suites assert. A fourth branch keeps the gate, the id and the composition untouched and only tells the truth about the state the control is in. Nothing is lost by not naming the stored provider here: `page.tsx:137-160` already states the effective provider and its readiness above the form.

The idiom both files already use, unchanged in shape:

```ts
const modelHintId = "providerModelHint";
const modelDescribedBy =
  [readOnly ? describedBy : undefined, modelHintId]
    .filter((id): id is string => Boolean(id))
    .join(" ") || undefined;
```

`|| undefined` is kept even though `modelHintId` is unconditional today: it is the invariant all four compositions in these two files state, and one of them differing for a reason that is true only now is the drift these files' comments argue against.

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/components/__tests__/provider-form.test.tsx src/components/__tests__/embedding-settings-override.test.tsx src/app/settings/__tests__` -- expected: all pass
- `pnpm test` -- expected: both projects green, no suite newly failing
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm exec eslint src/components/ProviderForm.tsx src/components/EmbeddingSettings.tsx` -- expected: clean

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

**DW-505** — the credential-status line under the provider picker now reads the picker's OWN value instead of `effectiveProvider`. `selectedProvider = provider || null` was added beside the existing derivation, `selectedProviderHasKey` was re-guarded on it, and a fourth, FIRST branch was put in the line's ternary for the blank `— Select provider —` option: "Select a provider to check its server credential". The three existing branches keep their copy and are now chosen off the selection. `effectiveProvider` and all four of its other readers — the Ollama, Ollama Cloud and Custom gates and the model placeholder — keep the stored-provider fallback the file's `:110-113` comment argues for. The line's render gate (`showCredentialStatus`), its id, and the picker's `aria-describedby` composition are byte-identical.

**DW-506** — both default-model hints are now announced with the box they describe instead of merely sitting beside it. `ProviderForm`'s hint carries `id="providerModelHint"` and the input's attribute became a composed `modelDescribedBy` (`describedBy` first, then the hint) instead of the `readOnly ? describedBy : undefined` choice that never composed. `EmbeddingSettings` gained `MODEL_HINT_ID = "embeddingModelHint"`, inserted into its existing `notes` list between the vector notice and the page's read-only id. Both hint `<p>`s sit outside their file's env/editable ternary, so their ids are unconditional and can never name an absent element. Both env-locked `<div>`s deliberately take no `aria-describedby`, matching the reasoning `EmbeddingSettings`' locked branch already spells out.

### Files changed

- `src/components/ProviderForm.tsx` -- DW-505's `selectedProvider` derivation and the blank credential branch; DW-506's `modelHintId`/`modelDescribedBy` composition and the hint's id.
- `src/components/EmbeddingSettings.tsx` -- `MODEL_HINT_ID`, the hint's id, and its slot in the `notes` composition.
- `src/components/__tests__/provider-form.test.tsx` -- two new describes (10 cases): the blank-selection matrix rows plus the notes-keep-the-fallback and selection-unchanged rows, and the model-hint writable / read-only-composed / env-locked / ids-resolve rows.
- `src/components/__tests__/embedding-settings-override.test.tsx` -- seven assertions re-pinned against the composed attribute, each narrowed to its own id rather than to "nothing describes anything"; a four-case describe for the hint including the all-four-ids composition; and `expectNoDanglingDescribedIds()` restoring the component-wide claim the narrowing dropped.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` -- two embedding `aria-describedby` assertions re-pinned; a new DW-505 page-level case proving the blank picker through the real payload -> hook -> picker chain on an `env`-sourced deployment.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` -- the writable null-description loop split so the three controls that now legitimately describe something assert what they DO say (every id resolves, none is the read-only banner) rather than being dropped from the suite.

### Review findings breakdown

- Patches applied: 4 (medium 1, low 3) -- see the Review Triage Log entry for each.
- Items deferred: 4 (all medium) -- recorded in frontmatter `deferred`.
- Items rejected: 11 (all low).

### Follow-up review recommendation

`true`. Patched findings this pass: high 0, medium 1, low 3. Score = 3 x 1 + 1 x 3 = 6, which is >= 5.

### Verification performed

- `pnpm exec vitest run --project dom src/components/__tests__/provider-form.test.tsx src/components/__tests__/embedding-settings-override.test.tsx src/app/settings/__tests__` -- 6 files, 75 tests, all pass.
- `pnpm exec tsc --noEmit` -- clean.
- `pnpm exec eslint` over all six changed files -- clean.
- `pnpm test` -- 326 files pass, 13 fail (229 tests). Every failure is under `src/components/workbench/__tests__/` with `TypeError: Cannot read properties of undefined (reading 'clear')` at `window.localStorage.clear()`. Verified pre-existing and unrelated: with this change stashed, that directory fails with the identical 13 files / 229 tests on baseline `88557079`. Passing tests rose 7590 -> 7592, matching the two cases added during review patching.
- Matrix test audit: all ten I/O rows are covered by a test that ran and passed, including the four-id embedding composition row, which needed a case added during the audit.
- The new DW-505 page-level case was mutation-checked: restoring the pre-fix subject (`provider || settings?.provider || null`) makes it fail with the stored provider's key sentence.

### Residual risks

- The spec's Verification section asks for a green `pnpm test`; that is not currently attainable on this machine because of the pre-existing `window.localStorage` failures described above. Baseline-identical counts are the evidence this change is clean.
- The four deferred items are all real and all medium; three of them (the env-locked hint copy, the read-only sentence's position across the two model boxes, and the placeholder still reading `effectiveProvider`) are adjacent to the nodes this change touched and would be a natural single follow-up bundle.
