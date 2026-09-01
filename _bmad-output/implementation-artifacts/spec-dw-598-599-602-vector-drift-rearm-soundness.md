---
title: 'Make the embedding-drift re-arm sound: filtered windows, a persisted rebuild epoch, a sequenced burn'
type: 'bugfix'
created: '2026-09-01'
baseline_revision: '9ef733cd986a7570a7f87fe0ecc276392028265a'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The `drift:<active model>` warning key re-arms on the composition of one query window, and that window is unsound three ways: `queryEmbeddings` slices to `topK` BEFORE the model filter runs, so DW-404's own reproduction (topK 1, one stale-tagged and one current-tagged vector, alternating queries) still emits four drift lines instead of one (DW-598); nothing persists that a rebuild COMPLETED, so one stale orphan vector leaves every window mixed forever and wedges the key shut for the rest of the process (DW-599); and the gate, the burn and the delete all run after an `await` with no sequence carried across it, so a healthy read that resolves late un-burns a key another in-flight query just burnt (DW-602).

**Approach:** Push the model filter into the `queryEmbeddings` provider signature so the window a door judges is the top-K nearest ACCEPTED vectors and the provider reports how many stored vectors it rejected; persist a monotonic rebuild epoch that `rebuildVectorStore` increments on completion and re-arm the drift key from that epoch instead of from window composition; and record the epoch observed at burn time so the re-arm is a strictly-greater comparison, which is what sequences two concurrent reads.

## Boundaries & Constraints

**Always:**
- The `accept` predicate, when supplied, is applied to the candidate set BEFORE the top-K reduction on every provider that ranks locally (filesystem, the R2 KV fallback). `rejected` counts what it turned away.
- `rebuildVectorStore` keeps its never-delete contract and its fail-soft per-page/per-flush behaviour exactly as they are.
- The rebuild epoch is a monotonically increasing integer obtained through the existing provider-atomic `incrementIndex` door; the re-arm compares strictly greater (`epoch > epochAtBurn`), never inequality, so a stale read can never re-arm.
- Both doors (`searchByVector`, `relatedByVector`) keep sharing the ONE key `drift:<active model>`, keep the single-config-snapshot rule (DW-313), and keep returning what they returned before — the change is on the warn/re-arm gate and on which vectors the provider ranks, never on the door's answer being narrowed beyond the model filter that already applied.
- Every storage read added on the warn/re-arm path is fail-soft: a throwing or unparseable epoch read degrades to "no rebuild observed", never to a spurious re-arm.
- The epoch read happens only in the states that need it (about to burn; key already burnt), never on the common healthy read with no burnt key.

**Block If:**
- Closing DW-598 for the Cloudflare Vectorize branch would require creating a Vectorize metadata index or otherwise changing deployed index configuration.
- The change would require `rebuildVectorStore` to delete vectors.

**Never:**
- Do not give the two doors separate keys, and do not add a `drift:null` branch — `warnedMisconfigurations` already records why neither is a case.
- Do not keep the whole-window/positive-proof conjuncts as an additional AND on the re-arm: an orphan vector makes every window mixed forever, so keeping them re-opens DW-599.
- Do not add a second unfiltered probe query to distinguish an empty store from a fully drifted one — that is what `rejected` is for.
- Do not touch the deferred-work ledger.
- Do not widen scope to `spec-dw-404-405-406-embedding-drift-rearm-gate.md` (still `in-review`, never implemented, owned by a separate ledger entry).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Filter before slice | Store holds a stale-tagged and a current-tagged vector; `queryEmbeddings(v, 1, accept)` | Returns `{ matches: [current], rejected: 1 }` — the stale vector never occupies the single slot | No error expected |
| No filter supplied | `queryEmbeddings(v, topK)` with no `accept` | `{ matches: <top-K as today>, rejected: 0 }` — ranking and slicing unchanged | No error expected |
| DW-598 reproduction | Fully drifted corpus burns the key; then `page-b` is re-tagged current, `page-a` stays stale; eight alternating `searchByVector(q, 1)` calls | Exactly ONE drift line (the first). No line from the mixed phase, and a later full re-drift stays silent | No error expected |
| DW-599 reproduction | Two vectors; drift burns the key; a COMPLETED rebuild re-tags only the live one (orphan stays stale); corpus drifts again under the same active model | TWO drift lines — the epoch bump re-arms despite the permanently mixed window | No error expected |
| DW-602 interleave | Read A's query resolves AFTER read B has burnt the key, and no rebuild happened in between | A does not re-arm; the next drifted read stays silent (still one line) | No error expected |
| Empty store | No vectors stored at all | `matches: []`, `rejected: 0` → NO drift line; door returns `[]` | No error expected |
| Fully drifted store | Every stored vector rejected by `accept` | `matches: []`, `rejected > 0` → drift line said once, epoch recorded | No error expected |
| Rebuild embedded nothing | `rebuildVectorStore` completes with `embedded === 0` | Epoch NOT incremented — nothing landed, so nothing may re-arm | Counter untouched |
| Epoch read fails | `getIndex` throws or holds a non-integer | Treated as epoch `0`; no re-arm, burn still recorded | Swallowed, no rethrow |
| Query throws | `queryEmbeddings` rejects (dimension mismatch) | `[]` via the existing catch; no warn, no re-arm | Existing `logVectorQueryFailure` path, unchanged |

</intent-contract>

## Code Map

- `src/lib/storage/types.ts:519` -- `queryEmbeddings(vector, topK)` contract. Gains an optional `accept` predicate and returns `EmbeddingQueryResult`. `EmbeddingMatch` is at `:145`; `getIndex`/`putIndex`/`incrementIndex` at `:430`/`:441`/`:459` are the epoch primitives — `incrementIndex`'s docblock already promises provider-atomic monotonicity, which is exactly what the re-arm needs. Read-only otherwise.
- `src/lib/storage/filesystem.ts:922` -- `queryEmbeddings`: `loadEmbeddings()` → map to scored → `sort` → `slice(0, topK)`. Apply `accept` to the loaded entries BEFORE scoring/sorting; `rejected` = entries dropped. `indexPath`/`getIndex`/`incrementIndex` at `:808-838` are the epoch's on-disk home (`.indexes/<key>.json`).
- `src/lib/storage/r2.ts:426` -- `queryEmbeddings`, two branches. The KV fallback mirrors filesystem exactly. The Vectorize branch ranks SERVER-side and cannot express `accept` (metadata filtering needs an index this repo does not create), so it over-fetches to the ceiling `returnMetadata: "all"` allows, then filters and slices; `VECTORIZE_UPSERT_CHUNK` near `:64` is the existing precedent for such a constant.
- `src/lib/embeddings.ts:189-228` -- `warnedMisconfigurations` (a `Set` today), `warnOnceAbout`, `rearmWarningAbout`, `_resetEmbeddingWarnings`. The Set becomes a Map from key to the epoch observed at burn (`null` for the three non-drift families). `rearmWarningAbout` must stay an unconditional delete — `selectOllama` re-arms `ollama-endpoint:sdk-default` through it.
- `src/lib/embeddings.ts:44-188` -- the `warnedMisconfigurations` docblock. The `drift:<active model>` bullet is the CANONICAL statement of the gate and currently documents the whole-window/positive-proof predicate plus DW-598's and DW-599's live residue. It must be rewritten to the epoch gate; both doors' branch comments point here rather than restating.
- `src/lib/embeddings.ts:1005-1075` -- `searchByVector`. `cfg`/`currentModel` one-snapshot reads at `:1047-1051`, `queryEmbeddings` at `:1056`, the local `.filter(modelMatches)` at `:1057` (deleted — the provider does it), the re-arm branch at `:1063` and the warn branch at `:1064-1074`.
- `src/lib/embeddings.ts:1128-1192` -- `relatedByVector`. Stale-anchor early return + burn at `:1144-1158`, `queryEmbeddings(self.vector, topK + 1)` at `:1165`, the `m.id !== slug` split and local model filter at `:1169-1170`, the same two branches at `:1171-1186`. `currentModel` is legitimately `null` here; `modelMatches` is true against null, so `accept` degrades to accept-all — keep that.
- `src/lib/embeddings.ts:1206-1322` -- `rebuildVectorStore`. `RebuildResult` at `:1206`, the `try/finally` loop and tail `flushPending()` at `:1284-1320`, `return { total, embedded, skipped, model }` at `:1321`. The epoch bump belongs after the tail flush, gated on `embedded > 0`.
- `src/lib/embeddings.ts` `modelMatches` -- the accept predicate's body; deliberately keeps unlabelled legacy vectors. Unchanged, now passed down instead of applied locally.
- `src/lib/__tests__/embeddings.test.ts:1195-1560` (searchByVector drift suite) and `:540-930` (relatedByVector drift suite) -- every test whose "rebuild landed" step is a `reseed`/`seedVector` re-tag rather than an epoch bump now asserts a re-arm that no longer happens. Helpers: `seedVector` (`:84`), `withWarnSpy`, `DEFAULT_TEST_MODEL` (`:78`), real filesystem storage in a temp dir via `getStorage()`.
- `src/lib/__tests__/storage-fs.test.ts:468-535` and `src/lib/__tests__/storage-r2.test.ts:760-840` -- ~13 `queryEmbeddings` call sites that must read `.matches`; the natural home for the new pre-slice-filter and `rejected` pins.

## Tasks & Acceptance

**Execution:**
- `src/lib/storage/types.ts` -- add `EmbeddingFilter` (metadata predicate) and `EmbeddingQueryResult` (`matches`, `rejected`); change `queryEmbeddings` to `(vector, topK, accept?) => Promise<EmbeddingQueryResult>` and document the pre-slice guarantee, what `rejected` counts, and that a server-ranking provider satisfies it best-effort over an over-fetched window -- the contract is what makes the window a corpus signal instead of a window signal.
- `src/lib/storage/index.ts` -- re-export the two new types beside `EmbeddingMatch` -- keep the public storage surface consistent.
- `src/lib/storage/filesystem.ts` -- apply `accept` to the loaded entries before scoring/sorting/slicing; return `{ matches, rejected }` -- this is the provider DW-598 is reported against.
- `src/lib/storage/r2.ts` -- same for the KV fallback; for Vectorize, over-fetch to a named ceiling constant when `accept` is supplied, then filter and slice, with a comment stating plainly that `rejected` is window-scoped there -- honest rather than over-claiming.
- `src/lib/embeddings.ts` -- turn `warnedMisconfigurations` into a `Map<string, number | null>`; give `warnOnceAbout` an optional epoch argument; add a `rearmDriftIfRebuilt(key, observedEpoch)` that deletes only on `observedEpoch > epochAtBurn`, plus a fail-soft `readRebuildEpoch()` over `getIndex` and an exported `EMBEDDING_REBUILD_EPOCH_KEY` -- the epoch, recorded at burn and compared strictly, is both the DW-599 fix and the DW-602 sequence number.
- `src/lib/embeddings.ts` -- rewrite the `drift:<active model>` bullet on the `warnedMisconfigurations` docblock and `rearmWarningAbout`'s docblock: the gate is now a persisted rebuild epoch, the window-composition conjuncts are gone, DW-598/DW-599 are closed, and the residue that remains (server-ranking providers; a burn that records a stale epoch erring toward one extra line) is named once -- this docblock is the canonical statement and currently asserts the opposite.
- `src/lib/embeddings.ts` -- rewire `searchByVector`: pass `accept` to `queryEmbeddings`, drop the local `.filter`, warn on `matches.length === 0 && rejected > 0`, and re-arm on a non-empty accepted window whose freshly-read epoch exceeds the epoch at burn -- reading the epoch AFTER the query resolves and taking the Map entry synchronously with the delete is what makes the interleave safe.
- `src/lib/embeddings.ts` -- rewire `relatedByVector` identically, keeping the anchor split (`m.id !== slug`) and the stale-anchor early-return burn, which now records the epoch too -- one gate, both doors, as today.
- `src/lib/embeddings.ts` -- increment the epoch in `rebuildVectorStore` after the tail flush, only when `embedded > 0`, fail-soft -- a rebuild that landed nothing is not evidence of anything.
- `src/lib/__tests__/storage-fs.test.ts`, `src/lib/__tests__/storage-r2.test.ts` -- update call sites to the result object and add pins for the matrix's first two rows (pre-slice filtering at `topK: 1`; unchanged behaviour with no `accept`) plus `rejected` counts -- the pre-slice guarantee is the provider's, so it is pinned at the provider.
- `src/lib/__tests__/embeddings.test.ts` -- rewrite the drift suites in both doors: every "a rebuild landed" step bumps the epoch (via `getStorage().incrementIndex(EMBEDDING_REBUILD_EPOCH_KEY)`), and add the DW-598, DW-599 and DW-602 rows of the matrix as named pins; keep the tests that assert NO re-arm (mixed, unlabelled, empty window, drift-still-standing, other key families, other model identity) and re-anchor their comments on the epoch -- the ledger names these three reproductions as what must be pinned.
- `src/lib/__tests__/embeddings.test.ts` -- pin in the `rebuildVectorStore` suite that a completed rebuild increments the epoch and one that embedded nothing does not -- otherwise the only wiring between the fix and its trigger is untested.

**Acceptance Criteria:**
- Given a store holding one stale-tagged and one current-tagged vector, when `searchByVector` runs with `topK: 1`, then the returned window holds only the current-tagged vector regardless of which vector is nearer the query.
- Given the drift key is burnt and no rebuild has completed since, when any number of healthy or mixed reads run through either door, then the key stays burnt and no second drift line is emitted.
- Given the drift key is burnt and `rebuildVectorStore` has since completed with at least one page embedded, when a read returns a non-empty accepted window, then the key re-arms and a later genuine drift under the same active model speaks again — even though a stale orphan vector is still stored.
- Given two `searchByVector` calls in flight, when the one that read its window first resolves after the other has burnt the key, then it does not re-arm.
- Given no `accept` argument, when any caller invokes `queryEmbeddings`, then ranking, top-K slicing and returned matches are byte-identical to today's behaviour and `rejected` is `0`.
- Given `getIndex` throws on the epoch key, when a drifted or healthy read runs, then the door behaves as if no rebuild had been observed and no error propagates to the caller.

## Spec Change Log

## Review Triage Log

## Design Notes

Why the epoch REPLACES the window conjuncts rather than joining them: DW-599's orphan is a vector `rebuildVectorStore` never deletes, so after a completed rebuild every window containing it is permanently mixed. Any re-arm that also demands a whole-window match therefore stays wedged, which is the entry itself. The epoch is corpus-level evidence and is the only conjunct that survives.

Why strictly-greater and not inequality — this is DW-602's fix, and it is subtle:

```ts
// AFTER the query resolves. The Map read and the delete are one synchronous
// step, and `incrementIndex` is monotonic, so a read holding a STALE (lower)
// epoch cannot re-arm, and a read that another query burnt underneath sees
// its own epoch equal to the recorded one.
const epoch = await readRebuildEpoch();          // 0 on any failure
const burntAt = warnedMisconfigurations.get(key); // read AFTER every await
if (burntAt != null && epoch > burntAt) warnedMisconfigurations.delete(key);
```

The mirror-image case is accepted deliberately: a burn that records an epoch read just before a rebuild lands will re-arm on the next healthy read and cost ONE extra line. Erring toward speaking is the right side of DW-310's trade — a suppressed second outage is the failure that entry exists to prevent.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/embeddings.test.ts src/lib/__tests__/storage-fs.test.ts src/lib/__tests__/storage-r2.test.ts` -- expected: all pass, including the three named reproductions.
- `pnpm exec tsc --noEmit` -- expected: clean; the `queryEmbeddings` return-shape change has no unconverted call site.
- `pnpm lint` -- expected: no new errors or warnings.
- `pnpm test` -- expected: full suite green, no collateral breakage from the storage-interface change.
