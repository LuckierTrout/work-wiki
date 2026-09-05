---
title: 'Settings surfaces stop asserting facts they cannot know (DW-715, DW-750)'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized, multiple-goals]
deferred:
  - summary: >-
      SkillsCanvas tells an owner on a deployed origin to start a sidecar that
      may be running and merely refusing that origin — the same flat claim
      DW-750 removed from the rail dot and the API/MCP health line.
    evidence: |-
      On a rejected loopback scan `SkillsCanvas` renders
      `SKILLS_SCAN_FAILED_COPY` ("Skills are scanned by the local sidecar, and
      it did not answer. Start it with `pnpm sidecar`…"). The scan goes through
      the same origin-blind `loopbackFetch`, so a bare 403 with no
      `Access-Control-Allow-Origin` reaches it as the same opaque rejection a
      dead port does. The component holds no `pageOrigin` and the constant has
      no origin-sensitive twin. Pre-existing and untouched by this change; the
      "did not answer" contract is a different one from the health/status
      contract the two surfaces above share, so it was left out of scope rather
      than half-adopted. `usePageOrigin` and `isSidecarDefaultAdmittedOrigin`
      are now both in place as the pieces a fix would reuse.
    location: >-
      src/components/workbench/SkillsCanvas.tsx:97
    severity: low
baseline_revision: '179fac44a77c9a6b5deecf2941ffb5200df2bf72'
---

<intent-contract>

## Intent

**Problem:** Two Settings surfaces state infrastructure facts nothing resolved. The embedding hint (`src/components/EmbeddingSettings.tsx:379-381`) claims "a 1,024-dimensional Vectorize index" from the resolved Workers AI provider alone, but `YOPEDIA_VECTORIZE` is an independent, optional binding (`src/lib/storage/r2.ts:116` holds it as `VectorizeIndex | undefined` and every vector call guards on it) and no settings payload carries that fact. Separately, `SETTINGS_API_HEALTH_UNREACHABLE_COPY` ("The sidecar is not running on 127.0.0.1:19828.") and `IconRail.tsx:83` ("Sidecar not running") are decided by the same origin-blind browser fetch that DW-607 already conceded cannot report WHY it failed — so on a deployed unconfigured origin both flatly assert a sidecar is dead while Chat, on the same screen, correctly says it may be running and refusing.

**Approach:** Resolve the missing facts where they can be resolved, and let each sentence claim only what was resolved. Server-side: add a `hasVectorizeBinding` read beside the existing `getWorkersAiBinding()` read in `GET /api/settings`, serve it, and split the embedding hint so the index clause is claimed only when the binding is present. Browser-side: reuse `isSidecarDefaultAdmittedOrigin` (`src/lib/sidecar.ts:124`) exactly as `chatSidecarDownCopy` (`src/lib/workbench-modes.ts:144-149`) already does, selecting an origin-honest sentence for the rail dot and for the API/MCP pane's `unreachable` arm.

## Boundaries & Constraints

**Always:**
- The Vectorize fact is SERVER-RESOLVED and travels as data. The browser must never derive it.
- Absent/unknown facts make NO claim, never a guessed one — the DW-616 precedent. An unpassed `hasVectorizeBinding` drops the index clause while leaving the Workers AI provider clause intact (the provider half is independently resolved); an absent `pageOrigin` degrades to today's sentence, which keeps the server render and the first client render identical.
- `window.location.origin` is read AFTER mount, never during render (hydration).
- Only the `unreachable` arm of `loopbackHealthSentence` becomes origin-sensitive. `error` is a health payload that ARRIVED, so CORS admitted the page and the origin says nothing about it; it keeps `SETTINGS_API_HEALTH_UNREACHABLE_COPY` and stays a shared fact with a genuinely dead listener.
- Copy has ONE definition. No component inlines a sentence a module owns.
- `YOPEDIA_VECTORIZE` is a frozen runtime identifier — read it, never rename it.

**Block If:**
- The Vectorize binding cannot be read from `GET /api/settings` without a new server-only dependency inside `config.ts` or `workbench-settings.ts` (both must stay client-safe).

**Never:**
- Do not widen `EffectiveSettings` in `src/lib/config.ts` or change `getEffectiveSettings()` — it is sync, cache-backed and callable off a Workers request scope, so it cannot answer a binding question.
- Do not change `probeLoopbackApiPane`, `classifyLoopbackHealth`, `LOOPBACK_STATUSES`, or the `starting` / `running` / `port_conflict` sentences.
- Do not change `CHAT_SIDECAR_DOWN_COPY`, `CHAT_SIDECAR_UNREACHABLE_COPY` or `chatSidecarDownCopy`.
- Do not add a server-side sidecar probe; the Worker cannot reach loopback.
- Do not touch the `PUT /api/settings` response shape, `.github/`, `.yoyo/yoyo.toml`, or `llm-wiki.md`.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Index claimed | env-pinned `@cf/baai/bge-m3`, `providerInEffect: "workers-ai"`, `hasVectorizeBinding: true` | Hint ends "…This deployment uses Cloudflare Workers AI with a 1,024-dimensional Vectorize index." — byte-identical to today | No error expected |
| Binding absent | same, `hasVectorizeBinding: false` | Hint ends "…This deployment uses Cloudflare Workers AI. No Vectorize index is bound." — no dimension claim | No error expected |
| Binding unknown | same, prop omitted | Hint ends "…This deployment uses Cloudflare Workers AI." — provider clause only | No error expected |
| Non-Workers provider | `providerInEffect: "openai"` | No Workers AI sentence at all, whatever `hasVectorizeBinding` says (DW-616 unchanged) | No error expected |
| Route serves the fact | `GET /api/settings` on Workers with `YOPEDIA_VECTORIZE` bound | body `hasVectorizeBinding: true` | Binding read never throws; off-Workers answers `false` |
| Rail, loopback page | `sidecar: "down"`, `pageOrigin: "http://localhost:3000"` | Dot label "Sidecar not running" — unchanged | No error expected |
| Rail, deployed page | `sidecar: "down"`, `pageOrigin: "https://app.example"` | Dot label "Sidecar not reachable" | No error expected |
| Rail, origin unknown | `sidecar: "down"`, `pageOrigin` absent/`null`/`""`/`"null"` | Dot label "Sidecar not running" (conservative degrade) | Never throws |
| Pane, deployed page | probe rejects (`unreachable`), origin `https://app.example` | `SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY` | No error expected |
| Pane, dead listener | health payload `{status:"error"}`, any origin | `SETTINGS_API_HEALTH_UNREACHABLE_COPY` — origin ignored | No error expected |

</intent-contract>

## Code Map

DW-715 (Vectorize claim):
- `src/lib/storage/index.ts:66-80` -- private `getOpenNextCloudflareEnv()` already reads the OpenNext env and is what `R2StorageProvider` is constructed from. ADD an exported `hasVectorizeBinding(): boolean` here reusing it; this module already owns the Vectorize binding's only consumer.
- `src/lib/storage/r2.ts:116` -- `this.vectorize = env.YOPEDIA_VECTORIZE` — the binding read the new helper must agree with. `src/lib/storage/cloudflare-types.ts:181` declares it optional.
- `src/app/api/settings/route.ts:125` -- `const hasWorkersAiBinding = getWorkersAiBinding() !== null;` inside `GET`. Add the Vectorize read beside it and put the flat field on the `Response.json({ ...settings, version, workbench })` at :133-141. `PUT` (:224, :703) is NOT in scope — the hint only renders on the env-locked branch.
- `src/hooks/useSettings.ts:25-99` -- hand-duplicated view of the route body; add the optional boolean field with its docblock. `settings-route.test.ts` mocks `getEffectiveSettings`, so a flat route-level field breaks no fixture.
- `src/app/settings/page.tsx:275-289` -- where `providerInEffect` is already threaded into `EmbeddingSettings`; the new prop goes beside it.
- `src/components/EmbeddingSettings.tsx:37-59` (`providerInEffect` docblock, the model to follow) and `:376-381` (the composed sentence) -- the split lands here.
- Pins to update: `src/components/__tests__/embedding-settings-override.test.tsx:318` (`WORKERS_AI_COPY`), `:395-430`; `src/app/settings/__tests__/settings-page-embedding-wiring.test.tsx:160-171` (`pinned()` fixture), `:203-220`.
- Read-only evidence: `src/lib/config.ts:2082-2090` documents WHY `providerInEffect` is served — the same argument extends to the index half; leave `config.ts` unchanged.

DW-750 (sidecar sentences):
- `src/lib/sidecar.ts:124-128` -- `isSidecarDefaultAdmittedOrigin`, already exported, never throws, `false` for non-strings.
- `src/lib/workbench-modes.ts:11` already imports it; `:130-150` `chatSidecarDownCopy` is the selector shape to copy. ADD the two rail labels + their selector here (client-safe, pure, node-testable).
- `src/components/workbench/IconRail.tsx:74-83` -- the inline three-way ternary; the `down` arm becomes a selector call. New `pageOrigin?: string | null` prop on `IconRailProps` (`:22-45`).
- `src/components/workbench/Workbench.tsx:1888-1901` -- the one `<IconRail>` mount; passes the new prop.
- `src/components/workbench/ModeCanvas.tsx:165-180` -- the existing `useState`/`useEffect` origin read, with the full hydration rationale. EXTRACT it to a hook and reuse.
- `src/lib/workbench-loopback-health.ts:26,58-72` -- `SETTINGS_API_HEALTH_UNREACHABLE_COPY` and the exhaustive `loopbackHealthSentence` switch whose `unreachable` arm becomes origin-sensitive. No import cycle: `sidecar.ts` imports nothing.
- `src/components/workbench/SettingsApiMcpPane.tsx:141-157` (mount probe effect) and `:188` (`loopbackHealthSentence(apiLive.health)`) -- the pane's caller.
- Pins to update: `src/components/workbench/__tests__/icon-rail.test.tsx:159-183`; `src/lib/__tests__/workbench-chrome.test.ts:110-121` (source-text pin on the literal `"Sidecar not running"` inside `IconRail.tsx`).
- Test technique to reuse: `src/components/workbench/__tests__/sidecar-down-copy.test.tsx:1-3` sets a deployed origin with `@vitest-environment-options { "url": "https://app.example/" }` — jsdom's `window.location` is not assignable.

## Tasks & Acceptance

**Execution:**
1. `src/lib/storage/index.ts` -- export `hasVectorizeBinding(): boolean` built on `getOpenNextCloudflareEnv()`; document that it answers the same binding `R2StorageProvider` holds and that off-Workers/unbound both answer `false` -- so one module owns the read.
2. `src/app/api/settings/route.ts` -- read it in `GET` beside `hasWorkersAiBinding` and serve it flat on the response; comment why it is a SECOND independent fact rather than implied by the provider.
3. `src/hooks/useSettings.ts` -- add `hasVectorizeBinding?: boolean` to the hand-duplicated `EffectiveSettings` view, documenting why it is served rather than derived.
4. `src/components/EmbeddingSettings.tsx` -- add `hasVectorizeBinding?: boolean | null` (default `null`) and split the composed sentence into the three-state form; keep the DW-616 provider+model gate exactly as it is.
5. `src/app/settings/page.tsx` -- thread `hasVectorizeBinding={settings?.hasVectorizeBinding ?? null}`.
6. `src/hooks/usePageOrigin.ts` (new) -- `usePageOrigin(): string | null`, carrying the read-after-mount hydration rationale currently in `ModeCanvas`.
7. `src/components/workbench/ModeCanvas.tsx` -- replace the local state/effect pair with `usePageOrigin()`; behaviour unchanged.
8. `src/lib/workbench-modes.ts` -- add `RAIL_SIDECAR_DOWN_LABEL`, `RAIL_SIDECAR_REFUSED_LABEL` and `railSidecarDownLabel(pageOrigin)` beside `chatSidecarDownCopy`, degrading to the DOWN label.
9. `src/components/workbench/IconRail.tsx` -- accept `pageOrigin`, call the selector for the `down` arm.
10. `src/components/workbench/Workbench.tsx` -- pass `pageOrigin={usePageOrigin()}` to `<IconRail>`.
11. `src/lib/workbench-loopback-health.ts` -- add `SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY`; give `loopbackHealthSentence` an optional `pageOrigin` second argument that only the `unreachable` arm reads.
12. `src/components/workbench/SettingsApiMcpPane.tsx` -- capture the page origin with `usePageOrigin()` and pass it to `loopbackHealthSentence`.
13. Tests -- update the four pinned suites above and add matrix coverage: three-state hint cases in `embedding-settings-override.test.tsx`; a `hasVectorizeBinding: false` wiring case in `settings-page-embedding-wiring.test.tsx`; a route case asserting the served field; pure selector rows for `railSidecarDownLabel` and `loopbackHealthSentence` in `src/lib/__tests__/workbench-modes.test.ts` / a loopback-health suite; and a deployed-origin mount test for the rail and the pane using the `@vitest-environment-options` technique.

**Acceptance Criteria:**
- Given a deployment resolving `workers-ai` with `EMBEDDING_MODEL=@cf/baai/bge-m3` pinned and NO Vectorize binding, when `/settings` renders, then the hint states the Workers AI provider and that no Vectorize index is bound, and contains no "1,024-dimensional" claim.
- Given the same deployment WITH the binding bound, when `/settings` renders, then the hint is byte-identical to today's composed sentence.
- Given `GET /api/settings` served by an owner, when the response is read, then it carries a boolean `hasVectorizeBinding` resolved server-side, independent of `hasWorkersAiBinding`.
- Given the Workbench mounted on `https://app.example` with the sidecar probe answering `down`, when the rail dot is read, then its accessible name and title say the sidecar is not reachable and never that it is not running.
- Given the same page with the API/MCP pane's probe rejected, when the health line renders, then it names both causes and the `WORKWIKI_SIDECAR_ALLOWED_ORIGINS` knob rather than asserting the sidecar is not running.
- Given a loopback origin (`http://localhost:3000`) in either surface, when the same states are reached, then every sentence is byte-identical to today.
- Given a health payload of `{"status":"error"}` on any origin, when the pane renders, then `SETTINGS_API_HEALTH_UNREACHABLE_COPY` is still what it says.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 1, low 8)
- defer: 1: (high 0, medium 0, low 1)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[medium]` `[patch]` `hasVectorizeBinding()` — the one new statement of fact in the change — was exercised by no test: `settings-route.test.ts` replaces it with a `vi.fn`, and the component/page suites hand the value in. Added real-function and end-to-end coverage in `settings-runtime-wiring.test.ts`, the file that drives the real route against a mocked Cloudflare context; mutation-checked (inverting the null test fails 4 tests).
  - `[low]` `[patch]` Broken doc link `{@link WORKERS_AI_INDEX_COPY}` in `EmbeddingSettings.tsx`; corrected to `EMBEDDING_WORKERS_AI_INDEX_COPY`.
  - `[low]` `[patch]` The three exported hint constants were imported by nothing while both suites retyped the literals. Both suites now import them and assert each export equals its literal pin, so an inlined fourth spelling fails.
  - `[low]` `[patch]` `hasVectorizeBinding()`'s docblock named two routes to `false` but `getOpenNextCloudflareEnv()` also gates on `YOPEDIA_BUCKET`/`YOPEDIA_CONFIG`; enumerated all three and softened the "cannot disagree with `R2StorageProvider`" claim to what actually holds (every production caller goes through the OpenNext context).
  - `[low]` `[patch]` The rail↔Chat correspondence test covered 2 of the 3 surfaces that now spell the origin rule; extended it to `loopbackHealthSentence` so the Settings health sentence cannot drift away from both.
  - `[low]` `[patch]` `usePageOrigin` had no test of its own and the hydration claim repeated in four docblocks was asserted nowhere; added `src/hooks/__tests__/use-page-origin.test.tsx` pinning `null` on the first render and the origin after mount; mutation-checked.
  - `[low]` `[patch]` The rail label's docblock justified its brevity by saying Chat's sentence is on the same screen; Chat's copy renders only in Chat mode while the dot is persistent chrome. Corrected to the real remedy location.
  - `[low]` `[patch]` `config.ts` prose still cited the hint as one unconditional sentence; corrected (comment-only — `EffectiveSettings` and `getEffectiveSettings()` untouched, per the spec's Never clause).
  - `[low]` `[patch]` `sidecar-origin-surfaces.test.tsx` lacked the deployed-origin premise assertion its sibling carries; added, so a lost `@vitest-environment-options` docblock fails legibly.

## Design Notes

Three-state honesty on both halves, following DW-616: a claim about infrastructure is rendered only when something resolved it. For the hint that means `true` → index clause, `false` → "No Vectorize index is bound.", `null`/absent → provider clause alone. For the origin selectors it means the degrade target is today's sentence, because an absent origin is the server render and the first client render, where the conservative answer is also the one that keeps hydration stable.

The rail label and the pane sentence are selected in modules, not inlined, so the surfaces cannot drift from Chat's answer to the same question. Sketch:

```ts
// workbench-modes.ts, beside chatSidecarDownCopy
export function railSidecarDownLabel(pageOrigin: string | null | undefined): string {
  return isSidecarDefaultAdmittedOrigin(pageOrigin)
    ? RAIL_SIDECAR_DOWN_LABEL
    : RAIL_SIDECAR_REFUSED_LABEL;
}
```

`error` deliberately stays origin-blind: its payload arrived, so the door admitted the page, and applying the origin rule there would describe an answered probe as an ambiguous refusal.

## Verification

**Commands:**
- `pnpm vitest run src/components/__tests__/embedding-settings-override.test.tsx src/app/settings/__tests__/settings-page-embedding-wiring.test.tsx src/lib/__tests__/settings-route.test.ts` -- expected: all pass
- `pnpm vitest run src/components/workbench/__tests__/icon-rail.test.tsx src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx src/components/workbench/__tests__/sidecar-down-copy.test.tsx src/lib/__tests__/workbench-modes.test.ts src/lib/__tests__/workbench-chrome.test.ts` -- expected: all pass
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm lint` -- expected: no new errors
- `pnpm vitest run` -- expected: no regressions beyond the pre-existing baseline

## Auto Run Result

Status: done
Blocking condition: none

### Summary

Both Settings surfaces now claim only what something actually resolved.

**DW-715.** `YOPEDIA_VECTORIZE` is read server-side beside the existing `AI` binding read in `GET /api/settings` and served flat as `hasVectorizeBinding`. The embedding hint's single composed sentence became three whole sentences selected by a pure `workersAiHint()`: bound → today's byte-identical "…with a 1,024-dimensional Vectorize index."; known-absent → "This deployment uses Cloudflare Workers AI. No Vectorize index is bound."; unresolved → the provider clause alone. DW-616's provider+model gate runs first and is unchanged, so a non-Workers deployment still says nothing at all.

**DW-750.** `isSidecarDefaultAdmittedOrigin` — the predicate Chat already selects its fail-closed sentence with — now also decides the rail dot's `down` label and the API/MCP pane's `unreachable` sentence. `pageOrigin` is read after mount by one new hook and threaded from the shell to the rail and into the pane. Only `unreachable` reads the origin: `error` is a payload that arrived, so the door admitted the page and its origin says nothing more. Every loopback-page and unknown-origin sentence is byte-identical to before.

### Files changed

- `src/lib/storage/index.ts` -- new exported `hasVectorizeBinding()`, built on the same `getOpenNextCloudflareEnv()` the R2 provider is constructed from.
- `src/app/api/settings/route.ts` -- reads it in `GET` beside `hasWorkersAiBinding` and serves it flat; `PUT` untouched.
- `src/hooks/useSettings.ts` -- the served field on the hand-duplicated `EffectiveSettings` view.
- `src/components/EmbeddingSettings.tsx` -- three exported copy constants plus the pure `workersAiHint()` selector; new three-state `hasVectorizeBinding` prop.
- `src/app/settings/page.tsx` -- threads the served fact into the component.
- `src/hooks/usePageOrigin.ts` (new) -- the read-after-mount origin, with the hydration rationale that used to live inline in `ModeCanvas`.
- `src/components/workbench/ModeCanvas.tsx` -- uses the hook; behaviour unchanged.
- `src/lib/workbench-modes.ts` -- `RAIL_SIDECAR_DOWN_LABEL` / `RAIL_SIDECAR_REFUSED_LABEL` / `railSidecarDownLabel()`; `isPageOrigin` exported so the health module degrades by the same predicate.
- `src/components/workbench/IconRail.tsx` -- new `pageOrigin` prop; only the `down` arm consults the selector.
- `src/components/workbench/Workbench.tsx` -- reads the origin and hands it to the rail.
- `src/lib/workbench-loopback-health.ts` -- `SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY`; optional `pageOrigin` argument read by the `unreachable` arm alone.
- `src/components/workbench/SettingsApiMcpPane.tsx` -- passes the origin to the sentence selector.
- `src/lib/config.ts` -- comment-only correction of prose that cited the hint as one unconditional sentence.
- Tests: `embedding-settings-override`, `settings-page-embedding-wiring`, `settings-route`, `settings-runtime-wiring`, `icon-rail`, `workbench-modes`, `workbench-chrome` updated; `loopback-health-sentence.test.ts`, `sidecar-origin-surfaces.test.tsx`, `use-page-origin.test.tsx` added.

### Review findings breakdown

- Patches applied: 9 (medium 1, low 8) — see the Review Triage Log entry for each.
- Items deferred: 1 (low) — `SkillsCanvas` makes the same origin-blind "start it" claim on a rejected loopback scan.
- Items rejected: 7 — chiefly copy-enrichment preferences on the new no-index sentence (it states only what was resolved, and the R2 KV fallback it does not mention is not something it claims about), the unreachable `null` branch being defensive rather than dead, the `modelSource === "env"` and model-id gates being DW-559/DW-616 design the spec preserves, and two hedging suggestions on the new Settings sentence that would have made it disagree with Chat's established sibling copy.

### Follow-up review recommendation

Patched findings by severity: high 0, medium 1, low 8. Score: `false` — no patched finding was high severity.

### Verification performed

- `pnpm exec tsc --noEmit` -- exit 0, no output.
- `pnpm lint` -- exit 0; output identical to the pre-change baseline (3 pre-existing `jsx-ast-utils` notices, no errors).
- `pnpm vitest run` -- 392 files, 9849 passed, 1 skipped, 0 failed.
- Matrix audit: every one of the 10 I/O rows is covered by a test that ran and passed — the three hint states and the non-Workers row in `embedding-settings-override.test.tsx`, the served-fact row in `settings-route.test.ts` and `settings-runtime-wiring.test.ts`, the three rail rows across `workbench-modes.test.ts` and `icon-rail.test.tsx`, and the two pane rows in `loopback-health-sentence.test.ts`.
- `git diff src/lib/config.ts` inspected line by line to confirm the edit is comment-only.

### Residual risks

- The new sentences are user-facing copy. "Sidecar not reachable" and the Settings origin sentence were written to match the shape of the existing Chat pair rather than handed down by a UX source, so they are the one part of this change a human may want to reword.
- `hasVectorizeBinding()` reads the OpenNext request context rather than any env explicitly passed to `initCloudflareStorage(env)`. No production caller uses that initializer, and the docblock now says so, but a future one would need this helper taught about it.
