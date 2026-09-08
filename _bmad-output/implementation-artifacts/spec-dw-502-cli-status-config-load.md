---
title: 'DW-502: yopedia status must load the stored config before reading effective settings'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
baseline_revision: 'acb8d96eb93fca145e91ad9ed5f69019598230f4'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `hasLLMKey()` reads `loadConfigSync()` for the two store-only providers, so a
      cold CLI or MCP process tells an owner who saved Ollama or Custom that no API
      key is configured.
    evidence: |-
      `src/lib/llm.ts:226-243` falls through to `loadConfigSync()` for
      `cfg.provider === "ollama"` (line 232) and `"custom"` (line 243). `callLLM`
      warms the cache (`src/lib/llm.ts:481`), but `hasLLMKey()` runs first and
      short-circuits: `src/lib/query.ts:330`, `src/lib/ingest.ts:1042` and
      `src/lib/ingest.ts:1562` all gate on it. On a cold process the store leg is
      `{}`, so `pnpm cli query` answers "No API key configured." and ingest
      degrades to the fallback page for a provider the owner did save. Same class
      as DW-502, at a call site DW-502's intent did not reach. `src/mcp.ts`
      exposes the same entry points and warms nothing either.
    location: >-
      src/lib/llm.ts:226-243
    severity: medium
  - summary: >-
      `yopedia status` prints "not configured" for a config object it could not
      read, which is the same sentence it prints when nothing was ever stored.
    evidence: |-
      `runStatus` now warms through `loadConfig()` (`src/lib/config.ts:813-816`),
      which flattens `readStoredConfig`'s `unreadable` answer to `{}`.
      `readConfig()` (`src/lib/config.ts:782`) keeps that distinction. So malformed
      JSON, a non-object parse, or a storage read failure all surface as
      "nothing was ever set" on the one surface with no Settings screen to go and
      look at — the exact conflation DW-402 closed for the `Ollama endpoint:` row,
      one row above it. The intent named `loadConfig()` explicitly, so widening the
      row set was out of scope for DW-502.
    location: >-
      src/cli.ts:584
    severity: medium
  - summary: >-
      `loadConfigSync()`'s doc comment still justifies its `{}` answer with a
      startup sequence that does not exist in this repo.
    evidence: |-
      `src/lib/config.ts:930-937` says the cold-cache `{}` is safe because "The
      app's startup sequence calls `loadConfig()` before any LLM call". There is no
      startup hook: no `instrumentation.ts` anywhere in the repo, and neither
      `next.config.ts` nor `src/app/layout.tsx` calls `loadConfig`. Every surface
      warms at its own call site instead (`src/app/api/status/route.ts:6-8`, and
      now `src/cli.ts`). That comment is the premise DW-502's call site was written
      against; leaving it invites the next caller to make the same assumption.
    location: >-
      src/lib/config.ts:930-937
    severity: low
  - summary: >-
      `src/cli.ts` calls `main()` unconditionally at module load, so every test
      that imports it runs a CLI command and could exit the vitest worker.
    evidence: |-
      There is no `require.main`/`import.meta` guard — `main().catch(...)` runs at
      `src/cli.ts:703`. Under vitest, argv parses to `help`, so importing the module
      prints the whole HELP block into the run's stdout (visible in
      `cli.test.ts` and `cli-status-config-load.test.ts` output today). The catch
      arm ends in `process.exit(1)`, so an argv that parsed to any other command
      would abort the worker mid-collection. Pre-existing; DW-502 added a second
      static importer of the module rather than creating the hazard.
    location: >-
      src/cli.ts:703
    severity: low
---

<intent-contract>

## Intent

**Problem:** `runStatus()` (`src/cli.ts:558-571`) calls `getEffectiveSettings()` with no preceding `await loadConfig()`. `getEffectiveSettings()` reads the store through `loadConfigSync()`, which returns `{}` on a cold cache (`src/lib/config.ts:937-946`), so on a fresh CLI process every ladder's store leg is empty and `yopedia status` reports env-only settings — it cannot see a provider the owner saved, nor a refused stored `ollamaBaseUrl`.

**Approach:** Await `loadConfig()` inside `runStatus()` before reading the effective settings, so the sync cache is warm for the one read that follows. Pin the behaviour with a cold-process test that puts a provider only in the store and asserts the CLI prints it.

## Boundaries & Constraints

**Always:** Keep the printed output shape exactly as it is today — four `Label:\tvalue` rows plus the conditional `Ollama endpoint:` row in its current position. Reuse the existing dynamic `await import("./lib/config")` in `runStatus()` rather than adding a second import site. `loadConfig()` already answers `{}` for a missing or unreadable config, so no new error handling belongs at the call site.

**Block If:** The fix would require changing `loadConfigSync()`'s cold-cache contract or `getEffectiveSettings()`'s signature — both are read by the web surface and the hot path in `llm.ts`, and widening them is a different change from this one.

**Never:** Do not make `getEffectiveSettings()` async. Do not add `loadConfig()` to any other CLI command in this change — DW-502 is scoped to `status`. Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stored-only provider, cold process | `.llm-wiki-config.json` holds `{"provider":"openai"}`; no provider env vars set; config cache never warmed | `LLM provider:\topenai` | No error expected |
| Stored refused endpoint, cold process | Store holds `{"provider":"ollama","ollamaBaseUrl":"localhost:11434"}`; `OLLAMA_BASE_URL` unset | `Ollama endpoint:` row printed carrying the resolver's refusal sentence | No error expected |
| No config object at all | Nothing stored; no provider env vars | `LLM provider:\tnot configured`, exactly four rows, no `Ollama endpoint:` row | `loadConfig()` answers `{}` on ENOENT; nothing thrown |
| Env provider beside a stored one | Store holds `{"provider":"openai"}`, `ANTHROPIC_API_KEY` set | `LLM provider:\topenai` — the store leg still wins the ladder, as it does on the web surface | No error expected |

</intent-contract>

## Code Map

- `src/cli.ts:558-571` -- `runStatus()`. Already destructures from `await import("./lib/config")`; add `loadConfig` there and await it before `const settings = getEffectiveSettings()`. This is the only `getEffectiveSettings()` call in `src/cli.ts`.
- `src/lib/config.ts:813-816` -- `loadConfig()`. Awaits `readStoredConfig()`, which populates `_configCache` on success (`src/lib/config.ts:747`); returns `{}` when the read is unreadable. Never throws for a missing file.
- `src/lib/config.ts:937-946` -- `loadConfigSync()`. Cold cache ⇒ `{}` plus a 5 s empty cache stamp. The bug's mechanism.
- `src/lib/config.ts:1981+` -- `getEffectiveSettings()`. Reads `cfg = loadConfigSync()` once; `cfg.provider`, `cfg.model` and `resolveOllamaBaseUrl(cfg)` (`src/lib/config.ts:479-488`, which produces the refusal sentence for a stored value) are the legs that go blind.
- `src/lib/__tests__/cli.test.ts:331-333` -- `vi.mock("../config", …)` factory exports **only** `getEffectiveSettings`. A `loadConfig` call in `runStatus()` throws `loadConfig is not a function` in all four existing `runStatus` tests until the factory grows the export.
- `src/lib/__tests__/cli.test.ts:369-408,466-612` -- the `effectiveSettings()` fixture and the four existing `runStatus` assertions; the output-shape contract to preserve.
- `src/lib/__tests__/config.test.ts:41-116` -- the temp-`DATA_DIR` harness (`fs.mkdtemp`, env save/clear, `_resetConfigCache()`, `_resetStorage()`) to copy for the cold-process pin.
- `src/lib/paths.ts:7-9` + `src/lib/storage/index.ts:126-133` + `src/lib/config.ts:327-329` -- the filesystem provider roots at `DATA_DIR`, and the config object is `.llm-wiki-config.json` at that root. Writing that file directly is how a test gets a store the in-process cache has never seen.

## Tasks & Acceptance

**Execution:**
- `src/cli.ts` -- in `runStatus()`, destructure `loadConfig` beside `getEffectiveSettings` from the existing `await import("./lib/config")` and `await loadConfig()` before `getEffectiveSettings()`. Add a short WHY comment naming DW-502 and the cold-cache mechanism (`loadConfigSync()` answers `{}` until an async load warms it), in the surrounding file's comment idiom.
- `src/lib/__tests__/cli.test.ts` -- add `loadConfig: vi.fn()` to the `../config` mock factory so the existing `runStatus` suite keeps running, and add one test pinning that `loadConfig` is called and that it is called **before** `getEffectiveSettings` (mock call-order assertion, e.g. via `mock.invocationCallOrder`).
- `src/lib/__tests__/cli-status-config-load.test.ts` -- new node-project suite covering the I/O matrix against the **real** `../config` module: mock only `../wiki` and `../raw` (empty lists), point `DATA_DIR` at a `fs.mkdtemp` dir, write `.llm-wiki-config.json` there directly, clear provider env vars, call `_resetConfigCache()` + `_resetStorage()` so the process is genuinely cold, then run `runStatus()` and assert the printed rows. Restore env, reset caches and remove the temp dir in `afterEach`.

**Acceptance Criteria:**
- Given a config object storing `provider: "openai"` and no provider environment variables, when a cold process runs `runStatus()`, then the output contains `LLM provider:\topenai`.
- Given a config object storing an `ollamaBaseUrl` the resolver refuses and `OLLAMA_BASE_URL` unset, when a cold process runs `runStatus()`, then an `Ollama endpoint:` row is printed carrying the resolver's refusal sentence.
- Given no stored config and no provider environment variables, when a cold process runs `runStatus()`, then exactly four rows print, `LLM provider:\tnot configured` among them, and nothing throws.
- Given the existing `runStatus` unit tests, when the suite runs, then all four still pass unchanged in their assertions, and one further test proves `loadConfig` was awaited before `getEffectiveSettings` was read.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `runStatus()` now awaits `loadConfig()` before reading `getEffectiveSettings()`, so `yopedia status` resolves each ladder against the stored config instead of the environment alone. Printed output shape is unchanged: the same four `Label:\tvalue` rows and the same conditional `Ollama endpoint:` row in the same position.

**Files changed.**
- `src/cli.ts` -- `runStatus()` destructures `loadConfig` from the existing dynamic `./lib/config` import and awaits it before the settings read, with a WHY comment naming DW-502, the 5 s cache TTL, and the per-request precedent at `src/app/api/status/route.ts`.
- `src/lib/__tests__/cli.test.ts` -- `loadConfig: vi.fn()` added to the `../config` mock factory (without it every existing `runStatus` case dies on `loadConfig is not a function`), plus one case pinning that `loadConfig` runs before `getEffectiveSettings` via `mock.invocationCallOrder`.
- `src/lib/__tests__/cli-status-config-load.test.ts` (new) -- five cases against the real `config` module and a real temp store: stored-only provider, stored refused `ollamaBaseUrl`, empty-store output shape, store-beats-env precedence, and a spawned `tsx src/cli.ts status` child process asserting on its stdout.

**Review findings.** 5 patches applied (2 medium, 3 low); 4 items deferred (2 medium, 2 low); 8 rejected as noise. No intent gaps and no spec repairs — the intent named the call site and the fix landed there.

**Follow-up review recommendation:** `true`. Patched findings this pass: high 0, medium 2, low 3. Score = 3x2 + 1x3 = 9, which is >= 5.

**Verification.**
- `pnpm exec vitest run --project node src/lib/__tests__/cli.test.ts src/lib/__tests__/cli-status-config-load.test.ts` -- 92 passed (87 + 5), 2 files.
- `pnpm exec tsc --noEmit` -- exit 0.
- `pnpm exec eslint src/cli.ts src/lib/__tests__/cli-status-config-load.test.ts src/lib/__tests__/cli.test.ts` -- exit 0.
- Negative control, measured twice independently: with `await loadConfig()` removed, 5 cases fail (4 of the 5 in the new file, plus the order pin in `cli.test.ts`). The empty-store case passes either way and is documented as a shape guard rather than a pin.
- Matrix audit: all four I/O matrix rows are covered by a case that ran and passed.

**Residual risks.**
- The spawned-process case shells out to `node_modules/.bin/tsx` with a 30 s timeout; it takes ~0.2 s locally, but it is the only test in this repo that spawns a child process, so it has no precedent to inherit conventions from. It builds its child env explicitly (`PATH`, `HOME`, `NODE_ENV`, `DATA_DIR`) rather than inheriting the suite's mutated `process.env`, and asserts on stdout only so a node deprecation warning on stderr cannot break it.
- The four deferred items in this spec's frontmatter are real and unaddressed, two of them medium: `hasLLMKey()` short-circuits on a cold `loadConfigSync()` for store-only Ollama/Custom owners, and an unreadable config object still prints as "not configured" on this command.

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 4: (high 0, medium 2, low 2)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` The new WHY comment in `src/cli.ts` asserted a startup path that does not exist ("the long-running web surface never sees this because its startup path loads first") and framed the defect as peculiar to fresh processes. Rewritten: the hazard is "no async load inside the last 5 seconds" (`CACHE_TTL_MS`, `src/lib/config.ts:924`), a CLI process is the case that hits it every time, and the cited precedent is the per-request `await loadConfig()` at `src/app/api/status/route.ts:6-8`.
  - `[medium]` `[patch]` No test observed the surface the intent names ("a cold CLI process") — every case called the exported `runStatus()` in-process with a hand-reset cache. Added a fifth case that spawns `node_modules/.bin/tsx src/cli.ts status` against a temp `DATA_DIR` holding a stored provider and asserts on the child's stdout.
  - `[low]` `[patch]` The new suite left `logger.warn` live, so an ambient `LOG_LEVEL=warn` (not scrubbed by `ENV_KEYS`) would leak the refused-endpoint warn line into test output. Stubbed in `beforeEach`, restored in `afterEach`, never asserted on.
  - `[low]` `[patch]` The `ENV_KEYS` comment claimed the list was everything `config.ts` reads; it is not (`FIRECRAWL_API_KEY`, `RESEARCH_PROVIDER`, `SEARXNG_*`, `SERPAPI_*`, `TAVILY_API_KEY` are absent). Claim narrowed to the variables that can decide one of the four printed rows.
  - `[low]` `[patch]` The implementation's negative-control record over-claimed: three of the four original cases fail without the `await`, not four — the empty-store case resolves identically either way. That case's comment now states outright that it is a shape guard, not a DW-502 pin.

## Design Notes

The fix is one awaited call; the weight of the change is the pin. The existing `runStatus` tests mock `../config` wholesale, so they can never observe this bug — a mocked `getEffectiveSettings` returns a full object regardless of cache state. That is why the new suite must use the real config module and a real temp store, and why it writes `.llm-wiki-config.json` with `fs` rather than through `saveConfig()`: `saveConfig()` warms `_configCache` as a side effect (`src/lib/config.ts:915`), which would erase the very cold-cache condition under test.

```ts
// Cold: the file exists, the in-process cache has never seen it.
await fs.writeFile(path.join(tmpDir, ".llm-wiki-config.json"), JSON.stringify({ provider: "openai" }));
_resetConfigCache();
_resetStorage();
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/cli.test.ts src/lib/__tests__/cli-status-config-load.test.ts` -- expected: all tests pass, including the new cold-process pins.
- `pnpm exec tsc --noEmit` -- expected: no new type errors.
- `pnpm exec eslint src/cli.ts src/lib/__tests__/cli-status-config-load.test.ts src/lib/__tests__/cli.test.ts` -- expected: clean.
