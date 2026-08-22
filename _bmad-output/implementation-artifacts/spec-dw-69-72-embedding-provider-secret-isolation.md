---
title: 'DW-69/72 — Embedding provider secret isolation'
type: 'bugfix'
created: '2026-08-21'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
baseline_revision: '2427b276e142ce7f503399e2633b434d463d8f13'
deferred:
  - summary: >-
      The EFFECTIVE embedding vendor can move without the stored
      `embeddingProvider` moving, so the clear never fires and a stored key or
      endpoint can still reach a vendor it was not entered for.
    evidence: |-
      `resolveEmbeddingProvider` takes `process.env.EMBEDDING_PROVIDER` ahead of
      the stored field and falls back to the detected generation provider
      (`cfg.provider`) when nothing is stored. No save moves either, so
      `embeddingProviderChanged` never sees a switch: with
      `EMBEDDING_PROVIDER=google` and a stored OpenAI key,
      `embeddingApiKeyFor("google", cfg)` still returns it and
      `_createEmbeddingModel` still passes the stored `embeddingBaseUrl`.
      Pre-existing, and out of scope for the recorded decisions, whose trigger is
      literally "whenever `embeddingProvider` changes" — closing it means
      deciding what a chat-provider change may do to an embedding credential.
      This pass also makes one NEW consequence reachable on an env-pinned
      deployment: the stored provider select stays editable there, and moving it
      now clears the credential the env-selected vendor is using. The surface
      stays honest (the key hint flips to "No key is stored." and the row's env
      sentence already says the variable owns the selection), but the select is
      inert for resolution and arguably should not be editable at all.
    location: >-
      src/lib/embeddings.ts:170 (resolveEmbeddingProvider); src/components/workbench/SettingsCanvas.tsx (embedding provider select)
    severity: medium
  - summary: >-
      `spec-dw-66-72-settings-credential-fidelity.md` still reads
      `status: 'in-progress'` for DW-69/DW-72 under the superseded per-provider
      keying approach.
    evidence: |-
      That spec planned to key `embeddingApiKey`/`embeddingBaseUrl` per provider
      with a load-time migration. The recorded decisions rule that out, and
      nothing from it landed — the store is still flat. Its frontmatter is where
      anyone scanning for open work will look, and it currently claims work is
      under way on entries this spec resolves.
    location: >-
      _bmad-output/implementation-artifacts/spec-dw-66-72-settings-credential-fidelity.md
    severity: low
---

<intent-contract>

## Intent

**Problem:** One stored `embeddingApiKey` and one stored `embeddingBaseUrl` serve whichever embedding vendor is selected, so switching `embeddingProvider` from OpenAI to Google silently sends OpenAI's secret and OpenAI's endpoint to Google — while the surface still reads "A key is stored." and the vector gate still passes on the strength of the old vendor's credential.

**Approach:** Clear on switch. Whenever the stored `embeddingProvider` value changes, drop the stored `embeddingApiKey` (and with it the derived `hasEmbeddingApiKey` flag) and the stored `embeddingBaseUrl`, on both writers — the flat legacy branch and the `workbench` patch merge — so the owner re-enters both for the new vendor. The vector rule's two halves (route merge and browser draft) stop counting the stored key and endpoint across a switch, and the Workbench draft blanks both boxes the moment the select moves, so what the surface shows is what will be stored. No stored-shape change: the fields stay flat.

## Boundaries & Constraints

**Always:** The switch test is a VALUE comparison of the stored `embeddingProvider` before and after this request — not presence — because `settingsSaveBody` sends `embeddingProvider` on every save. A value explicitly supplied in the SAME request wins over the clear: the clear drops what the STORE held, then the patch applies. Every new rule is a pure exported function in `src/lib/workbench-settings.ts` executed by the node suite — no rule may live only inside JSX. The route half (`mergedVectorInputs`) and the browser half (`draftVectorInputs`) must answer identically for the same situation. No stored secret ever appears in a payload; presence stays a boolean. `GET`/`PUT /api/settings` keep the one nested `workbench` key and the flat legacy contract frozen; the `If-Match` write precondition stays required and unchanged.

**Block If:** the intended clear cannot be expressed without changing the stored shape of `AppConfig` (e.g. per-provider keying) — the recorded decisions rule that out, so a design that needs it is a decision this spec does not carry.

**Never:** Do not key `embeddingApiKey` or `embeddingBaseUrl` per provider, and do not add a migration. Do not change how `_createEmbeddingModel` builds its clients (the store, not the constructor, is what makes the endpoint vendor-correct). Do not clear `embeddingModel`, the vector switch, or any non-embedding credential. Do not add a settings route, a confirmation dialog, or new UI copy strings beyond reusing the existing key-absent hint.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Workbench switch, nothing retyped | stored `{embeddingProvider:"openai", embeddingApiKey:"sk-o", embeddingBaseUrl:"https://o/v1"}`; patch `{embeddingProvider:"google"}` | saved config keeps `embeddingProvider:"google"` and holds NEITHER `embeddingApiKey` nor `embeddingBaseUrl`; payload reports `hasEmbeddingApiKey: false` | No error expected |
| Switch with new credentials in the same request | same store; patch `{embeddingProvider:"google", embeddingApiKey:"g-key", embeddingBaseUrl:"https://g/v1"}` | the patch's values are stored for Google; the OpenAI pair is gone | No error expected |
| Same provider re-sent | stored provider `openai`; patch `{embeddingProvider:"openai"}` (every save sends it) | stored key and endpoint untouched; `hasEmbeddingApiKey` stays `true` | No error expected |
| Provider cleared to auto-detect | stored provider `openai` + key + endpoint; patch `{embeddingProvider:null}` | provider deleted AND key and endpoint cleared — the effective vendor may now resolve elsewhere | No error expected |
| Flat legacy body switches provider | `PUT` body `{embeddingProvider:"google"}`, no `workbench` key | stored key and endpoint cleared before the vector gate runs; with `vectorSearchEnabled` stored ON the gate refuses 400 rather than silently switching vector search off | 400 with the existing vector refusal sentence; nothing is written |
| Gate sees the post-switch reality | `vectorSearchEnabled: true`, stored OpenAI key, patch switches to `google` with no key | `PUT` refuses 400 — the stored key no longer counts for the new vendor | 400, store unchanged |
| Draft switch in the Workbench | endpoint box shows `https://o/v1`, hint reads "A key is stored."; owner picks Google in the select | endpoint box blanks, key field returns to untouched, hint reads the key-absent sentence, `Remove` disappears | No error expected |
| Switch and back within one draft | draft provider `openai` → `google` → `openai`, nothing else typed | boxes stay blank (they were cleared at the first move) but the STORED key is not dropped on save: the stored value never changed | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts` — home of every pure rule. `WorkbenchSettingsStored` (:1188-1190 `embeddingProvider`/`embeddingBaseUrl`), `validateWorkbenchSettingsPatch` (~:1250-1400, vector gate at :1345+), `mergedVectorInputs` (:1493-1533 — `baseUrl: resolve(patch.embeddingBaseUrl, stored.embeddingBaseUrl)` at :1518 and `hasKey` from `stored.hasEmbeddingApiKey` at :1509-1514 are the two lines that must stop counting across a switch), `SettingsDraft` (:1555), `SECRET_UNTOUCHED` (:1573), `settingsDraftFromPayload` (:1575), `settingsSaveBody` (:1620-1650 — sends `embeddingBaseUrl` on EVERY save, which is why the draft must be blanked client-side), `secretPatchValue` (:1668), `draftVectorInputs` (:1697-1725). Add the new exports here.
- `src/lib/config.ts` — `AppConfig` embedding fields (:40, :74, :76). `applyWorkbenchSettings` (:1371-1401): `setText("embeddingProvider")` at :1396 then `embeddingBaseUrl`/`embeddingApiKey` at :1398-1399, all independent — the store-side clear goes here, computed from `existing.embeddingProvider` BEFORE any mutation. `workbenchSettingsStored` (:1339) and the two payload builders (:1285-1294, :1346-1349) derive `hasEmbeddingApiKey` from the store, so the `has*` flag follows for free. config.ts already imports from `./workbench-settings` (:9-18) — direction is safe; the reverse is not.
- `src/app/api/settings/route.ts` — the flat legacy `embeddingProvider` branch (:398-404) writes `updated.embeddingProvider` directly; the clear must land here too, and BEFORE `workbenchSettingsStored(updated, …)` is computed at :473 so the gate judges the cleared state. `applyWorkbenchSettings(updated, validation.patch)` at :486 receives the already-flat-merged object, so a body carrying both halves clears once, not twice. Third argument stays `workbenchSettingsStored(existing, …)` (DW-219 baseline) — do not touch.
- `src/components/workbench/SettingsCanvas.tsx` — `set()` (:234-241), the embedding provider `<select>` `onChange` (:542-544), `secretRow(…)` (:422-482, hint + `Remove` gated on the `hasStoredKey` argument), the embeddings rows (:620-625: `textRow("embeddingBaseUrl", …)` and `secretRow("embeddingApiKey", …, stored.hasEmbeddingApiKey, …)`). The select must apply the pure draft rule; the `hasStoredKey` argument must become the switch-aware predicate.
- `src/lib/embeddings.ts` — `_createEmbeddingModel` (:405-425) spreads one `baseUrlOption` into `createOpenAI` and `createGoogleGenerativeAI`; `resolveEmbeddingProvider` (:170) and `embeddingApiKeyFor` (~:139). Read-only for logic: the store's clear-on-switch is what makes the shared read correct. Only the invariant comment changes.
- Read-only evidence / prior art: `_bmad-output/implementation-artifacts/spec-dw-66-72-settings-credential-fidelity.md` is a superseded `in-progress` plan for the SAME ledger entries via per-provider keying; the recorded decisions reject that shape. Nothing from it landed (the store is still flat) — do not resume it.
- Test homes: `src/lib/__tests__/config.test.ts`, `src/lib/__tests__/workbench-settings.test.ts`, `src/lib/__tests__/settings-route.test.ts`, `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` (the existing SettingsCanvas DOM harness — `payload()` helper, `render`/`fireEvent` from `@testing-library/react`).

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- export `embeddingProviderChanged(previous: string | null, next: string | null): boolean` (trim-normalised value comparison, both `null`-able) as the ONE definition of "switched"; export `settingsDraftAfterEmbeddingProvider(draft, next): SettingsDraft` which sets `embeddingProvider` and, only when the value moves, blanks `embeddingBaseUrl` to `""` and resets `embeddingApiKey` to `SECRET_UNTOUCHED`; export `draftEmbeddingKeyStored(draft, payload): boolean` = `payload.hasEmbeddingApiKey && !embeddingProviderChanged(payload.embeddingProvider, draftText(draft.embeddingProvider))`. -- one rule, four callers; a second copy is how the browser and the route drift apart.
- `src/lib/workbench-settings.ts` -- in `mergedVectorInputs`, compute the post-patch stored provider and, when it differs from `stored.embeddingProvider`, take `baseUrl` from the patch alone (`null` when the patch omits it) and drop `stored.hasEmbeddingApiKey` from `hasKey` (env-for-the-new-vendor and a key typed in this request still count). In `draftVectorInputs`, take `hasKey`'s stored leg from `draftEmbeddingKeyStored` instead of `payload.hasEmbeddingApiKey`; its `baseUrl` needs no change, because the draft box itself is blanked on the switch. -- the gate must judge what the store will hold after the switch, or it waves through a config it then refuses to honour.
- `src/lib/config.ts` -- in `applyWorkbenchSettings`, before any `setText`, decide the switch from `existing.embeddingProvider` versus the patch's resolved provider; when it moved, `delete updated.embeddingApiKey` and `delete updated.embeddingBaseUrl` first, then let the existing `setText` calls apply the patch's own values on top. -- clear the STORE, then apply the request, so a credential supplied in the same save wins.
- `src/app/api/settings/route.ts` -- in the flat `body.embeddingProvider` branch, apply the same clear to `updated` when the value moves versus `existing.embeddingProvider`, using the shared predicate. -- the flat route is the second writer of this field; leaving it out means the API path keeps reusing the old vendor's secret.
- `src/lib/embeddings.ts` -- add a short comment on `_createEmbeddingModel`'s `stored`/`baseUrlOption` read (and on `embeddingApiKeyFor`) recording that one flat field is safe BECAUSE the store clears both on a provider switch, naming DW-69/DW-72. -- no logic change; the next reader of these lines needs to know why the shared read is not the bug it looks like.
- `src/components/workbench/SettingsCanvas.tsx` -- route the embedding provider `<select>`'s `onChange` through `settingsDraftAfterEmbeddingProvider` (a `setDraft` that applies the rule, keeping the existing status/error reset), and pass `draftEmbeddingKeyStored(values, stored)` instead of `stored.hasEmbeddingApiKey` as `secretRow`'s `hasStoredKey`. -- the box must show what the save will store; `Remove` for a key the switch already drops is the misreport DW-69 names.
- `src/lib/__tests__/workbench-settings.test.ts` -- cover `embeddingProviderChanged` (moved / re-sent / cleared / whitespace), `settingsDraftAfterEmbeddingProvider`, `draftEmbeddingKeyStored`, and the switch-aware `mergedVectorInputs`/`draftVectorInputs` agreement (same situation, same answer). -- these are the rules; the suite is where they are pinned.
- `src/lib/__tests__/config.test.ts` -- cover `applyWorkbenchSettings` for every store-side row of the I/O matrix, including "patch value wins over the clear" and "same provider re-sent leaves both fields alone". -- the merge is where a wrong order silently keeps a vendor's secret.
- `src/lib/__tests__/settings-route.test.ts` -- cover the workbench-patch switch, the flat-body switch, and the gate refusal with `vectorSearchEnabled` stored ON, asserting the store is unchanged on the 400. -- both writers, over the wire.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` (or a sibling DOM test using the same harness) -- mount `SettingsCanvas` with an OpenAI key and endpoint stored, change the provider select to Google, and assert the endpoint box is empty, the key hint reads the key-absent sentence, and `Remove` is gone. -- the claim is about what an owner sees, which a node suite reading source cannot observe.

**Acceptance Criteria:**
- Given a stored embedding key and endpoint for one vendor, when any writer changes the stored `embeddingProvider` to a different value, then the saved config holds neither field and no later embed call can be handed the previous vendor's secret or endpoint.
- Given the vector switch is stored ON and the only credential is the previous vendor's, when a request switches the embedding provider without supplying a new key, then `PUT /api/settings` answers 400 with the existing vector refusal sentence and writes nothing.
- Given the Workbench settings surface, when the owner changes the embedding provider select, then the endpoint box and the key hint immediately describe the state the save will produce, and the browser's vector predicate agrees with the route's for that same draft.
- Given a stored embedding key and endpoint, when a save arrives that does not move the stored `embeddingProvider` value — including the every-save re-send of the same provider — then both fields are preserved byte-identically.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 5, low 3)
- defer: 2: (high 0, medium 1, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` Switching the provider away and back within one draft left `embeddingBaseUrl` blank, so `settingsSaveBody` sent `null` and the store DELETED an endpoint whose provider never net-moved — a direct violation of the fourth acceptance criterion, and asymmetric with the key half, which was already correct. `settingsDraftAfterEmbeddingProvider` now takes the payload and restores the seeded endpoint when the draft returns to the stored vendor; JSDoc corrected, unit and DOM cases rewritten, three sibling cases added.
  - `[medium]` `[patch]` The `switched ? null` term in `mergedVectorInputs`' `baseUrl` was unpinned — the whole suite passed with it reverted, because every test supplied `embeddingBaseUrl` in the patch. Added a case that switches vendor, supplies a key, names no endpoint, with the vector switch stored ON; mutation-checked.
  - `[medium]` `[patch]` The `embeddingApiKey: SECRET_UNTOUCHED` reset was unpinned — every test started from an already-untouched draft. Added pure cases from a removal-pending `null` and from a typed string, plus mounted Remove-then-switch and type-then-switch cases; mutation-checked.
  - `[medium]` `[patch]` The flat route's value-vs-presence guard had no negative case: replacing it with `if (true)` passed the full suite. Added the flat mirror of the every-save re-send; mutation-checked.
  - `[medium]` `[patch]` The new `embeddings.ts` invariant comments overstated the guarantee — `EMBEDDING_PROVIDER` and the generation-provider fallback move the effective vendor without moving the stored field, and a pre-existing or hand-edited config can already be mismatched. Both comments now claim only what the two save paths guarantee and name the gaps.
  - `[low]` `[patch]` No test pinned the response payload the surface re-seeds from. Assertions on the `PUT` response's `workbench.hasEmbeddingApiKey`/`embeddingBaseUrl` added in the suite that drives the real config store (the route suite mocks `saveConfig`, so it structurally cannot make the claim).
  - `[low]` `[patch]` Two DOM assertions wrapped an already-true value in `waitFor` and would have passed on the pre-clear frame. All post-event assertions are now synchronous, and the same-provider case first edits the box to a marker the rule would destroy.
  - `[low]` `[patch]` The route comment claiming a body carrying both halves "clears once, not twice" holds only when the halves name the same provider. Qualified.

## Design Notes

**One predicate, four callers.** "Did the embedding provider move?" is exported once from `workbench-settings.ts` and imported by `config.ts`, the route, and the component. `config.ts` already imports from `workbench-settings.ts`; never the reverse.

**Clear, then apply.** Order is the whole design. The clear drops what the STORE held; the patch then writes whatever this request explicitly carried. That is what lets one request both switch vendor and supply the new credential.

```ts
// applyWorkbenchSettings — decided BEFORE any mutation, from `existing`.
const switched = embeddingProviderChanged(
  existing.embeddingProvider ?? null,
  patch.embeddingProvider === undefined
    ? existing.embeddingProvider ?? null
    : patch.embeddingProvider,
);
if (switched) {
  delete updated.embeddingApiKey;   // …and its derived `has*` flag follows
  delete updated.embeddingBaseUrl;  // …the endpoint typed for the old vendor
}
// …then the existing setText calls run unchanged: a value in THIS patch wins.
```

**Why the browser has to blank the boxes.** `settingsSaveBody` sends `embeddingBaseUrl` on every save from the draft. Without the draft rule the surface would re-send the old vendor's endpoint straight back into the store after the clear, and the fix would hold on the API path while failing on the surface the owner actually uses.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/config.test.ts src/lib/__tests__/settings-route.test.ts src/lib/__tests__/embeddings.test.ts src/components/workbench/__tests__/` -- expected: all pass
- `npx vitest run` -- expected: no new failures versus the baseline revision
- `npx eslint` -- expected: clean
- `npx tsc --noEmit` -- expected: clean

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Clear-on-switch for the embedding vendor pair. One shared predicate, `embeddingProviderChanged`, defines "the stored `embeddingProvider` moved" as a trim-normalised VALUE comparison — never presence, because `settingsSaveBody` sends the field on every save. Both writers apply the clear before anything else: `applyWorkbenchSettings` decides it from `existing` and deletes `embeddingApiKey`/`embeddingBaseUrl` before its `setText` calls run, so a credential supplied in the same request wins; the route's flat legacy branch does the same on `updated` before `workbenchSettingsStored(updated, …)` is computed, so the vector gate judges the cleared state. Both halves of the vector rule became switch-aware, so the browser and the route still answer identically. On the surface, moving the provider select blanks the endpoint box and returns the key field to untouched — and restores the seeded endpoint if the draft returns to the stored vendor, so a save that does not net-move the provider preserves both fields. `hasEmbeddingApiKey` needed no work: both payload builders derive it from the store. No stored-shape change, no migration, no per-provider keying.

**Files changed.**
- `src/lib/workbench-settings.ts` — new exports `embeddingProviderChanged`, `settingsDraftAfterEmbeddingProvider`, `draftEmbeddingKeyStored`; `mergedVectorInputs` and `draftVectorInputs` stop counting the stored endpoint and key across a switch.
- `src/lib/config.ts` — `applyWorkbenchSettings` clears the pair on a switch, decided before any mutation.
- `src/app/api/settings/route.ts` — the same clear in the flat legacy `embeddingProvider` branch, ahead of the gate.
- `src/components/workbench/SettingsCanvas.tsx` — the provider select routes through the draft rule (new `apply` helper beside `set`); `secretRow`'s `hasStoredKey` is now `draftEmbeddingKeyStored`.
- `src/lib/embeddings.ts` — comments only: why one flat field is safe on the two save paths, and which paths fall outside that guarantee.
- `src/lib/__tests__/config.test.ts`, `src/lib/__tests__/settings-route.test.ts`, `src/lib/__tests__/workbench-settings.test.ts` — the store merge, both wire paths, the response payload, and the three new rules.
- `src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx` (new) — the mounted surface: endpoint box, key hint, `Remove` visibility, switch-and-back, auto-detect, read-only.

**Review findings.** 8 patches applied (5 medium, 3 low); 2 deferred (1 medium, 1 low); 8 rejected; 0 intent gaps, 0 spec repairs. See the Review Triage Log for each.

**Follow-up review recommendation:** `true`. Patched counts — high 0, medium 5, low 3; score `3 × 5 + 1 × 3 = 18`, at or above the threshold of 5.

**Verification.** `npx tsc --noEmit` clean. `npx eslint` exit 0 (only the three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, unchanged from the baseline). `npx vitest run` — 269 files, 5977 tests, all passing (baseline: 269 files, 5927 tests). The targeted run over `workbench-settings`, `config`, `settings-route`, `embeddings` and the workbench component suites passes. Every I/O matrix row is covered by a test that ran and passed, and each new test was mutation-checked: the corresponding production change was temporarily reverted and the intended test confirmed to fail. One unrelated DOM test, `workspace-purpose-settings.test.tsx > does not call a first wiki a change from a previous one`, failed once mid-run and once in isolation, then passed 5/5 in isolation and in a clean full re-run; it shares no import path with anything this change touches. Recorded as pre-existing flakiness, not caused here.

**Residual risks.**
- Behaviour change on the wire, by design: a `PUT` that switches the embedding provider while `vectorSearchEnabled` is stored ON now answers 400 unless the new vendor's endpoint and key ride along. That is the second acceptance criterion, but it is visible to any existing API client that switched vendors in a bare request. On the flat `/settings` page, which renders no embedding endpoint or key control, the owner's only route out is the Workbench settings surface.
- The I/O matrix's switch-and-back row says the boxes "stay blank". The implemented behaviour restores the endpoint box when the draft returns to the stored vendor, because leaving it blank deleted a stored endpoint whose provider never moved — which the fourth acceptance criterion forbids and which the key half never did. The matrix row's substantive claim (stored values survive) holds and is now true of both fields; its parenthetical about the box is superseded. `<intent-contract>` is read-only at review, so the row was left verbatim.
- Configs already holding a mismatched pair are not migrated (the spec forbids one) and stay mismatched until the owner next moves the provider.
- The two effective-vendor paths that bypass the stored-field trigger are documented in `embeddings.ts` and recorded in `deferred`, not fixed.
