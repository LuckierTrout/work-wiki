---
title: 'Filter the drift window before the top-K slice, and re-arm from a persisted rebuild epoch'
type: 'bugfix'
created: '2026-09-04'
baseline_revision: 'b4a4460d9b863bdcc7db5c7d0de0250a6f8eb588'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      On Cloudflare, `searchByVector` can say "the model filter dropped every
      match" about a corpus that is not drifted, because Vectorize ranks
      server-side and the pre-slice filter is best-effort over a 20-vector
      window.
    evidence: |-
      `queryEmbeddings`' pre-slice guarantee is exact only where the provider
      ranks locally (filesystem, the R2 KV fallback). The Vectorize branch
      over-fetches to `VECTORIZE_FILTERED_TOPK` (20, the `returnMetadata:
      "all"` ceiling) and filters that window here, so on a corpus whose
      nearest 20 vectors are all stale the door returns `matches: []` with
      `rejected: 20` and burns `drift:<model>` — while perfectly current
      vectors sit at rank 21. The owner reads "rebuild embeddings" about a
      corpus that does not need it, and the burn then suppresses the next
      genuine drift line until a rebuild bumps the epoch. The bundle's own
      note named a Vectorize metadata filter plus a pre-created metadata index
      as the fix; that route was found unusable, not merely unbuilt —
      `modelMatches` is "model equals the active one OR the vector carries no
      model at all", Vectorize's filter grammar has no existence operator and
      excludes vectors missing the filtered field, so any expressible filter
      would drop unlabelled legacy vectors from what the door RETURNS. Closing
      it needs paging the Vectorize query (repeat calls under the metadata
      ceiling until `topK` accepted matches are collected) or a labelling
      migration that lets an `$eq` filter be faithful. Live callers pass topK
      30 and 64, both above the ceiling, so the window is at its narrowest
      exactly where it is asked to be widest.
    location: >-
      src/lib/storage/r2.ts (queryEmbeddings, Vectorize branch)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The `drift:<active model>` warning re-arms on the composition of one query window, and that window is unsound in two ways that DW-404's narrowing left live. `queryEmbeddings` sorts and slices to `topK` BEFORE `searchByVector` applies the model filter, so DW-404's own reproduction (a burnt key, then one stale-tagged and one current-tagged vector, alternating `topK: 1` queries) still emits four drift lines where DW-310's throttle promises one (DW-598). And `rebuildVectorStore` never deletes, so one stale ORPHAN vector leaves every window permanently mixed and wedges the key shut for the rest of the process — a second genuine drift ships silent on any store that has ever deleted, renamed or emptied a page (DW-599).

**Approach:** Push the model filter into the `queryEmbeddings` provider signature as an optional `accept` predicate applied BEFORE the sort-and-slice, with the provider reporting how many stored vectors it turned away, so the window a door judges is the top-K nearest ACCEPTED vectors. Then persist a monotonic rebuild epoch that `rebuildVectorStore` increments on completion, record the epoch observed at burn time, and re-arm from a strictly-greater epoch comparison instead of from window composition.

## Boundaries & Constraints

**Always:**
- The `accept` predicate, when supplied, is applied to the candidate set BEFORE the top-K reduction on every provider that ranks locally (filesystem, the R2 KV fallback). `rejected` counts what it turned away.
- `rebuildVectorStore` keeps its never-delete contract (`src/lib/embeddings.ts:1306-1310`) and its fail-soft per-page/per-flush behaviour exactly as they are.
- The rebuild epoch is a monotonically increasing integer obtained through the existing provider-atomic `incrementIndex` door; the re-arm compares strictly greater (`epoch > epochAtBurn`), never inequality, so a read holding a stale epoch can never re-arm.
- Both doors (`searchByVector`, `relatedByVector`) keep sharing the ONE key `drift:<active model>`, keep the single-config-snapshot rule (DW-313), and keep returning what they returned before — the change is on the warn/re-arm gate and on which vectors the provider ranks, never on the door's answer being narrowed beyond the model filter that already applied.
- Every storage read added on the warn/re-arm path is fail-soft: a throwing or unparseable epoch read degrades to "no rebuild observed", never to a spurious re-arm.
- The epoch is read only in the states that need it (about to burn; key already burnt), never on the common healthy read with no burnt key.
- `rearmWarningAbout` stays an unconditional delete — `selectOllama` re-arms `ollama-endpoint:sdk-default` through it.

**Block If:**
- Closing DW-598 on the Vectorize branch would require the door to stop returning unlabelled legacy vectors.
- The change would require `rebuildVectorStore` to delete vectors.

**Never:**
- Do not give the two doors separate keys, and do not add a `drift:null` branch — `warnedMisconfigurations` already records why neither is a case.
- Do not keep the whole-window/positive-proof conjuncts as an additional AND on the re-arm: an orphan vector makes every window mixed forever, so keeping them re-opens DW-599.
- Do not add a second unfiltered probe query to distinguish an empty store from a fully drifted one — that is what `rejected` is for.
- Do not add a server-side Vectorize metadata filter (see Design Notes) or a new env/binding knob for one.
- Do not claim DW-602 (the concurrent-interleave entry) is closed; it is not in this bundle.
- Do not widen scope to `spec-dw-404-405-406-embedding-drift-rearm-gate.md` or `spec-dw-598-599-602-vector-drift-rearm-soundness.md` — both sit at `status: in-review` having never been implemented, and neither is this bundle's contract.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Filter before slice | Store holds a stale-tagged and a nearer current-tagged vector; `queryEmbeddings(v, 1, accept)` | `{ matches: [current], rejected: 1 }` — a rejected vector never occupies the single slot | No error expected |
| No filter supplied | `queryEmbeddings(v, topK)` with no `accept` | `{ matches: <top-K exactly as today>, rejected: 0 }` — ranking and slicing unchanged | No error expected |
| DW-598 reproduction | A fully drifted corpus burns the key; then `page-b` is re-tagged current and `page-a` stays stale; eight alternating `searchByVector(q, 1)` calls | Exactly ONE drift line (the first). The mixed phase neither warns nor re-arms | No error expected |
| DW-599 reproduction | Two vectors; drift burns the key; a COMPLETED `rebuildVectorStore` re-tags only the live one (the orphan stays stale); the corpus drifts again under the same active model | TWO drift lines — the epoch bump re-arms despite the permanently mixed window | No error expected |
| Empty store | No vectors stored at all | `matches: []`, `rejected: 0` → no drift line, no re-arm; door returns `[]` | No error expected |
| Fully drifted store | Every stored vector rejected by `accept` | `matches: []`, `rejected > 0` → drift line said once, epoch recorded at burn | No error expected |
| Rebuild embedded nothing | `rebuildVectorStore` completes with `embedded === 0` | Epoch NOT incremented — nothing landed, so nothing may re-arm | Counter untouched |
| Epoch read fails | `getIndex` throws, or holds a non-integer | Treated as epoch `0`; no re-arm, the burn is still recorded | Swallowed, warned once through `logger`, no rethrow |
| Epoch bump fails | `incrementIndex` throws at the tail of a rebuild | `RebuildResult` is returned unchanged; the key simply stays burnt | Swallowed and warned, never rethrown |
| Query throws | `queryEmbeddings` rejects (dimension mismatch) | `[]` via the existing catch; no warn, no re-arm | Existing `logVectorQueryFailure` path, unchanged |
| Vectorize branch | `accept` supplied and `this.vectorize` is bound | Over-fetch to `VECTORIZE_FILTERED_TOPK` (20, the `returnMetadata: "all"` ceiling), filter locally, then slice to `topK`; `rejected` counts what the over-fetched window turned away | No error expected |

</intent-contract>

## Code Map

- `src/lib/storage/types.ts:575` -- `queryEmbeddings(vector, topK)` contract. Gains an optional `accept` predicate and returns `EmbeddingQueryResult`. `EmbeddingMatch` is at `:175` (`EmbeddingEntry` at `:165`); `getIndex`/`putIndex`/`incrementIndex` at `:487`/`:498`/`:515` are the epoch primitives — `incrementIndex`'s docblock already promises provider-atomic monotonicity. `ATOMIC_COUNTER_INDEX_KEYS` at `:259` is `["data-version"]` today and MUST gain the epoch key, or R2's `incrementIndex` throws (`r2.ts:309-313`) and its `getIndex`/`putIndex` would use KV rather than the R2 compare-and-swap object.
- `src/lib/storage/filesystem.ts:936` -- `queryEmbeddings`: `loadEmbeddings()` → map to scored → `sort` → `slice(0, topK)`. Apply `accept` to the loaded entries BEFORE scoring/sorting; `rejected` = entries dropped. `indexPath`/`getIndex`/`putIndex`/`incrementIndex` at `:822-853` are the epoch's on-disk home (`.indexes/<key>.json`), already serialized through `withFileLock("index:<key>")`.
- `src/lib/storage/r2.ts:429` -- `queryEmbeddings`, two branches. The KV fallback (`:445-452`) mirrors filesystem exactly. The Vectorize branch (`:433-443`) ranks SERVER-side; over-fetch to a named ceiling constant when `accept` is supplied, then filter and slice. `VECTORIZE_UPSERT_CHUNK` near `:67` is the existing precedent for such a constant. `incrementIndex` at `:308`, `getIndex` at `:285`, `listIndexKeys`'s atomic-key sweep at `:365` all key off `isAtomicCounterIndexKey`.
- `src/lib/storage/index.ts:174-186` -- the public storage re-export list. `EmbeddingQueryResult` and `EmbeddingFilter` belong beside `EmbeddingMatch`.
- `src/lib/data-version.ts` -- the module to MIRROR for the epoch: a logical key, an `isAtomicCounterIndexKey` assertion at import time (`:39-43`), a fail-soft `readDataVersion` over `getIndex` + `narrowIndexInteger` (`:78`), a fail-soft `bumpDataVersion` over `incrementIndex` (`:100`). Read-only — do not modify it.
- `src/lib/storage/index-integer.ts` -- `narrowIndexInteger`; the shared "what a stored counter is worth" narrowing the epoch reader must reuse.
- `src/lib/embeddings.ts:188-228` -- `warnedMisconfigurations` (a `Set` today), `warnOnceAbout`, `rearmWarningAbout`, `_resetEmbeddingWarnings`. The Set becomes a `Map<string, number | null>` from key to the epoch observed at burn (`null` for the non-drift families).
- `src/lib/embeddings.ts:44-187` -- the `warnedMisconfigurations` docblock. The `drift:<active model>` bullet (`:65-160`) is the CANONICAL statement of the gate and currently documents the whole-window/positive-proof predicate plus DW-598's and DW-599's live residue. It must be rewritten to the epoch gate; both doors' branch comments point here rather than restating.
- `src/lib/embeddings.ts:990` -- `modelMatches`; the accept predicate's body, deliberately keeping unlabelled legacy vectors. Unchanged, now passed down instead of applied locally.
- `src/lib/embeddings.ts:1141-1217` -- `searchByVector`. `cfg`/`currentModel` one-snapshot reads at `:1146-1150`, `queryEmbeddings` at `:1154`, the local `.filter(modelMatches)` at `:1155` (deleted — the provider does it), the re-arm branch at `:1171-1193` and the warn branch at `:1194-1211`. Its docblock at `:1104-1140` restates the gate and must be re-anchored on the epoch.
- `src/lib/embeddings.ts:1235-1291` -- `relatedByVector`. Stale-anchor early return + burn at `:1243-1259`, `queryEmbeddings(self.vector, topK + 1)` at `:1263`, the `m.id !== slug` anchor split and local filter at `:1268-1269`, the two branches at `:1270-1285`. `currentModel` is legitimately `null` here; `modelMatches` is true against null, so `accept` degrades to accept-all — keep that.
- `src/lib/embeddings.ts:1315-1420` -- `rebuildVectorStore`. The `try/finally` loop and tail `flushPending()` at `:1380-1412`, `return { total, embedded, skipped, model }` at `:1420`. The epoch bump belongs after the tail flush, gated on `embedded > 0`.
- `src/lib/__tests__/embeddings.test.ts` -- helpers `seedVector` (`:84`), `withWarnSpy` (`:169`), `DEFAULT_TEST_MODEL` (`:78`); every drift suite runs against real filesystem storage in a temp `DATA_DIR`, so `incrementIndex` works there unmodified. The tests whose "a rebuild landed" step is a `reseed`/`seedVector` re-tag rather than an epoch bump are the ones that will now fail and must bump the epoch: `:1195` (`SPEAKS again after the corpus is REBUILT…`), `:1338` (`DOES re-arm on a window holding an ACTIVE-model vector…`), `:1475` (`re-arms ONLY the read's OWN drift identity…`), `:1512` (`re-arms on the SAME snapshot the filter used…`), `:663` (`RE-ARMS a key searchByVector burnt…`), `:843` (`completes a warn/re-arm cycle through THIS door alone`). The tests asserting NO re-arm (`:1248`, `:1291`, `:1378`, `:1411`, `:884`, `:706`, `:744`) keep passing and need their comments re-anchored, not their bodies changed. `:1576` (`SPEAKS again after a REAL rebuildVectorStore…`) passes unchanged and becomes the canonical wiring pin.
- `src/lib/__tests__/storage-fs.test.ts:477-541` and `src/lib/__tests__/storage-r2.test.ts:770-845` -- ~13 `queryEmbeddings` call sites that must read `.matches`; the natural home for the new pre-slice-filter and `rejected` pins. `storage-r2.test.ts:760` also pins that `incrementIndex` REFUSES a non-atomic-counter key — the epoch key must be a counter key for the same reason `data-version` is.
- `src/lib/__tests__/embeddings.test.ts:1984` -- the `rebuildVectorStore` suite (real filesystem provider, `DATA_DIR` set); the home for the "a completed rebuild bumps the epoch, one that embedded nothing does not" pins.

## Tasks & Acceptance

**Execution:**
- `src/lib/storage/types.ts` -- add `EmbeddingFilter` (a metadata predicate) and `EmbeddingQueryResult` (`matches`, `rejected`); change `queryEmbeddings` to `(vector, topK, accept?) => Promise<EmbeddingQueryResult>`, documenting the pre-slice guarantee, what `rejected` counts, and that a server-ranking provider satisfies it best-effort over an over-fetched window. Add the rebuild-epoch key to `ATOMIC_COUNTER_INDEX_KEYS` with a docblock line saying why it belongs beside `data-version` -- the contract is what turns the window from a window signal into a corpus signal, and the counter must be the R2 compare-and-swap object rather than eventually-consistent KV.
- `src/lib/storage/index.ts` -- re-export the two new types beside `EmbeddingMatch` -- keep the public storage surface consistent.
- `src/lib/storage/filesystem.ts` -- apply `accept` to the loaded entries before scoring/sorting/slicing and return `{ matches, rejected }` -- this is the provider DW-598 is reported against.
- `src/lib/storage/r2.ts` -- same for the KV fallback; for Vectorize, over-fetch to a named ceiling constant when `accept` is supplied, then filter and slice, with a comment stating plainly that `rejected` is window-scoped there and why a server-side metadata filter is not the answer -- honest rather than over-claiming.
- `src/lib/embeddings.ts` -- add the epoch module surface: an exported `EMBEDDING_REBUILD_EPOCH_KEY`, a fail-soft `readRebuildEpoch()` over `getIndex` + `narrowIndexInteger`, and a fail-soft `bumpRebuildEpoch()` over `incrementIndex`, mirroring `data-version.ts`'s shape -- the epoch is the corpus-level signal both entries name.
- `src/lib/embeddings.ts` -- turn `warnedMisconfigurations` into a `Map<string, number | null>`, give `warnOnceAbout` an optional epoch argument, and add `rearmDriftIfRebuilt(key, observedEpoch)` that deletes only on `observedEpoch > epochAtBurn`; leave `rearmWarningAbout` an unconditional delete -- the epoch recorded at burn and compared strictly is the DW-599 fix.
- `src/lib/embeddings.ts` -- rewrite the `drift:<active model>` bullet on the `warnedMisconfigurations` docblock and `searchByVector`'s docblock: the gate is a persisted rebuild epoch, the window-composition conjuncts are gone, DW-598 and DW-599 are closed, and the residue that remains (server-ranking providers over-fetch rather than filter exactly; a burn that records an epoch just before a rebuild lands costs ONE extra line; the render door's stale-orphan-anchor false positive, unchanged) is named once -- this docblock is the canonical statement and currently asserts the opposite.
- `src/lib/embeddings.ts` -- rewire `searchByVector`: pass `accept` to `queryEmbeddings`, drop the local `.filter`, warn on `matches.length === 0 && rejected > 0`, and re-arm on a non-empty accepted window whose freshly-read epoch exceeds the epoch at burn, reading the epoch only when the key is already burnt -- keeping the epoch off the healthy path is what stops this adding a storage read per query.
- `src/lib/embeddings.ts` -- rewire `relatedByVector` identically, keeping the anchor split (`m.id !== slug`) and the stale-anchor early-return burn, which now records the epoch too -- one gate, both doors, as today.
- `src/lib/embeddings.ts` -- increment the epoch in `rebuildVectorStore` after the tail flush, only when `embedded > 0`, fail-soft, leaving the never-delete contract untouched -- a rebuild that landed nothing is not evidence of anything.
- `src/lib/__tests__/storage-fs.test.ts`, `src/lib/__tests__/storage-r2.test.ts` -- update the call sites to the result object and add pins for the matrix's first two rows (pre-slice filtering at `topK: 1`; byte-identical behaviour with no `accept`) plus `rejected` counts, and for the Vectorize over-fetch branch -- the pre-slice guarantee is the provider's, so it is pinned at the provider.
- `src/lib/__tests__/embeddings.test.ts` -- rewrite the drift suites in both doors: every "a rebuild landed" step bumps the epoch (via `getStorage().incrementIndex(EMBEDDING_REBUILD_EPOCH_KEY)`), and add the DW-598 and DW-599 rows of the matrix as named pins; keep the tests that assert NO re-arm and re-anchor their comments on the epoch -- the ledger names these two reproductions as what must be pinned.
- `src/lib/__tests__/embeddings.test.ts` -- pin in the `rebuildVectorStore` suite that a completed rebuild increments the epoch and one that embedded nothing does not -- otherwise the only wiring between the fix and its trigger is untested.

**Acceptance Criteria:**
- Given a store holding one stale-tagged and one nearer current-tagged vector, when `searchByVector` runs with `topK: 1`, then the window it judges holds only the current-tagged vector regardless of which vector is nearer the query.
- Given the drift key is burnt and no rebuild has completed since, when any number of healthy or mixed reads run through either door, then the key stays burnt and no second drift line is emitted.
- Given the drift key is burnt and `rebuildVectorStore` has since completed with at least one page embedded, when a read returns a non-empty accepted window, then the key re-arms and a later genuine drift under the same active model speaks again — even though a stale orphan vector is still stored.
- Given no `accept` argument, when any caller invokes `queryEmbeddings`, then ranking, top-K slicing and returned matches are identical to today's behaviour and `rejected` is `0`.
- Given `getIndex` throws on the epoch key, when a drifted or healthy read runs through either door, then the door behaves as if no rebuild had been observed and no error propagates to the caller.
- Given a healthy read on which the drift key was never burnt, when it completes, then no epoch read is issued at all.

## Spec Change Log

## Review Triage Log

### 2026-09-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 12: (high 0, medium 4, low 8)
- defer: 1: (high 0, medium 1, low 0)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` A `topK: 0` query (reachable from `browse.ts:129` when a tag filter matches no page) burnt `drift:<model>` on a healthy corpus holding one stale orphan, because filtering before the slice makes `matches` empty and `rejected` non-zero. Added a `topK > 0` conjunct to the warn condition in both doors, with pins at both.
  - `[medium]` `[patch]` A completed rebuild followed by re-drift with no intervening non-empty read could never re-arm — DW-599's own failure surviving in a narrower form. The epoch is now consulted whenever the key is burnt, not only on the non-empty branch; the re-arm carries no window conjunct at all. Same fix applied to `relatedByVector`'s stale-anchor early return. Pinned with a real `rebuildVectorStore` and no read in between.
  - `[medium]` `[patch]` `readRebuildEpoch`'s docblock claimed a degraded `0` "can never re-arm spuriously"; a read that fails AT BURN TIME records `0` and lets a later healthy read re-arm with no rebuild. Both directions now stated, with why recording `null` instead would wedge the key.
  - `[medium]` `[patch]` Strictly-greater was indistinguishable from inequality under the whole suite (no test burnt the key at a non-zero epoch). Added a pin that burns at watermark 2 then degrades the re-arm read to 0, plus a second one across two drift identities; corrected the comment that credited tests which did not hold that line.
  - `[low]` `[patch]` `VECTORIZE_FILTERED_TOPK`'s docblock asserted a ceiling the next line exceeds via `Math.max`. Rewritten as the floor it actually is, naming the pre-existing above-ceiling callers.
  - `[low]` `[patch]` The residue paragraph stated the burn/bump race only in its benign direction; the reachable interleave errs toward silence. Corrected.
  - `[low]` `[patch]` `rebuildVectorStore`'s epoch comment did not address a throw escaping the loop (tail flush runs, bump is skipped). The placement is now named as a choice, with its cost.
  - `[low]` `[patch]` `write-batching-bounds.test.ts` justified its `+1` barrier by naming `putIndex`; the code calls `incrementIndex`. Corrected.
  - `[low]` `[patch]` The "re-arms ONLY the drift key" comment credited a `null`-epoch guard no caller reaches. Now credits the key namespace and describes the guard as the unreached floor it is.
  - `[low]` `[patch]` The matrix's "epoch read fails, or holds a non-integer" row was pinned only on the throwing half. Added a pin for `"x"`, `1.5` and `-3`.
  - `[low]` `[patch]` The "no epoch read on a healthy never-burnt read" criterion was pinned only for `searchByVector`. Added the `getIndex` spy pin for `relatedByVector`, the per-render door.
  - `[low]` `[patch]` The window-scoped `rejected` claim on the Vectorize branch was prose-only. Added a 25-vector pin showing `rejected: 20` there against `25` through the KV fallback.

## Design Notes

Why the epoch REPLACES the window conjuncts rather than joining them: DW-599's orphan is a vector `rebuildVectorStore` never deletes, so after a completed rebuild every window containing it is permanently mixed. Any re-arm that also demands a whole-window match therefore stays wedged, which is the entry itself. The epoch is corpus-level evidence and is the ONLY conjunct that survives. Planning expected a second one — "the accepted window is non-empty" — and review removed it: gating the re-arm on a non-empty window leaves DW-599 alive in a narrower form, because a corpus that is rebuilt and then re-drifts before any read returns anything falls into the warn branch forever, where `warnOnceAbout` silently declines to speak. The re-arm now reads no property of the window at all; the window still decides only whether to WARN.

Why NOT a server-side Vectorize metadata filter, which the bundle intent raises. `modelMatches` deliberately KEEPS unlabelled legacy vectors (dropping them empties the corpus after a first deploy), so the predicate is "model equals the active one OR the vector carries no model at all". Vectorize's metadata filter grammar is `$eq/$ne/$lt/$lte/$gt/$gte/$in/$nin` over a field, with no existence operator, and vectors missing the filtered field are excluded — so any expressible filter would DROP the legacy vectors from what the door RETURNS, not merely from what it judges. That is a change to the door's answer, which the Always list forbids. The Vectorize branch therefore over-fetches to the `returnMetadata: "all"` topK ceiling and filters locally, and says so in a comment; no metadata index is created and no new knob is added. The residue — a corpus deeper than the ceiling can still hand back a window the filter dropped nothing from — is stated on `warnedMisconfigurations` rather than papered over.

Why strictly-greater and not inequality:

```ts
// AFTER the query resolves. `incrementIndex` is monotonic, so a read holding a
// STALE (lower) epoch cannot re-arm, and a read that another query burnt
// underneath sees its own epoch equal to the recorded one.
const burntAt = warnedMisconfigurations.get(key);   // undefined ⇒ never burnt
if (burntAt == null) return;                        // nothing to re-arm
const epoch = await readRebuildEpoch();             // 0 on any failure
if (epoch > burntAt) warnedMisconfigurations.delete(key);
```

The mirror-image case is accepted deliberately: a burn that records an epoch read just before a rebuild lands will re-arm on the next healthy read and cost ONE extra line. Erring toward speaking is the right side of DW-310's trade — a suppressed second outage is the failure that entry exists to prevent.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/embeddings.test.ts src/lib/__tests__/storage-fs.test.ts src/lib/__tests__/storage-r2.test.ts` -- expected: all pass, including the two named reproductions.
- `pnpm exec tsc --noEmit` -- expected: clean; the `queryEmbeddings` return-shape change has no unconverted call site.
- `pnpm lint` -- expected: no new errors or warnings.
- `pnpm test` -- expected: full suite green, no collateral breakage from the storage-interface change.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** The `drift:<active model>` warning's two unsound halves are closed together. The model filter now travels DOWN into the storage contract as an optional `accept` predicate that every locally-ranking provider applies BEFORE the sort-and-slice, and `queryEmbeddings` returns `{ matches, rejected }` so a caller can tell an empty STORE from a fully refused one (DW-598). And the re-arm no longer reads any property of a query window: `rebuildVectorStore` raises a persisted, provider-atomic `embedding-rebuild-epoch` when it completes having embedded at least one page, the epoch observed at burn time is recorded beside the key, and a later read re-arms when a freshly-read epoch is strictly greater — so a stale orphan vector can no longer wedge the key shut (DW-599). `rebuildVectorStore`'s never-delete contract is untouched, both doors still share one key, and neither door's answer is narrowed beyond the model filter that already applied.

**Files changed.**
- `src/lib/storage/types.ts` -- `EmbeddingFilter` and `EmbeddingQueryResult`; `queryEmbeddings(vector, topK, accept?)` with the pre-slice guarantee documented; `embedding-rebuild-epoch` added to `ATOMIC_COUNTER_INDEX_KEYS`.
- `src/lib/storage/index.ts` -- re-exports the two new types.
- `src/lib/storage/filesystem.ts` -- `accept` applied to loaded entries before scoring, sorting and slicing; `rejected` counted.
- `src/lib/storage/r2.ts` -- the same for the KV fallback; the Vectorize branch over-fetches to `VECTORIZE_FILTERED_TOPK` and filters locally, with the argued reason a server-side metadata filter is not usable here.
- `src/lib/embeddings.ts` -- the epoch surface (`EMBEDDING_REBUILD_EPOCH_KEY`, fail-soft `readRebuildEpoch`/`bumpRebuildEpoch`); `warnedMisconfigurations` as a `Map` to the epoch at burn; `rearmDriftIfRebuilt`; both doors rewired; the canonical gate docblock rewritten; the epoch bumped at the rebuild's tail on `embedded > 0`.
- `src/lib/__tests__/embeddings.test.ts`, `storage-fs.test.ts`, `storage-r2.test.ts` -- both named reproductions pinned, every "a rebuild landed" step moved to an epoch bump, provider-level pre-slice and `rejected` pins added.
- `src/lib/__tests__/write-batching-bounds.test.ts` -- the rebuild's barrier bound gains one flat term for the epoch bump (`REBUILD_EPOCH_STORES`).

**Review findings.** 12 patches applied (4 medium, 8 low; 0 high), 1 item deferred (medium — the Vectorize window is best-effort, see frontmatter `deferred`), 6 rejected. Four reviewers ran: blind hunter, edge-case hunter, verification-gap and intent-alignment. The two behaviour patches were a spurious drift burn at `topK: 0` (reachable from `browse.ts:129`) and a rebuild-then-re-drift sequence that could never re-arm; the rest corrected canonical docblocks that asserted things the code did not do, and closed unpinned claims.

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 4, low 8. Score: no high-severity patch, so no further iteration.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/embeddings.test.ts src/lib/__tests__/storage-fs.test.ts src/lib/__tests__/storage-r2.test.ts` -- 380 passed.
- `pnpm exec tsc --noEmit` -- clean.
- `pnpm lint` -- exit 0 (three pre-existing `jsx-ast-utils` notices).
- `pnpm test` -- 386 files, 9612 passed, 1 skipped.
- Matrix test audit: all 11 I/O rows covered by named tests that ran and passed.

**Residual risks.**
- On Cloudflare the pre-slice guarantee is best-effort over a 20-vector window; the resulting owner-facing false drift line is recorded in `deferred`.
- A burnt key now costs one small index read per vector query and per article render until a rebuild clears it. The healthy, never-burnt read issues none, which is pinned at both doors.
- An epoch read that fails AT BURN TIME records `0` and lets one later read re-arm with no rebuild behind it, costing one extra line. Deliberate — the alternative (recording `null`) wedges the key, which is DW-599.
- Because the re-arm is now driven by a corpus-level epoch consulted on every read of a burnt key, a mis-keyed re-arm is no longer separately observable in the log: the correct code clears the same key one read later. The one-snapshot test therefore pins the sharply observable half (the warn) and records the reduction.
- DW-602 (concurrent burn/re-arm interleave) is NOT claimed closed; recording the epoch after the query and comparing strictly greater narrows it but the entry stays open.
- The bundle intent's note named a Vectorize metadata filter and a pre-created metadata index. That route was found unusable rather than merely unbuilt (Vectorize's filter grammar cannot express "model equals the active one OR the vector carries no model at all" without dropping unlabelled legacy vectors from what the door returns), so no deployed index configuration was changed and the reasoning is recorded on `queryEmbeddings` in `r2.ts` and in Design Notes.
