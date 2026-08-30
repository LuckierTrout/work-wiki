---
title: 'Env-locked model boxes: an accessible name, and one read-only sentence position'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The env-locked `Ollama Base URL` box has the same nameless-locked-box defect DW-562
      just fixed on the two model boxes, and no mounted test renders that branch at all.
    evidence: |-
      `ProviderForm.tsx` renders `<label htmlFor="ollamaBaseUrl">` unconditionally, while the
      `settings?.ollamaBaseUrlSource === "env"` branch renders a bare `<div>` with no id — so on an
      `OLLAMA_BASE_URL`-pinned deployment the label names an id nothing carries and the value is
      announced with no accessible name, exactly the state removed from `#model` and
      `#embeddingModel`. Excluded by this bundle's intent, which names only the model boxes.
      Nothing would catch it drifting further: a repo-wide search for `ollamaBaseUrlSource: "env"`
      matches only `src/lib/__tests__/config.test.ts` (a server-side resolver test that renders
      nothing), and every mounted suite uses `config` sources for that field. The fix is the same
      one-line element swap plus a twin of the accessible-name case.
    location: >-
      src/components/ProviderForm.tsx — the `Ollama Base URL` env branch
    severity: medium
baseline_revision: '8103ff2b6758729f1b15a401206606fb3c073960'
---

<intent-contract>

## Intent

**Problem:** On an env-pinned deployment `/settings` renders each model value as a bare `<div>` while its `<label htmlFor>` still points at `model` / `embeddingModel` — ids no element carries — so both locked boxes are announced with NO accessible name at all (DW-562). Separately, the page's one read-only banner sentence is announced FIRST on `ProviderForm`'s model box and LAST on `EmbeddingSettings`', so one sentence occupies two positions on one page (DW-560).

**Approach:** Give each locked box the id its label already names, plus the role/aria pairing that makes a name computable on a non-form element, and move `readOnlyNoteId` to the front of `EmbeddingSettings`' `notes` so both model boxes lead with the banner. Rewrite the comments whose premises these two changes falsify, and pin both properties with mounted assertions.

## Boundaries & Constraints

**Always:**
- The locked box's accessible name must come from a mechanism a BROWSER honours, not only from Testing Library's `label[for]` heuristic: HTML `for` associates only with labelable elements (`button`, `input`, `meter`, `output`, `progress`, `select`, `textarea`), and a `<div>` is not one. The id alone would turn `getByLabelText` green while a screen reader still announced nothing.
- Both branches of each env/editable ternary must be named by the SAME node — the existing `<label>`, `SourceBadge` included — so the locked and editable spellings of one control announce one name.
- Every id any `aria-describedby` names must resolve to a node in the document, and the attribute is `undefined` rather than `""` when the list is empty. This is the invariant all five compositions in the two files already state.
- After the reorder, both `/settings` model boxes name the page's read-only id in the SAME position (first). The comments that currently assert or excuse the divergence must be rewritten to match what the code now does.
- Any comment whose stated premise this change falsifies is rewritten, not left standing.

**Block If:**
- Making the locked box nameable would require putting it in the tab order or otherwise changing keyboard behaviour of `/settings`.

**Never:**
- Do not add `aria-describedby` to either locked box. DW-562 is about the missing NAME; what the locked branches announce as a DESCRIPTION is a separate change neither ledger entry asks for, and the existing cases that assert its absence stay as they are (their comments are rewritten to state the real reason, not a premise this change removes).
- Do not touch the `ollamaBaseUrl` env-locked box, the structured-knowledge fields, or `SettingsCanvas.tsx`. Same defect class, different controls, outside both entries.
- Do not change what any sentence on the page SAYS, nor which sentences render.
- Do not change `ProviderForm`'s own composition order — it is already correct and is the order `EmbeddingSettings` is being moved onto.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Locked provider model | `ProviderForm` with `settings.modelSource: "env"`, `model: "gpt-4o"` | The value box carries `id="model"`, an exposed role, and an accessible name from the `Model` label; `document.getElementById("model")` is that box | No error expected |
| Locked embedding model | `EmbeddingSettings` with `modelSource: "env"` | The value box carries `id="embeddingModel"`, an exposed role, and an accessible name from the `Embedding Model` label | No error expected |
| Editable branch unchanged | Either component with a `config` / `default` / `none` source | The `<input>` keeps its id, its label association and its exact `aria-describedby`; no locked-branch attribute leaks onto it | No error expected |
| Read-only embedding box | `EmbeddingSettings` `modelSource: "config"`, `readOnly`, `describedBy: "readOnlyNote"` | `aria-describedby` is `readOnlyNote embeddingModelHint` | No error expected |
| All four embedding ids | read-only + `overridden` + `vectorNotice`, `config` source | `aria-describedby` is `readOnlyNote embeddingModelOverride embeddingVectorNotice embeddingModelHint` | No error expected |
| Writable deployment | `readOnly` false | No banner id in either composition; lists are unchanged from today | No error expected |
| Page parity | `/settings` mounted read-only with `config` sources | `#model` and `#embeddingModel` both name the banner node at index 0 | No error expected |

</intent-contract>

## Code Map

- `src/components/ProviderForm.tsx` -- `modelDescribedBy`'s docstring (search `Scoped to this form deliberately`) names `EmbeddingSettings`' trailing `readOnlyNoteId` as a standing exception; after DW-560 the page-wide claim holds and that paragraph is false. `modelHintId` just below it is the file's convention for a hardcoded id const read by both the JSX and the composition.
- `src/components/ProviderForm.tsx` -- the `Model` block: `<label htmlFor="model">` and the `settings?.modelSource === "env"` ternary. The env branch is the bare `<div>` DW-562 is about; its comment argues from "plain non-focusable `<div>` with no role", a premise this change removes.
- `src/components/ProviderForm.tsx` -- the `Ollama Base URL` block below it carries the SAME defect (`<label htmlFor="ollamaBaseUrl">` over a bare env `<div>`) and is deliberately NOT touched. Do not let a comment claim a rule "for the two boxes on this page" that this third box does not follow.
- `src/components/EmbeddingSettings.tsx` -- `readOnlyNoteId` and the `notes` array: `readOnlyNoteId` is last and an inline comment defends that position; both change.
- `src/components/EmbeddingSettings.tsx` -- `<label htmlFor="embeddingModel">` and its env/editable ternary; the env branch `<div>` carries the same comment and the same gap.
- `src/components/EmbeddingSettings.tsx` -- `OVERRIDE_NOTE_ID` / `VECTOR_NOTICE_ID` / `MODEL_HINT_ID`, the module-const-with-docstring convention. `MODEL_HINT_ID`'s docstring states the old between-notes-and-banner position and needs its ordering sentence updated.
- `src/app/settings/page.tsx` -- mints `readOnlyNoteId` with `useId()` and hands the same `describedBy` to `ProviderForm`, `StructuredKnowledgeSettings` and `EmbeddingSettings`. One id, several boxes: this is why the position divergence is observable at all. Read-only, no change needed.
- `src/components/__tests__/provider-form.test.tsx` -- the case named `leaves the ENV-LOCKED box unattributed…` asserts `document.getElementById("model")` is null, which pins the DW-562 defect. Its `aria-describedby`-is-null and hint-copy assertions stay.
- `src/components/__tests__/embedding-settings-override.test.tsx` -- the locked-box case (`names the in-effect model beside the locked env box`) whose comment carries the "no role" premise; the three cases pinning the OLD `notes` order; the two cases using `queryByLabelText(/Embedding Model/)` to mean "no editable box"; and `expectNoDanglingDescribedIds()`, the existing helper to reuse rather than re-derive.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` -- the `field(id)` helper and the mounted read-only suite. Its case `points every control the FORM refuses at the form's refusal sentence` already enumerates every control the page hands `describedBy` to and checks banner MEMBERSHIP; the ordering claim needs banner POSITION over that same list. Its fixture uses `config` sources throughout, so it never renders a locked box.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` -- its DW-327 case asserts `queryByLabelText(/Embedding Model/)` and `getElementById("embeddingModel")` are both null on an env mount; both answers change.
- `vitest.config.ts` -- the `dom` project collects `src/**/__tests__/**/*.test.tsx`; every suite above is already inside it.

## Tasks & Acceptance

**Execution:**
- `src/components/ProviderForm.tsx` -- render the env-locked model value as `<output id="model" aria-live="off">` instead of a bare `<div>`, keeping the same `className` (add whatever Tailwind display/width utilities are needed to keep the box looking identical, since `<output>` is inline by default) -- `<output>` is one of HTML's labelable elements, so the `<label htmlFor="model">` that already exists associates with it natively and names it with no ARIA at all. `aria-live="off"` silences the live-region behaviour its implicit `status` role would otherwise carry.
- `src/components/ProviderForm.tsx` -- rewrite the env branch's comment and the `modelDescribedBy` docstring's scoping paragraph -- the first argues from a premise ("no role") this change removes; the second names an exception DW-560 deletes.
- `src/components/EmbeddingSettings.tsx` -- apply the same `<output>` change to the env-locked embedding value, and rewrite its branch comment -- one shape for the two model boxes.
- `src/components/EmbeddingSettings.tsx` -- move `readOnlyNoteId` to the FRONT of `notes` and rewrite the inline comment that defended the trailing position, plus `MODEL_HINT_ID`'s ordering sentence -- the page's banner renders above the whole section, so first IS its DOM reading-order position.
- `src/components/__tests__/provider-form.test.tsx` -- rewrite the env-locked case to assert the name: `#model` IS the locked box, it is not an `<input>`, its accessible name equals the `Model` label's own `textContent`, and `getByLabelText`/`getByRole` resolve to it. The `aria-describedby`-is-null and hint-copy assertions stay.
- `src/components/__tests__/embedding-settings-override.test.tsx` -- add the twin accessible-name case plus an editable-branch-untouched case, re-pin the two order-sensitive expectations to `readOnlyNote`-first, and correct the "no role" comment on the locked-box case.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` -- add one case asserting that on a read-only mount EVERY control the page hands `describedBy` to names the banner at index 0, over the same control list its membership case already enumerates -- the DW-560 property is page-level and this is the claim the rewritten `ProviderForm` docstring makes.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` -- update its env-mount assertions, which answered null only because the locked box was nameless.

**Acceptance Criteria:**
- Given a deployment with `modelSource: "env"`, when `ProviderForm` mounts, then `document.getElementById("model")` is the rendered value box, it is not an `<input>`, and it is the element `getByLabelText(/^Model/)` returns.
- Given a deployment with `modelSource: "env"`, when `EmbeddingSettings` mounts, then `document.getElementById("embeddingModel")` is the rendered value box, it is not an `<input>`, and it is the element `getByLabelText(/Embedding Model/)` returns.
- Given either locked box, when its accessible name is computed, then it equals the `textContent` of the `<label>` rendered for that control — asserted against that label's own text, never against a loose pattern that a partial name would also satisfy.
- Given either locked box, when its attributes are read, then it carries no `aria-describedby` and no `tabIndex`, and it is not focusable.
- Given a read-only `/settings` mount, when the `aria-describedby` of every control the page hands `describedBy` to is read, then the attribute is present on each and index 0 of each is the id of the node containing "Read-only mode" — the same node id for all of them.
- Given any mount of either component, when every node carrying `aria-describedby` is walked, then each names at least one id and every id resolves.
- Given a writable deployment, when either component mounts, then its composition is byte-identical to today's.

## Spec Change Log

### 2026-08-29 — Review pass 1 (bad_spec)

**Triggering findings.** All four review layers independently flagged the same defect: the planned pairing put `role="textbox"` (an ARIA WIDGET role) on a deliberately non-focusable `<div>`. A `textbox` that cannot take focus is a control an assistive technology will offer in form-field navigation and then be unable to operate — the change would have traded "no name" for "an inoperable widget", and no repo tooling (`eslint-config-next`'s jsx-a11y subset; there is no axe dependency) would ever flag it. Three layers also noted that `<output>` was listed in the diff's OWN enumeration of labelable elements and never considered. Secondary findings folded into this amendment: the accessible name was asserted with regexes (`/^Model/`) loose enough to pass on a partial name; the rewritten `ProviderForm` docstring claims a PAGE-WIDE ordering rule while the new page test pinned only two of the page's controls; a `getAttribute(...)!.split(...)` in the new page case would fail as a bare `TypeError` rather than as the claim it guards; and comments cited a page suite as pinning a keyboard-order claim that suite's fixture never exercises.

**What was amended.** Design Notes now prescribe `<output>` — a labelable element, so the existing `<label htmlFor>` associates with it natively — instead of a `<div>` plus an invented widget role plus `aria-labelledby`. Tasks drop the two new label-id constants entirely. Acceptance Criteria now require the name to be asserted against the label's own `textContent`, require the page-level ordering claim to cover every control the page hands `describedBy` to, and require the locked box to be non-focusable. Verification gains a typecheck.

**Known-bad state avoided.** A `/settings` that announces its env-locked values as read-only text fields which no keyboard or forms-mode user can reach, defended by five copies of a comment explaining why the missing focusability is fine.

**KEEP — must survive re-derivation.**
- The DW-560 half was correct and complete: `readOnlyNoteId` first in `notes`, the inline comment rewritten to say the banner renders above the whole section, `MODEL_HINT_ID`'s docstring updated to "LAST of the three ids this component owns", and `ProviderForm`'s exception paragraph replaced by the page-wide claim.
- The three order-sensitive re-pins in `embedding-settings-override.test.tsx` (`readOnlyNote embeddingModelHint`, and the four-id `toEqual` led by `readOnlyNote`).
- The insight that `getByLabelText` is not sufficient evidence on its own — Testing Library resolves `label[for]` to any element with the id and a browser does not. With `<output>` the association is real, but the assertions should still name the mechanism they rely on.
- Reusing `expectNoDanglingDescribedIds()` rather than re-deriving it.
- Updating `settings-page-legacy-surface-parity.test.tsx`'s env-mount case, which is outside the Code Map but pins the same defect.
- The `deferred-work.md` ledger stays untouched.

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 5: (high 0, medium 2, low 3)
- patch: 0
- defer: 1: (high 0, medium 0, low 1)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[medium]` `[bad_spec]` `role="textbox"` on a non-focusable `<div>` creates an inoperable widget; spec now prescribes `<output>`, a labelable element the existing `<label htmlFor>` names natively.
  - `[medium]` `[bad_spec]` the rewritten `ProviderForm` docstring claimed a page-wide banner-position rule while only two controls were pinned; the page-level AC now covers every control the page hands `describedBy` to.
  - `[low]` `[bad_spec]` the accessible name was pinned with loose regexes that a partial name satisfies; the AC now requires equality with the label's own `textContent`.
  - `[low]` `[bad_spec]` the new page case dereferenced `getAttribute(...)!`, failing as a bare `TypeError`; the AC now requires the attribute's presence to be asserted first.
  - `[low]` `[bad_spec]` comments cited `settings-page-read-only-controls.test.tsx` as pinning a keyboard-order claim its `config`-source fixture never exercises; the Design Notes now forbid citing a test that does not exercise the claim.

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 1: (high 0, medium 1, low 0)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` `aria-live="off"` was unpinned on `ProviderForm`'s locked `<output>` — deleting it left the whole dom project green, silently restoring the live region. Assertion added, mutation-confirmed to fail now.
  - `[medium]` `[patch]` five passages claimed that putting the id on the `<div>` would have turned Testing Library's `label[for]` heuristic green while a browser announced nothing. Probed and false: `getByLabelText` refuses a non-labellable element outright. Rewritten in both components, both new test cases and the Design Notes to say what is true.
  - `[low]` `[patch]` `provider-form.test.tsx` pinned the accessible name with `toContain("Model")`, which the spec's AC forbids; now `toBe("Modelfrom environment")`, matching the twin.
  - `[low]` `[patch]` `expect(tagName).not.toBe("INPUT")` after `toBe("OUTPUT")` is unfailable; replaced in both cases with the real `input#…`-absence claim.
  - `[low]` `[patch]` new `!` dereferences in three test additions would have failed as bare `TypeError`s; guarded, with the loop's iteration named.
  - `[low]` `[patch]` `modelDescribedBy`'s docstring claimed the index-0 rule for controls that carry no description at all on an env-pinned deployment; narrowed to controls that carry one.
  - `[low]` `[patch]` `aria-live="off"` does not remove `<output>`'s implicit `status` role, but the comments and the `hasAttribute("role")` assertion together read as "no role"; reworded to "no EXPLICIT role", with the implicit one named as what the accessible name is computed for.

## Design Notes

The locked box becomes an `<output>`, not a `<div>` wearing ARIA:

```tsx
// Locked branch — no role, no aria-labelledby, no new id constant.
<output id="model" aria-live="off" className="mt-1.5 block w-full …">
  {settings.model}
</output>
```

`<output>` is one of HTML's seven LABELABLE elements (`button`, `input`, `meter`, `output`, `progress`, `select`, `textarea`), so the `<label htmlFor="model">` that this component already renders associates with it the same way it associates with the editable branch's `<input>` — one label node, one name, both spellings. That is what `htmlFor` alone could not do for a `<div>`: `for` associates ONLY with a labelable element, so the ELEMENT is what had to change and no attribute piled onto the `<div>` would have substituted for it.

The browser and the test stack agree on that refusal, so there is no false-green to guard against here. Probed against the versions this repo installs: `getByLabelText` throws `Found a label with the text of: …, however the element associated with this label (<div />) is non-labellable` rather than resolving, and `getByRole("status", { name })` finds no match for a `<div id role="status">` sitting under a `label[for]`. The assertions should still name the mechanism they rely on — the association is real because the element is labelable — but they are evidence about what a browser announces, not merely about a heuristic.

`aria-live="off"` is the one attribute that is not free: `<output>`'s implicit role is `status`, which is a live region, and this box is re-rendered whenever `/api/settings` answers. The implicit role STAYS — it is what the box is exposed as, and what `getByRole("status", { name })` resolves through — and only the live-region behaviour is silenced, so the box is a named value read where it sits rather than an announcement on every answer. What the components must not carry is an EXPLICIT role.

No `role="textbox"`, and no `tabIndex`. A widget role on an element that cannot take focus is a control an assistive technology offers and then cannot operate, and making the box focusable would change `/settings`' keyboard order — a behaviour change neither ledger entry asks for.

Two rules for the comments this change rewrites: a comment may not state a premise the code no longer has, and it may not cite a test as pinning a claim that test's fixture never exercises (the mounted read-only page suite uses `config` sources throughout, so it renders no locked box at all).

## Verification

**Commands:**
- `pnpm vitest run src/components/__tests__/provider-form.test.tsx src/components/__tests__/embedding-settings-override.test.tsx src/app/settings/__tests__/settings-page-read-only-controls.test.tsx src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` -- expected: all pass, including the new accessible-name and ordering cases.
- `pnpm test` -- expected: the full suite passes; no other suite depended on the old `notes` order or on `#model` being absent.
- `npx tsc --noEmit` -- expected: clean.
- `pnpm lint` -- expected: clean (the three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices are not errors and exit 0).

## Auto Run Result

Status: done

**Implemented change.** On `/settings`, the two env-locked model boxes are now `<output>` elements instead of bare `<div>`s, so the `<label htmlFor="model">` / `<label htmlFor="embeddingModel">` the components already rendered associate with them natively and the locked values have a real accessible name — they had none, because `for` associates only with HTML's labelable elements and a `<div>` is not one (DW-562). `aria-live="off"` silences the live-region behaviour `<output>`'s implicit `status` role would otherwise carry; no explicit role and no `tabIndex`, so `/settings`' keyboard order is unchanged and no widget role is claimed that a non-focusable element could not honour. Separately, `readOnlyNoteId` moved to the front of `EmbeddingSettings`' `notes`, so the page's single read-only banner sentence is announced at index 0 on every control that carries a description rather than first on one model box and last on the other (DW-560).

**Files changed.**
- `src/components/ProviderForm.tsx` — locked model box becomes `<output id="model" aria-live="off">`; env-branch comment rewritten; `modelDescribedBy`'s "scoped to this form" exception paragraph replaced by the page-wide index-0 rule.
- `src/components/EmbeddingSettings.tsx` — same `<output>` change for the embedding box; `readOnlyNoteId` moved to the front of `notes`; the inline comment defending the trailing position and `MODEL_HINT_ID`'s ordering sentence rewritten.
- `src/components/__tests__/provider-form.test.tsx` — the env-locked case becomes a name case (id, tag, exact accessible name from the label's own text, `aria-live`, no explicit role, no `tabindex`, still no description); new editable-branch-untouched case.
- `src/components/__tests__/embedding-settings-override.test.tsx` — twin accessible-name case and an editable-branch case over all three non-env sources; the two order-sensitive expectations re-pinned to `readOnlyNote`-first; "no role" comments corrected.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` — new page-level case asserting all seven `describedBy` consumers name the banner at index 0, and that it is one id, not seven lookalikes.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` — its env-mount case asserted the defect (`getElementById("embeddingModel")` null); now asserts the locked `<output>` and that the label resolves to it.

**Review findings.** Two passes. Pass 1: 5 bad_spec (2 medium, 3 low), 1 defer, 9 reject — all four layers independently flagged the planned `role="textbox"` on a non-focusable `<div>` as trading "no name" for an inoperable widget; the spec was amended to `<output>`, the code reverted and re-derived. Pass 2: 0 intent_gap, 0 bad_spec, 7 patches applied (2 medium, 5 low), 1 deferred, 11 rejected. Follow-up review recommended: **true** — patched severities 0 high / 2 medium / 5 low, score `3×2 + 1×5 = 11`, which is ≥ 5.

**Verification.** `pnpm test` — 348 files, 8078 passed, 1 skipped, 0 failed. The four target suites — 72 passed. `npx tsc --noEmit` — exit 0, no output. `pnpm lint` — exit 0 (the three `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing and are not errors). Mutation-checked: reverting the `notes` order fails the page-level DW-560 case and two component cases; reverting the `<output>` to a `<div>` fails both name cases; deleting `aria-live="off"` from either locked box fails that box's case.

**Residual risks.**
- The accessible name is verified through jsdom + `dom-accessibility-api`, not a real accessibility tree. The association is a native HTML one rather than an ARIA reconstruction, so the risk is low, but no axe or Playwright a11y check exists in this repo to confirm what a screen reader actually announces.
- `<output>` is a listed form-associated element and both boxes sit inside the page's `<form>`, so `#model` and `#embeddingModel` now appear in `form.elements` where the `<div>`s did not. Nothing in the repo reads `form.elements` and the page has no reset control, so no behaviour depends on it today.
- The `Ollama Base URL` env-locked box still carries the identical defect and no mounted test renders that branch — recorded in this spec's frontmatter `deferred`.
