---
title: 'Settings names the model that actually embeds'
type: 'bugfix'
created: '2026-08-20'
status: 'done'
baseline_revision: '02407585c106feed551aa99988b0bc21698144e7'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The Workbench Settings canvas has its own embedding-model control and still
      cannot say which model is actually embedding.
    evidence: |-
      `src/components/workbench/SettingsCanvas.tsx:542-565` renders the embedding
      model row from `getWorkbenchSettings`, not `getEffectiveSettings`, so the two
      new fields never reach it. It names a provider/model mismatch only through the
      vector-gate refusal copy (`src/lib/workbench-settings.ts:640-659`) — i.e. as a
      reason the vector switch cannot be turned on, not as "this is not the model
      embedding". `src/app/api/settings/route.ts:70-77` calls these "Both Settings
      surfaces", so after this story they answer the DW-274 question differently.
      Pre-existing and left alone deliberately: DW-274 names `getEffectiveSettings`
      and `src/components/EmbeddingSettings.tsx`, and the canvas is fed by a
      different accessor whose payload shape is its own contract.
    location: >-
      src/components/workbench/SettingsCanvas.tsx:542
    severity: low
  - summary: >-
      `getEffectiveSettings` reads the config cache several times, so its "what is
      set" and "what is in effect" halves can in principle describe different
      snapshots.
    evidence: |-
      `src/lib/config.ts:1156` takes `cfg` from `loadConfigSync()`, and both
      `getEmbeddingModelName()` (:1274) and `hasEmbeddingSupport()` (:1288) re-enter
      it. `loadConfigSync` has a 5 s TTL and returns an EMPTY config when the cache
      is cold (:569-578), so a TTL boundary crossed between two of those reads would
      report a stored model as set while resolving the in-effect half against `{}` —
      a "Not in effect" note about a substitution that is not happening. The shape is
      pre-existing (`embeddingSupport` has re-entered the same way since before this
      story) and the window is between two adjacent synchronous statements with no
      await, so it is vanishingly narrow; the fix is a `cfg`-taking door on the
      resolver, which `src/lib/embeddings.ts` does not expose today.
    location: >-
      src/lib/config.ts:1156
    severity: low
---

<intent-contract>

## Intent

**Problem:** `getEffectiveSettings` (`src/lib/config.ts:1207-1232`) reports the embedding model as `env ?? stored` after trimming and never consults `embeddingModelMatchesProvider`, the predicate `resolveEmbeddingModelName` applies before honouring that same value. With `EMBEDDING_MODEL=text-embedding-3-small` on a Workers AI deployment, `/settings` renders `text-embedding-3-small` in the locked "from env" box (`src/components/EmbeddingSettings.tsx:38-42`) while `embedText` runs on `@cf/baai/bge-m3` — the one surface whose job is "what is in effect and where did it come from" answers wrongly (DW-274).

**Approach:** Keep `embeddingModel`/`embeddingModelSource` meaning exactly what they mean today — *what is set, and where it was set* — and widen `EffectiveSettings` with the missing half: `embeddingModelInEffect` (resolved through `getEmbeddingModelName()`, the same door the embed path uses) and an `embeddingModelOverridden` flag. `EmbeddingSettings` renders the flag beside the field, naming the model the deployment actually embeds with.

## Boundaries & Constraints

**Always:**
- The in-effect value comes from `getEmbeddingModelName()` — the resolver itself, not a second copy of `embeddingModelMatchesProvider` in `config.ts`. A rule stated twice is two rules that agree today.
- `embeddingModel` and `embeddingModelSource` keep their current values and meaning on every input, including the DW-227/DW-221 whitespace cases. They are what `useSettings.ts:165-166` seeds the editable draft from, so an in-effect value leaking into them would put a provider default into the owner's input and save it in on the next write.
- `embeddingModelOverridden` is true only when a model IS reported (`embeddingModel !== null`) AND something is in effect (`embeddingModelInEffect !== null`) AND they differ. Nothing in effect is the `embeddingSupport: false` story, not an override story.
- The new fields ride at the top level of the legacy object beside `embeddingModel`, so `GET /api/settings`'s `...settings` spread carries them with no route change.
- When `embeddingModelOverridden` is false, `EmbeddingSettings` renders exactly what it renders today.

**Block If:** nothing — the ledger entry names both the value and the flag.

**Never:**
- Do not change `embeddingSupport`, `hasEmbeddingSupport()`, `resolveEmbeddingModelName`, `embeddingModelMatchesProvider`, or any resolution behaviour. This story changes what is *reported*, never what embeds.
- Do not touch the Workbench Settings surface (`workbench-settings.ts`, `SettingsCanvas`) or its vector gate — the gate already speaks about mismatches, and DW-274 is about the flat `/settings` page.
- Do not mark the model box invalid or block the save: a mismatch owned by `EMBEDDING_MODEL` cannot be fixed from that box, and `DEPLOY.md:98-101` already settles that "describe, do not mark" rule.
- Do not add a new API field outside `EffectiveSettings`, and do not reshape the frozen legacy keys pinned by `src/lib/__tests__/workbench-settings.test.ts:2170-2183`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| The DW-274 case | `AI` binding bound, `EMBEDDING_MODEL=text-embedding-3-small` | `embeddingModel` `"text-embedding-3-small"`, source `env`, `embeddingModelInEffect` `"@cf/baai/bge-m3"`, `embeddingModelOverridden` true | No error expected |
| Mismatched STORED model | `embeddingProvider: "ollama"`, `embeddingModel: "@cf/baai/bge-m3"` stored | `embeddingModel` `"@cf/baai/bge-m3"`, source `config`, in-effect `"nomic-embed-text"`, overridden true | No error expected |
| Honoured override | `EMBEDDING_PROVIDER=openai`, `OPENAI_API_KEY` set, `EMBEDDING_MODEL=text-embedding-3-large` | In-effect equals the reported model, overridden false | No error expected |
| Nothing set, provider resolves | `OPENAI_API_KEY` set, no `EMBEDDING_MODEL`, nothing stored | `embeddingModel` null, source `none`, in-effect `"text-embedding-3-small"`, overridden false | No error expected |
| Model set, nothing embeds | `EMBEDDING_MODEL=text-embedding-3-small`, no key, no binding, no stored provider | Reported model and source unchanged (`env`), in-effect null, overridden **false**, `embeddingSupport` false | No error expected |
| Whitespace-only override | `EMBEDDING_MODEL="   "` under any provider | DW-227 answers unchanged: model null, source `none`, overridden false | No error expected |
| Component, overridden + env source | `modelSource: "env"`, overridden true, in-effect `@cf/baai/bge-m3` | The locked box still shows the env value; an override note names the in-effect model | No error expected |
| Component, overridden + config source | `modelSource: "config"`, overridden true | The editable input still holds the stored value and is described by the override note | No error expected |
| Component, not overridden | overridden false, any source | Today's markup, unchanged — no override note anywhere in the output | No error expected |

</intent-contract>

## Code Map

- `src/lib/config.ts` -- the fix. `EffectiveSettings` interface :84-103 (add the two fields beside `embeddingModel`/`embeddingModelSource`); `getEffectiveSettings` :1136, embedding-model branch :1207-1232, return literal :1236-1255. `hasEmbeddingSupport` is already imported at :2 from `./embeddings` — the config↔embeddings cycle is pre-existing and documented at :838, so adding `getEmbeddingModelName` to that same import introduces nothing new. `nonEmpty` and `getEmbeddingModelOverride` (:231) are the existing trim-and-null doors; leave both branches alone.
- `src/lib/embeddings.ts` -- READ ONLY. `resolveEmbeddingModelName` :249-289 is the rule (returns `fallback` and `warnOnceAbout`s on mismatch); `getEmbeddingModelName` :303-308 is the door to call; `hasEmbeddingSupport` :373-375 is literally `getEmbeddingModelName() !== null`. The resolver's warning is already throttled once per `(provider, override)` per process (DW-273), so a settings read cannot spam it.
- `src/lib/providers.ts:149-155` -- `embeddingModelMatchesProvider`, the ONE statement of the rule. Read it to understand the asymmetry; do not call it from `config.ts`.
- `src/components/EmbeddingSettings.tsx` -- props :7-15, locked env box :38-42, editable input :44-51, helper paragraph :53-57. Add `modelInEffect` + `overridden` props and the note; the `@cf/baai/bge-m3` helper special-case at :54-55 stays.
- `src/app/settings/page.tsx:147-154` -- the only call site; passes `settings?.embeddingModel` / `settings?.embeddingModelSource` and needs the two new pass-throughs.
- `src/hooks/useSettings.ts` -- `EffectiveSettings` is HAND-DUPLICATED here at :13-40 and must gain the same two fields. :165-166 seeds the draft only from a `config`-sourced model — that behaviour must not change.
- `src/app/api/settings/route.ts:59-102` -- `GET` spreads `...settings`; no edit needed, but the DW-63 comment at :91-97 explains why the fields belong in `EffectiveSettings` rather than in `workbench`.
- `src/lib/__tests__/settings-route.test.ts:103-122` -- whole-object `EffectiveSettings` fixture; TypeScript forces both new fields in.
- `src/hooks/__tests__/useSettings.test.tsx:32-53` -- `body()` fixture; keep it truthful.
- `src/lib/__tests__/config.test.ts:519+` -- `describe("getEffectiveSettings")`; `EMBEDDING_MODEL`/`EMBEDDING_PROVIDER` are already saved/cleared per test via `ENV_KEYS` :37-53. Nothing here mocks `@opennextjs/cloudflare`, so the Workers-AI leg cannot be reached from this file — use the non-`@cf/` direction of the predicate here.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- `@opennextjs/cloudflare` is mocked at :68-72 and a binding is faked with `mockGetCfContext.mockReturnValue({ env: { AI: { run: vi.fn() } } })` (see :542, :679). This is the only place the literal DW-274 scenario can be reproduced.
- `src/components/__tests__/` -- existing `@testing-library/react` DOM suites (e.g. `workspace-purpose-settings.test.tsx`) are the pattern for a new `EmbeddingSettings` render test. The component has no test today.
- `DEPLOY.md:236-247` -- the operator paragraph that ends "Confirm the current state from Settings … not from the log's silence". It is the doc that points at the surface this story fixes.

## Tasks & Acceptance

**Execution:**
- `src/lib/config.ts` -- add `embeddingModelInEffect: string | null` and `embeddingModelOverridden: boolean` to `EffectiveSettings`, resolve the in-effect value once through `getEmbeddingModelName()` in `getEffectiveSettings`, derive the flag by the three-part rule, and return both -- documenting why the reported/set pair is deliberately left alone (it seeds the editable draft) and why the resolver door is called rather than the predicate re-applied.
- `src/components/EmbeddingSettings.tsx` -- add `modelInEffect: string | null` and `overridden: boolean` props and render, when `overridden`, a note naming the in-effect model beneath the field, wired to the editable input with `aria-describedby` -- the flag is worth nothing if the surface does not say it.
- `src/app/settings/page.tsx` + `src/hooks/useSettings.ts` -- pass the two new fields through and add them to the hand-duplicated `EffectiveSettings` type, leaving the draft-seeding branch untouched -- the client type is the only reason the page can read them.
- `src/lib/__tests__/config.test.ts` -- extend `describe("getEffectiveSettings")` with the matrix rows reachable off Workers: mismatched stored model, honoured override, nothing-set, model-set-but-nothing-embeds, and the whitespace row asserted to be unchanged.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- add the literal DW-274 row: `AI` bound plus `EMBEDDING_MODEL=text-embedding-3-small`, asserting the reported model stays the env one while the in-effect model is `@cf/baai/bge-m3` and the flag is true.
- `src/components/__tests__/embedding-settings-override.test.tsx` -- new DOM suite covering the three component rows: overridden under `env`, overridden under `config`, and the not-overridden case asserting no note is rendered.
- `src/lib/__tests__/settings-route.test.ts` + `src/hooks/__tests__/useSettings.test.tsx` -- extend the `EffectiveSettings` fixtures with the two new fields -- the route fixture is type-forced, and a stale hook fixture would misdescribe the body the route now serves.
- `DEPLOY.md` -- update the "confirm the current state from Settings" guidance so it says what `/settings` now shows -- the doc sends operators to this surface precisely when a substitution is suspected.

**Acceptance Criteria:**
- Given a deployment whose embedding model is being substituted, when the owner opens `/settings`, then the page names both the model that is set and the model that is actually embedding, and the two are visibly distinguished.
- Given `GET /api/settings`, when it is served, then the two new fields appear at the top level beside `embeddingModel` and every previously-pinned legacy key is still present in its exact shape.
- Given any input at all, when `getEffectiveSettings()` runs, then `embeddingModel`, `embeddingModelSource` and `embeddingSupport` hold exactly the values they held before this change.
- Given `vitest run` and `eslint`, when run over the repo, then both pass with no new failures, and `tsc --noEmit` is clean.

## Spec Change Log

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 2: (high 0, medium 0, low 2)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[medium]` `[patch]` Nothing mounted `SettingsPage`, so the one production wiring of the new fields was unverified — mutating `modelInEffect` to `settings?.embeddingModel` left all 5389 tests green while `/settings` rendered the original wrong answer wearing the new note. Added `src/app/settings/__tests__/settings-page-embedding-wiring.test.tsx`, mounting the real page + hook + component against a stubbed `fetch`, and confirmed it fails under that mutation.
  - `[medium]` `[patch]` `DEPLOY.md`'s new "No note means no substitution: the model in the box is the model running" was false in two states this story's own tests pin (nothing embedding at all; nothing set at all). Rewrote it to enumerate all three no-note states and to name which surface it is about, since the Workbench canvas deliberately does the opposite with a forced value.
  - `[low]` `[patch]` The note rendered on `overridden` alone, so `overridden: true` with `modelInEffect: null` produced "embeds with  —". One `showOverrideNote` condition now gates both the note and the `aria-describedby` that points at it, with a component row covering the pair.
  - `[low]` `[patch]` `aria-describedby` on the `modelSource === "env"` branch sat on a non-focusable roleless `<div>`, where assistive tech does not expose it — decoration on the exact branch DW-274 is about. Dropped it there, kept it on the `<input>`, and pinned the reading-order claim that carries the note instead.
  - `[low]` `[patch]` `config.test.ts` covered an env-set and a stored-set model separately but never both at once. Added a row where `EMBEDDING_MODEL` overrides a different stored value, so both halves of the answer are pinned to the same env-over-config winner.

## Design Notes

The two fields answer two different questions and neither can be dropped:

```ts
const embeddingModelInEffect = getEmbeddingModelName();
const embeddingModelOverridden =
  embeddingModel !== null &&
  embeddingModelInEffect !== null &&
  embeddingModelInEffect !== embeddingModel;
```

Replacing `embeddingModel` with the resolved name — the ledger's first option — was rejected: `useSettings.ts:165-166` seeds the editable input from that field, so a provider default would appear in the owner's box and be written into the store by the next save, and `embeddingModelSource` would then say `env` about a value the env never named.

## Verification

**Commands:**
- `vitest run src/lib/__tests__/config.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/settings-route.test.ts src/components/__tests__/embedding-settings-override.test.tsx src/hooks/__tests__/useSettings.test.tsx` -- expected: all pass, including every new matrix row.
- `vitest run` -- expected: no new failures anywhere (notably `workbench-settings.test.ts`, which pins the frozen legacy key list).
- `tsc --noEmit` -- expected: exit 0, proving every `EffectiveSettings` literal was updated.
- `eslint` -- expected: clean apart from the pre-existing `jsx-ast-utils` "TSNonNullExpression could not be resolved" noise.

**Note:** `pnpm <script>` fails repo-wide with `ERROR packages field missing or empty` (pre-existing workspace-config issue). Invoke the binaries from `node_modules/.bin` instead.

## Auto Run Result

Status: done

**Implemented change.** `getEffectiveSettings` now answers both halves of its own question (DW-274). `embeddingModel` / `embeddingModelSource` keep meaning *what is set and where it was set*, and two new `EffectiveSettings` fields say what is actually running: `embeddingModelInEffect`, resolved through `getEmbeddingModelName()` — the resolver's own door, so the rule is not restated in `config.ts` — and `embeddingModelOverridden`, true only when a model is reported, something is in effect, and they differ. `EmbeddingSettings` renders the flag as a note naming the in-effect model beneath the field. On the literal DW-274 deployment (`EMBEDDING_MODEL=text-embedding-3-small` with the Workers AI binding bound) `/settings` still shows the env value in its locked box — that IS what the variable says — and now adds "Not in effect. This deployment embeds with `@cf/baai/bge-m3`". The ledger's other option, replacing the reported model with the resolved one, was rejected on a checkable ground: `useSettings` seeds the editable input from `embeddingModel`, so a provider default landing there would be written into the store by the next save. No resolution behaviour changed.

**Files changed.**
- `../../src/lib/config.ts` -- two new `EffectiveSettings` fields, resolved once per call in `getEffectiveSettings`, with the rationale for the second-field design recorded at the assignment.
- `../../src/components/EmbeddingSettings.tsx` -- `modelInEffect` / `overridden` props and the override note, gated by one `showOverrideNote` condition shared with its `aria-describedby`; described, never marked invalid.
- `../../src/app/settings/page.tsx`, `../../src/hooks/useSettings.ts` -- the pass-through and the hand-duplicated client type; the draft-seeding branch is untouched.
- `../../src/lib/__tests__/config.test.ts` -- six new `getEffectiveSettings` rows: substituted stored model, honoured override, nothing-set, model-set-but-nothing-embeds, env-over-config precedence, and DW-227's whitespace answers asserted unchanged.
- `../../src/lib/__tests__/settings-runtime-wiring.test.ts` -- the literal DW-274 deployment, the only file that can reach the Workers AI leg of the predicate, asserting the embed path, the reported/in-effect split, and both fields at the top level of the real `GET /api/settings` body.
- `../../src/components/__tests__/embedding-settings-override.test.tsx` -- new mounted suite for the component's render contract.
- `../../src/app/settings/__tests__/settings-page-embedding-wiring.test.tsx` -- new mounted suite for the page → hook → component seam, added at review.
- `../../src/lib/__tests__/settings-route.test.ts`, `../../src/hooks/__tests__/useSettings.test.tsx`, `../../src/lib/__tests__/cli.test.ts` -- the three `EffectiveSettings` fixtures.
- `../../../DEPLOY.md` -- the troubleshooting paragraph now leads with what `/settings` shows, enumerates the three states in which the note is absent, and warns that the Workbench canvas deliberately behaves the other way.

**Review findings breakdown.** 5 patches applied (2 medium, 3 low), 2 deferred (both low: the Workbench canvas still cannot name the in-effect model; `getEffectiveSettings` re-reads the config cache, so its two halves could in principle span a TTL boundary), 12 rejected — including surfacing the in-effect model when nothing is set (a broader reading than the intent's two named options, and no wrong answer to correct there), collapsing `embeddingSupport` into `embeddingModelInEffect !== null` (a deliberate second call rather than a second statement of the rule), teaching the CLI's `status` output about substitution, widening `ProviderForm`'s local subset type, exporting the note id for the test, `it.each`/jest-dom test-style preferences, and hiding the note while the input holds unsaved edits (the substitution is still happening until the save lands).

**Follow-up review recommendation:** true. Patched findings this pass: high 0, medium 2, low 3. Score = 3x2 + 1x3 = 9, which is >= 5.

**Verification performed.**
- `vitest run` (full suite) -- 254 files / 5393 tests passed, before the patches (253/5389) and after.
- `tsc --noEmit` -- exit 0, which is what forced the third fixture (`cli.test.ts`) the Code Map had missed.
- `eslint .` -- exit 0 (the `jsx-ast-utils` "TSNonNullExpression could not be resolved" lines are pre-existing stderr noise on unrelated JSX).
- Mutation check on the review's strongest finding: with `modelInEffect={settings?.embeddingModel ?? null}` the new page test fails naming `text-embedding-3-small` where `@cf/baai/bge-m3` was expected — the original wrong answer wearing the new note. Line restored and byte-compared against the pre-mutation copy.
- `pnpm test` / `pnpm lint` as literally written could not run: `pnpm <script>` fails repo-wide with `ERROR packages field missing or empty`, a pre-existing workspace-config issue. The `node_modules/.bin` equivalents were used.

**Residual risks.**
- The page test mocks the four sibling panels below the form (`WorkspacePurposeSettings`, `NamesTermsSettings`, `EmailIngestSettings`, `VaultExportButton`) so their own on-mount fetches stay off the stub. The page → hook → `EmbeddingSettings` path is entirely real, and the mutation check confirms the isolation did not hollow out the assertion.
- The note's sentence commits to one mechanism ("the embedding provider cannot serve the model above"), while the flag is a plain inequality between set and in-effect. Today the predicate is the only way those two can differ, so the sentence is accurate; a future second cause of divergence would make it confidently wrong rather than merely incomplete.
- `embeddingModelInEffect` is now on the wire in every state but rendered only when it contradicts what is set. A deployment with nothing set still reads "Leave empty to use the embedding provider default" without naming that default — true, but not the whole answer the field could now give.
