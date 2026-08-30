---
title: 'DW-328 / DW-372 — settings write-door field semantics and version-stamp binding'
type: 'bugfix'
created: '2026-08-30'
status: 'done'
baseline_revision: '129a4540bd5eddb0cdf457f278957184d7fcfb35'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized, multiple-goals]
deferred:
  - summary: >-
      `applyWorkbenchSettings`'s `setText` still resolves a non-string to `""` and then
      reads `""` as the delete, so the two halves of the settings body now answer
      differently about the same stored key.
    evidence: |-
      DW-328 named only the route's four flat text fields, and the spec's Never list kept
      `setText` out on the grounds that its parameter is typed `string | null | undefined`
      and `validateWorkbenchSettingsPatch` runs above it, so the arm is unreachable by
      construction. That is still true. What changed is the symmetry: a flat
      `embeddingModel` carrying a non-string now leaves the stored key untouched, while
      `workbench.embeddingModel` carrying one would delete it. `config.ts` already imports
      from `workbench-settings.ts`, so `flatTextFieldAction` is importable there and the
      collapse is available.
    location: >-
      src/lib/config.ts (applyWorkbenchSettings -> setText)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two unrelated soft spots in the settings write door. (DW-328) All four flat text fields in `PUT /api/settings` resolve a non-string to `""` and then treat `""` as DELETE, so the belt-and-braces fallback points AT erasing a field a malformed client never meant to clear. (DW-372) `CONFIG_VERSION_KEY` is a plain in-object key that a pre-DW-272 build round-trips verbatim, so after a rollback save the stamp is frozen while the bytes moved, and a draft seeded before that save still matches and lands over it.

**Approach:** Route the four flat text fields through one shared applier whose non-string arm leaves the stored field untouched. Bind the stamp to the config bytes with a second reserved key holding a digest of the stripped config: `readStoredConfig` honours a stored token only when the digest still matches what it computed, otherwise it answers the unstamped sentinel. The served token stays the opaque random `s1:` value — the digest never crosses the response boundary.

## Boundaries & Constraints

**Always:**
- All four flat text fields (`model`, `structuredKnowledgeModel`, `ollamaBaseUrl`, `embeddingModel`) decide `undefined` / `null` / `""` / whitespace / non-string identically — one code path, no per-field variants. `null`, `""` and whitespace still DELETE; a non-string leaves the field untouched.
- The type-check 400s above the merge stay exactly as they are; the fallback is defence in depth behind them, never a replacement.
- Branch ORDER in the merge is preserved: `provider`, `model`, `structuredKnowledgeProvider`, `structuredKnowledgeModel`, `ollamaBaseUrl`, `embeddingModel`, then the `embeddingProvider` clear-on-switch, then the `workbench` patch.
- The version served by `GET`/`PUT` remains an opaque `s1:<32 hex>` (or the sentinel) derived from randomness alone — AD-23: no digest, etag, or function of any stored secret is ever serialized into a response.
- Both reserved keys are stripped from `AppConfig` on the way out of `readStoredConfig` AND from whatever a caller hands `saveConfig`, so no consumer, backup, or cache ever sees them.
- A stamp the read refuses degrades to `UNSTAMPED_CONFIG_VERSION` (recoverable: the next save re-stamps) and is logged — never to a hard refusal the owner has no path out of.

**Block If:**
- The digest binding cannot be made deterministic across a save/read round-trip (i.e. an existing suite proves a legitimately-saved store reads back as unstamped).

**Never:**
- Do not touch `applyWorkbenchSettings`'s `setText` in `config.ts` — its input is typed and validated, its non-string arm is unreachable by construction, and DW-328 names only the route's four flat fields.
- Do not read a second file (`.llm-wiki-config.version` included) — DW-272's one-object/one-round-trip property is the point.
- Do not sweep or delete the orphan legacy version file.
- Do not change the wire shape of the settings payload, the `s1:` token format, or any refusal copy.
- No new dependency: hash through `crypto.subtle.digest("SHA-256", …)`, the house pattern.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Flat text delete | `PUT {"model": null}` / `{"model": "   "}` over a store holding `model` | 200, `model` gone from the saved object | No error expected |
| Flat text store | `PUT {"ollamaBaseUrl": " http://x:1 "}` | 200, stored trimmed as `"http://x:1"` | No error expected |
| Flat non-string | `PUT {"embeddingModel": 42}` (and the same for the other three) | 400 with that field's existing sentence, `saveConfig` never called, store byte-identical | 400 |
| Flat fallback | Non-string reaching the merge (unreachable behind the 400s) | Field left untouched — never deleted | No error expected |
| Stamp honoured | Store saved through `saveConfig`, read back unchanged | `readConfig` answers the stored `s1:` token | No error expected |
| Stamp broken by a foreign write | Config bytes changed under a standing token (rollback-era save, or a hand edit) | `readConfig` answers `UNSTAMPED_CONFIG_VERSION`; a draft holding the old token is refused 412; the next save re-stamps | Warn-logged, recoverable |
| Key order only | Same fields re-serialized in a different key order under the same token | Token still honoured — the digest is canonical over sorted keys | No error expected |
| Reserved keys in a body | `PUT {"model":"x","__settingsVersion":"…","__settingsDigest":"…"}` | 200; neither key reaches the saved object or the sync cache; served version is the freshly stamped one | No error expected |

</intent-contract>

## Code Map

- `src/app/api/settings/route.ts:396-486` -- the four flat text merge branches (`model`, `structuredKnowledgeModel`, `ollamaBaseUrl`, `embeddingModel`), each `typeof x === "string" ? x.trim() : ""` then `trimmed.length === 0 → delete`. This is DW-328's whole surface. Their type-check 400s live at lines ~220-291 and stay.
- `src/app/api/settings/route.ts:487-532` -- `embeddingProvider` clear-on-switch; clears only `embeddingApiKey`/`embeddingBaseUrl`, so it is order-independent from the four text fields but must stay AFTER them.
- `src/app/api/settings/route.ts:88-100` -- the `GET` comment asserting "nothing about the bytes is read at all"; needs amending once a digest gates the stamp (nothing about the bytes is SERVED — that stays true).
- `src/lib/config.ts:329-359` -- `CONFIG_VERSION_KEY` and its doc block (the single-file rationale). New `CONFIG_DIGEST_KEY` belongs beside it.
- `src/lib/config.ts:600-629` -- `UNSTAMPED_CONFIG_VERSION` and the "LARGER RESIDUAL" paragraph that records the hand-edit hole as accepted; the digest closes it, so the paragraph must be rewritten rather than left contradicting the code.
- `src/lib/config.ts:709-750` -- `readStoredConfig`: lifts the token, strips it, primes `_configCache`. Where the digest check goes.
- `src/lib/config.ts:752-758` -- `isStoredConfigVersion`; the `s1:` shapes stay exactly as they are.
- `src/lib/config.ts:884-917` -- `saveConfig`: strips the caller's reserved key, stamps a fresh token, writes `JSON.stringify({...stored, [KEY]: version}, null, 2)`, primes the cache with `stored`. Where the digest is written.
- `src/lib/config.ts:2031-2042` -- `applyWorkbenchSettings`'s `setText`: the same-shaped helper for the `workbench` half. OUT OF SCOPE (typed input, unreachable non-string arm) — noted so it is not "fixed" by accident.
- `src/lib/write-precondition.ts:27-36` -- records why the settings store left the derived-version scheme; the AD-23 reasoning is unchanged and must stay true (the digest is stored, never served).
- `src/lib/__tests__/settings-route.test.ts:284-321` -- "cannot be made to forge or unstamp the token from the BODY"; the reuse point for the reserved-key body test, extend for the digest key. `readConfig`/`saveConfig` are mocked in this file, so the flat-field 400s are the observable half here.
- `src/lib/__tests__/config.test.ts:186-200, 381-402, 455-487` -- `VERSION_KEY`, `readRawStore()`, `stamp()` helpers and the round-trip tests. `config.test.ts:381` ("is derived from NOTHING in the config") hand-writes changed content under a standing token and asserts the token stands — that assertion is exactly DW-372 and must be re-aimed at the invariant it actually guards (no stored value appears in a token).
- `src/lib/__tests__/workbench-settings.test.ts:215-240, 3578-3616` -- `handWrite()` helper and the residual test asserting a content-changing hand edit leaves the version standing; same re-aim.
- `src/lib/__tests__/storage-r2.test.ts:883-908` -- asserts the raw stored object's `__settingsVersion`; must keep passing.
- `src/lib/email-ingest.ts:135`, `src/lib/agent-workspaces.ts:116` -- the house `crypto.subtle.digest("SHA-256", …)` + hex pattern to copy.

## Tasks & Acceptance

**Execution:**
- `src/app/api/settings/route.ts` -- add one module-level applier (e.g. `applyFlatTextField(updated, key, value)`) covering the four fields: `undefined` → no-op; string → trim, empty deletes, otherwise store trimmed; `null` → delete; any other type → LEAVE UNTOUCHED. Replace all four merge branches with calls to it, keeping each field's existing rationale comment at its call site and replacing the "belt-and-braces … must never be what turns a malformed body into a delete" sentences with the fact that the fallback now leaves the field alone (DW-328). -- one applier is the only shape that keeps the four uniform by construction, which is what DW-305 was about.
- `src/lib/config.ts` -- add `CONFIG_DIGEST_KEY = "__settingsDigest"` beside `CONFIG_VERSION_KEY`, plus a canonical serializer (sorted keys, recursive) and an async `configDigest()` over it using `crypto.subtle.digest("SHA-256", …)` → lowercase hex. In `saveConfig`, strip BOTH reserved keys from the caller's object, compute the digest over the stripped object, and write `{...stored, [CONFIG_VERSION_KEY]: version, [CONFIG_DIGEST_KEY]: digest}`; keep priming `_configCache` with `stored`. In `readStoredConfig`, lift both keys, strip both, and honour a real stored token ONLY when the stored digest equals the digest recomputed over the stripped config — otherwise fall back to `UNSTAMPED_CONFIG_VERSION` and `logger.warn` that the config changed underneath its stamp. -- binds the token to the bytes without putting any function of a secret into a response.
- `src/lib/config.ts` -- rewrite the `UNSTAMPED_CONFIG_VERSION` "LARGER RESIDUAL" paragraph and extend the `CONFIG_VERSION_KEY` doc: the stamp is now honoured only while the bytes it was stamped for are still there, which is what makes a pre-DW-272 rollback save (and a hand edit) read as unstamped instead of frozen (DW-372). -- a doc block that still promises the old residual is a lie the next reader would act on.
- `src/app/api/settings/route.ts` -- amend the `GET` version comment: nothing about the bytes is SERVED; a stored digest gates whether the stamp is honoured. -- same reason.
- `src/lib/__tests__/settings-route.test.ts` -- add route tests: each of the four flat fields answers 400 for a non-string with `saveConfig` never called; `null` / `""` / whitespace still delete and a padded value is stored trimmed, for all four; and extend the reserved-key body test to `__settingsDigest`. -- pins the door DW-328's fallback sits behind, and the four staying uniform.
- `src/lib/__tests__/config.test.ts` -- add: a saved store reads back with its stored token; the same object re-serialized in a different key order still honours it; content changed under a standing token (the DW-372 rollback shape) reads as `UNSTAMPED_CONFIG_VERSION` and the next save heals it; a caller-supplied `__settingsDigest` is stripped from the store and the cache. Re-aim the "derived from NOTHING" test at the invariant it guards (no stored value appears in a token; `newConfigVersion()` is random) without asserting the frozen-token behaviour DW-372 removes. -- these are the only tests that can see the binding.
- `src/lib/__tests__/workbench-settings.test.ts` -- re-aim the residual block at `GET`: key-order-only hand edit keeps the version, a content-changing hand edit now serves the sentinel alongside the token-dropped case. -- the old assertion pins the behaviour this change removes.

**Acceptance Criteria:**
- Given a store holding `model`, `structuredKnowledgeModel`, `ollamaBaseUrl` and `embeddingModel`, when a `PUT` carries a non-string for any one of them, then the response is that field's existing 400, `saveConfig` is never called, and every stored field is unchanged.
- Given the merge is reached with a non-string for any of the four (defence in depth), when the applier runs, then the stored field is left exactly as it was rather than deleted — and all four resolve `undefined` / `null` / `""` / whitespace / non-string through the same code path.
- Given a config saved through `saveConfig`, when `readConfig` reads it back unchanged, then it answers the stored `s1:` token and the returned `AppConfig` carries neither reserved key.
- Given a config whose bytes were changed under a standing token by something other than `saveConfig`, when `readConfig` reads it, then it answers `UNSTAMPED_CONFIG_VERSION`, a `PUT` sending the old token is refused 412, and the next save writes a fresh token the following read honours.
- Given any response from `GET` or `PUT /api/settings`, when its body is inspected, then it contains no digest, no etag and no stored secret — the version is still an opaque `s1:` value.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 4, low 6)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` `readStoredConfig`'s new `await configDigest(...)` sat between the parse and the `_configCache` prime, widening a window where a concurrent `saveConfig` primes the cache and this read then overwrites it with the pre-save object for the whole 5 s TTL — the cache is now primed synchronously, before any await.
  - `[medium]` `[patch]` the digest recompute sat outside both `catch` blocks, so a throw would reject the promise and break `loadConfig`'s `{}`-or-config contract for its ~50 callers — it is wrapped, and a failure leaves the store unstamped rather than unreadable.
  - `[medium]` `[patch]` the "config changed underneath its version stamp" line was not warn-once, and every already-deployed store holds a real token with no digest beside it, so it would have repeated on every cache-miss read of every existing install — routed through the existing `warnOnceAbout`, keyed on the token/digest pair actually found.
  - `[medium]` `[patch]` `canonicalConfigJson`'s recursion was unpinned: every hand-edit case in the suite re-orders top-level keys only, so a top-level-only sort left the suite green. Added a `skillEnablement` nested-map re-order case, mutation-checked to fail under that narrowing.
  - `[low]` `[patch]` the "callers pay nothing" perf sentence read as reassurance while the common case — a stamped store — pays one SHA-256 per cache-miss read; corrected.
  - `[low]` `[patch]` the new doc did not say that detecting the event also switches the cross-surface guard off until the next save, a state now entered by every hand edit and once by every deployed store on upgrade; added.
  - `[low]` `[patch]` no note covered a rollback to an intermediate (post-DW-272, pre-this-change) build, which carries `__settingsDigest` through as an ordinary field; added, worded to what the path actually does.
  - `[low]` `[patch]` `configDigest` re-implemented a hex loop the repo already exports; it now calls `sourceSha256` from `source-sha256.ts` (which imports nothing, so no cycle).
  - `[low]` `[patch]` nothing asserted the DW-372 warning, the operator's only signal that a store silently went unstamped; pinned, including that it fires exactly once across repeated reads.
  - `[low]` `[patch]` `heldDigest()` returned the raw value unchecked, so a regression that stopped writing the digest would have produced a passing test for the wrong reason; both helpers now assert 64-hex before returning.

## Auto Run Result

Status: done

**Implemented change.** Two independent hardening fixes to the settings write door.

DW-328: the four flat text fields of `PUT /api/settings` (`model`, `structuredKnowledgeModel`, `ollamaBaseUrl`, `embeddingModel`) now resolve through one decision, `flatTextFieldAction`, whose non-string arm LEAVES THE STORED FIELD UNTOUCHED instead of resolving to `""` and taking the delete arm. `undefined` no-ops, `null`/`""`/whitespace clear, any other string stores trimmed. The type-check 400s above the merge and the branch order are unchanged, so the change is behaviour-preserving through every HTTP entry point — which is the point: it re-aims a fallback that pointed at deletion.

DW-372: the write-precondition stamp is now BOUND to the config it was stamped for. `saveConfig` writes a second reserved key, `__settingsDigest`, holding a SHA-256 over the canonical (recursively sorted-key) serialization of the stripped config; `readStoredConfig` honours a well-formed `s1:` token only while that digest still matches what it recomputes, and otherwise answers `UNSTAMPED_CONFIG_VERSION` and warns once. So a pre-DW-272 build's save — which round-trips the reserved key verbatim while the bytes move — no longer leaves a frozen stamp the guard keeps believing; a draft seeded before it is refused 412, and the next save re-stamps. The value that crosses the response boundary is unchanged: the opaque random `s1:` token, never the digest (AD-23).

**Files changed.**
- `src/app/api/settings/route.ts` — one `applyFlatTextField` mutator replacing the four hand-written merge branches; the `GET` version comment corrected to "nothing about the bytes is SERVED".
- `src/lib/workbench-settings.ts` — new exported `flatTextFieldAction` / `FlatTextFieldAction`: the decision itself, in the module the node suite executes directly, because a Next `route.ts` may export nothing but its HTTP verbs and the arm that matters is the one no request can reach.
- `src/lib/config.ts` — `CONFIG_DIGEST_KEY`, `canonicalConfigJson`, `configDigest` (over `sourceSha256`); `readStoredConfig` lifts, strips and verifies both keys and primes the cache before any await; `saveConfig` strips both and writes the pair; the `UNSTAMPED_CONFIG_VERSION` "larger residual" paragraph rewritten to what the code now does.
- `src/lib/__tests__/settings-route.test.ts` — table-driven cases over all four fields (non-string refused with no save, padded stored trimmed, `null` clears, blank answered by each field's own door, omitted untouched, merge order preserved); the reserved-key body test extended to `__settingsDigest`.
- `src/lib/__tests__/config.test.ts` — the DW-372 binding: stamp honoured, key re-order (flat and nested) honoured, bytes-moved refused and self-healing, both reserved keys stripped from store and cache, the warning pinned once.
- `src/lib/__tests__/workbench-settings.test.ts` — `flatTextFieldAction`'s full decision table including the non-string arm; the `GET`/`PUT` residual cases re-aimed from "lands over a hand edit" to "refuses, and here is the way through"; a boundary test that `GET` serves no digest, no reserved key name and no secret.

**Review findings.** 10 patched (0 high, 4 medium, 6 low), 1 deferred (low — `setText`'s unreachable non-string arm in `config.ts`, out of DW-328's named scope), 8 rejected. Follow-up review recommended: `true` (3 x 4 medium + 1 x 6 low = 18, at or above the threshold of 5; no high).

**Verification.**
- `pnpm vitest run` over the four spec-named files: 531 passed, 4 files.
- `pnpm vitest run` (full suite): 350 files, 8139 passed, 1 skipped. One unrelated flake was seen once in an earlier run (`src/components/__tests__/workspace-purpose-settings.test.tsx`, a focus-refresh fetch-count assertion); it passed on three isolated re-runs and on both later full runs, and touches nothing in this change.
- `pnpm tsc --noEmit`: clean. `pnpm eslint` on the three changed source files: clean.
- Both new tests were mutation-checked rather than trusted green: narrowing `canonicalConfigJson` to a top-level-only sort fails the nested-re-order case and only that case; replacing `warnOnceAbout` with a plain `logger.warn` fails the warn-once case.

**Matrix note.** The I/O matrix's "Flat text delete" row lists `{"model": "   "}` alongside `{"model": null}` as 200-and-gone. Read against the contract's own Always tier — the per-field type-check 400s stay exactly as they are — the row is about the delete decision AT THE MERGE, and whitespace `model` is refused 400 above it, as it always was. The tests encode each field's own door explicitly rather than flattening the two.

**Residual risks.**
- The binding closes the documented hand-edit residual as a side effect, which is an improvement but a behaviour change: an owner who edits `.llm-wiki-config.json` by hand now gets a 412 on their open draft's next save and must reload. The refusal copy is the generic write-conflict sentence, which is accurate but does not name the hand edit as the cause.
- While a store reads unstamped, both Settings surfaces hold the same sentinel and neither save is refused. That state is now entered by every hand edit, every rollback-era save, and once by every already-deployed store on upgrade — it lasts until the first save, which re-stamps. Recorded in `UNSTAMPED_CONFIG_VERSION`.
- An actor who rewrites the config AND its digest together forges a stamp the read accepts, and a hand edit that restores the exact original bytes is invisible. Both require store write access, which is the owner.
- A stamped store now pays one SHA-256 over the config per cache-miss read of `readStoredConfig`. Small and bounded, and recorded in the docblock.

## Design Notes

The digest is a SECOND reserved key inside the SAME object, not a second file: DW-272's one-object/one-round-trip property survives, and the served token keeps its `s1:<32 hex>` random shape so no client, copy, or test that reads a version changes. Splitting "what is served" (random) from "what binds" (stored digest) is what lets AD-23 and DW-372 both hold — a version *computed over* the store cannot be served, but one *checked against* it never leaves the server.

```ts
// config.ts — canonical, so key order alone is not a change.
function canonicalConfigJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}
```

The digest is recomputed only when a real stored token is present, so the ~50 `loadConfig()` callers on an unstamped store pay nothing.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/config.test.ts src/lib/__tests__/settings-route.test.ts src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/storage-r2.test.ts` -- expected: all pass, including the new cases
- `pnpm tsc --noEmit` -- expected: no errors
- `pnpm eslint src/lib/config.ts src/app/api/settings/route.ts` -- expected: clean
