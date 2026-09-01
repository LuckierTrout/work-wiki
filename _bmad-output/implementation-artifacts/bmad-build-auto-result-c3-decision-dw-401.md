---
status: done
---

# BMad Build Auto Result

Status: done
Blocking condition: none — the bundle's intent is already true in the tree; no source, test, or spec file needed to change.

## Bundle

- Bundle: `c3-decision-dw-401` (run `20260820-220331-0f16`)
- Intent: `.bmad-loop/runs/20260820-220331-0f16/bundles/c3-decision-dw-401/intent.md`
- Ledger entry: DW-401 (human decision: option 1 — "Warn once, keep selecting")
- Baseline revision: `793e0a9c287d90c426accd41a2203bb49f67f797`
- Files touched by this session: none (this result file only).

## Why no change was made

The bundle asks to "keep the explicit selection authoritative but emit a warn-once from
`resolveEmbeddingProvider` naming the SDK localhost default as the endpoint actually in
effect, so the substitution is audible. Smallest change, no behaviour change." That is
exactly what shipped, in commit `40f313b7` ("sweep dw-embeddings-provider-resolution:
DW-333, DW-398, DW-401 via bmad-loop").

**The ledger entry is closed.** `_bmad-output/implementation-artifacts/deferred-work.md:2941`
carries DW-401 as `status: done 2026-08-27`, `archived: 2026-08-29`, and the entry is
mirrored in `deferred-work-archive.md:3416`.

**The warn-once is in the tree.** `src/lib/embeddings.ts`:

- `:382` — `OLLAMA_SDK_DEFAULT_BASE_URL = "http://127.0.0.1:11434/api"`, copied from
  `ollama-ai-provider-v2` (`createOllama`'s unexported `baseURL` default) for one purpose:
  naming, in the log line, where the embeddings actually went. Nothing *resolves* against
  it — the fall-through at `:675-676` is still `createOllama()` with no argument, so a
  refused URL is never handed to the SDK.
- `:406-426` — `selectOllama(cfg)`: when `getOllamaBaseUrl(cfg) === undefined` it emits
  `warnOnceAbout("ollama-endpoint:sdk-default", …)` naming both the missing inputs
  (`OLLAMA_BASE_URL`, the saved endpoint) and the endpoint in effect; otherwise it calls
  `rearmWarningAbout(key)` so a save that fixes the endpoint goes quiet and a later break
  is news again. `return "ollama"` on **every** path — log-only, as the decision asked.
- The helper is reached from all three rungs of `resolveEmbeddingProvider`, which is why it
  is one helper rather than a check per rung: the `EMBEDDING_PROVIDER=ollama` override
  (`:342`), the stored generation provider `cfg.provider === "ollama"` (`:349`), and the
  auto-detect credential tail on `OLLAMA_MODEL` alone beside a refused `OLLAMA_BASE_URL`
  (`:359-361`). Warning on two of the three would be an asymmetry with no rule behind it.
- `:158`, `:205` — the warn-key census records `ollama-endpoint:sdk-default` as one of the
  two identities that may re-arm, with the evidence (the ladder's store leg is fixable
  in-process).

**The selection stays authoritative.** DW-370's endpoint-usability rule still governs only
the auto-detect rung that reads the variable to decide; the explicit rungs still select
`ollama` and are now merely audible about the substitution.

## Verification

```
npx vitest run src/lib/__tests__/embeddings.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts

 ✓ src/lib/__tests__/embeddings.test.ts (190 tests)
 ✓ src/lib/__tests__/settings-runtime-wiring.test.ts (53 tests)
 Test Files  2 passed (2)
      Tests  243 passed (243)
```

The behaviour is asserted directly in `embeddings.test.ts:3025-3140`, `describe("an ollama
selection with no endpoint is AUDIBLE (DW-401)")` — seven cases covering: still resolves
`ollama` while naming the SDK default; silent when an endpoint resolves; said once across
every embed door (`getEmbeddingModelName`, `getEmbeddingModel`, `embedText`, `embedTexts`,
`hasEmbeddingSupport`); reached from the stored-generation-provider rung and from the
credential tail on `OLLAMA_MODEL` alone; re-armed by a save and audible again when the
endpoint breaks; and log-only, since a model is still built. The companion claim — that the
sentence's endpoint never becomes the value passed to `createOllama` — is pinned against a
mocked SDK in `settings-runtime-wiring.test.ts:492` ("gives the EMBEDDING leg no endpoint
either when none resolves (DW-401)").

## Note for the orchestrator

DW-401 was already `done` and `archived` before this dispatch. Nothing about the re-dispatch
changed the tree; recording it resolved is accurate. No new deferred work was found.
