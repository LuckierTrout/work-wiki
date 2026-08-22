---
title: 'Warn once per distinct embedding misconfiguration'
type: 'bugfix'
created: '2026-08-20'
status: 'done'
baseline_revision: '00cae83a26ea0ed7026c9c6a0ebc6a5ece7f3314'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `searchByVector`'s model-drift breadcrumb is the same standing-misconfiguration
      shape as the three warnings this story throttled, but fires once per search
      query and was left unguarded.
    evidence: |-
      `src/lib/embeddings.ts:656-662` logs "all N matches dropped by the model
      filter (active=...) — likely embedding-model drift; rebuild embeddings"
      whenever the store returns hits and the model filter drops all of them.
      That condition is standing state (the active model name has drifted from
      every stored vector) and a search query is a higher-frequency door than
      either resolver, so a drifted corpus emits the line per query. It stayed
      unguarded because this bundle's intent named exactly three resolvers, and
      the sentence embeds a per-query `matches.length`, so it is not literally
      the same line each time. DW-273's own reason frames the fix as "a change
      to the module's logging convention", which argues the other way.
    location: >-
      src/lib/embeddings.ts:656
    severity: low
  - summary: >-
      The non-embedding-capable override warning hardcodes `EMBEDDING_PROVIDER="..."`
      even when the value came from stored config, and now says it only once.
    evidence: |-
      `src/lib/embeddings.ts:134` reads `process.env.EMBEDDING_PROVIDER ??
      cfg.embeddingProvider`, but the warning text always attributes the value to
      the env var. Pre-existing, and harmless while the line repeated; now that
      it is said once per identity, an owner whose bad value came from Settings
      gets a single line telling them to unset an env var they never set. The fix
      is to name the source (env vs stored) in the message.
    location: >-
      src/lib/embeddings.ts:134-145
    severity: low
---

<intent-contract>

## Intent

**Problem:** All three embedding-resolution warnings in `src/lib/embeddings.ts` fire per resolution rather than once per distinct misconfiguration. `resolveEmbeddingModelName` (:215-222) and `resolveEmbeddingProvider` (:96-102) are re-entered by every embed door, and `rebuildVectorStore` calls `getEmbeddingModelName()` once plus `embedText` per page, so a persistently mismatched `EMBEDDING_MODEL` emits roughly two identical WARN lines per page (DW-273). `getWorkersAiBinding()` (:64-71) has the same shape and is now called unconditionally by `GET` and `PUT /api/settings` (route.ts:90, :127), so an unbound Workers deployment logs one WARN per settings request on a path that previously logged nothing (DW-278).

**Approach:** Add one module-private warn-once guard to `src/lib/embeddings.ts` keyed on the identity of the misconfiguration, and route all three warnings through it. A *changed* misconfiguration is a new key and still speaks once, so the guard suppresses repetition, never information. Export an `@internal` reset so tests keep observing each warning.

## Boundaries & Constraints

**Always:**
- Key on misconfiguration identity, not on call site: the model warning keys on `(provider, override)`, the provider warning on the rejected override string, the binding warning on the binding's identity. Changing any of those must produce a fresh warning.
- The guard is logging only. Every return value, fallback, and refusal on all three paths stays byte-identical — `resolveEmbeddingModelName` still returns the provider default, `resolveEmbeddingProvider` still returns `null`, `getWorkersAiBinding` still returns `null`.
- Guard state is module-level (per process / per Workers isolate) — that lifetime *is* the intended scope of "once".
- Follow the existing `@internal` reset convention (`_resetStorage` in `src/lib/storage/index.ts:152`, `_resetLocks`, `_resetConfigCache`) for the test hook.

**Block If:** nothing — the intent names the three warnings and the keying rule.

**Never:**
- Do not throttle `runWorkersAiEmbedding`'s "unexpected response shape" warning (:384-390) or any other per-call data anomaly — those report a runtime event, not a standing misconfiguration, and suppressing repeats would hide real failures.
- Do not touch `src/app/api/settings/route.ts` — DW-278 is explicitly closed inside `embeddings.ts`, not at that seam.
- Do not add a time-based expiry, an env var, or a log-level knob.
- Do not change `src/lib/logger.ts`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Repeated model mismatch | `EMBEDDING_PROVIDER=workers-ai`, `EMBEDDING_MODEL=text-embedding-3-small`; `getEmbeddingModelName()` then `embedText()` then `embedTexts()` | Exactly ONE mismatch WARN across all three calls; every call still resolves/embeds with `@cf/baai/bge-m3` | No error expected |
| Changed model mismatch | Same provider, override switched from `text-embedding-3-small` to `@cf/nope` after the first warning | A SECOND WARN naming the new override | No error expected |
| Same model id, different provider | Override `@cf/baai/bge-m3` rejected first under `openai`, then under `ollama` | Two WARNs — provider is part of the key | No error expected |
| Repeated invalid provider override | `EMBEDDING_PROVIDER=deepseek`; two `getEmbeddingModelName()` calls | ONE "not embedding-capable" WARN; both calls still return `null` | No error expected |
| Changed invalid provider override | `EMBEDDING_PROVIDER` switched `deepseek` → `bogus` | A SECOND WARN naming `bogus` | No error expected |
| Repeated unbound Workers binding | On the Workers runtime, `env.AI` absent; `getWorkersAiBinding()` called twice | ONE unbound-binding WARN; both calls return `null` | No error expected |
| Off the Workers runtime | `getCloudflareContext()` throws | Silent, returns `null`, no key recorded (so a later real Workers miss can still warn) | Expected — silent by design |
| Honoured override | `EMBEDDING_MODEL=@cf/baai/bge-large-en-v1.5` on `workers-ai` | Silent; no key recorded | No error expected |

</intent-contract>

## Code Map

- `src/lib/embeddings.ts` -- the only file to change. Three warning sites: `getWorkersAiBinding` :56-73 (warn at :64-71, on the Workers runtime with `env.AI` unbound; the `catch` at :60-62 is the off-Workers path and must stay silent and unrecorded); `resolveEmbeddingProvider` :88-127 (warn at :96-102, rejecting a non-embedding-capable `EMBEDDING_PROVIDER`/`cfg.embeddingProvider` override, then `return null`); `resolveEmbeddingModelName` :180-226 (warn at :215-222 when `embeddingModelMatchesProvider(provider, override)` is false, then returns `fallback`). `logger` is already imported at :20. `runWorkersAiEmbedding` :373-399 holds the response-shape warning that must stay unthrottled.
- Amplifiers (read-only evidence, no edits): `rebuildVectorStore` :679 calls `getEmbeddingModelName()` once then `embedText` per page; `getEmbeddingModelName` :233, `getEmbeddingModel` :247, `embedText`/`embedTexts`, and `runWorkersAiEmbedding` :377/:380 all re-enter the two resolvers. `src/app/api/settings/route.ts:90` (GET) and `:127` (PUT) call `getWorkersAiBinding()` unconditionally once per request.
- `src/lib/storage/index.ts:152` -- `_resetStorage()` is the `@internal` reset convention to mirror (see also `src/lib/lock.ts:77`, `src/lib/config.ts:563`).
- `src/lib/logger.ts` -- `logger.warn(tag, msg, ...args)`; no changes.
- `src/lib/__tests__/embeddings.test.ts` -- must be updated. Global `beforeEach` at :108-120 is where the reset belongs. The `withWarnSpy` helper at :1312-1325 filters `logger.warn` calls tagged `embeddings`. Two tests reuse the SAME `(workers-ai, text-embedding-3-small)` pair: "WARNS once on getEmbeddingModelName" (~:1414) and "WARNS on the embed path itself" (~:1435). The latter asserts one warning from `embedText` AND one from `embedTexts` *within a single test* — the guard makes the second call silent, so that test needs an explicit reset between its two halves.
- Other `getWorkersAiBinding` consumers that must keep working: `src/lib/vision.ts:119`, `src/lib/__tests__/settings-route.test.ts:21` and `src/lib/__tests__/vision.test.ts:6` both `vi.mock` the embeddings module with only `getWorkersAiBinding`, so the new export must not be something those callers need.
- No existing test asserts the provider-override or unbound-binding warnings, so those are new coverage.

## Tasks & Acceptance

**Execution:**
- `src/lib/embeddings.ts` -- add a module-level `Set<string>` of already-warned keys plus a private `warnOnceAbout(key, message)` helper near the top of the "Embedding provider detection" section, documenting why the state is module-scoped and why a changed key speaks again -- one guard shared by all three sites keeps the module's logging convention consistent.
- `src/lib/embeddings.ts` -- route the three warnings through the helper with identity keys: unbound binding → a fixed binding-identity key; rejected provider override → a key carrying the raw override string; model mismatch → a key carrying `(provider, override)`. Leave the returned values and the off-Workers silent `catch` untouched -- the keys are what make "once per distinct misconfiguration" true rather than "once per process".
- `src/lib/embeddings.ts` -- export `_resetEmbeddingWarnings()` marked `@internal`, mirroring `_resetStorage` -- without it every suite after the first assertion would see a silenced warning.
- `src/lib/__tests__/embeddings.test.ts` -- call `_resetEmbeddingWarnings()` in the global `beforeEach`, and add an explicit reset with a comment between the `embedText` and `embedTexts` halves of "WARNS on the embed path itself" -- existing per-test warning assertions must keep observing their warning.
- `src/lib/__tests__/embeddings.test.ts` -- add tests for the I/O matrix rows: repeated vs. changed model mismatch, same model id under two providers, repeated vs. changed invalid provider override, repeated unbound Workers binding, off-Workers silence not consuming the binding key, and that suppression does not change what gets embedded.

**Acceptance Criteria:**
- Given a persistently mismatched `EMBEDDING_MODEL` and a rebuild over N pages, when `rebuildVectorStore` runs, then the mismatch sentence appears exactly once in the logs while every page is still embedded with the provider default.
- Given a Workers deployment with `AI` unbound, when `GET /api/settings` and `PUT /api/settings` are each served more than once, then the unbound-binding warning appears exactly once for the isolate and both routes still see `hasWorkersAiBinding === false`.
- Given a misconfiguration that has already warned, when its identity changes (a different override, a different provider for the same override), then a new warning is emitted naming the new value.
- Given `pnpm test` and `pnpm lint`, when run, then both pass with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 3, low 5)
- defer: 2: (high 0, medium 0, low 2)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` "stays silent OFF the Workers runtime" could not fail — one spy window asserting a single warning across both calls passes even if the off-Workers `catch` warns, because the guard mutes the real miss that follows. Split into two windows; mutation-verified that injecting a warn into the `catch` now fails.
  - `[medium]` `[patch]` `DEPLOY.md` promised "Every such substitution now emits one warning", which the throttle makes false. Rewrote to once-per-distinct-`(provider, model)`-per-process (per isolate on Cloudflare), noted that an identical misconfiguration re-introduced in the same process stays silent, and fixed the "grep the logs" advice so absence of a repeated line is not read as absence of the problem.
  - `[medium]` `[patch]` Acceptance criterion 2 (repeated `GET`/`PUT /api/settings` warn once) had no test at the route surface — `settings-route.test.ts` mocks the whole embeddings module. Added a route-level test in `settings-runtime-wiring.test.ts` driving the real route with `AI` unbound on Workers.
  - `[low]` `[patch]` "SAYS the mismatch ONCE across every embed door" asserted only the count, so a wrong-but-single warning passed. Added content assertions for the dropped id, provider, and fallback.
  - `[low]` `[patch]` The mid-test `_resetEmbeddingWarnings()` inside "WARNS on the embed path itself" made a pre-existing assertion depend on a test-only lever. Gave the `embedTexts` half a distinct override instead, so the door warns on its own key.
  - `[low]` `[patch]` Nothing asserted that two different misconfiguration families coexist without cross-suppression. Added a test with an unbound binding and a model mismatch standing simultaneously.
  - `[low]` `[patch]` Every guard test drove `process.env`; the stored-config path is what `/api/settings` actually exercises. Added coverage for `cfg.embeddingModel` and `cfg.embeddingProvider` through the guard.
  - `[low]` `[patch]` Docblock inaccuracies: it named only `/api/settings` as an amplifier, hid the identical-re-break trade-off, did not say which module warnings were deliberately left unguarded, and the reset's docstring did not note that it is wired per-suite with no central registry. All four corrected.

## Design Notes

The guard is a `Set` of string keys, not a boolean or a WeakMap: string keys let the same helper serve three unrelated warnings while keeping "distinct misconfiguration" literally distinct.

```ts
const warnedMisconfigurations = new Set<string>();

/** Emit `message` the first time `key` is seen; later repeats are silent. */
function warnOnceAbout(key: string, message: string): void {
  if (warnedMisconfigurations.has(key)) return;
  warnedMisconfigurations.add(key);
  logger.warn("embeddings", message);
}
```

Key shapes: `binding:workers-ai` (there is one way for the binding to be missing), `provider-override:${override}`, `model:${provider}:${override}`. The fallback model is a pure function of the provider, so it adds nothing to the model key.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/embeddings.test.ts` -- expected: all tests pass, including the new throttle tests.
- `pnpm test` -- expected: no new failures anywhere (notably `settings-route.test.ts`, `vision.test.ts`, `workbench-settings.test.ts`, `settings-runtime-wiring.test.ts`, which mock or exercise `getWorkersAiBinding`).
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** `src/lib/embeddings.ts` gained a module-private warn-once guard — a `Set<string>` of misconfiguration identities plus `warnOnceAbout(key, message)` — and all three resolver warnings now route through it: the unbound `AI` binding in `getWorkersAiBinding` (key `binding:workers-ai`), the non-embedding-capable override in `resolveEmbeddingProvider` (key `provider-override:${override}`), and the model/provider mismatch in `resolveEmbeddingModelName` (key `model:${provider}:${override}`). Every return value, fallback, and refusal is unchanged, and the off-Workers `catch` still returns silently without consuming its key. An `@internal` `_resetEmbeddingWarnings()` export mirrors `_resetStorage`. A rebuild over N pages now logs the mismatch once instead of ~2N times, and an unbound Workers deployment logs the binding line once instead of once per settings request; a *changed* misconfiguration is a new key and still speaks.

**Files changed.**
- `../../src/lib/embeddings.ts` -- warn-once guard, `_resetEmbeddingWarnings()`, three warnings rerouted, docblocks recording the amplifiers, the trade-off, and the two warnings deliberately left unguarded.
- `../../src/lib/__tests__/embeddings.test.ts` -- guard reset in the global `beforeEach`, `withWarnSpy` hoisted to module scope, and new coverage for every I/O-matrix row plus once-per-rebuild, cross-family isolation, and the stored-config path.
- `../../src/lib/__tests__/settings-runtime-wiring.test.ts` -- new route-surface test: repeated `GET`/`PUT /api/settings` with `AI` unbound on Workers warns once and still reports `hasWorkersAiBinding === false`.
- `../../../DEPLOY.md` -- the embedding-mismatch operator guidance now describes once-per-misconfiguration-per-isolate semantics instead of one warning per substitution.

**Review findings breakdown.** 8 patches applied (3 medium, 5 low), 2 items deferred (both low: `searchByVector`'s per-query drift breadcrumb left unguarded; the override warning attributing a stored value to `EMBEDDING_PROVIDER`), 11 rejected as noise or out of scope on the intent's authority — including a runtime log-level/key-burn race (`setLogLevel` has no non-test caller), unbounded `Set` growth from operator-typed values, keying the provider override on an untrimmed string (two padded values are two different warning texts), throttling `runWorkersAiEmbedding`'s per-call shape anomaly, and re-arming keys when a misconfiguration clears (explicitly out of scope per the spec's Never list).

**Follow-up review recommendation:** true. Patched findings this pass: high 0, medium 3, low 5. Score = 3x3 + 1x5 = 14, which is >= 5.

**Verification performed.**
- `vitest run` (full suite) -- 252 files / 5380 tests passed, after the patches as well as before them.
- `vitest run src/lib/__tests__/embeddings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts` -- 163 passed.
- `eslint` -- exit 0 (the three `jsx-ast-utils` "TSNonNullExpression could not be resolved" lines are pre-existing noise on unrelated JSX).
- `tsc --noEmit` -- exit 0.
- Mutation check: injecting a `warnOnceAbout("binding:workers-ai", ...)` into the off-Workers `catch` fails the split off-Workers test, confirming that assertion can now fail.
- `pnpm test` / `pnpm lint` as literally written in the Verification section could not run: `pnpm <script>` fails repo-wide with `ERROR packages field missing or empty`, a pre-existing workspace-config issue unrelated to this change. The equivalent `node_modules/.bin` invocations were used instead.

**Residual risks.**
- The guard's scope is one process / one Workers isolate. On Cloudflare that means the line lands in only some isolates' logs while a misconfiguration stands, and an operator who fixes and re-breaks the identical value inside one isolate sees silence. Both are the specified meaning of "once", now documented in the docblock and in `DEPLOY.md`.
- The key is recorded before `logger.warn` is called, so a process running at `LOG_LEVEL=error` or `silent` burns the key without printing. No non-test caller of `setLogLevel` exists, so there is no runtime path where the level changes mid-process; rejected rather than patched.
- `warnedMisconfigurations` is unbounded. Its growth is one short string per distinct bad value an owner types, which is bounded in practice for a single-owner deployment.
