---
title: 'Endpoint refusal and credential readiness, said out loud (DW-402, DW-403)'
type: 'bugfix'
created: '2026-08-22'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The reason a refused `OLLAMA_BASE_URL` was ignored reaches no MOUNTED
      surface in the one deployment state DW-402 describes, so that owner still
      reads a bare "No LLM provider configured".
    evidence: |-
      `StatusBadge` — the component the ledger names, and the one this change
      taught to render the sentence — is imported by nothing in `src/` except
      its own new test (verified repo-wide). Its reachable twin is the status
      block at `src/app/settings/page.tsx:117-135`, which renders
      `status?.configured ? "Connected: …" : "No LLM provider configured"` from
      the same `/api/status` body and was left unchanged; `useSettings` now
      carries `status.ollamaBaseUrlIssue` and nothing reads it. The other render
      site, `ProviderForm`'s endpoint block, is gated on
      `effectiveProvider === "ollama"` (`src/components/ProviderForm.tsx:96-97`)
      — and in the described state (`OLLAMA_BASE_URL=localhost:11434`, nothing
      else set) `detectEnvProvider` deliberately selects no provider, so the
      block never renders and the owner must guess "pick Ollama" to be told why
      Ollama was not picked. Pre-existing (the badge has never been mounted) and
      outside this bundle's named render sites, but it is what stands between
      the served field and the owner. Whoever takes it must also decide the
      duplication question: on `/settings` with Ollama selected, a status-block
      sentence and the endpoint-box sentence would say one fact twice on one
      page, which is the shape DW-368's inherit-aware gate exists to avoid.
    location: >-
      src/app/settings/page.tsx:117-135 and src/components/StatusBadge.tsx
    severity: medium
  - summary: >-
      `yopedia status` prints the provider verdict with no reason, so the CLI —
      the surface a headless operator actually reaches — still reports "not
      configured" for a variable the deployment saw and refused.
    evidence: |-
      `runStatus` (`src/cli.ts:554-567`) reads `getEffectiveSettings()` and
      prints `LLM provider` and `Embeddings` only. The payload now carries
      `ollamaBaseUrlIssue` beside those fields, so the sentence is one line
      away, but nothing prints it. This change touched `src/lib/__tests__/cli.test.ts`
      only to keep a whole-object fixture compiling. Same harm class as DW-402
      on a third surface the bundle's intent did not name.
    location: >-
      src/cli.ts:554-567
    severity: medium
baseline_revision: '410c0a1726e1e1c4c079ef48bbe65a761fd4d594'
---

<intent-contract>

## Intent

**Problem:** Two owner-facing surfaces assert a readiness the runtime will refuse. A refused `OLLAMA_BASE_URL` is discarded with a server-log line only (`envOllamaBaseUrl`, `getOllamaBaseUrl`), while `StatusBadge`'s help panel still advertises that very variable as the remedy and `getEffectiveSettings` reports `ollamaBaseUrlSource: "none"` with no reason — so an owner who set `localhost:11434` reads "no provider configured" beside advice they have already followed (DW-402). Separately, the extraction section's "Credential ready" badge goes green for `custom` with no model name, because `providerIsConfigured` tests the two credential halves only while a `custom` construction also needs a model that `DEFAULT_MODELS` deliberately does not supply (DW-403).

**Approach:** Have the Ollama endpoint ladder report a nullable REASON beside the URL it resolved, thread that reason through `getEffectiveProvider` into `/api/status` and through `getEffectiveSettings` into the settings payload, and render it where each surface already speaks about the endpoint. For readiness, keep `providerIsConfigured` as the credential question and AND the model in at the three resolution sites that already hold one, through a single composed predicate.

## Boundaries & Constraints

**Always:**
- ONE sentence per refusal, owned in `src/lib/workbench-settings.ts` beside `settingsEnvOverrideCopy`, and used BOTH as the `warnOnceAbout` message and as the surfaced reason — the log and the screen must not be able to drift.
- A reported reason covers EXACTLY the ladder whose answer sits beside it: `ProviderInfo`'s reason is the ENV leg only (detection is env-only, deliberately — DW-370), `EffectiveSettings`' reason is the full env→store ladder that produced its `ollamaBaseUrl`.
- `getOllamaBaseUrl` and `envOllamaBaseUrl` keep their exact current signatures, behaviour and warn-once keys; the reason arrives through NEW sibling accessors that the existing two delegate to.
- Blank is unset: `OLLAMA_BASE_URL=` and whitespace stay "not configured" with no warning and no reason (the `nonEmpty` convention).
- A leg that never ran contributes no reason: when the env value resolves, the store is not walked and no stored refusal is reported; when `provider === "ollama-cloud"`, the ladder is not walked at all and the reason is `null`.
- The readiness predicate is derived from `DEFAULT_MODELS`, not from the literal `"custom"` — "a provider with no default model must be handed one" — so a future default-less provider cannot reopen the same hole.
- Both new payload fields are `string | null` / additive; every existing caller of the changed resolvers compiles unchanged.

**Block If:**
- Closing DW-402 would require mounting `StatusBadge`. It does not: the component is currently imported by nothing (verified repo-wide), and this change makes it correct where it stands. Mounting it is a product decision outside this bundle.

**Never:**
- Do not change what `getOllamaBaseUrl` RETURNS for any input, and do not make it throw.
- Do not widen `detectEnvProvider` to the store, and do not change which provider it selects.
- Do not change `providerIsConfigured`'s own contract or its `llm.ts:220` caller's meaning.
- Do not add base-URL, API-key or model inputs to any surface, and do not block a save on a reported reason — these DESCRIBE (no `aria-invalid`), matching `ProviderForm`'s custom-endpoint note.
- Do not render the endpoint reason outside the block that already speaks about the Ollama endpoint.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Refused env endpoint | `OLLAMA_BASE_URL=localhost:11434`, nothing stored | `getOllamaBaseUrl()` still `undefined`; both new accessors report the env reason naming the variable and the value; `/api/status` and `GET /api/settings` carry it | Warn-once only; no throw |
| Env refused, store usable | `OLLAMA_BASE_URL=localhost:11434`, `cfg.ollamaBaseUrl=http://ollama.internal:11434` | URL is the stored one, source `config`, reason is the ENV refusal | Warn-once only |
| Env usable | `OLLAMA_BASE_URL=http://host:11434`, store holds anything | URL is the env one, source `env`, reason `null` (store never walked) | No error expected |
| Store refused only | no env var, `cfg.ollamaBaseUrl=not-a-url` | URL `undefined`, source `none`, reason names the STORED endpoint | Warn-once only |
| Blank | `OLLAMA_BASE_URL=` or whitespace, nothing stored | URL `undefined`, reason `null` | No warning at all |
| Ollama Cloud | `provider === "ollama-cloud"` with a refused `OLLAMA_BASE_URL` | `EffectiveSettings` reports the cloud endpoint, source `default`, reason `null` | No error expected |
| Custom without a model | `custom` selected with base URL and API key set, no model anywhere | `configured` is `false` on `getEffectiveProvider`, `getEffectiveSettings` and `workloadModelSettings`; extraction badge reads "Credential required" | No error expected |
| Custom with a model | same, plus `cfg.model` / workload model / `LLM_MODEL` | `configured` is `true` on the matching site | No error expected |
| Custom, whitespace model | `cfg.model = "   "` | `configured` is `false` — `llm.ts` resolves the model through `.trim()` | No error expected |
| Keyed provider, no model change | `ANTHROPIC_API_KEY` set, no `cfg.model` | `configured` stays `true` — the provider has a `DEFAULT_MODELS` entry | No error expected |

</intent-contract>

## Code Map

- `src/lib/config.ts:310-341` -- `envOllamaBaseUrl()`: the env leg, `nonEmpty` → `isAbsoluteHttpUrl` → `warnOnceAbout` → `undefined`. Becomes a `.url` view over the new answer-shaped accessor; its doc block already states the "one rule" reasoning — extend, do not restate.
- `src/lib/config.ts:343-393` -- `getOllamaBaseUrl(cfg)`: env leg then stored leg, with the second `warnOnceAbout` at `:385-389`. Same treatment: keep the signature, delegate to the new resolver.
- `src/lib/config.ts:290-295` -- `warnOnceAbout`, keyed by SOURCE and VALUE. The keys must stay byte-identical; `config.test.ts:1218-1244` pins two-warning and one-warning counts on them.
- `src/lib/config.ts:863-870` -- `providerIsConfigured`: the credential-halves question. Unchanged; `src/lib/llm.ts:220` (`hasCustomProvider`) is its only outside caller and keeps that meaning.
- `src/lib/config.ts:892-946` -- `getEffectiveProvider`: resolves `model` at `:905-931` and returns `configured: providerIsConfigured(provider)` at `:932`. DW-403 site #1 and the DW-402 `ProviderInfo` site.
- `src/lib/config.ts:964-1015` -- `workloadModelSettings`: holds `resolvedModel`, returns `configured: providerIsConfigured(resolvedProvider)` at `:1008`. DW-403 site #2 — feeds `structuredKnowledgeConfigured`.
- `src/lib/config.ts:1508-1626` -- `getEffectiveSettings`: model ladder at `:1535-1559`, the `ollamaBaseUrl`/`ollamaBaseUrlSource` block at `:1561-1590` (note the `ollama-cloud` early branch), `configured:` at `:1607`. DW-403 site #3 and the DW-402 `EffectiveSettings` site.
- `src/lib/config.ts:86-124` -- `EffectiveSettings` interface; `src/lib/types.ts:251-260` -- `ProviderInfo`. Both gain `ollamaBaseUrlIssue: string | null`.
- `src/lib/workbench-settings.ts:333-362` -- `ENV_OVERRIDE_VARIABLES` + `settingsEnvOverrideCopy`: the precedent wording ("The environment sets X=Y, and that wins at runtime…") and the place the new copy function belongs. Client-safe, already imported by `config.ts:13` and by `ProviderForm`; it must not import `config.ts`.
- `src/lib/providers.ts:166-173` -- `DEFAULT_MODELS`: `custom` is the only provider with no entry, by design (`providers.ts:20-23`).
- `src/components/StatusBadge.tsx:6-11,68-90` -- local `ProviderInfo` copy and the help panel listing `OLLAMA_BASE_URL / OLLAMA_MODEL` at `:81`. **No mount exists anywhere in the repo** (verified) — `/api/status` is also fetched by `useSettings.ts:267`, which is the live consumer of the new field.
- `src/components/ProviderForm.tsx:17-28,196-224` -- local `EffectiveSettings` copy and the `showOllamaUrl` block (`env` source renders a read-only div, otherwise an input). The reason renders inside this block; `:230-236` is the note styling to match.
- `src/hooks/useSettings.ts:20-68` -- the third hand-copied `EffectiveSettings` view; `ProviderForm` receives values typed by its own copy, so both need the field.
- `src/lib/__tests__/config.test.ts:1172-1290` -- `withWarnSpy` and the warn-once suite, including `.includes("OLLAMA_BASE_URL")` / `.includes("stored")` filters any new wording must keep satisfying. `:1331-1411` holds the DW-370 detection cases.
- `src/components/__tests__/structured-knowledge-settings.test.tsx:1-48` -- the mounted-component pattern (`settings()` / `props()` factories, `cleanup` in `afterEach`); its `settings()` factory needs the new field.
- `src/lib/structured-knowledge.ts:299-303` -- read-only evidence: extraction already refuses `!selection.model` with its own sentence, which is what makes the green badge a lie rather than a crash.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- add `ollamaBaseUrlRefusedCopy(source: "env" | "config", value: string): string` beside `settingsEnvOverrideCopy`, one sentence per source naming the variable or the store, the refused value, and what to set instead -- one wording for the log and for both surfaces, so they cannot drift.
- `src/lib/config.ts` -- add an answer shape `{ url: string | undefined; issue: string | null }` with `envOllamaBaseUrlAnswer()` and `resolveOllamaBaseUrl(cfg)`; have `envOllamaBaseUrl`/`getOllamaBaseUrl` return `.url` from them, and emit the shared copy through the existing `warnOnceAbout` keys -- the refusal becomes a value the callers can report instead of a line only a server operator sees.
- `src/lib/config.ts` -- add `providerIsUsable(provider, model)` = `providerIsConfigured(provider)` AND (the provider has a `DEFAULT_MODELS` entry OR `nonEmpty(model) !== null`), and call it at `getEffectiveProvider:932`, `workloadModelSettings:1008` and `getEffectiveSettings:1607` with the model each already resolved -- one predicate rather than three restatements of the `custom` exception.
- `src/lib/types.ts` and `src/lib/config.ts` -- add `ollamaBaseUrlIssue: string | null` to `ProviderInfo` (env leg) and to `EffectiveSettings` (full ladder, `null` on the `ollama-cloud` branch), documenting on each which ladder its reason covers -- the surfaces cannot report a reason the payload does not carry.
- `src/hooks/useSettings.ts` and `src/components/ProviderForm.tsx` -- carry the new field on both hand-copied `EffectiveSettings` views and render the reason inside the Ollama Base URL block when it is non-null, styled as the existing describing note -- the owner reads why the box is empty in the place the box is.
- `src/components/StatusBadge.tsx` -- carry `ollamaBaseUrlIssue` on its local `ProviderInfo` and render it in the help panel beneath the variable list when non-null -- the panel stops advertising a variable the deployment has already refused without saying so.
- `src/lib/__tests__/config.test.ts` -- cover every I/O matrix row: the new accessors' `issue` for env-refused / env-refused-store-usable / env-usable / store-refused / blank, the two payload fields (including `ollama-cloud` → `null`), and `configured` for custom with no model, with a model, with a whitespace model, plus the keyed-provider regression -- the matrix is only closed if it is executed.
- `src/components/__tests__/provider-form.test.tsx` -- new file: mounted, the reason renders in the Ollama block when the payload carries one and is absent when it does not, and is absent when the picker is not on Ollama -- a rendered sentence is not visible to a source scan.
- `src/components/__tests__/status-badge.test.tsx` -- new file: mounted with `/api/status` stubbed, the help panel shows the reason when the payload carries one and shows the variable list unchanged when it does not -- same reason, and the component has no test today.
- `src/components/__tests__/structured-knowledge-settings.test.tsx` -- extend the `settings()` factory with the new field -- the shared fixture must stay a faithful view of the payload.

**Acceptance Criteria:**
- Given a deployment whose only Ollama signal is an `OLLAMA_BASE_URL` the resolver refuses, when an owner opens the settings surface and selects Ollama, then the endpoint box names the variable, the refused value and what to set instead, rather than standing empty beside a `none` source badge.
- Given the same deployment, when `/api/status` is read, then its body carries the same sentence the server log emitted, so no owner-facing consumer has to infer the reason from the absence of a provider.
- Given a stored endpoint the resolver refuses while no environment variable is set, when the settings payload is built, then the reported reason names the STORED endpoint rather than the environment variable.
- Given a `custom` provider with both credential halves set and no model name anywhere, when the extraction section renders, then its badge reads "Credential required", matching what extraction actually does with that configuration.
- Given any provider that carries a default model, when it is configured exactly as before this change, then its reported readiness is unchanged.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 1, low 9)
- defer: 2: (high 0, medium 2, low 0)
- reject: 10: (high 0, medium 4, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The new endpoint-refusal note in `ProviderForm` sat beside the input with no programmatic association, which the repo's own convention (`SettingsCanvas.tsx:419-433`) calls invisible to a screen reader. Gave it `id="ollamaBaseUrlIssue"` and composed that id into the input's `aria-describedby` alongside the existing read-only `describedBy` (space-joined, `undefined` when neither applies), with three mounted cases.
  - `[low]` `[patch]` `provider-form.test.tsx`'s `ollamaBlock()` walked one level past the endpoint block to the render container, so every "inside this block" assertion was really about the whole form. Dropped the `.parentElement`; confirmed by mutation that moving the note out of the block now fails three cases where it previously passed silently.
  - `[low]` `[patch]` The "locked env box" case asserted a payload the resolver cannot emit (`ollamaBaseUrlSource: "env"` beside a non-null issue — an env leg that returned a URL reports no reason). Rebuilt on the reachable state (env refused, stored endpoint usable → source `config`), with the impossibility recorded in the comment.
  - `[low]` `[patch]` `ProviderStatus.ollamaBaseUrlIssue` was optional on a false premise: `POST /api/settings/test` returns `{ ok: true, ...getProviderInfo() }`, so both doors serve a whole `ProviderInfo`. Made it required and corrected the comment.
  - `[low]` `[patch]` `ollamaBaseUrlRefusedCopy`'s example endpoint contradicted `README.md:168` and the placeholder in the very box the sentence renders beside. Aligned both branches to `http://localhost:11434/api` and pinned the full literal in the tests.
  - `[low]` `[patch]` `providerIsUsable` indexed `DEFAULT_MODELS` directly, so a provider string reaching a prototype key (`constructor`, `toString`) short-circuited to "usable" with no model. Switched to `Object.hasOwn`, with a case proving the bare lookup is the hole.
  - `[low]` `[patch]` The "log and screen cannot drift" invariant was pinned for the env leg only. The stored leg now asserts its warn line is the same string as the reported issue — the likelier drifter, since its reason surfaces only when the env leg has none.
  - `[low]` `[patch]` `config.test.ts` had three copies of `withWarnSpy` under one name. Hoisted a single module-level helper and removed the `await`s that were awaiting a non-promise.
  - `[low]` `[patch]` `/api/status`'s catch branch hand-duplicated `ProviderInfo` with nothing enforcing completeness. Added `satisfies ProviderInfo & { error: string }` — the same omission is how the branch came to be missing a field.
  - `[low]` `[patch]` `status-badge.test.tsx` drove the disclosure with a raw `button.click()`, bypassing RTL's `act` wrapping. Switched to `fireEvent.click`.

## Design Notes

The refusal becomes a VALUE rather than a second code path. Both existing accessors keep their signatures by delegating:

```ts
export interface OllamaBaseUrlAnswer { url: string | undefined; issue: string | null }

export function envOllamaBaseUrlAnswer(): OllamaBaseUrlAnswer {
  const fromEnv = nonEmpty(process.env.OLLAMA_BASE_URL);
  if (fromEnv === null) return { url: undefined, issue: null };
  if (isAbsoluteHttpUrl(fromEnv)) return { url: fromEnv, issue: null };
  const issue = ollamaBaseUrlRefusedCopy("env", fromEnv);
  warnOnceAbout(`ollama-endpoint:env:${fromEnv}`, issue);   // same key, same sentence
  return { url: undefined, issue };
}
export function envOllamaBaseUrl(): string | undefined { return envOllamaBaseUrlAnswer().url; }
```

`resolveOllamaBaseUrl` walks the env answer first and RETURNS on a usable URL, so a store that was never consulted contributes no reason; only when the env leg yields no URL does it walk the store, and the reported reason is the env one if there was a refusal there, otherwise the store's.

Why two scopes for one fact: `ProviderInfo` describes what the ENVIRONMENT alone selects (`detectEnvProvider` is env-only by DW-370's own design note), so pairing it with a stored-value complaint would answer a question that object does not ask. `EffectiveSettings.ollamaBaseUrl` is the full ladder's answer, so its reason is the full ladder's.

DW-403 keys off the data, not the name: `providerIsConfigured(p) && (DEFAULT_MODELS[p] !== undefined || nonEmpty(model) !== null)`. Today that singles out `custom`, which is the only entry `providers.ts` withholds on purpose; tomorrow it covers whatever else is withheld, without a second edit at three call sites.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/config.test.ts src/lib/__tests__/embeddings.test.ts src/lib/__tests__/llm.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/settings-route.test.ts` -- expected: all pass, including every pre-existing `getOllamaBaseUrl`, warn-once and detection case, untouched.
- `npx vitest run --project dom src/components/__tests__/provider-form.test.tsx src/components/__tests__/status-badge.test.tsx src/components/__tests__/structured-knowledge-settings.test.tsx` -- expected: the mounted suites pass.
- `npx vitest run` -- expected: full suite green, brand-copy and english-only scans included.
- `npx eslint .` and `npx tsc --noEmit` -- expected: exit 0, no new findings.

## Auto Run Result

Status: done

**Implemented change.** Two owner-facing readiness claims now match what the runtime will do. The Ollama endpoint ladder reports a nullable REASON beside the URL it resolved: `envOllamaBaseUrlAnswer()` and `resolveOllamaBaseUrl()` return `{ url, issue }`, `envOllamaBaseUrl`/`getOllamaBaseUrl` became `.url` views over them (same signatures, same answers, same warn-once keys), and the sentence is minted once in `ollamaBaseUrlRefusedCopy` and used as BOTH the `warnOnceAbout` message and the surfaced reason, so the server log and the screen cannot drift. The reason is threaded into `ProviderInfo` (env leg only — `detectEnvProvider` is env-only by DW-370's design) and `EffectiveSettings` (the full env→store ladder, `null` on the `ollama-cloud` branch that never walks it), and rendered in `StatusBadge`'s help panel and inside `ProviderForm`'s Ollama endpoint block. Separately, readiness now includes the model: `providerIsUsable(provider, model)` composes over `providerIsConfigured` — which keeps its credential-only contract for `llm.ts`'s `hasCustomProvider` — and is keyed off whether `DEFAULT_MODELS` owns an entry for the provider, so a `custom` selection with both credential halves and no model name stops reporting "Credential ready" for a configuration extraction refuses.

**Files changed.**
- `src/lib/workbench-settings.ts` -- `ollamaBaseUrlRefusedCopy(source, value)`: one sentence per source, the single wording for log and both surfaces.
- `src/lib/config.ts` -- `OllamaBaseUrlAnswer`, `envOllamaBaseUrlAnswer`, `resolveOllamaBaseUrl`, `providerIsUsable`; the two existing accessors delegate; `EffectiveSettings.ollamaBaseUrlIssue`; the three `configured:` sites judge against the model each already resolved.
- `src/lib/types.ts` -- `ProviderInfo.ollamaBaseUrlIssue`, documented as the env leg only.
- `src/app/api/status/route.ts` -- the catch-branch body stays a complete `ProviderInfo`, now enforced by `satisfies`.
- `src/hooks/useSettings.ts` -- the field on both hand-copied views (`EffectiveSettings`, `ProviderStatus`).
- `src/components/ProviderForm.tsx` -- the reason rendered inside the endpoint block, with `aria-describedby` association and no `aria-invalid`.
- `src/components/StatusBadge.tsx` -- the reason rendered beneath the variable list the panel advertises.
- `src/lib/__tests__/config.test.ts` -- the full I/O matrix over both halves, plus the prototype-key and drift cases; one hoisted `withWarnSpy`.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- the one case that PINNED the DW-403 defect (`custom` + no model reported `configured: true`) flipped to `false`.
- `src/components/__tests__/provider-form.test.tsx`, `src/components/__tests__/status-badge.test.tsx` -- new mounted suites (7 and 3 cases); `src/components/__tests__/structured-knowledge-settings.test.tsx` -- fixture widened plus two badge cases.
- `src/lib/__tests__/settings-route.test.ts`, `src/lib/__tests__/cli.test.ts` -- whole-object fixtures widened to keep compiling.

**Review findings breakdown.** 10 patches applied (0 high, 1 medium, 9 low), 2 items deferred (both medium, recorded in frontmatter `deferred`), 10 rejected, 0 intent gaps, 0 spec repairs.

**Follow-up review recommendation:** `true`. Patched severities: high 0, medium 1, low 9 — score `3 x 1 + 1 x 9 = 12`, at or above the threshold of 5.

**Verification performed.**
- `npx vitest run` -- 273 files / 6102 tests passed.
- `npx vitest run --project dom` over the three mounted suites -- 18 passed.
- `npx eslint .` -- exit 0. `npx tsc --noEmit` -- exit 0.
- Every I/O matrix row is covered by a case that ran and passed; the placement rule in `provider-form.test.tsx` was confirmed by mutation (moving the note out of the endpoint block fails three cases).
- Note: `pnpm test` / `pnpm lint` abort in this checkout with `ERROR packages field missing or empty`, a pre-existing pnpm workspace-resolution problem unrelated to this change; the same commands were run through `npx`.

**Residual risks.**
- Behavioural change by design: a `custom` deployment with both credential halves and no model name now reports `configured: false` on `/api/status`, `/settings` and the extraction badge. It was already unable to extract — `extractStructuredKnowledge` refuses on `!selection.model` — so this replaces a green badge with an accurate amber one rather than removing a capability.
- `llm.ts`'s `hasCustomProvider` deliberately still asks `providerIsConfigured` alone, so `POST /api/settings/test` will still attempt a call for that deployment and fail with "The Custom provider needs a model name". That is the informative outcome and the spec forbids changing that gate's meaning, but the two answers are now different questions asked of one configuration.
- The served reason does not reach a mounted surface in the exact state DW-402 describes — recorded as the first `deferred` item, with the duplication question whoever takes it must settle.
- **Recorded for the orchestrator:** a CONCURRENT bmad-loop session was working in this same checkout throughout this run. Its commit `da04e94` ("sweep dw-settings-canvas-mount-preservation: DW-373") swept most of this bundle's files — this spec included — into a commit labelled DW-373. The remaining files were committed by this run. Nothing was lost and the tree is verified green, but this bundle's history is split across two commits and the DW-373 commit's message does not name DW-402 or DW-403.
