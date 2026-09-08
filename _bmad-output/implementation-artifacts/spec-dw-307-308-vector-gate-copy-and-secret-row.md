---
title: 'Vector-gate finishing: secret rows announce a read-only refusal, and the route picks the same frame the client does (DW-307, DW-308)'
type: 'bugfix'
created: '2026-08-20'
status: 'done'
baseline_revision: '1bd45b6176060e1685f739e01c13b36ae1d2e060'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      Every refusal the legacy flat `/settings` path can now produce ends "Turn
      it off, or supply what is missing." — naming a switch that page does not
      render.
    evidence: |-
      For a flat-only body the gate runs only when the STORED flag is already on
      (`route.ts` spells out that "the flat branch cannot move that flag, so
      `turningOn` is always `false`"), so after DW-308 the flat path can receive
      ONLY the switched-on frame. `src/app/settings/page.tsx` renders the
      embedding model and nothing else — no vector checkbox anywhere outside
      `SettingsCanvas` — so "supply what is missing" is actionable there and
      "Turn it off" is not. That collides with the DW-303 principle already
      written into the same function ("a refusal has to be one the requesting
      surface can DO something about"), which DW-308 narrowed to WHETHER-only
      without extending the same surface-awareness to WHICH sentence is chosen.
      The intent framed the frame decision as binary on the stored flag and said
      nothing about surface-awareness, and the repinned expectations in
      `settings-route.test.ts` lock the current wording in — so whether the
      frame should additionally read `actionableLegs` is a distinct decision of
      the DW-303 family rather than part of DW-308.
    location: >-
      src/lib/workbench-settings.ts:validateWorkbenchSettingsPatch (the frame
      selection) with src/app/settings/page.tsx
    severity: medium
  - summary: >-
      The client picks the refusal's frame from the DRAFT checkbox and the route
      from the STORED flag, so one composition still shows both sentences on the
      same screen at the same moment.
    evidence: |-
      `SettingsCanvas` selects between `vectorSearchInactiveCopy` and
      `vectorSearchMissingCopy` on `values.vectorSearchEnabled` — the draft flag
      — while `validateWorkbenchSettingsPatch` selects on
      `baseline.vectorSearchEnabled`. Reachable: with the switch stored OFF and
      the legs met, the owner ticks the box (`vectorRefused` permits it), then
      moves a leg into an unmet state in the same draft. The checkbox hint reads
      "Vector search is switched on, but it needs …" while the 400 that lands in
      the save bar a few rows below reads "… before it can be turned on". The
      behaviour is unchanged by DW-308 — that composition answered the same way
      before — but it is the same two-sentences-for-one-state shape DW-279 and
      DW-308 exist to remove. DW-308's own intent excluded the literal
      "same frame the client picks" reading by also requiring both frames to be
      pinned at the route, so closing this needs a decision the intent does not
      contain: whether the route should read the REQUEST's flag for the frame
      while still keeping the turning-on sentence reachable. No test anywhere
      mounts `SettingsCanvas` with a mocked 400, so the save bar and the
      checkbox hint are never asserted together.
    location: >-
      src/components/workbench/SettingsCanvas.tsx (the checkbox hint selector)
      with src/lib/workbench-settings.ts:validateWorkbenchSettingsPatch
    severity: low
  - summary: >-
      `workspace-purpose-settings.test.tsx` is flaky — one `getByRole("status")`
      assertion fails intermittently, roughly one run in three.
    evidence: |-
      Observed during this change's verification: a full `npm test` reported
      1 failed / 5514 passed in that file, and two subsequent full runs reported
      5515/5515. Run in isolation three times it failed once and passed twice.
      The file is untouched by this change and shares nothing with the settings
      or vector-gate surface — the failing assertion is on the active-wiki
      status line ("This workspace now has an active wiki, ...") — so this is
      pre-existing suite noise rather than a regression. It makes every future
      run's green a coin flip on that one file.
    location: src/components/__tests__/workspace-purpose-settings.test.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two gaps are left on the vector-gate surface. `secretRow` hardcodes `aria-describedby={hintId}` while it sets `readOnly={stored.readOnly || removing}` and drops its Remove button under read-only, so on a `YOPEDIA_READONLY` deployment the three API-key rows are the last controls that refuse without saying why — the exact defect DW-280 closed for `textRow` (DW-307). And `validateWorkbenchSettingsPatch` returns `vectorSearchMissingCopy(merged)` — "…before it can be turned on" — for *every* refusal, so a save that moves a vector input into an unmet state while the switch is already stored ON lands that sentence in the save bar beside a still-ticked box, which is the mismatch DW-279 closed on the client only (DW-308).

**Approach:** Route `secretRow`'s description through the existing `describedBy()` and repin the source-shape guard that counts its call sites; add the first mounted case for a password field on a read-only deployment. Separately, let the route's refusal pick its frame from `baseline.vectorSearchEnabled`, which it already reads as `turningOn`: a request that turns the switch ON keeps `vectorSearchMissingCopy`, a request against an already-ON switch gets `vectorSearchInactiveCopy`.

## Boundaries & Constraints

**Always:**
- `canEnableVectorSearch` stays the ONE rule with two callers answering identically about *whether* a situation is refused. This change touches only which SENTENCE a refusal carries, never whether one happens.
- Both frames stay reachable at the route and both are pinned: `turningOn` (baseline OFF) → `vectorSearchMissingCopy`, already-on (baseline ON) → `vectorSearchInactiveCopy`.
- The frame is chosen from `baseline.vectorSearchEnabled` — the flag as the store held it BEFORE the request — which is the server's analogue of the ticked box the client reads, and is already computed as `turningOn`.
- `vectorSearchMissingCopy` and `vectorSearchInactiveCopy` keep their exact current sentences, legs, notes and order. Neither function changes.
- `workbench-settings.ts` stays client-safe and gains no new payload field, no new export, and no new parameter on `validateWorkbenchSettingsPatch`.
- `secretRow` keeps `readOnly={stored.readOnly || removing}`, keeps hiding Remove under read-only, and keeps its three hint states verbatim; only `aria-describedby` changes.
- The read-only sentence is APPENDED to the key row's own hint, never replaces it — "A key is stored." is the only thing distinguishing a password box that renders nothing from an empty one.

**Block If:** the client and the route would have to disagree about WHETHER a situation is refused.

**Never:**
- Do not `disable` the key input, do not restore the Remove button under read-only, and do not add `aria-invalid` to a secret row — a password field holds no wrong value to complain about.
- Do not change the flat-`/settings` leg scoping (`flatMovableVectorLegs`), the `suppressed` logic, or `vectorInputsEqual`.
- Do not change the client's frame selector in `SettingsCanvas` (`values.vectorSearchEnabled`), and do not make `vectorRefused` read the new distinction.
- Do not delete any test to accommodate the change.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Key row, read-only deployment, no stored key | `readOnly: true`, `hasCustomApiKey: false` | Custom API key box announces `SETTINGS_KEY_ABSENT_COPY` AND `SETTINGS_READ_ONLY_COPY`; still `readOnly`, still focusable, no Remove button | No error expected |
| Key row, read-only deployment, stored key + extra hint | `readOnly: true`, `hasEmbeddingApiKey: true`, env key for the selected provider | announces `SETTINGS_KEY_STORED_COPY`, the env-key sentence, AND `SETTINGS_READ_ONLY_COPY` | No error expected |
| Key row, writable deployment | `readOnly: false`, `hasFirecrawlApiKey: false` | announces its own hint alone; no read-only sentence; Remove button present when a key is stored | No error expected |
| Key row, writable, removal pending | `readOnly: false`, value set to `null` | unchanged: `SETTINGS_KEY_REMOVE_PENDING_COPY` alone, box `readOnly`, Undo offered | No error expected |
| Route, switch turned ON with an unmet leg | baseline `vectorSearchEnabled: false`, patch sets it `true`, no key | 400 with `vectorSearchMissingCopy(merged)` — "…before it can be turned on" | 400, nothing written |
| Route, already-ON switch broken by this save | baseline `vectorSearchEnabled: true` and satisfiable, patch clears the key | 400 with `vectorSearchInactiveCopy(merged)` — "Vector search is switched on, but it needs an API key before it can run. Turn it off, or supply what is missing." | 400, nothing written |
| Route, already-ON switch, flat legacy body | baseline ON, flat `embeddingModel` moved into a namespace mismatch | 400 with the inactive frame, notes intact | 400, nothing written |
| Route, refusal suppressed | flat-only body, unactionable legs, configuration not broken by this request | unchanged: `ok: true`, no refusal at all | No error expected |
| Route, switch turned OFF | patch sets `vectorSearchEnabled: false` | unchanged: gate not entered, no refusal | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/SettingsCanvas.tsx:302-306` -- `describedBy(hintId: string | undefined)`; already widened by DW-280, already appends `readOnlyNoteId`. No change needed — `secretRow` just has to call it.
- `src/components/workbench/SettingsCanvas.tsx:406-455` -- `secretRow`. The bare `aria-describedby={hintId}` is at `:435`, its comment at `:433-434`; `readOnly={stored.readOnly || removing}` at `:432`; the hint span at `:437-444`; the Remove button gated `hasStoredKey && !stored.readOnly` at `:445-455`. Call sites: `:482` (Custom API key), `:567-572` (Embedding API key, with the `envKeyProvider` extra hint), `:624-628` (Firecrawl API key).
- `src/lib/__tests__/workbench-settings.test.ts:3700-3736` -- the source-shape guard `describes every control whose constraint is not in its label`. `:3724` pins `aria-describedby={describedBy(` at 4 call sites → becomes 5; `:3733-3735` pins exactly one bare `aria-describedby={hintId}` → becomes 0, and its comment (which says the secret row "has no refusal to announce") is now false and must be rewritten. `:3735` `expect(canvas).toContain("aria-describedby={describedBy(hintId)}")` still holds — `providerRow` and now `secretRow` both match.
- `src/components/workbench/__tests__/settings-read-only.test.tsx:30-60` -- `payload()` fixture (`readOnly: true`, `hasEmbeddingApiKey: true`, `embeddingProvider: "openai"`); `:83-93` `announcedFor()` resolves every id in the list; `:96-108` `mount(category, stored)`; `:143-172` the DW-280 text-row cases are the exact model for the new key-row cases. Categories available: `"llm-models"` (Custom API key) and `"embeddings"` (Embedding API key).
- `src/lib/workbench-settings.ts:143-156` -- `SETTINGS_READ_ONLY_COPY`, `SETTINGS_KEY_STORED_COPY`, `SETTINGS_KEY_ABSENT_COPY`, `SETTINGS_KEY_REMOVE_COPY`.
- `src/lib/workbench-settings.ts:1125-1182` -- the vector rule inside `validateWorkbenchSettingsPatch`. `turningOn = !baseline.vectorSearchEnabled` at `:1132`; the refusal `return { ok: false, error: vectorSearchMissingCopy(merged) }` at `:1178`; the `suppressed` flag at `:1170-1177` is unchanged.
- `src/lib/workbench-settings.ts:702-736` -- `vectorSearchMissingCopy` and `vectorSearchInactiveCopy`. Read-only here: both are already exported and already carry the leg notes; the route only picks between them.
- `src/lib/workbench-settings.ts:988-1010` -- `validateWorkbenchSettingsPatch`'s doc comment; the `baseline` paragraph now has a second job to state.
- `src/app/api/settings/route.ts:430-452` -- the call site. The comment at `:437` asserts the sentence is "`vectorSearchMissingCopy(merged)` verbatim either way", which the change falsifies; the surrounding DW-303 argument (scoping narrows WHETHER, not the sentence) still stands and must survive.
- `src/lib/__tests__/workbench-settings.test.ts` -- refusal-sentence pins. Unit suites over the copy functions (`:490-1070`) are unaffected. Validator/route pins that assert a SENTENCE where the stored/baseline flag is already `true` will now read the inactive frame: audit every `"before it can be turned on"` occurrence from `:1340` down (notably `:1447`, `:1550`, `:1605`, `:1674`, `:1787`, `:2021`, `:2316-2320`, `:2823`, `:3032`, `:3459`, `:3529`) and repin only those whose baseline had the switch ON.
- `src/lib/__tests__/settings-route.test.ts`, `src/lib/__tests__/settings-runtime-wiring.test.ts`, `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- the same audit; the component suites assert client copy and are expected to be unaffected.
- `DEPLOY.md:170-173` -- "The three **API-key** rows (Custom, Embedding, Firecrawl) are the exception: they still announce only whether a key is stored." — now false. `:175-189` -- the "A switch that is already ON" paragraph, which states the client half only and is where the route's frame belongs.

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/SettingsCanvas.tsx` -- in `secretRow`, replace `aria-describedby={hintId}` with `aria-describedby={describedBy(hintId)}` and rewrite the comment above it to say why: the box is `readOnly` and the Remove affordance is gone on a read-only deployment, and "A key is stored." is the only thing said otherwise (DW-307).
- `src/lib/workbench-settings.ts` -- in `validateWorkbenchSettingsPatch`'s vector rule, select the refusal sentence by `turningOn`: `vectorSearchMissingCopy(merged)` when the request turns the switch on, `vectorSearchInactiveCopy(merged)` when the baseline already had it on. Comment the choice, and extend the `baseline` paragraph of the function's doc comment to name its second job (DW-308).
- `src/app/api/settings/route.ts` -- correct the comment that calls the refusal "`vectorSearchMissingCopy(merged)` verbatim either way" to say the scoping narrows WHETHER the gate refuses and not WHICH sentence it carries, which the baseline flag decides -- the DW-303 argument is still right and must not be lost.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- add the first mounted cases for a password field on a read-only deployment: a key row appends `SETTINGS_READ_ONLY_COPY` to its own hint (both the stored-key and the no-key wording), the Embedding API key row keeps its env-key extra hint beside both, the Remove button is absent, and a writable deployment leaves the row announcing its hint alone with Remove present -- no test in the repo mounts a secret row under `YOPEDIA_READONLY` today.
- `src/lib/__tests__/workbench-settings.test.ts` -- in the source-shape guard, bump the `describedBy(` call-site count from 4 to 5, drop the bare-`aria-describedby={hintId}` pin to 0, and rewrite both comments so they state the new truth (five call sites: two pickers, the vector switch, `textRow`, `secretRow`) rather than the retired exception.
- `src/lib/__tests__/workbench-settings.test.ts` -- add validator cases pinning BOTH frames at the route: baseline OFF + turning on → the "before it can be turned on" sentence; baseline ON + a save that moves a leg into an unmet state → the "switched on, but it needs …" sentence with the same legs and notes. Repin any existing sentence assertion whose baseline had the switch ON.
- `src/lib/__tests__/settings-route.test.ts`, `src/lib/__tests__/settings-runtime-wiring.test.ts`, `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- repin any 400-body assertion whose baseline stored `vectorSearchEnabled: true`, and add one end-to-end `PUT` pinning the inactive frame through the real route including the flat-legacy path.
- `DEPLOY.md` -- replace the "three API-key rows are the exception" sentence with the fact that they now announce the read-only sentence too, and record in the already-ON paragraph that the SAVE REJECTION now carries the same frame, with the turning-on request keeping "before it can be turned on".

**Acceptance Criteria:**
- Given `SettingsCanvas.tsx` after the change, when its source is scanned, then no `aria-describedby={hintId}` remains and every control whose deployment can refuse it routes its description through `describedBy`.
- Given the client/server agreement table, when each situation is evaluated on both halves, then the browser's answer still equals the route's for every one — this change moves no refusal boundary.
- Given `workbench-settings.ts` after the change, when its import graph and exports are inspected, then it imports nothing from `embeddings.ts`, `config.ts` or any Node builtin and exports no new symbol.
- Given the whole suite, when `npx eslint`, `npx tsc --noEmit` and `npx vitest run` run, then all pass with no test deleted to accommodate the change.

## Spec Change Log

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 0, low 5)
- defer: 3: (high 0, medium 1, low 2)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[low]` `[patch]` `vectorSearchInactiveCopy`'s doc comment still described a single, client-only caller — asserting that "every term this surface computes is DRAFT-derived" and that the save bar's standing sentence "is already announced on this control", neither of which holds for the new server caller. Rewritten to name both callers and what the sentence means on each; the returned string is unchanged.
  - `[low]` `[patch]` The Firecrawl API key row — the third row DW-307 is about — was never mounted, because `mount()` accepted only `"llm-models" | "embeddings"`. Widened to `"external-sources"` and added a read-only case covering both hint states with Remove absent.
  - `[low]` `[patch]` The env-key case was commented "Three things in one description, in the row's own order" but verified with three independent `toContain` calls, which pass on any permutation. Replaced with one exact-equality read of the whole announced string.
  - `[low]` `[patch]` `expect(await stored()).not.toMatchObject({ vectorSearchEnabled: true })` in the new end-to-end route test passed vacuously on an absent key. Replaced with whole-object equality pinning the flag as unwritten and nothing else landed.
  - `[low]` `[patch]` DEPLOY.md's binding section presented two refusal quotes that are now the turning-on frame only, with no way for a reader to match a real already-on 400 body back to the docs. Added a paragraph giving the switched-on sentence for the same leg verbatim and cross-referencing the frame rule; both existing quotes kept.

## Design Notes

**Why `baseline`, not `enabled`.** The client picks its frame from the box the owner is looking at (`values.vectorSearchEnabled`). The route has no box; the closest server fact is the flag as the store held it before the request, which the function already computes as `turningOn = !baseline.vectorSearchEnabled`. Reading the POST-merge `enabled` instead would be useless — the gate only runs inside `if (enabled)`, so `enabled` is always `true` there and `vectorSearchMissingCopy` would become unreachable, retiring a sentence that is exactly right for a request asking to turn the switch on:

```ts
return {
  ok: false,
  // Same legs, same notes — only the frame differs, and it is the same
  // question the client asks of its checkbox.
  error: turningOn ? vectorSearchMissingCopy(merged) : vectorSearchInactiveCopy(merged),
};
```

**Why the key row was left out of DW-280.** Nothing about it was ever safe; the guard's comment claimed the row "has no refusal to announce" because it renders `readOnly` rather than `aria-disabled`. But `readOnly` announces nothing beyond "read-only" as a property of the box, and the Remove button — the row's only other affordance — is *removed* under `stored.readOnly`, so the state a screen reader perceives is a box that will not take a keystroke next to a vanished button, described only as "A key is stored."

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: no errors.
- `pnpm lint` -- expected: clean.
- `pnpm test` -- expected: all suites pass, no test removed.

## Auto Run Result

Status: done

### Summary

Closed the last two gaps in the vector-gate surface work.

**DW-307** — `secretRow` routed its description through the existing `describedBy()`, so on a `YOPEDIA_READONLY` deployment the three API-key rows (Custom, Embedding, Firecrawl) now append `SETTINGS_READ_ONLY_COPY` to their own hint instead of announcing only whether a key is stored. The row was the last control on the surface that refused without saying why: its box is `readOnly` and its Remove button is *removed* rather than refused, so "A key is stored." was the whole description of a box that would take no keystroke beside an affordance that had vanished. `readOnly`, the Remove gating and the three hint states are untouched; no `disabled`, no `aria-invalid`.

**DW-308** — `validateWorkbenchSettingsPatch` now picks its refusal sentence from `turningOn` (`!baseline.vectorSearchEnabled`): a request that turns the switch ON keeps `vectorSearchMissingCopy` ("…before it can be turned on"), a request against a switch the store already held on gets `vectorSearchInactiveCopy`. Both frames stay reachable and both are pinned. Choosing on the post-merge `enabled` would have retired the missing frame outright, since the gate only runs inside `if (enabled)`. Neither copy function changed, and no refusal boundary moved — `canEnableVectorSearch` is still the one rule.

### Files changed

- `src/components/workbench/SettingsCanvas.tsx` -- `secretRow` uses `aria-describedby={describedBy(hintId)}`, with the comment stating why the row's earlier exemption was never sound.
- `src/lib/workbench-settings.ts` -- the vector refusal selects its frame on `turningOn`; `validateWorkbenchSettingsPatch`'s doc comment names `baseline`'s second job; `vectorSearchInactiveCopy`'s doc comment names both callers.
- `src/app/api/settings/route.ts` -- comment corrected: scoping narrows WHETHER the gate refuses, the baseline flag decides WHICH sentence it carries. The DW-303 argument is preserved.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- five new mounted cases, the first in the repo to mount a password field under `YOPEDIA_READONLY`; `mount()` widened to `"external-sources"` so the Firecrawl row is covered too.
- `src/lib/__tests__/workbench-settings.test.ts` -- source-shape guard repinned (`describedBy(` 4 → 5, bare `aria-describedby={hintId}` 1 → 0, both comments rewritten); new `the refusal's FRAME follows the stored flag (DW-308)` suite of five cases; a new end-to-end `PUT` covering both frames including the flat-legacy path; ten baseline-ON sentence assertions repinned.
- `src/lib/__tests__/settings-route.test.ts` -- the flat-branch DW-217/DW-303 expectations repinned to the switched-on frame (their stores all hold the flag on).
- `DEPLOY.md` -- the "three API-key rows are the exception" sentence replaced; the binding section notes its two quotes are the turning-on frame and gives the switched-on sentence; the already-ON paragraph records that a refused save now carries the same frame.

### Review findings breakdown

- Patches applied: 5 (high 0, medium 0, low 5) -- see the Review Triage Log.
- Items deferred: 3 (high 0, medium 1, low 2) -- the flat `/settings` surface receiving "Turn it off" for a switch it does not render; the residual client-draft-flag vs route-baseline-flag frame disagreement in one composition; a flaky pre-existing test file.
- Items rejected: 9 (all low) -- the stale DEPLOY.md flat-branch caveats (already open in the ledger as a separate entry); the deferred-work ledger and spec not being in the diff (orchestrator-owned / handled at finalize); an Undo affordance vanishing on a mid-draft read-only flip (speculative, pre-existing); the source-shape guard counting call sites rather than controls (pre-existing design the intent directed a bump to); verbatim sentence literals in tests (a legitimate copy pin, and the file's convention is mixed); the 400 body carrying no machine-readable code (architectural, out of scope); the change carrying two goals (bundle-directed, already flagged `multiple-goals`); and the save bar's error being byte-identical to the checkbox hint when both agree (which is the point of the change).

### Follow-up review recommendation

`true`. Patched findings this pass: high 0, medium 0, low 5. Score = 3x0 + 1x5 = 5, which is >= 5.

### Verification

- `npx tsc --noEmit` -- exit 0, no output.
- `npm run lint` -- clean; only the three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices.
- `npm test` -- 256 files, 5515 tests, all passing. `git diff` confirms zero deleted `it(` blocks.
- Matrix test audit: all nine I/O matrix rows are covered by tests that ran and passed. The four key-row rows by the new mounted cases in `settings-read-only.test.tsx`; the turning-on, already-on and flat-legacy frames by the new DW-308 suite and end-to-end `PUT`; the suppressed-refusal row by the existing DW-303 `actionableLegs` cases; the switch-OFF row by the existing "always allows turning it OFF" cases.

### Residual risks

- `src/components/__tests__/workspace-purpose-settings.test.tsx` is flaky (one `getByRole("status")` assertion, roughly one run in three). It is untouched by this change and unrelated to this surface, but it means a full-suite run is not deterministically green. Deferred.
- The two deferred copy findings above are both real and both about the same rule's edges: neither is a regression, and both need a decision this change's intent does not contain.
