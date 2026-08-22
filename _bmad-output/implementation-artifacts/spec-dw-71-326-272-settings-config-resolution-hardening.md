---
title: 'Settings config resolution hardening (DW-71, DW-326, DW-272)'
type: 'bugfix'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      `detectEnvProvider()` and the embedding provider detection still select `ollama`
      from the mere presence of `OLLAMA_BASE_URL`, including a value `getOllamaBaseUrl`
      now refuses.
    evidence: |-
      src/lib/config.ts:739-742 and src/lib/embeddings.ts:217 branch on the variable's
      presence, not on its usability. After DW-326 a typo'd `OLLAMA_BASE_URL=localhost:11434`
      both SELECTS the ollama provider and resolves to no endpoint, so generation and embed
      silently go to the SDK's own localhost default instead of failing against the address
      the owner typed. Pre-existing detection logic; the fall-through this bundle chose over a
      refusal is what makes the outcome silent. Closing it means either detecting through the
      validated accessor or writing down why detection deliberately answers a wider question.
    location: >-
      src/lib/config.ts:739
    severity: medium
  - summary: >-
      The filesystem provider's compare-and-set is best-effort: its etag is `mtime-size` and
      its read pairs `readFile` with `stat`, so a losing compare-and-set can still win there.
    evidence: |-
      src/lib/storage/filesystem.ts:266-299. `readFileWithEtag` resolves `fs.readFile` and
      `fs.stat` through `Promise.all` — an unordered pair, so a write landing between them can
      yield old content with a fresh etag, and the CAS then MATCHES on a stale merge base. The
      etag itself is `${mtime.getTime()}-${size}`, so two saves in the same millisecond that
      swap equal-length values collide. Measured ~190/200 identical etags for back-to-back
      rewrites without fsync on a scratch file, 0/100 through the provider's fsync+rename path.
      Never worse than the unconditional write it replaced, and R2's server-side conditional put
      is exact — but the fs guard is narrower than "refuses instead" reads. Closing it means a
      content hash or stat-then-read ordering in the storage layer, whose contract and other
      consumer (graphify-jobs.ts) are outside this bundle. Documented at src/lib/config.ts's
      saveConfig docblock rather than hidden.
    location: >-
      src/lib/storage/filesystem.ts:266
    severity: medium
  - summary: >-
      A pre-DW-272 build reading the new single-object config carries `__settingsVersion`
      through as an ordinary key and writes it back, so the stamp stops rotating on a rollback.
    evidence: |-
      The retired scheme's `readStoredConfig` returned the parsed object verbatim and `saveConfig`
      wrote whatever it was handed, so an older build round-trips the reserved key untouched while
      stamping its sibling file. The new build then keeps reading the same frozen token out of the
      object. The guard degrades to always-matching rather than losing data, and this fork deploys
      manually via wrangler with no rolling releases, so the window is a deliberate rollback.
      Namespacing the key per scheme, or refusing a token whose config predates the scheme, would
      close it.
    location: >-
      src/lib/config.ts (CONFIG_VERSION_KEY)
    severity: low
baseline_revision: 'b91e764bce8eae383511d7fc09de8aee0d4cd067'
---

<intent-contract>

## Intent

**Problem:** Three read-side gaps in `src/lib/config.ts` let what is stored, what the environment overrides, and what reaches a provider SDK disagree. `LLM_CUSTOM_BASE_URL` wins at runtime but the Custom endpoint box shows only the store, so it can be typed into and saved with no effect (DW-71). `getOllamaBaseUrl()` returns the stored/env string literally with no URL check, so a value stored before DW-304's write-time rule — or any `OLLAMA_BASE_URL` — still reaches the provider SDK (DW-326). And the settings precondition token lives in a second object beside the config, a pairing R2 cannot keep consistent across two keys (DW-272).

**Approach:** Serve the env endpoint as its own payload field and say it on the row with the copy function the embedding rows already use; validate the Ollama endpoint at the accessor with a warn-once and a fall-through, and route every SDK-facing reader through that one accessor; and fold the version token into the config object itself, guarding the save with the storage layer's `writeFileIfMatch` compare-and-set.

## Boundaries & Constraints

**Always:**
- The served version token stays OPAQUE and derived from nothing in the config (AD-23): a random `s1:` stamp, never an etag or any hash of bytes that include `customApiKey` / `embeddingApiKey` / `firecrawlApiKey`. The etag is an INTERNAL compare-and-set input and must never appear in a response body.
- `AppConfig` as handed to its ~50 consumers keeps exactly today's shape: the token key is written into the stored JSON and STRIPPED on read, so `loadConfig()` round-trips the caller's object unchanged.
- One ladder per fact. `getOllamaBaseUrl()` is the only place the `OLLAMA_BASE_URL` → stored → none ladder is spelled; `getResolvedCredentials` and `getConfiguredModel` call it rather than re-deriving it.
- An invalid endpoint FALLS THROUGH rather than throwing: an unusable env value falls to the stored one, an unusable stored value falls to `undefined`, and the SDK gets its own default. The warning is said once per distinct bad value per process, like `warnOnceAbout` in `embeddings.ts`.
- A refused/lost save writes nothing.

**Block If:**
- Closing DW-272 would require serving a content-derived version (an etag) to the browser — that is the AD-23 leak the current design exists to avoid, and a different scheme would be needed.

**Never:**
- Do not touch the deferred-work ledger (`_bmad-output/implementation-artifacts/deferred-work.md`); the orchestrator records resolution.
- Do not add a second editor for `customBaseUrl` on the flat `/settings` page, do not disable the Custom endpoint box, and do not seed the draft from the env value — the box edits the store, which is what applies once the variable is unset.
- Do not build an R2-backed test harness, and do not split `hasCustomApiKey` into env/store halves (DW-66) or key endpoints per provider (DW-70/DW-72) — separate open entries.
- Do not add a `deleteFile` sweep of the orphan `.llm-wiki-config.version`; a migrated store simply stops reading it.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Env endpoint announced | `LLM_CUSTOM_BASE_URL=https://env.example/v1`, store holds `https://saved.example/v1` | Payload carries `envCustomBaseUrl` = the env value; the Custom base URL row still shows the STORED value and its hint carries `settingsEnvOverrideCopy("customBaseUrl", …)` naming `LLM_CUSTOM_BASE_URL` | No error expected |
| Env endpoint blank | `LLM_CUSTOM_BASE_URL=""` or whitespace | `envCustomBaseUrl` is `null`, no notice rendered, stored value still applies | No error expected |
| Bad stored Ollama URL | store holds `file:///etc/passwd`, no env var | `getOllamaBaseUrl()` returns `undefined`; SDK falls to its own default | `logger.warn` once for that value |
| Bad env Ollama URL | `OLLAMA_BASE_URL=localhost:11434`, store holds `http://ollama.internal:11434` | `getOllamaBaseUrl()` returns the STORED value | `logger.warn` once for that value |
| Both bad | env and store both unusable | `undefined` | one warning per distinct value |
| Repeat reads | the same bad value read N times in one process | exactly ONE warning | — |
| Two-file store migrates | config object with no embedded token, stale `.llm-wiki-config.version` on disk | `readConfig()` answers `ok` with the sentinel; the next save writes a single object carrying a real token | No error expected |
| Losing compare-and-set | the config object changed between this request's read and its write | `saveConfig` answers `conflict`; `PUT` answers 412 with `WRITE_CONFLICT_COPY` and nothing is written | 412, draft stays on screen |
| Malformed embedded token | stored JSON holds a token key that is not a `s1:` stamp | sentinel, logged; the next save heals it | No error expected |
| Unreadable store | config file is not JSON / not an object / storage error | `unreadable`, `CONFIG_UNREADABLE_COPY`, 503 | unchanged |

</intent-contract>

## Code Map

- `src/lib/config.ts` — all three fixes land here.
  - `getOllamaBaseUrl()` :259 — the DW-326 site; today `process.env.OLLAMA_BASE_URL ?? cfg.ollamaBaseUrl ?? undefined`, no validation. Give it an optional `cfg` parameter defaulting to `loadConfigSync()`, the DW-313 pattern `getEmbeddingModelName(cfg)` already uses.
  - `getResolvedCredentials()` :1386, ollama leg ~:1427 — a SECOND copy of the same ladder, and the one that reaches `createOllama` via `llm.ts:315`. Must call the accessor with the `cfg` it already read.
  - `getCustomBaseUrl()` :671 — the env-wins resolution DW-71 makes visible. Unchanged; it is the fact the new field reports.
  - `getWorkbenchSettings()` :1101 — add `envCustomBaseUrl` beside `envEmbeddingModel` (:1140). `customBaseUrl` stays the store-only value.
  - `configVersionRelPath()` :229, `readStoredVersion()` :430-448, `readConfig()` :482, `saveConfig()` :541 — the two-file scheme DW-272 replaces. `readStoredVersion` and `configVersionRelPath` go away entirely.
  - `readStoredConfig()` :373 — switch `readFile` to `readFileWithEtag`, extract+strip the token, return the etag. `isEnoent` covers R2's `R2NotFoundError` (`storage/r2.ts:357` sets `code = "ENOENT"`).
  - `UNSTAMPED_CONFIG_VERSION` :325, `isStoredConfigVersion()` :406, `newConfigVersion()` :342 — keep; only where the token is READ FROM changes. Their docblocks describe a sibling file and must be rewritten.
- `src/lib/workbench-settings.ts` — `WorkbenchSettingsPayload` (:483 env block) add `envCustomBaseUrl: string | null`; `isWorkbenchSettingsPayload` (:593) add `nullableString("envCustomBaseUrl")`; `settingsEnvOverrideCopy` :328 widen `kind` to include `"customBaseUrl"` → `LLM_CUSTOM_BASE_URL`. `isAbsoluteHttpUrl` :1131 is the validator DW-326 reuses (config.ts already imports from this module — no new cycle).
- `src/components/workbench/SettingsCanvas.tsx` :507 — `textRow("customBaseUrl", "Custom base URL")` gains a hint, exactly as the embedding rows at :560/:596 do.
- `src/lib/embeddings.ts` :71-78 `warnOnceAbout` — the warn-once shape to mirror (module-level `Set`, key = the misconfiguration's identity). config.ts needs its own local copy; do not import it (embeddings.ts imports config.ts).
- `src/lib/llm.ts` :412-417 — `getConfiguredModel`'s workload-`ollama` leg reads `process.env.OLLAMA_BASE_URL` raw, a THIRD ladder. Route it through `getOllamaBaseUrl()`. This also makes a stored endpoint apply to workload-routed ollama, matching the primary path.
- `src/app/api/settings/route.ts` :73/:262 `readConfig()`, :478 `saveConfig(merged)` — the only production caller of `saveConfig`. Must thread the etag and answer 412 on a lost compare-and-set. `checkWritePrecondition` / `WRITE_CONFLICT_COPY` in `src/lib/write-precondition.ts` already own the 412 wording.
- `src/lib/storage/types.ts` :237-257 — `readFileWithEtag` / `writeFileIfMatch` contract; `writeFileIfMatch` returns `false` on a missing file, so a FIRST write (no etag) must use plain `writeFile`.
- Tests to amend: `src/lib/__tests__/config.test.ts` (:126 `VERSION_FILE`, :175 no-token-file, :185 empty token, :236 EISDIR, :306 token-file-write-order, :331 "lives in a SIBLING FILE" — all describe the retired scheme), `src/lib/__tests__/settings-route.test.ts`, `src/lib/__tests__/workbench-settings.test.ts` (:278 fixture), `src/components/workbench/__tests__/settings-read-only.test.tsx` (:60), `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` (:56), `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` (:72) — four payload fixtures need the new field.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` — widen `settingsEnvOverrideCopy`'s `kind` to `"provider" | "model" | "customBaseUrl"` mapping to `LLM_CUSTOM_BASE_URL`; add `envCustomBaseUrl: string | null` to `WorkbenchSettingsPayload` with a docblock saying why it rides apart from the editable `customBaseUrl`; add its `nullableString` check to `isWorkbenchSettingsPayload` — one sentence, one shape, for the third variable that wins at runtime.
- `src/lib/config.ts` (DW-71) — serve `envCustomBaseUrl: nonEmpty(process.env.LLM_CUSTOM_BASE_URL)` from `getWorkbenchSettings`, leaving `customBaseUrl` the stored value, so the payload reports both halves of what `getCustomBaseUrl()` already resolves.
- `src/components/workbench/SettingsCanvas.tsx` (DW-71) — pass the override sentence as the Custom base URL row's hint when `stored.envCustomBaseUrl` is set; described, never marked invalid and never disabled, matching the embedding model row.
- `src/lib/config.ts` (DW-326) — add a module-local warn-once helper and validate in `getOllamaBaseUrl(cfg = loadConfigSync())`: take the env value only if `isAbsoluteHttpUrl`, else the stored value only if `isAbsoluteHttpUrl`, else `undefined`; warn once per rejected value naming where it came from. Have `getResolvedCredentials` call it with its own `cfg` instead of re-deriving the ladder.
- `src/lib/llm.ts` (DW-326) — replace the raw `process.env.OLLAMA_BASE_URL` read in `getConfiguredModel`'s `ollama` case with `getOllamaBaseUrl()`, so no SDK-facing reader bypasses the check.
- `src/lib/config.ts` (DW-272) — fold the token into the config object under one reserved key: `readStoredConfig` reads via `readFileWithEtag`, lifts the token, strips the key from the returned `AppConfig` and returns the etag; `readConfig` returns `{ status, config, version, etag }` with no second read; `saveConfig(config, ifMatch?)` writes `{…config, [key]: newConfigVersion()}` through `writeFileIfMatch` when given an etag (answering `{ status: "conflict" }` on `false`) and through `writeFile` when not, returning `{ status: "ok", version }`. Delete `configVersionRelPath`, `readStoredVersion`, and every docblock claim that the token is a sibling file; keep `UNSTAMPED_CONFIG_VERSION`, `isStoredConfigVersion` and the self-heal behaviour for a missing or malformed embedded token.
- `src/app/api/settings/route.ts` (DW-272) — carry `read.etag` into `saveConfig(merged, read.etag)` and answer 412 with `WRITE_CONFLICT_COPY` when it comes back `conflict`; keep the existing `checkWritePrecondition` If-Match check ahead of the merge unchanged.
- `src/lib/__tests__/config.test.ts` — retire the sibling-file tests (no-token-file, empty-token-file, EISDIR, write-order, "lives in a SIBLING FILE") and cover the matrix above: single-object round-trip with the token stripped from `loadConfig`, migration from a two-file store, malformed embedded token self-heal, a LOSING compare-and-set, the token still derived from nothing, and each Ollama URL validation row including the warn-once count.
- `src/lib/__tests__/settings-route.test.ts` — cover a `PUT` whose compare-and-set loses: 412, `WRITE_CONFLICT_COPY`, store unchanged.
- `src/lib/__tests__/workbench-settings.test.ts`, `src/components/workbench/__tests__/settings-read-only.test.tsx`, `src/components/workbench/__tests__/settings-vector-namespace.test.tsx`, `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` — add `envCustomBaseUrl` to the payload fixtures and assert the Custom endpoint notice renders (and does not when the variable is unset).

**Acceptance Criteria:**
- Given `LLM_CUSTOM_BASE_URL` is set, when the Workbench Settings canvas renders the LLM Models category, then the Custom base URL row shows the stored value, stays editable, and its accessible description names `LLM_CUSTOM_BASE_URL` and its value.
- Given `LLM_CUSTOM_BASE_URL` is unset, when the same row renders, then no override sentence appears and the row's description is unchanged from today.
- Given a stored or env Ollama endpoint that is not an absolute http(s) URL, when any provider SDK is constructed for `ollama`, then the SDK receives the next valid value in the ladder or none at all, and the process logs exactly one warning for that value however many times it is read.
- Given a store written by the previous two-file scheme, when the settings route reads it and the owner then saves, then the read succeeds, the save lands, and the store afterwards holds ONE object carrying both the settings and a fresh `s1:` token.
- Given the stored config object changed between a request's read and its write, when that request saves, then it is refused with 412 and the store still holds the other writer's value.
- Given any settings response, when it is inspected, then no etag and no value derived from the config bytes appears in it.

## Design Notes

DW-272's recorded decision names both halves — "single object" AND "via `writeFileIfMatch`" — and they are complementary, not alternatives. The token inside the object is what makes a READ consistent on any backend (one object, one round-trip, no pairing to get wrong). The compare-and-set is what makes a WRITE safe: the route's If-Match check compares the owner's draft token against the store, but the read-modify-write inside one request is still a window a concurrent save can land in, and `writeFileIfMatch` closes it. Using the etag AS the served version was rejected: R2's etag is an MD5 of the bytes, and those bytes hold three API keys — the AD-23 leak `newConfigVersion`'s docblock exists to prevent. The etag stays internal.

Shape of the stored object:

```jsonc
// .llm-wiki-config.json — one object, one read
{ "provider": "openai", "__settingsVersion": "s1:0f16…" }
```

`readStoredConfig` strips `__settingsVersion` before returning, so `loadConfig()` and every consumer see exactly the fields they saw before. A first write (no prior object, so no etag) uses plain `writeFile`; two concurrent first writes both land and the last wins — the storage interface exposes no if-none-match, and the window is one save on a store that has never been written. Say so in the docblock rather than pretending it is closed.

## Verification

**Commands:**
- `pnpm test src/lib/__tests__/config.test.ts src/lib/__tests__/settings-route.test.ts src/lib/__tests__/workbench-settings.test.ts` -- expected: all pass, including the new migration, losing-CAS and URL-validation cases
- `pnpm test` -- expected: full suite green, no regression in the ~50 `loadConfig` consumers or the brand-copy scan
- `pnpm lint` -- expected: clean
- `npx tsc --noEmit` -- expected: clean; the `saveConfig` return-type change surfaces every caller

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** Closed the three read-side gaps the bundle named. `LLM_CUSTOM_BASE_URL` now rides on the settings payload as `envCustomBaseUrl` and is said out loud on the Custom base URL row through the same `settingsEnvOverrideCopy` the embedding rows use — the box still edits the store, stays editable and is never marked invalid. `getOllamaBaseUrl()` became the one validated ladder: an endpoint that is not an absolute http(s) URL falls through (env → store → none) with one warning per distinct rejected value per process, and every reader that reaches a provider SDK — `getResolvedCredentials`, `getConfiguredModel`'s ollama leg, `_createEmbeddingModel` — plus the reporting reader `getEffectiveSettings` now goes through it. And the settings precondition token moved inside the config object under a reserved key that is stripped on read, so one object carries both the bytes and the token on any backend, with `writeFileIfMatch` guarding the save and a lost compare-and-set answered 412.

**Files changed:**
- `src/lib/config.ts` — all three fixes: `envCustomBaseUrl` on the payload; validated `getOllamaBaseUrl(cfg)` with a module-local warn-once; the two-file token scheme replaced by a single object plus compare-and-set (`configVersionRelPath` and `readStoredVersion` deleted, `readConfig` returns an etag, `saveConfig` returns `ok`/`conflict`).
- `src/lib/workbench-settings.ts` — `envCustomBaseUrl` on `WorkbenchSettingsPayload` and its type guard; `settingsEnvOverrideCopy` widened to name `LLM_CUSTOM_BASE_URL`.
- `src/components/workbench/SettingsCanvas.tsx` — the Custom base URL row carries the override sentence as its accessible description.
- `src/lib/llm.ts` — `getConfiguredModel`'s ollama leg resolves through the accessor instead of reading the env var raw.
- `src/lib/embeddings.ts` — the ollama embedding leg passes its `cfg` snapshot to the accessor (DW-313).
- `src/app/api/settings/route.ts` — threads the read's etag into the write, answers 412 on a lost compare-and-set, and the two write-door comments were restated.
- `src/lib/storage/r2.ts`, `src/lib/storage/cloudflare-types.ts` — `readFileWithEtag` returns the raw `etag` rather than the quoted `httpEtag`, which is what `onlyIf.etagMatches` compares.
- `src/lib/write-precondition.ts` — docblock references to the retired sibling file.
- Tests: `config.test.ts`, `settings-route.test.ts`, `workbench-settings.test.ts`, `settings-runtime-wiring.test.ts`, `storage-r2.test.ts`, `settings-read-only.test.tsx`, `settings-vector-namespace.test.tsx`, `settings-page-legacy-surface-parity.test.tsx`.

**Review findings breakdown:** 14 patches applied (1 high, 2 medium, 11 low), 3 items deferred (2 medium, 1 low), 4 rejected. No intent gaps and no spec repairs. Follow-up review recommended: **true** — one patched finding was high severity (score 3x2 + 1x11 = 17, threshold 5).

**Verification.** `npx tsc --noEmit` clean. `npx eslint` clean (exit 0; only the pre-existing `jsx-ast-utils` TSNonNullExpression notices, which are not diagnostics). `npx vitest run` — 260 files, 5688 tests, all passing. Every row of the I/O matrix has a covering test that ran and passed: the DW-71 rows in `workbench-settings.test.ts` and `settings-read-only.test.tsx`, the four Ollama URL rows and the warn-once rows in `config.test.ts`, and the migration, losing-CAS, malformed-token and unreadable rows in `config.test.ts`, `settings-route.test.ts` and `storage-r2.test.ts`.

**Residual risks.**
- The R2 compare-and-set is still exercised only against `createMockR2Bucket`, not real R2. The mock was rebuilt to store a raw etag and reject the quoted form, so it now fails on the specific mismatch that would have locked Workers deployments out of saving — but a real-R2 semantics difference remains unobservable to the suite.
- On the filesystem provider the compare-and-set is narrower than the refusal reads: the etag is `mtime-size` and the read pairs `readFile` with `stat`. Documented in `saveConfig`'s docblock and deferred.
- A store that has never been written has no etag, so two concurrent first saves both land and the last wins; the storage interface exposes no if-none-match. Documented and pinned by a test.
- `getConfiguredModel`'s workload-routed ollama leg now honours a STORED endpoint, which it previously ignored. This is the intended consequence of collapsing the ladders and matches the primary path, but it is a behaviour change the ledger entry did not name.
- Upgrading a two-file deployment enters the already-documented unstamped window for exactly one save, and a draft held open across the upgrade is answered 412 once before a reload recovers it.
