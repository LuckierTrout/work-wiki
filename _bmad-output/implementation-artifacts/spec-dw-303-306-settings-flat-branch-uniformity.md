---
title: 'The flat /settings branch validates and refuses like the workbench branch (DW-303, DW-304, DW-305, DW-306)'
type: 'bugfix'
created: '2026-08-20'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      DW-304's URL rule is write-time only: a value stored before this change, or one
      supplied through OLLAMA_BASE_URL, still reaches the provider SDK unvalidated.
    evidence: |-
      `getOllamaBaseUrl()` (src/lib/config.ts) returns the stored string literally and
      prefers `process.env.OLLAMA_BASE_URL` over it; neither path calls
      `isAbsoluteHttpUrl`. So a deployment that stored `file:///etc/passwd` or
      `localhost:11434` before this change keeps handing it to the SDK, and an operator
      can still set the env var to anything. The new refusal closes the write door only.
      No backfill and no read-side guard were in this bundle's scope — the intent named
      the workbench branch's check, which is a write-time check.
    location: >-
      src/lib/config.ts:239
    severity: medium
  - summary: >-
      A flat save that the new scoping ALLOWS lands with no signal on /settings that the
      stored vector switch is on but inactive.
    evidence: |-
      Before this change the owner got a refusal they could not act on; now the save
      answers 200 and `vectorSearchEnabled` stays stored-on while
      `getVectorSearchSettings()` still intersects it to off. `vectorSearchInactiveCopy`
      exists for exactly this "switched on but cannot run" state, but it is rendered only
      by the Workbench's `SettingsCanvas`; `/settings` shows nothing about vector state at
      all. Closing it means either an advisory in the 200 response or wiring the existing
      copy into the flat surface — both were out of scope here (this bundle's intent
      forbids widening the response shape and adding embedding controls to /settings).
    location: >-
      src/hooks/useSettings.ts
    severity: medium
  - summary: >-
      All four flat text fields resolve a non-string to `""` before deciding the delete, so
      the belt-and-braces fallback points AT deletion rather than away from it.
    evidence: |-
      `model`, `ollamaBaseUrl`, `embeddingModel` and now `structuredKnowledgeModel` all read
      `typeof x === "string" ? x.trim() : ""` and then treat `trimmed.length === 0` as
      DELETE. Each comment says the ternary "must never be what turns a malformed body into
      a delete", but `""` is exactly the delete arm — the only thing preventing it is the
      non-string 400 above the merge. Unreachable today and identical across all four, so
      fixing one alone would break the uniformity DW-305 was about; the fix is to make all
      four fall back to leaving the field untouched.
    location: >-
      src/app/api/settings/route.ts:321-395
    severity: low
baseline_revision: 'dd08d03eb7c51b391bb416b252f22921d1ea7a78'
---

<intent-contract>

## Intent

**Problem:** DW-217 routed the legacy flat `PUT /api/settings` body through `validateWorkbenchSettingsPatch`, but the flat branch still does not validate or refuse like the workbench branch it now shares a rule with. Flat `ollamaBaseUrl` is stored on a bare `typeof` check where every workbench endpoint must pass `isAbsoluteHttpUrl`, so `"not-a-url"` or `file:///etc/passwd` reaches `getOllamaBaseUrl()` and the provider SDK (DW-304); flat `structuredKnowledgeModel` alone decides its delete on the literal `""` where `model`, `ollamaBaseUrl` and `embeddingModel` all decide on `trimmed.length === 0` (DW-305); and the shared vector refusal can now name endpoint, key and binding legs on a surface (`useSettings` / `/settings`) that renders no control for any of them, so an owner editing the embedding model on a deployment already missing an endpoint is refused in terms the page cannot act on (DW-303). The one case the DW-219 `baseline` argument exists for — a body carrying BOTH a flat legacy field and a `workbench` key — has no coverage in `settings-route.test.ts` (DW-306).

**Approach:** Apply the workbench branch's own URL rule and the flat branch's own trim convention to the two odd fields out, and scope the shared vector refusal — on the flat-only path only — to legs this request can actually act on, using the same `vectorSearchMissingLegs` the sentence is built from, inside `validateWorkbenchSettingsPatch` rather than at the route.

## Boundaries & Constraints

**Always:** Reuse the existing expressions — `isAbsoluteHttpUrl` and `SETTINGS_INVALID_URL_COPY` for the URL rule, `vectorSearchMissingLegs` / `vectorSearchMissingCopy` for the vector rule. The refusal sentence stays the one the Workbench shows, never re-typed at the route. Scoping applies ONLY when the body carries no `workbench` key — a body with one reaches every control, so it is gated on every leg exactly as today. A leg that this request turned from met to unmet is always the request's business, scoped or not, so a flat move that BREAKS a previously satisfiable config still refuses (DW-217 holds). Refuse before `saveConfig`. Whitespace-only still DELETES for `ollamaBaseUrl`, `embeddingModel`, `model` and `structuredKnowledgeModel`. Every new parameter is optional and defaults to today's behavior, so callers other than the route are unchanged.

**Block If:** The scoping rule would have to let through a body that moves a satisfiable stored vector config into an unsatisfiable one — that is DW-217's hole and must not reopen.

**Never:** Do not add embedding-provider, endpoint or API-key controls to `/settings` or `useSettings` — the Workbench owns those. Do not change the response SHAPE of the 400 (no structured leg list on the wire); the ledger offers that as the alternative to scoping, not as well as. Do not touch `applyWorkbenchSettings`'s conditionality on the `workbench` key.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Flat URL refused | Store any; body `{ollamaBaseUrl: "not-a-url"}` (also `"file:///etc/passwd"`, `"/api"`) | 400, `SETTINGS_INVALID_URL_COPY`; `saveConfig` not called | 400 |
| Flat URL accepted and trimmed | body `{ollamaBaseUrl: "  http://h:11434/api "}` | 200, stores `http://h:11434/api` | No error expected |
| Flat URL cleared | Store holds a URL; body `{ollamaBaseUrl: "   "}` / `""` / `null` | 200, key deleted — the URL rule does not apply to a clear | No error expected |
| structuredKnowledgeModel uniform delete | Store holds one; body `{structuredKnowledgeModel: null}` | 200, key deleted, decided on `trimmed.length === 0` like its siblings | Whitespace-only still 400 from the non-empty check above |
| Flat refusal scoped away (DW-303) | Store `{vectorSearchEnabled: true, embeddingProvider: "openai", embeddingModel: "text-embedding-3-small"}` — no endpoint, no key; body `{embeddingModel: "text-embedding-3-large"}` | 200, model saved: the only unmet legs (endpoint, key) were unmet BEFORE the request and no flat field can move them | No error expected |
| Flat refusal kept — actionable leg | Same store; body `{embeddingModel: null}` | 400, sentence names the model leg among the others | 400 |
| Flat refusal kept — request broke it | Store satisfied on `ollama`; body `{embeddingProvider: "openai"}` | 400: endpoint and key are newly unmet because of this request | 400 |
| Combined body still fully gated (DW-306) | Store satisfied on `openai`; body `{embeddingModel: "@cf/baai/bge-m3", workbench: {chatModel: "gpt-4o"}}` | 400, nothing saved — the flat move is measured against the PRE-request baseline, and no scoping applies | 400 |

</intent-contract>

## Code Map

- `src/app/api/settings/route.ts` -- `PUT`. Flat validation block :130-235 (`ollamaBaseUrl` type check at :219-227). Flat merge branches :268-355 (`structuredKnowledgeModel` :301-311; `ollamaBaseUrl` :313-330; `embeddingModel` :332-350 is the trim shape to copy). The single shared gate call at :397-408 (`hasWorkbenchKey`, `validateWorkbenchSettingsPatch(patch, workbenchSettingsStored(updated,…), workbenchSettingsStored(existing,…))`).
- `src/lib/workbench-settings.ts` -- `isAbsoluteHttpUrl` :907 and `SETTINGS_INVALID_URL_COPY` :888 (the workbench endpoint rule at :1005-1011). `VectorSearchLegField` :609, `VectorSearchLeg` :627, module-private `vectorSearchMissingLegs` :640, `vectorSearchMissingCopy` :702, `VECTOR_LEG_CONTROL` :776-783 (binding maps to the PROVIDER control — the reason `embeddingProvider` can move the binding leg). `validateWorkbenchSettingsPatch` :966 with the `baseline` param and the vector rule at :1078-1091. Client-safe: no server-only imports may be added.
- `src/hooks/useSettings.ts` -- the flat surface's whole vocabulary: `provider`, `model`, `ollamaBaseUrl`, `embeddingModel`, `structuredKnowledge*`. READ-ONLY evidence for DW-303: no embedding-provider, endpoint or key control exists; `ProviderForm.tsx:145-165` is the one base-URL input, so the URL refusal DOES name a control this surface shows.
- `src/lib/config.ts` -- `getOllamaBaseUrl()` :239 reads the stored value literally; the only consumer that makes DW-304 reachable.
- `src/lib/__tests__/settings-route.test.ts` -- mocked-route suite. Flat vector-gate describe :362-586, flat normalization describe :590-652. `request()` helper :67 sends the `If-Match` the route requires.
- `src/lib/__tests__/workbench-settings.test.ts` -- `validateWorkbenchSettingsPatch` unit describe :1221; real-store route describes around :3108-3245 already carry two combined flat+`workbench` cases (:3108 accept, :3132 refuse), so DW-306's gap is the MOCKED surface plus the new scoping interaction, not the parameter's first exercise.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- export `flatMovableVectorLegs(body: { embeddingProvider?: unknown; embeddingModel?: unknown }): ReadonlySet<VectorSearchLegField>` (present `embeddingProvider` → `provider` + `binding` per `VECTOR_LEG_CONTROL`; present `embeddingModel` → `model`), and add a 4th optional `actionableLegs?: ReadonlySet<VectorSearchLegField>` to `validateWorkbenchSettingsPatch` -- so the scoping decision lives beside the legs it reads and the sentence it suppresses, not at the route.
- `src/lib/workbench-settings.ts` -- in the vector rule, when `actionableLegs` is supplied and the patch is not `turningOn`, refuse only if the BASELINE was satisfiable (`canEnableVectorSearch(current)`) or some leg of `vectorSearchMissingLegs(merged)` is in `actionableLegs` -- a refusal must name something this request could act on, or report a working configuration this request broke. Do NOT decide "broke it" by diffing leg SETS: `vectorSearchMissingLegs` early-returns the provider leg ALONE when the provider is absent or invalid, so an already-broken baseline reports one leg and the merge reports the legs behind it, and every one of those reads as newly unmet.
- `src/app/api/settings/route.ts` -- pass `hasWorkbenchKey ? undefined : flatMovableVectorLegs(body)` as the 4th argument -- the workbench surface reaches every control, so only the flat-only path is scoped.
- `src/app/api/settings/route.ts` -- after the `ollamaBaseUrl` type check, refuse with `SETTINGS_INVALID_URL_COPY` when the trimmed value is non-empty and fails `isAbsoluteHttpUrl` -- DW-304; the empty/whitespace/`null` clear must stay a delete.
- `src/app/api/settings/route.ts` -- decide the `structuredKnowledgeModel` delete on `trimmed.length === 0` and store `trimmed`, matching its three siblings -- DW-305.
- `src/lib/__tests__/settings-route.test.ts` -- cover every I/O row: the URL refusals and the surviving clear, the uniform delete, the three DW-303 scoping rows, and the DW-306 combined flat+`workbench` body (refused, nothing saved) plus its allowed twin -- the combined case is the only one the `baseline` argument exists for.
- `src/lib/__tests__/workbench-settings.test.ts` -- unit-cover `flatMovableVectorLegs` and the scoped `validateWorkbenchSettingsPatch` call, including that an omitted 4th argument refuses exactly as before -- the default is what keeps every other caller unchanged.
- `src/lib/__tests__/workbench-settings.test.ts` -- PIN each half of the scoping predicate separately, so neither can be deleted while the suite stays green. (a) An unmet leg that IS in `actionableLegs` and was ALREADY unmet in the baseline must still refuse -- e.g. baseline `openai` with no model, no endpoint and no key, merged the same store plus a `@cf/` model, scoped by `flatMovableVectorLegs({ embeddingModel })`; only the `actionableLegs` half decides this one. (b) A baseline whose provider is UNSET, moved to `openai` by `flatMovableVectorLegs({ embeddingProvider })`, must be ALLOWED: the endpoint and key legs the provider leg was hiding are not this request's doing and no flat field can fill them. Add the route twin of (b) to `settings-route.test.ts` -- it is the shape a set-diff predicate gets wrong.
- `src/lib/__tests__/workbench-settings.test.ts` -- add the unit case for the `baseline` parameter itself, at the ledger's own location: a three-argument `validateWorkbenchSettingsPatch` where `stored` already carries the flat move and `baseline` does not, refusing where a two-argument call would compare the move to itself and pass -- DW-306 names the parameter, not only the route body that reaches it.
- `src/lib/workbench-settings.ts`, `src/app/api/settings/route.ts` -- keep the new comments TRUE of the code they sit on. `useSettings` sends `embeddingModel` only when the box is non-empty and never sends `embeddingProvider` at all, so do not claim either is a shape the flat page commonly sends -- say instead that presence-not-value is the API contract and that the provider half serves direct API callers. The workbench URL loop skips the literal `""` only, so the flat rule is the same PREDICATE, not byte-identical handling of whitespace -- say which.

**Acceptance Criteria:**
- Given a deployment whose stored vector config was ALREADY unsatisfiable only on legs the flat surface cannot show, when the owner saves an embedding-model edit from `/settings`, then the save lands with 200 rather than being refused in terms of an endpoint box that does not exist.
- Given a stored vector config that IS satisfiable, when a flat-only body moves any vector input into a state `canEnableVectorSearch` rejects, then the request is still refused with the Workbench's sentence and nothing is written.
- Given a body with a `workbench` key, when the merged config fails the vector gate on any leg, then the refusal is unchanged from today — scoping never applies to a body that reaches every control.
- Given `npx vitest run`, when the suite runs, then no existing test was deleted or weakened to accommodate the change.

## Spec Change Log

### 2026-08-20 — Scoping predicate replaced (review pass 1)

**Triggering finding:** the per-leg predicate this spec prescribed (`actionableLegs.has(leg.field) || !before.has(leg.field)`) reproduces the very defect DW-303 describes. `vectorSearchMissingLegs` early-returns the provider leg ALONE when the provider is absent or invalid, so a baseline with no `embeddingProvider` reports `[provider]` while the merge reports `[endpoint, key]` — a set diff reads both as newly unmet. Store `{vectorSearchEnabled: true, embeddingProvider: unset, embeddingModel: "text-embedding-3-small"}` with flat body `{embeddingProvider: "openai"}` answered 400 "Vector search needs an endpoint and an API key before it can be turned on." — the unactionable sentence, on a request that made an already-broken configuration no more broken. Verified against the reverted implementation.

**Amended:** the Design Notes predicate and its Tasks bullet now ask `canEnableVectorSearch(current)` — a question about the CONFIGURATION rather than about individual legs, which cannot be distorted by the provider early-return. Tasks also gained: separate pins for each half of the predicate (a set-diff-only predicate passed the whole suite, so the `actionableLegs` half was unpinned), the route twin of the provider-collapse case, the DW-306 unit case at the `baseline` parameter itself, and a requirement that the new comments stay true of `useSettings`'s actual body shapes and of the workbench URL loop's literal-`""` skip.

**Known-bad state avoided:** shipping a DW-303 "fix" that still emits the endpoint/key refusal on an unsatisfiable baseline, with a test suite that stays green when the actionable half of the predicate is deleted outright.

**KEEP — must survive re-derivation:**
- `flatMovableVectorLegs` derived from `VECTOR_LEG_CONTROL` (not a hand-listed leg set), reading key PRESENCE, so `embeddingProvider` claims `binding` because the binding leg's control is the provider select.
- The 4th parameter optional and defaulting to today's behavior, with a test proving an omitted argument and an EMPTY set are opposites.
- The `turningOn` exemption.
- DW-304 refusing only when `trimmed.length > 0`, reusing `isAbsoluteHttpUrl` and `SETTINGS_INVALID_URL_COPY`; `""`, whitespace and `null` still delete, with a test for each.
- DW-305 deciding on `trimmed` and storing `trimmed`, with a test pinning that `""` and whitespace still answer 400 above the merge (which is why the replaced `=== ""` arm was unreachable).
- The combined flat + `workbench` route pair (refused / allowed) and the "does NOT scope a body that carries a workbench key" case.
- Route comments that keep saying WHY the fourth argument is decided by the same `hasWorkbenchKey` fact as the patch and its application.

**Defer candidates observed this pass (record on the final pass, not now):** an `ollamaBaseUrl` stored before DW-304 — or supplied through `OLLAMA_BASE_URL` — is never re-validated by `getOllamaBaseUrl()`, so the new rule is write-time only; and a flat save that scoping now ALLOWS lands with no signal at all on `/settings`, which renders nothing about a stored-on-but-inactive vector switch even though `vectorSearchInactiveCopy` exists for that state.

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 1: (high 0, medium 1, low 0)
- patch: 0
- defer: 0
- reject: 11: (high 0, medium 2, low 9)
- addressed_findings:
  - `[medium]` `[bad_spec]` The prescribed per-leg scoping predicate still refuses with the unactionable endpoint/key sentence when the baseline provider is unset, because `vectorSearchMissingLegs` hides every other leg behind the provider leg — spec amended to ask `canEnableVectorSearch(current)` instead, plus new pins for each half of the predicate, the provider-collapse route case, and the DW-306 unit case; implementation reverted and re-derived.

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 3: (high 0, medium 2, low 1)
- reject: 10: (high 0, medium 2, low 8)
- addressed_findings:
  - `[medium]` `[patch]` `flatMovableVectorLegs`'s `binding` claim changed no outcome in any test — dropping it failed only a set-equality assertion. Added a discriminating case where `binding` is the only unmet leg and the claim is what produces the refusal.
  - `[low]` `[patch]` The scoping block had a second success exit duplicating the function's tail, so any validation appended after the vector rule would be silently skipped for scoped requests. Replaced with a `suppressed` flag falling through to the single exit.
  - `[low]` `[patch]` The route comment claimed `flatMovableVectorLegs` "narrows the sentence"; it narrows whether the gate refuses at all, and the sentence is `vectorSearchMissingCopy(merged)` either way. Reworded.
  - `[low]` `[patch]` The DW-304 accept test sent the URL the store already held, so a route ignoring the field entirely would have passed. Now sends a distinct URL.
  - `[low]` `[patch]` Added `"localhost:11434"` to the DW-304 refusal loop — the schemeless `host:port` form is the likeliest real misconfiguration and was untested.
  - `[low]` `[patch]` The flat-vs-workbench whitespace divergence the route comment asserts was pinned on the flat side only. Added the workbench half (`customBaseUrl: "   "` → 400).

## Design Notes

The scoping predicate has two halves, and each answers a different question:

```ts
// inside the vector rule, after `!canEnableVectorSearch(merged)`
if (actionableLegs && !turningOn) {
  const brokeIt = canEnableVectorSearch(current); // it WORKED before this request
  const speaks =
    brokeIt ||
    vectorSearchMissingLegs(merged).some((leg) => actionableLegs.has(leg.field));
  if (!speaks) return { ok: true, patch: patch as WorkbenchSettingsPatch };
}
```

`actionableLegs.has(...)` is what closes DW-303: a refusal must name at least one thing the requesting surface can move. `canEnableVectorSearch(current)` is what keeps DW-217 shut: switching `embeddingProvider` from `ollama` to `openai` makes the endpoint and key legs unmet even though no flat field can supply either, and that must still refuse rather than silently switch effective vector search off.

The "did this request break it" question is asked about the CONFIGURATION, not about individual legs, because the legs are not independent. `vectorSearchMissingLegs` returns `[provider]` and nothing else when the provider is absent or invalid — the remaining questions cannot be asked until a provider is chosen. So a baseline with no provider at all reports one leg, and choosing `openai` reports the endpoint and key legs that were hidden behind it. A set diff reads both as "newly unmet" and refuses — naming exactly the two controls DW-303 says the flat page does not have, on a request that made a broken configuration no more broken. Asking `canEnableVectorSearch(current)` cannot get that wrong: it was already unsatisfiable, so nothing here was broken by this request.

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: exit 0.
- `npx eslint` -- expected: no new findings versus the baseline.
- `npx vitest run` -- expected: all pass; every I/O row has a covering case that ran.

## Auto Run Result

Status: done

### Summary

The legacy flat branch of `PUT /api/settings` now validates and refuses the way the
`workbench` branch it shares a rule with does. Flat `ollamaBaseUrl` must pass the
workbench's own `isAbsoluteHttpUrl` and is refused with the workbench's own sentence
(DW-304); `structuredKnowledgeModel` decides its delete on the trimmed value like its
three siblings (DW-305); and the shared vector refusal, on the flat-only path, fires
only when the request broke a configuration that worked or names a leg the flat body
could have moved (DW-303). The combined flat + `workbench` body — the one shape the
DW-219 `baseline` argument exists for — is now covered at the route and at the
validator (DW-306).

### Files changed

- `src/lib/workbench-settings.ts` -- new exported `flatMovableVectorLegs`, derived from
  `VECTOR_LEG_CONTROL`, plus an optional 4th `actionableLegs` parameter on
  `validateWorkbenchSettingsPatch` that scopes the vector refusal. Omitted = today's
  behavior, so every caller but the flat-only route path is unchanged.
- `src/app/api/settings/route.ts` -- the flat URL rule (DW-304), the uniform
  `structuredKnowledgeModel` delete (DW-305), and the 4th argument passed only when the
  body carries no `workbench` key (DW-303).
- `src/lib/__tests__/settings-route.test.ts` -- three new describes: the DW-304 URL rule
  (refusals, the shared sentence, the trimmed accept, every blank form still clearing, and
  the deliberate whitespace divergence from the workbench loop), DW-305 normalization, and
  the DW-303/306 scoping table including the combined-body pair.
- `src/lib/__tests__/workbench-settings.test.ts` -- unit coverage for
  `flatMovableVectorLegs` (including the binding claim deciding a refusal on its own), each
  half of the scoping predicate pinned separately, the `turningOn` exemption, omitted-vs-
  empty fourth argument, and the DW-306 case at the `baseline` parameter itself.

### Review findings

- Pass 1: 1 bad_spec (medium) — the prescribed per-leg predicate reproduced DW-303's own
  defect when the baseline provider was unset. Spec amended, implementation re-derived.
  11 rejected.
- Pass 2: 6 patches applied (1 medium, 5 low), 3 deferred (2 medium, 1 low), 10 rejected.
  No intent gaps, no further spec repairs.
- Follow-up review recommended: **true** — patched this pass: high 0, medium 1, low 5;
  score `3 x 1 + 1 x 5 = 8`, which is at or above the threshold of 5.

### Verification performed

- `npx tsc --noEmit` -- exit 0, no output.
- `npx eslint` -- exit 0 (only the pre-existing `jsx-ast-utils` `TSNonNullExpression`
  notices, unchanged from the baseline).
- `npx vitest run` -- 256 files / 5504 tests, all pass. No test deleted or weakened; the
  only removed line across the two test files is an import statement that was widened.
- Matrix audit: every I/O row has at least one covering test that ran and passed. The
  combined-body row is covered both by the new mocked-route pair and by the pre-existing
  real-store case in `workbench-settings.test.ts`.
- Mutation checks (each reverted afterwards) confirmed the pins discriminate: dropping
  either half of the scoping predicate fails 3 tests; substituting the rejected set-diff
  predicate fails the two provider-collapse cases; passing `updated` instead of `existing`
  as the baseline fails 11; removing or widening the URL rule fails 2 each; dropping
  `binding` from the claimed leg set fails 3.

### Residual risks

- The three items recorded in frontmatter `deferred`: DW-304 is a write-time rule only,
  a scoped-allow lands with no signal on `/settings`, and all four flat text fields share
  a non-string fallback that resolves toward deletion.
- Behaviour change for operators: an `ollamaBaseUrl` that is not an absolute http(s) URL
  is now refused on the next save of that field. Existing bad stored values are not
  migrated — only rejected on rewrite.
