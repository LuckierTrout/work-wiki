---
title: 'DW-68/DW-70 — embedding config plumbing: ingest vector gate and the ollama endpoint split'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      With vector search switched ON but no embedding provider actually resolvable,
      `findMergeCandidates` now takes the vector branch, gets an empty result, and
      returns early instead of falling through to the BM25 branch it used to take.
    evidence: |-
      `getVectorSearchSettings()` always passes `hasWorkersAiBinding: null`
      (config.ts:1653, DW-225), and `vectorSearchMissingLegs` applies the binding
      leg only on an explicit `false` (workbench-settings.ts:1588). So a store
      holding `embeddingProvider: "workers-ai"`, a supported `@cf/` model and
      `vectorSearchEnabled: true`, running OFF Workers, reports `enabled: true`
      while `resolveEmbeddingProvider` returns `null`. `searchByVector` then
      returns `[]` (embeddings.ts:1106) and `findMergeCandidates` returns that
      empty list without reaching `buildCorpusStats`/`bm25Score`. Before DW-68 the
      gate was `hasEmbeddingSupport()`, which is `false` there, so the BM25 branch
      ran and merge de-duplication worked. Consequence on such a deployment: every
      ingest forks a new page instead of merging, silently. Root cause is the
      pre-existing `hasWorkersAiBinding: null` hole rather than this change, and
      the three candidate fixes (fall through on empty results, conjoin
      `hasEmbeddingSupport()`, or close the binding hole) each diverge from the
      recorded DW-68 decision, so this wants its own decision. Reachable only on a
      misconfigured deployment that already embeds nothing at all.
    location: >-
      src/lib/ingest.ts:1048
    severity: low
baseline_revision: '88f1e0fa95147695e21bdfcedcbd3e5696035081'
---

<intent-contract>

## Intent

**Problem:** Two recorded embedding-config decisions are unapplied. (DW-68) `findMergeCandidates` in `src/lib/ingest.ts` gates its vector branch on `hasEmbeddingSupport()`, so an owner who pastes a key into Settings → Embeddings and leaves the vector switch off — the shipped default — silently flips ingest's merge retrieval onto `searchByVector`. (DW-70) The Embeddings category offers an "Embedding endpoint" field that `_createEmbeddingModel` reads only for `openai` and `google`; `ollama` reaches its server through `getOllamaBaseUrl()` instead, so the field accepts a value that goes nowhere and the two endpoint settings overlap.

**Approach:** Gate ingest's vector branch on `getVectorSearchSettings().enabled` (the same switch `lifecycle.ts` and `tasks/run` already read), falling through to the existing BM25 corpus-stats branch when off. Route `ollama`'s embedding endpoint through the stored `embeddingBaseUrl` — the same value `openai`/`google` already read — so `ollamaBaseUrl`/`OLLAMA_BASE_URL` becomes the chat/generation endpoint only, and move the DW-401 "going to the SDK default" warning onto the same fact so it cannot describe the wrong endpoint.

## Boundaries & Constraints

**Always:**
- `hasEmbeddingSupport()`'s contract is unchanged; `src/lib/__tests__/embeddings.test.ts`'s `hasEmbeddingSupport` / provider-resolution assertions stay as written.
- The vector branch's off-path is the branch that already exists (`buildCorpusStats` + `bm25Score`), not a new one.
- ONE rule decides the embedding endpoint: the warning in `selectOllama` and the `baseURL` handed to `createOllama` read the same helper, so they cannot disagree.
- A value the ladder REFUSES is still never substituted by `OLLAMA_SDK_DEFAULT_BASE_URL`: the constant stays log-only.
- `OLLAMA_BASE_URL` remains a provider-DETECTION signal (`detectEnvProvider`, `resolveEmbeddingProvider`'s auto-detect rung, DW-370) — the split is about which endpoint the embedding call uses, not about which provider is selected.

**Block If:**
- The split cannot be documented without changing the stored config shape (a per-provider endpoint keying / migration is explicitly out of scope).

**Never:**
- Do not teach `hasEmbeddingSupport()` about the vector switch (`config.ts:1605` and `workbench-settings.ts:1495` both pin that it must not learn it).
- Do not remove `ollama` from `SELF_TRANSPORTING_EMBEDDING_PROVIDERS` — the endpoint stays OPTIONAL for turning vector search on, exactly as today.
- Do not widen `workers-ai` to read `embeddingBaseUrl` (still the Cloudflare binding; DW-70's decision covers `ollama` only).
- Do not add per-provider endpoint keying, a config migration, or an `EMBEDDING_BASE_URL` env var.
- Do not add `isAbsoluteHttpUrl` validation to `embeddingBaseUrl`: it is one flat unvalidated field and `openai`/`google` already pass it through raw. One field, one treatment.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Vector on, ingest merge | `getVectorSearchSettings().enabled === true` | `findMergeCandidates` uses `searchByVector` at `CONCEPT_ADJUDICATE_FLOOR`, unchanged | No error expected |
| Stored key, switch OFF (DW-68 headline) | embedding key stored so `hasEmbeddingSupport()` is true, `vectorSearchEnabled` false | `searchByVector` is NOT called; candidates come from the BM25 corpus-stats branch | No error expected |
| Unconfigured deployment | no provider, no switch | Same BM25 branch as before — the off-path is the existing one | No error expected |
| ollama embeddings, endpoint saved | `embeddingProvider: ollama`, `embeddingBaseUrl: http://embed.test:11434` | `createOllama({ baseURL: "http://embed.test:11434" })`; no DW-401 warning | No error expected |
| ollama embeddings, only chat endpoint saved | `embeddingProvider: ollama`, `ollamaBaseUrl` set, `embeddingBaseUrl` blank | `createOllama()` with NO argument; DW-401 warning fires once naming the Embedding endpoint field | Warn-once on `ollama-endpoint:sdk-default` |
| Chat leg unaffected | `ollamaBaseUrl` and `embeddingBaseUrl` both set to different URLs | `getConfiguredModel`/`callLLM` still get `ollamaBaseUrl`; the embedding leg gets `embeddingBaseUrl` | No error expected |
| Endpoint saved mid-process | `embeddingBaseUrl` goes blank → set → blank | Warning speaks, goes quiet, then speaks again (re-arm preserved) | Warn-once key re-armed |

</intent-contract>

## Code Map

- `src/lib/ingest.ts:1031` — `findMergeCandidates`'s `if (hasEmbeddingSupport())`. The ONLY `hasEmbeddingSupport` call site in the file; its import is at line 147 (`contentHash, searchByVector, hasEmbeddingSupport`). `./config` is not yet imported here; `config.ts` does not import `ingest.ts`, so no new cycle. Off-branch already present at lines 1036-1044 (`listWikiPages` → `buildCorpusStats({fullBody:false})` → `bm25Score`).
- `src/lib/config.ts:1607` — `getVectorSearchSettings()`; returns `{enabled, provider, baseUrl, model, hasKey}`. `enabled` = stored flag ∩ `canEnableVectorSearch`. Its docblock at 1598-1606 already names Story 2.9 / Story 3.4 as consumers and pins that `hasEmbeddingSupport()` is NOT taught about it — READ-ONLY evidence, do not edit that pin.
- `src/lib/lifecycle.ts:663` — the precedent: `if (!isArtifact && getVectorSearchSettings().enabled)`. Same gate shape to mirror.
- `src/lib/config.ts:647` — `getOllamaBaseUrl(cfg)`, the env→store ladder with `isAbsoluteHttpUrl` refusal + warn-once. After this change it serves CHAT only; its docblock (609-646) needs the split named.
- `src/lib/config.ts:2607` — `getResolvedCredentials`' `ollamaBaseUrl`, the chat/generation consumer via `llm.ts:374/384/488/491`. Unchanged.
- `src/lib/embeddings.ts:624-685` — `_createEmbeddingModel`. `stored`/`baseUrlOption` computed at 654-658 and spread into `openai`/`google`; the `ollama` case at 673-683 calls `getOllamaBaseUrl(cfg)` instead. This is the DW-70 edit site.
- `src/lib/embeddings.ts:408-425` — `selectOllama`, whose warn condition is `getOllamaBaseUrl(cfg) === undefined` (DW-401) and whose copy names `OLLAMA_BASE_URL`. Must follow the endpoint it describes.
- `src/lib/embeddings.ts:372-382` — `OLLAMA_SDK_DEFAULT_BASE_URL`, log-only by design; docblock names `_createEmbeddingModel`'s argument-free fall-through.
- `src/lib/embeddings.ts:11-17` — import block; `getOllamaBaseUrl` becomes unused once both call sites move (`envOllamaBaseUrl` at line 364 stays — provider detection).
- `src/lib/workbench-settings.ts:1446-1458` — `SELF_TRANSPORTING_EMBEDDING_PROVIDERS` docblock says `ollama` "reaches its server through `getOllamaBaseUrl()`" and "would store an endpoint no code path reads". Stale after the change; the SET itself must not change.
- `src/components/workbench/SettingsCanvas.tsx:1054` — `textRow("embeddingBaseUrl", "Embedding endpoint")`, no description today. READ-ONLY reference; no UI change required by the decisions.
- `src/lib/__tests__/ingest.test.ts:48-77, 2375-2578` — the merge-candidate suite. `vi.mock("../embeddings", …)` partial-mock pattern at 65-77 is the template for a `../config` partial mock. Nine `mockedHasEmbeddingSupport` call sites drive the vector branch.
- `src/lib/__tests__/embeddings.test.ts:13-26` — already partial-mocks `../config` (`loadConfigSync`, `getVectorSearchSettings`). `describe("an ollama selection with no endpoint is AUDIBLE (DW-401)")` at 3025-3162 drives the warning through `ollamaBaseUrl`/`OLLAMA_BASE_URL`.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:425-535` — `describe("the Ollama endpoint reaches every SDK construction through one ladder")`; mocks the SDK (`createOllamaMock`) so it is the ONLY place the `baseURL` argument is observable. Three embedding-leg cases at 492-534.
- `DEPLOY.md:140-185` — the Settings → Embeddings narrative; `DEPLOY.md:45` and `README.md:168` document `OLLAMA_BASE_URL`.

## Tasks & Acceptance

**Execution:**
- `src/lib/ingest.ts` -- Import `getVectorSearchSettings` from `./config`, drop `hasEmbeddingSupport` from the `./embeddings` import (keep `contentHash`, `searchByVector`), and change line 1031's condition to `getVectorSearchSettings().enabled`. Comment the WHY: a stored key is not consent to embed; the switch is (DW-68). -- The switch, not the predicate, is what says "this deployment does vector work".
- `src/lib/embeddings.ts` -- Extract the endpoint rule into one small module-local helper (e.g. `embeddingBaseUrlOf(cfg)`) returning the trimmed `cfg.embeddingBaseUrl` or `undefined`; have `_createEmbeddingModel` build `baseUrlOption` from it AND have the `ollama` case use it (`createOllama({baseURL})` when set, `createOllama()` with no argument when not); drop `getOllamaBaseUrl` from the import block. -- One fact, one reader; the argument-free fall-through is preserved verbatim.
- `src/lib/embeddings.ts` -- Repoint `selectOllama`'s condition at the same helper and rewrite its sentence to name the Embedding endpoint field, stating that `OLLAMA_BASE_URL` is the chat endpoint and is not read here. Keep the `ollama-endpoint:sdk-default` key and the `rearmWarningAbout` branch. Update the `OLLAMA_SDK_DEFAULT_BASE_URL` and `_createEmbeddingModel` docblocks to describe the split, including that an `OLLAMA_BASE_URL`-only deployment now needs an Embedding endpoint saved. -- A warning that reads a different endpoint than the call is worse than no warning.
- `src/lib/workbench-settings.ts` -- Correct the `SELF_TRANSPORTING_EMBEDDING_PROVIDERS` docblock: `ollama` now reads `embeddingBaseUrl` like every other non-binding provider, and stays exempt because the endpoint is OPTIONAL (falls through to the SDK default), not because nothing reads it. Do not change the set or the predicate. -- The comment is the only thing that went stale.
- `src/lib/config.ts` -- Name the split in `getOllamaBaseUrl`'s docblock (and the `ollamaBaseUrl` field comment if one exists): chat/generation endpoint only; embeddings read `embeddingBaseUrl`. -- The accessor is where a reader looks to learn what the value means.
- `src/lib/__tests__/ingest.test.ts` -- Add a `vi.mock("../config", …)` partial mock exposing `getVectorSearchSettings` (default `enabled: false`), replace the nine `mockedHasEmbeddingSupport` drives with it, drop the now-unused `hasEmbeddingSupport` mock/import, and ADD a case pinning DW-68's decision: a genuinely-true `hasEmbeddingSupport()` (env key set) with the switch off must not call `searchByVector` and must merge via BM25. -- The pin is the point of the entry.
- `src/lib/__tests__/embeddings.test.ts` -- Move the DW-401 describe block onto `embeddingBaseUrl`: the silent case and the re-arm case store it instead of `ollamaBaseUrl`; the copy assertion follows the new sentence; replace the "REFUSED, not merely absent" case (no ladder governs `embeddingBaseUrl`) with the split's hazard — a usable `OLLAMA_BASE_URL` and no saved Embedding endpoint still warns. -- These are the cases that would otherwise pass against the wrong endpoint.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- In the Ollama-endpoint describe: point "hands the embedding leg a USABLE stored endpoint" at `embeddingBaseUrl`; convert the "REFUSAL is a refusal" case into the split pin (a stored `ollamaBaseUrl` does NOT reach the embedding leg); add one case storing two DIFFERENT endpoints and asserting chat gets `ollamaBaseUrl` while embeddings get `embeddingBaseUrl`. Leave the chat-leg cases untouched. -- The mocked SDK is the only place the argument is observable.
- `DEPLOY.md` -- Add a short paragraph to the Settings → Embeddings narrative documenting the split and the migration note for `OLLAMA_BASE_URL`-only deployments. -- The decision asks for the split to be documented, not only pinned.

**Acceptance Criteria:**
- Given a deployment with an embedding key stored and `vectorSearchEnabled` false, when `ingest()` looks for merge candidates, then `searchByVector` is never called and candidates come from the BM25 corpus-stats branch.
- Given `hasEmbeddingSupport()`'s existing suite, when the change lands, then every assertion in `src/lib/__tests__/embeddings.test.ts`'s `hasEmbeddingSupport` / provider-resolution describes passes unmodified.
- Given `embeddingProvider: "ollama"` with `embeddingBaseUrl` saved, when an embedding model is constructed, then `createOllama` receives that `baseURL` and no DW-401 warning is emitted.
- Given `embeddingProvider: "ollama"` with only `ollamaBaseUrl`/`OLLAMA_BASE_URL` set, when an embedding model is constructed, then `createOllama` receives no endpoint and the DW-401 warning fires exactly once, naming the Embedding endpoint field.
- Given `ollamaBaseUrl` and `embeddingBaseUrl` set to different URLs, when chat and embedding models are both constructed, then chat gets `ollamaBaseUrl` and embeddings get `embeddingBaseUrl`.
- Given the warning has fired, when a save lands a usable `embeddingBaseUrl` and a later save clears it, then the sentence goes quiet and speaks again exactly once.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 14: (high 0, medium 3, low 11)
- addressed_findings:
  - `[medium]` `[patch]` Mocking `getVectorSearchSettings` to `enabled: true` in `ingest.test.ts` un-gates `lifecycle.ts:663`'s embed-on-write step, which the real gate used to hold shut; `upsertEmbedding` is now stubbed in that file's `../embeddings` partial mock so a merge-retrieval suite cannot reach provider resolution or the `ai` module at all.
  - `[low]` `[patch]` The new `findMergeCandidates` comment claimed the switch is answered "the same way everywhere"; `search.ts`'s `findRelatedPages`, `browse.ts`'s `hybridRank` and `query-search.ts`'s `searchIndex` are ungated. The claim was narrowed to ingest's write + merge sides and the three exceptions are named.
  - `[low]` `[patch]` `{@link getOllamaBaseUrl}` no longer resolved from `embeddings.ts` once the import was dropped; converted to backticked prose naming `config.ts`.
  - `[low]` `[patch]` `embeddingBaseUrlOf`'s blank-is-unset rule is newly load-bearing (it decides both the warning and the `createOllama` argument) and was untested; added a whitespace-only endpoint case to the DW-401/DW-70 describe.

## Design Notes

The two entries share a theme — a stored value being read as consent it was never given — but touch disjoint call sites, so they land as one bundle without coupling.

`_createEmbeddingModel`'s current `baseUrlOption` and `selectOllama`'s warn condition become two views of one helper. Shape:

```ts
function embeddingBaseUrlOf(cfg: ReturnType<typeof loadConfigSync>): string | undefined {
  const stored = cfg.embeddingBaseUrl;
  return typeof stored === "string" && stored.trim().length > 0 ? stored.trim() : undefined;
}
```

The known consequence, accepted by DW-70's decision and the reason the warning must move: an `OLLAMA_BASE_URL`-only deployment that embeds today stops reaching that endpoint. `embeddingBaseUrl` is store-only (no env feeder, and the Never list forbids adding one), so the warning is the migration path — it names the field to fill in.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/embeddings.test.ts src/lib/__tests__/ingest.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/workbench-settings.test.ts` -- expected: all pass
- `pnpm test` -- expected: full suite green, no new failures
- `pnpm exec tsc --noEmit` -- expected: clean (catches the dropped `getOllamaBaseUrl` / `hasEmbeddingSupport` imports)
- `pnpm lint` -- expected: clean (unused-import rule)

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** Applied both recorded embedding-config decisions. `findMergeCandidates` now gates vector retrieval on `getVectorSearchSettings().enabled` instead of `hasEmbeddingSupport()`, so a stored embedding key with the vector switch off takes the pre-existing BM25 corpus-stats branch (DW-68). `_createEmbeddingModel` reads `embeddingBaseUrl` for `ollama` through a new single-reader helper, `embeddingBaseUrlOf`, making `ollamaBaseUrl` / `OLLAMA_BASE_URL` the chat/generation endpoint only; `selectOllama`'s DW-401 warning reads the same helper so the sentence and the call cannot describe different endpoints (DW-70). `hasEmbeddingSupport`'s contract, `SELF_TRANSPORTING_EMBEDDING_PROVIDERS`' membership, `workers-ai`, and the stored config shape are unchanged.

**Files changed.**
- `src/lib/ingest.ts` -- vector branch gated on the switch; `hasEmbeddingSupport` import dropped, `getVectorSearchSettings` added; comment names the three call sites that remain ungated.
- `src/lib/embeddings.ts` -- new `embeddingBaseUrlOf` helper; `_createEmbeddingModel`'s `ollama` case and `selectOllama`'s warn condition both read it; warning copy names the Embedding endpoint field; `getOllamaBaseUrl` import removed.
- `src/lib/config.ts` -- `getOllamaBaseUrl` and the `ollamaBaseUrl` / `embeddingBaseUrl` field docs name the split.
- `src/lib/workbench-settings.ts` -- corrected the `SELF_TRANSPORTING_EMBEDDING_PROVIDERS` docblock; set and predicate untouched.
- `src/lib/__tests__/ingest.test.ts` -- `../config` partial mock drives the switch; `upsertEmbedding` stubbed; new DW-68 pin.
- `src/lib/__tests__/embeddings.test.ts` -- DW-401 describe moved onto `embeddingBaseUrl`, plus the split's hazard and a whitespace-only case.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` -- embedding leg reads `embeddingBaseUrl`; chat/embedding two-endpoint pin.
- `DEPLOY.md`, `README.md` -- the split and the migration note.

**Review findings breakdown.** 4 patches applied (1 medium, 3 low); 1 item deferred (low); 14 rejected. Follow-up review recommended: `true` (patched severities: high 0, medium 1, low 3; score = 3x1 + 1x3 = 6, threshold 5).

**Verification.**
- `pnpm exec tsc --noEmit` -- clean.
- `pnpm lint` -- clean (only the pre-existing `jsx-ast-utils` notices).
- `pnpm exec vitest run --project node` over `embeddings.test.ts`, `ingest.test.ts`, `settings-runtime-wiring.test.ts`, `workbench-settings.test.ts` -- 778 passed.
- `pnpm test` -- 359 files, 8809 passed, 1 skipped. One earlier run hit a 5s-timeout flake in `src/lib/__tests__/storage-fs.test.ts > reapStrandedScratchFiles`; that file and `src/lib/storage/` are byte-identical to the baseline, it passes in isolation (95/95), and it reproduces at the baseline commit under load.
- Matrix audit: every I/O row is covered by a test that ran and passed -- the three ingest merge cases for the switch rows, the `settings-runtime-wiring` `lastOllamaArgs()` cases for the endpoint and chat/embedding-split rows, and the `embeddings.test.ts` DW-401 describe for the warning and re-arm rows.

**Residual risks.**
- Behavioural, accepted by DW-70's decision and documented: an `OLLAMA_BASE_URL`-only deployment that embeds today falls to the SDK default until an Embedding endpoint is saved. `embeddingBaseUrl` is store-only, so the warn-once log line is the migration path; there is no Settings-UI hint for it.
- `embeddingBaseUrl` stays unvalidated for `ollama`, matching `openai`/`google`. A scheme-less endpoint now reaches `createOllama` verbatim and fails at request time, where the old chat ladder refused it and fell back silently.
- The switch is honoured by ingest's write and merge sides but not by `search.ts`, `browse.ts` or `query-search.ts` (pre-existing, ledgered separately as DW-686).
- One deferred item recorded in frontmatter: vector-on with no resolvable provider skips the BM25 fallback.
