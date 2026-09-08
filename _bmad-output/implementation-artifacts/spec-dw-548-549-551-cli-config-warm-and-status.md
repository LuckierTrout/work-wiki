---
title: 'DW-548/549/551: the cold-process config story on the CLI and MCP surfaces'
type: 'bugfix'
created: '2026-08-29'
baseline_revision: 'a8457430025e67bc5dcc5cdd837171b0cd34a4d7'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `hasLLMKey()` keys only off `cfg.provider`, so a store that selects a
      store-only provider through `chatProvider` or `ingestProvider` alone still
      reports that nothing is configured.
    evidence: |-
      The gate reads `cfg.provider` and nothing else (`src/lib/llm.ts:247-270`),
      but `AppConfig` carries `chatProvider` and `ingestProvider` as independent
      workload selections (`src/lib/config.ts:63,66`) and the resolvers honour
      them (`getChatModelSettings` at `src/lib/config.ts:1351`,
      `getIngestModelSettings` at `:1362`). A deployment that sets only
      `chatProvider: "ollama"` therefore has Chat refused by the gate at
      `src/lib/chat.ts:865` for a provider the workload resolver would have
      constructed. Pre-existing — the gate has always read that one field; DW-548
      changed WHERE the field is read from, not WHICH field.
    location: >-
      src/lib/llm.ts:247-270
    severity: low
  - summary: >-
      `src/app/api/status/route.ts` still reads through `loadConfig()`, so the
      web status surface keeps the unreadable-versus-absent conflation DW-549
      just closed on the CLI.
    evidence: |-
      `src/app/api/status/route.ts:7` awaits `loadConfig()`, which flattens
      `readStoredConfig`'s `unreadable` answer to `{}` (`src/lib/config.ts:813`).
      The served `ProviderInfo` therefore reports `configured: false` for a config
      that exists but could not be parsed, exactly as `yopedia status` used to.
      `readConfig()` keeps the distinction and is the same single round-trip.
      DW-549's intent named `yopedia status` only, so the web route was out of
      scope for this bundle.
    location: >-
      src/app/api/status/route.ts:6-8
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three defects share one root — a headless process reads config through a cache nothing warmed. `hasLLMKey()` (`src/lib/llm.ts:226`) resolves the two store-only providers through `loadConfigSync()`, which answers `{}` on a cold cache, so a CLI or MCP process tells an owner who saved Ollama or Custom that no API key is configured. `runStatus()` warms through `loadConfig()`, which flattens `readStoredConfig`'s `unreadable` answer to `{}`, so `status` prints "not configured" for a config it could not read. And `src/cli.ts:703` runs `main()` at module load, so every test importing it runs a CLI command.

**Approach:** Make the gate async-warmed rather than warming at each entry point: `hasLLMKey()` becomes `async` and awaits `loadConfig()` on the store leg, keeping its env fast path so an env-configured deployment pays no read. Every call site awaits it, and a source scan pins that. `runStatus()` reads through `readConfig()` and prints a distinct row when `status !== "ok"`. `src/cli.ts` gets the `process.argv[1]` entrypoint guard `src/mcp.ts:3311-3321` already uses.

## Boundaries & Constraints

**Always:**
- `hasLLMKey()` keeps its env fast path FIRST: when `detectEnvProvider().provider` is set it returns without touching storage, so the ~20 gate call sites add no read on env-configured deployments.
- Every `hasLLMKey(` call in `src/` is `await`ed. An un-awaited call returns a Promise, which is truthy, so `if (!hasLLMKey())` silently passes the gate — and this repo runs no type-aware lint rule that would catch it.
- `status` keeps the `Label:\tvalue` line shape and still prints exactly four rows for a readable-or-absent config. The unreadable row is CONDITIONAL, like `Ollama endpoint:`.
- The `src/cli.ts` guard mirrors `src/mcp.ts:3311-3314` verbatim in shape (`process.argv[1]?.endsWith(...)` for both `.ts` and `.js`), so the two entry points cannot drift.

**Block If:**
- Any `hasLLMKey()` call site turns out to sit in a synchronous function that cannot be made async without changing a public signature.

**Never:**
- Do not warm at the CLI/MCP `main()` instead of at the gate: `loadConfigSync()`'s cache TTL is 5 s (`src/lib/config.ts:928`) and re-stamps `{}` each time it reads cold, so a warm at process start is expired before a multi-second `ingest` reaches its gate.
- Do not rename `hasLLMKey`, change `loadConfigSync()`'s `{}` contract, or make `loadConfig()` carry the `unreadable` distinction — `readConfig()` already does and ~50 callers depend on `loadConfig()`'s lossy shape.
- Do not widen `status` beyond the unreadable row (no new rows for provider source, model, etc.).
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cold process, store-only Ollama | `.llm-wiki-config.json` holds `{provider:"ollama"}`, no LLM env vars, `_configCache` cold | `await hasLLMKey()` is `true` | No error expected |
| Cold process, store-only Custom | store holds `provider:"custom"` with both `customApiKey` and `customBaseUrl` | `await hasLLMKey()` is `true`; only one half stored ⇒ `false` | No error expected |
| Env fast path | `ANTHROPIC_API_KEY` set, no config file on disk | `await hasLLMKey()` is `true` with no storage read | No error expected |
| `status`, unreadable config | config file holds malformed JSON, or a non-object (`[1,2,3]`) | five rows: the four usual ones plus a `Stored config:` row naming the read failure | `readConfig()` returns `unreadable`; nothing throws |
| `status`, absent config | no config file, no env | exactly four rows, no `Stored config:` row | ENOENT is `status: "ok"` with `{}` |
| `src/cli.ts` imported, not executed | `process.argv[1]` is not a `cli.ts`/`cli.js` path | module loads, prints nothing, exits 0 | No `process.exit` |
| `src/cli.ts` executed directly | `tsx src/cli.ts help` | HELP block on stdout, exit 0 | unchanged |

</intent-contract>

## Code Map

- `src/lib/llm.ts:226-243` -- `hasLLMKey()`. Env fast path via `detectEnvProvider()`, then `loadConfigSync()` for `ollama` / `custom`. Becomes `async`; use `const cfg = await loadConfig()` and pass `cfg` to `providerIsConfigured("custom", cfg)` (it takes an optional config — `src/lib/config.ts:1090`), so the store leg never depends on the sync cache. The `loadConfigSync` import (line 11) becomes unused — remove it.
- Call sites to `await` (all already inside `async` bodies, verified): `src/app/api/query/stream/route.ts:135`, `src/lib/search.ts:47`, `src/lib/chat.ts:861,865`, `src/lib/research-runtime.ts:1571`, `src/lib/knowledge-compilation.ts:293`, `src/lib/query.ts:330`, `src/lib/vision.ts:96`, `src/lib/action-extractor.ts:37`, `src/lib/lint-checks.ts:369,516,959`, `src/lib/lint-fix.ts:272,362`, `src/lib/todo-extract.ts:124`, `src/lib/query-search.ts:215`, `src/lib/merge.ts:447`, `src/lib/ingest.ts:1042,1562,1638,2173`, `src/app/api/settings/test/route.ts:15`.
- `src/lib/config.ts:782 readConfig()` / `:813 loadConfig()` / `:709 readStoredConfig()` -- `readConfig` is the only door that tells absent from broken; ENOENT is `{status:"ok", config:{}}`, so an absent file prints no new row. `loadConfig` is the lossy wrapper. Both warm the sync cache identically on the success path.
- `src/cli.ts:588-668 runStatus()` -- swap `loadConfig` for `readConfig` in the dynamic import at line 590; keep the DW-502 comment's substance, retarget it at `readConfig`. `getErrorMessage` lives in `src/lib/errors.ts:7` (dynamic-import it; `cli.ts` has no static imports at all).
- `src/cli.ts:703` -- `main().catch(...)`. Guard it. Copy the shape at `src/mcp.ts:3310-3321`.
- `src/lib/__tests__/cli.test.ts:336-342` -- mocks `../config` with `getEffectiveSettings` + `loadConfig`. Replace `loadConfig` with `readConfig` and give it a default `{status:"ok", config:{}, version:"unstamped", etag:null}` (a bare `vi.fn()` returns `undefined` and `runStatus` would throw on `.status`). Row-count cases at :692 and :714 pin the four-row shape and the `Ollama endpoint:` adjacency (`indexOf(provider row) + 1`) — the new row goes ABOVE `LLM provider:`, which leaves that adjacency intact.
- `src/lib/__tests__/cli-status-config-load.test.ts` -- the real-store/cold-cache harness (temp `DATA_DIR`, `ENV_KEYS` scrub, `storeConfig()` writing via `fs` so the cache stays cold, `logger.warn` stubbed). Extend it for DW-549; its "exactly four rows" case at the empty-store already guards against an unconditional row.
- `src/lib/__tests__/source-scan.ts` -- `walkFiles(dir, {include, skipDirs})`, basename match, absolute paths, `__tests__`/`node_modules`/`.git`/`.next` excluded. The one sanctioned source walker (AGENTS.md).
- Test mocks that stub `hasLLMKey` as a plain boolean (`vi.fn(() => false)` in `query.test.ts`, `ingest.test.ts`, `merge.test.ts`, `lint.test.ts`, `lint-fix.test.ts`, `search.test.ts`, `query-search.test.ts`, `research-runtime.test.ts`, `query-stream-deadline.test.ts`, `todo-extract.test.ts`, `ingest-dedup-ledger.test.ts`, `x-article-teaser-upgrade.test.ts`) need NO change — `await false` is `false`. Only `src/lib/__tests__/settings-runtime-wiring.test.ts:256,259,262,304` calls the REAL `hasLLMKey()` and must await it.
- `src/lib/__tests__/mcp.test.ts:102` keeps `hasLLMKey` real on purpose; its no-key fallback cases go through awaited call sites, so they are unaffected.

## Tasks & Acceptance

**Execution:**
- `src/lib/llm.ts` -- make `hasLLMKey()` `async`, awaiting `loadConfig()` only after the env fast path misses; drop the now-unused `loadConfigSync` import; rewrite the docblock to say the gate warms itself and why (DW-548). -- The gate is the only place that can see the store for every caller at once; the 5 s cache TTL makes entry-point warming unreliable.
- `src/app/api/query/stream/route.ts`, `src/app/api/settings/test/route.ts`, `src/lib/search.ts`, `src/lib/chat.ts`, `src/lib/research-runtime.ts`, `src/lib/knowledge-compilation.ts`, `src/lib/query.ts`, `src/lib/vision.ts`, `src/lib/action-extractor.ts`, `src/lib/lint-checks.ts`, `src/lib/lint-fix.ts`, `src/lib/todo-extract.ts`, `src/lib/query-search.ts`, `src/lib/merge.ts`, `src/lib/ingest.ts` -- `await` every `hasLLMKey()` call. -- An un-awaited call is a truthy Promise and silently opens the gate.
- `src/cli.ts` -- `runStatus()`: import and call `readConfig()` instead of `loadConfig()`, and print a conditional `Stored config:` row above `LLM provider:` when `status !== "ok"`, naming the failure via `getErrorMessage` and saying the rows below reflect the environment only (DW-549). -- "not configured" is the same sentence for "nothing stored" and "could not read it", on the one surface with no Settings screen.
- `src/cli.ts` -- guard `main().catch(...)` behind a `process.argv[1]?.endsWith("cli.ts") || …("cli.js")` check, mirroring `src/mcp.ts` (DW-551). -- Importing the module in a test currently runs a command and can `process.exit` the vitest worker.
- `src/lib/__tests__/llm-key-cold-config.test.ts` (new) -- cold-store cases for the I/O matrix's first three rows against the REAL config module and a real temp `DATA_DIR`, plus a `walkFiles` scan asserting every `hasLLMKey(` call in `src/` is awaited (carry a member pin naming `src/lib/query.ts`, `src/lib/ingest.ts` and `src/app/api/query/stream/route.ts`, and a count floor, per the AGENTS.md scan idiom). -- Pins both the fix and the silent-truthy regression it opens.
- `src/lib/__tests__/cli-status-config-load.test.ts` -- add malformed-JSON and non-object-JSON cases asserting the `Stored config:` row; add `not.toContain("Stored config:")` to the existing empty-store four-row case. -- The unreadable/absent distinction is the whole of DW-549.
- `src/lib/__tests__/cli.test.ts` -- swap the `../config` mock's `loadConfig` for `readConfig` with an `ok` default. -- Keeps the mocked suite loading after the `runStatus` change.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- await the four real `hasLLMKey()` assertions. -- The gate is async now.
- `src/lib/__tests__/cli-entrypoint-guard.test.ts` (new) -- spawn `tsx` on a temp `.mts` script that dynamically imports the absolute path to `src/cli.ts` and prints a sentinel; assert the sentinel appears and the HELP block does not. Add the control: `tsx src/cli.ts help` still prints HELP. -- `src/cli.ts` has zero static imports, so importing it from a temp file needs no alias or dependency resolution.

**Acceptance Criteria:**
- Given a process whose config cache has never been warmed and a store holding only `{provider:"ollama"}`, when `hasLLMKey()` is awaited, then it resolves `true`.
- Given `ANTHROPIC_API_KEY` is set and no config file exists, when `hasLLMKey()` is awaited, then it resolves `true` without reading the store.
- Given `src/` on disk, when the source scan runs, then no file contains a `hasLLMKey(` call that is not immediately preceded by `await`, and the scan reports at least fifteen call sites across the pinned files.
- Given a config file that is not readable as a JSON object, when `yopedia status` runs, then its output carries a `Stored config:` row naming the failure, distinct from the `LLM provider:\tnot configured` sentence.
- Given no config file and no LLM environment, when `yopedia status` runs, then it prints exactly four rows and no `Stored config:` row.
- Given a process whose `process.argv[1]` is not a `cli.ts`/`cli.js` path, when `src/cli.ts` is imported, then no command runs, nothing is printed, and the process does not exit non-zero.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 2: (high 0, medium 0, low 2)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The new `Stored config:` row interpolated `getErrorMessage` verbatim, and V8's `JSON.parse` error quotes the offending bytes back — a config file holding a newline printed a second, unlabelled physical line and detached the caveat from its label, breaking the `Label:\tvalue` shape the surrounding comment calls load-bearing. Reproduced live. The message is now whitespace-collapsed and length-capped, and a multi-line malformed-config case asserts no printed entry contains a newline.
  - `[medium]` `[patch]` DW-548's ledger entry locates the symptom at a process (`pnpm cli query` answering "No API key configured."), but every new case ran in-process against a hand-reset cache. Added a spawned-process case: a seeded wiki plus a store-only `custom` provider, asserting the ledger's own sentence is gone and the run instead fails downstream on the model refusal, with a no-config control that the sentence still appears.
  - `[low]` `[patch]` `src/app/api/settings/test/route.ts` warmed with `await loadConfig()` immediately before the gate, which now loads the config itself — two full storage round-trips per request with a window between them. Removed.
  - `[low]` `[patch]` The gate does I/O now, so three call sites paid a storage read to answer a question a free local predicate already settled. Reordered the operands at `src/lib/search.ts:47`, `src/lib/knowledge-compilation.ts:293` and `src/lib/query-search.ts:215`. `src/lib/ingest.ts:2173` left alone — `canReconcileWithLlm` is read twice, so it must stay a variable.
  - `[low]` `[patch]` The await scan exonerated a whole line if an awaited call matched it anywhere, so a line holding both an awaited and a bare call passed. Offenders are now found by deleting every awaited occurrence and asking whether a bare one survives.
  - `[low]` `[patch]` Nothing pinned that an UNREADABLE store closes the gate cleanly rather than rejecting into ~20 call sites with no `try` between them and it. Added that case.
  - `[low]` `[patch]` The `not.toContain("Stored config:")` guard existed only on the empty-store case, so a readable non-empty store was never pinned as printing no row. Added it to the stored-provider case.

## Design Notes

The gate, after:

```ts
export async function hasLLMKey(): Promise<boolean> {
  if (detectEnvProvider().provider) return true;
  // The store leg needs the STORE. `loadConfigSync()` cannot read it (DW-548).
  const cfg = await loadConfig();
  if (cfg.provider === "ollama") return true;
  return cfg.provider === "custom" && providerIsConfigured("custom", cfg);
}
```

Passing `cfg` to `providerIsConfigured` rather than letting it re-enter `loadConfigSync()` means the answer comes from one snapshot, not from a cache that may have expired between the two reads.

Why the `Stored config:` row sits ABOVE `LLM provider:` and not beside it: an unreadable store degrades every settings row below it to environment-only, so it is a caveat on all three, not a note on one. `Ollama endpoint:` stays immediately after the provider verdict because it qualifies exactly that subject.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/llm-key-cold-config.test.ts src/lib/__tests__/cli-status-config-load.test.ts src/lib/__tests__/cli-entrypoint-guard.test.ts src/lib/__tests__/cli.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts` -- expected: all pass.
- `pnpm test` -- expected: no new failures against the pre-change baseline.
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm lint` -- expected: no new errors.
- `pnpm cli status` -- expected: the four rows; no HELP block, no stray output.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

The three defects shared one root — a headless process reading config through a cache nothing warmed — and are closed together.

**DW-548.** `hasLLMKey()` is now `async` and warms itself. The `detectEnvProvider()` fast path stays first, so an env-configured deployment still answers without touching storage; the store leg awaits `loadConfig()` and forwards that one snapshot into `providerIsConfigured("custom", cfg)` rather than letting it re-enter a 5 s-TTL cache. Warming at the gate rather than at each `main()` was deliberate: the TTL expires long before a multi-second `ingest` reaches its gate, so entry-point warming would have been unreliable. All 22 call sites now `await`, and a source scan pins that they keep doing so — a dropped `await` yields a truthy Promise that silently opens the gate, and this repo runs no type-aware lint rule that would catch it.

**DW-549.** `runStatus()` reads through `readConfig()`, the only door that tells an absent store from an unreadable one, and prints a conditional `Stored config:` row above `LLM provider:` — above, because an unreadable store degrades every settings row below it to the environment alone. The interpolated failure message is whitespace-collapsed and length-capped so the `Label:\tvalue` shape survives a parser error that quotes newline-bearing bytes back.

**DW-551.** `main().catch(...)` is behind a `process.argv[1]` entrypoint check mirroring `src/mcp.ts`, so importing the module runs no command and cannot `process.exit` a vitest worker.

### Files changed

- `src/lib/llm.ts` — `hasLLMKey()` becomes async and warms itself; `loadConfigSync` import dropped.
- `src/cli.ts` — `runStatus()` reads through `readConfig()` and prints the conditional unreadable row; `main()` guarded on being the process entrypoint.
- `src/app/api/settings/test/route.ts` — awaits the gate; redundant `loadConfig()` warm removed.
- `src/app/api/query/stream/route.ts`, `src/lib/{chat,ingest,lint-checks,lint-fix,merge,query,research-runtime,todo-extract,vision,action-extractor}.ts` — await the gate.
- `src/lib/{search,knowledge-compilation,query-search}.ts` — await the gate, with the free local predicate reordered ahead of it.
- `src/lib/__tests__/llm-key-cold-config.test.ts` (new) — cold-store gate cases, the spawned cold-CLI case, and the repo-wide await scan.
- `src/lib/__tests__/cli-entrypoint-guard.test.ts` (new) — spawned import-does-nothing and executed-still-works cases.
- `src/lib/__tests__/cli-status-config-load.test.ts` — unreadable-store rows, placement, and the readable/absent pins.
- `src/lib/__tests__/cli.test.ts` — `../config` mock swapped to `readConfig`.
- `src/lib/__tests__/settings-runtime-wiring.test.ts`, `llm.test.ts`, `lifecycle.test.ts` and eleven mock-carrying suites — await the real gate; `mockReturnValue` → `mockResolvedValue` where the mock types against the real signature.

### Review findings

- Patches applied: 7 (medium 2, low 5) — see the Review Triage Log entry for each.
- Deferred: 2 (both low) — the gate reads only `cfg.provider`, and `src/app/api/status/route.ts` keeps the conflation DW-549 closed on the CLI.
- Rejected: 10 — API-symmetry suggestions, test-file organisation, widening the scan past `src/` (nothing outside it imports `src/lib`), and re-litigating the entrypoint heuristic the intent left open and `src/mcp.ts` already ships.

Follow-up review recommended: **true**. Patched this pass: high 0, medium 2, low 5 → score 3×2 + 1×5 = 11, at or above the threshold of 5.

### Verification

- `pnpm exec vitest run --project node` over the five targeted suites — 169 passed.
- `pnpm test` — 350 files, 8108 passed, 1 skipped, 0 failed. One earlier post-patch run reported a single failure that did not reproduce across two subsequent full runs and three repeats of the spawn-heavy suites (22 passed each time); it is recorded here as an observed flake rather than explained away.
- `pnpm exec tsc --noEmit` — clean.
- `pnpm lint` — exit 0 (only the pre-existing `jsx-ast-utils` plugin warnings).
- `pnpm cli status` — four rows, no HELP block, exit 0.
- Each new guard was checked against the defect it pins: reverting the message flattening fails the multi-line case; restoring `loadConfigSync()` on the store leg fails the spawned CLI case with the ledger's own "No API key configured." sentence; injecting a mixed awaited/bare line fails the scan.

### Residual risks

- A store-configured deployment now pays one config read per gate call. The three sites where that read bought nothing were reordered; the rest sit immediately beside LLM work that costs orders of magnitude more, and `src/lib/ingest.ts:2173` keeps its single read because `canReconcileWithLlm` is consumed twice.
- The entrypoint guard is a filename heuristic (`endsWith("cli.ts")`), matching `src/mcp.ts` rather than an `import.meta`/`argv[1]` identity comparison. It is exact for every current invocation (`package.json` declares one `cli` script and no `bin`), and consistency with the shipped sibling was the stated trade.
- The await scan walks `src/` only. Nothing outside it imports `src/lib` — the sidecar and the Workers are architecturally forbidden to — so there is no reachable gap today, but a future importer elsewhere would not be covered.
- DW-618 in the ledger is now stale in part: its `reason` text describes `hasLLMKey` calling `providerIsConfigured("custom")` without forwarding the config, which `src/lib/llm.ts` now does. Flagged for the orchestrator's sweep; this session did not touch the ledger.
