---
title: 'Re-arm the embedding-drift warning after a corpus rebuild'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
baseline_revision: '6ba87e9d5f3c05ecf334878c98686bdaf9d461f2'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The re-arm gate `kept.length > 0` is a property of the per-query top-K
      window, not of the corpus, so a partially-rebuilt (mixed-model) corpus can
      oscillate warn -> re-arm -> warn and revert DW-310's once-per-process
      throttle to per-query noise.
    evidence: |-
      `queryEmbeddings` sorts and slices to `topK` BEFORE `searchByVector`
      applies the model filter (src/lib/storage/filesystem.ts queryEmbeddings;
      contract in src/lib/storage/types.ts). With one stale-tagged and one
      current-tagged vector and `topK: 1`, eight alternating queries emitted
      FOUR drift lines instead of one. This is not contrived: `rebuildVectorStore`
      upserts page by page with no bulk swap, so the store is mixed for the whole
      duration of the very operation the re-arm exists to detect, and it
      deliberately leaves stale orphans behind. The tighter gate
      (`kept.length === matches.length`, or a rebuild-completion epoch) was NOT
      applied because the recorded 2026-08-21 decision names `kept.length > 0`
      as the trigger verbatim; narrowing it is a decision this run does not hold.
    location: >-
      src/lib/embeddings.ts (searchByVector re-arm branch)
    severity: medium
  - summary: >-
      A single unlabelled legacy vector satisfies `kept.length > 0` and re-arms
      `drift:<active model>` on a corpus where every labelled vector is still
      stale, so a genuinely un-rebuilt corpus can repeat the drift line.
    evidence: |-
      `modelMatches` deliberately returns true when `metadata.model` is absent
      (pre-migration / KV-fallback vectors must survive the filter — pinned by
      the existing test "keeps unlabelled (legacy) vectors with no model
      metadata"). Seeding one unlabelled vector plus stale-tagged ones and
      alternating three queries produced TWO drift lines where the throttle
      should give one. A gate of
      `kept.some((m) => m.metadata.model === currentModel)` would close it, but
      that also narrows the decided `kept.length > 0` trigger. The inline comment
      at the re-arm branch was corrected to stop claiming corpus-level proof.
    location: >-
      src/lib/embeddings.ts (searchByVector re-arm branch, modelMatches)
    severity: medium
  - summary: >-
      `relatedByVector` runs the same model filter but neither warns nor
      re-arms, so a deployment whose only vector traffic is page-render related
      lookups observes neither the drift nor its recovery.
    evidence: |-
      src/lib/embeddings.ts relatedByVector applies `modelMatches` and silently
      returns [] on a drifted corpus. That muteness predates this change
      (DW-310 scoped the breadcrumb to searchByVector), but with drift now
      modelled as CLEARABLE state the asymmetry is newly consequential: a
      rebuild proven out only through relatedByVector never re-arms the key.
      Worth either one sentence of recorded rationale or a decision to widen the
      door.
    location: >-
      src/lib/embeddings.ts (relatedByVector)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `searchByVector` says the embedding-model drift line once per drifted active model per process, and `warnedMisconfigurations` is documented as never clearing. Drift is the one identity in that Set that is fixed *in-process* — by rebuilding the corpus — so once a corpus drifts, is rebuilt, and drifts again under the same active model, the second drift is silent for the rest of the process (DW-332).

**Approach:** Re-arm only the drift identity. On a successful `searchByVector` read where the model filter kept at least one match, delete the `drift:<active model>` key from `warnedMisconfigurations`, so a later real drift under that same active model speaks again. Every other member of the never-clearing clause stays exactly as-is.

## Boundaries & Constraints

**Always:**
- Re-arm exactly one key: `drift:${currentModel}`, where `currentModel` is the model name from the SAME `loadConfigSync()` snapshot the query was embedded with (DW-313 one-snapshot invariant). Never re-derive the model for the delete.
- Re-arm only on the success path inside the `try`, gated on `kept.length > 0` — the counter-signal that proves the corpus is answerable under the active model.
- Deleting a key that was never set is a silent no-op; the re-arm must not warn, throw, or change what `searchByVector` returns.
- Update the `warnedMisconfigurations` doc comment so the "nothing clears it" trade-off names drift as the deliberate exception and says why (rebuild happens in-process; the other three are env/binding state a restart fixes).
- Keep the drift warning sentence byte-identical; this change is about re-arming, not re-wording.

**Block If:**
- Honouring the intent would require deleting or re-arming any key other than `drift:<active model>`, or clearing the Set wholesale.

**Never:**
- Do not re-arm from `relatedByVector`, `rebuildVectorStore`, `upsertEmbedding`, `removeEmbedding`, or any other door — the decision names `searchByVector`'s successful read only.
- Do not re-arm the three env/binding identities (stale `EMBEDDING_MODEL`, unservable override, unbound `AI` binding). Their never-clearing trade-off is intact and recorded.
- Do not export a new public reset/re-arm API; `_resetEmbeddingWarnings` stays the only exported (test-only) escape hatch.
- Do not touch `getEmbeddingModelName`, `modelMatches`, or the catch-path `logVectorQueryFailure` behaviour.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rebuild then re-drift | Corpus drifted under active model M (line said once), corpus rebuilt so a query keeps matches, then corpus drifts again under the SAME model M | Drift line is said a SECOND time, with the same `active="M"` sentence | No error expected |
| Drift still standing | Corpus drifted under M, repeated queries all keep zero matches | Drift line still said exactly ONCE — no successful read intervened, so nothing re-armed | No error expected |
| Healthy corpus, never drifted | Every query keeps matches under M, drift key never set | No warning; the delete is a no-op and results are unchanged | No error expected |
| Query throws | `queryEmbeddings` rejects (dimension mismatch) | `[]` returned via the existing catch; no re-arm, since no successful read happened | Existing `logVectorQueryFailure` path, unchanged |

</intent-contract>

## Code Map

- `src/lib/embeddings.ts:31-76` -- doc comment for `warnedMisconfigurations` (the "four standing misconfigurations" / "nothing clears it" clause). Lines 52-57 are the trade-off paragraph that must gain the drift exception; lines 65-75 already explain why drift joined the Set (DW-310).
- `src/lib/embeddings.ts:76` -- `const warnedMisconfigurations = new Set<string>()`, module-scoped, one process = one lifetime.
- `src/lib/embeddings.ts:79-83` -- `warnOnceAbout(key, message)`, the only writer today. The re-arm needs a matching reader/deleter next to it — add a small module-private `rearmWarningAbout(key)` beside it rather than reaching into the Set from `searchByVector`, so the Set keeps exactly two named mutators plus the reset.
- `src/lib/embeddings.ts:95-97` -- `_resetEmbeddingWarnings()`, test-only clear. Unchanged.
- `src/lib/embeddings.ts:808-851` -- `searchByVector`. `cfg` snapshot at 812, `currentModel = getEmbeddingModelName(cfg)` at 816, the `try` at 820, `kept` at 822, the `matches.length > 0 && kept.length === 0` drift branch at 838-845, `return kept.map(...)` at 846, the catch at 847-850. The re-arm goes in this `try`, paired with the existing drift branch.
- `src/lib/embeddings.ts:788-807` -- `searchByVector`'s doc comment, which already spells out why a mis-fire would "BURN the `drift:<model>` key" — it should now also say the key re-arms on a kept read.
- `src/lib/__tests__/embeddings.test.ts:693-910` -- `describe("searchByVector")`. Existing drift coverage: "drops matches ... AUDIBLY" (754), "says the drift line ONCE" (773), "SPEAKS again when the ACTIVE MODEL changes" (805), "stays SILENT when the filter keeps even one match" (828), "stays SILENT when the store returns nothing at all" (842). The new rebuild-then-re-drift case belongs in this block, next to the ONCE test.
- `src/lib/__tests__/embeddings.test.ts:78-85` -- `seedVector(slug, vector, model, hash)` helper (writes through `getStorage().upsertEmbedding`); reuse it to seed both the drifted and the rebuilt corpus.
- `src/lib/__tests__/embeddings.test.ts:157-170` -- `withWarnSpy(body)` helper returning `{ result, warnings }` filtered to the `embeddings` channel; reuse for warning assertions.
- `src/lib/__tests__/embeddings.test.ts:110-127` -- global `beforeEach` already calls `_resetEmbeddingWarnings()`, so the new test starts with an empty Set.
- `src/lib/__tests__/embeddings.test.ts:550-596` -- `describe("removeEmbedding")` shows the existing way to delete stored vectors (`removeEmbedding(slug)`), which is how a test simulates a corpus rebuild alongside `seedVector`.

## Tasks & Acceptance

**Execution:**
- `src/lib/embeddings.ts` -- add a module-private `rearmWarningAbout(key: string): void` next to `warnOnceAbout` that deletes the key from `warnedMisconfigurations`, documented as "the next occurrence of this identity speaks again" -- keeps the Set's mutators named and greppable instead of an inline `.delete` at a call site.
- `src/lib/embeddings.ts` -- in `searchByVector`'s `try`, when `kept.length > 0`, call `rearmWarningAbout(drift:<currentModel>)` using the same `currentModel` the filter compared against -- a kept match is proof the corpus is no longer drifted under this active model, so the next real drift must be audible.
- `src/lib/embeddings.ts` -- amend the `warnedMisconfigurations` doc comment (trade-off paragraph) and `searchByVector`'s doc comment to record that drift is the ONE identity that re-arms, and why: drift is fixed by a corpus rebuild inside the same process, whereas the other three are env/binding state a restart or new isolate already fixes.
- `src/lib/__tests__/embeddings.test.ts` -- add to `describe("searchByVector")` a rebuild-then-re-drift test plus the two guards from the matrix (drift still standing stays once; a healthy never-drifted corpus stays silent), reusing `seedVector`, `removeEmbedding`, and `withWarnSpy` -- the ONCE test alone is satisfied by a key that never re-arms.

**Acceptance Criteria:**
- Given a corpus drifted under active model M whose drift line has already been said once, when the corpus is rebuilt so a query keeps at least one match and it then drifts again under the same model M, then the drift line is emitted a second time naming `active="M"`.
- Given a corpus that is drifted under model M and never rebuilt, when any number of further queries run, then the drift line is still emitted exactly once.
- Given the re-arm is in place, when `searchByVector` runs against a healthy corpus, then its returned results are byte-for-byte what they were before this change and no warning is emitted.
- Given `pnpm test` and `pnpm lint`, when run over the repository, then both pass with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 5, low 5)
- defer: 3: (high 0, medium 2, low 1)
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[medium]` `[patch]` Nothing pinned "only the drift key re-arms" — replacing the `delete` with a wholesale `warnedMisconfigurations.clear()` passed all 151 tests. Added "re-arms ONLY the drift key — other warning FAMILIES keep theirs" (burns `binding:workers-ai` and `model:openai:@cf/baai/bge-m3`, runs a re-arming read, re-provokes both, asserts silence).
  - `[medium]` `[patch]` Nothing pinned the DW-313 one-snapshot invariant for the DELETE — re-deriving via `getEmbeddingModelName()` passed all tests. Added "re-arms on the SAME snapshot the filter used", the mirror of the existing warn-path snapshot test.
  - `[medium]` `[patch]` I/O matrix row "Query throws" asserted `[]` but not the no-re-arm half. Added "does NOT re-arm when the query THROWS".
  - `[medium]` `[patch]` Nothing exercised the real `rebuildVectorStore`, though every comment names it as the in-process fix. Added "SPEAKS again after a REAL rebuildVectorStore, not a simulated one" (tests THROUGH the rebuild; nothing re-arms FROM it).
  - `[medium]` `[patch]` The inline branch comment claimed "a kept match proves the corpus is answerable under THIS active model" — false for unlabelled legacy vectors and for a top-K window over a mixed corpus. Reworded to what `kept.length > 0` actually establishes, naming both limitations; `rearmWarningAbout`'s docblock softened to match.
  - `[low]` `[patch]` "does NOT re-arm while the drift is still standing" was a near-duplicate of the DW-310 ONCE test and passed without the feature. Strengthened to assert all three reads returned `[]`, pinning the gate rather than the throttle.
  - `[low]` `[patch]` The rebuild-then-re-drift test discarded its results, asserting the effect without the cause. Now returns all three and asserts the middle read kept `["page-a"]`.
  - `[low]` `[patch]` The module-doc trade-off paragraph opened unqualified and contradicted itself three paragraphs later. Scoped to the three env/binding identities in its first clause.
  - `[low]` `[patch]` "on the line above its return" was inaccurate (`kept` is ~15 lines above, and the re-arm is in a branch). Replaced with "in the same branch chain that decides whether to warn".
  - `[low]` `[patch]` The DW-332 rationale was triplicated across the module doc, the `searchByVector` JSDoc, and the inline comment (~half the added lines). Module doc kept as canonical; inline comment trimmed to the correction plus a pointer.

Deferred (recorded in frontmatter `deferred`, not fixed here): the `kept.length > 0` gate is a per-query top-K property so a mixed-model corpus can oscillate; an unlabelled legacy vector re-arms a still-drifted corpus; `relatedByVector` neither warns nor re-arms. All three would require narrowing or moving the trigger the 2026-08-21 decision names verbatim.

Rejected: logging `Set.delete`'s boolean as a "drift cleared" info line (new behaviour beyond the decision); swapping the hardcoded `active="text-embedding-3-small"` assertions for `DEFAULT_TEST_MODEL` (the neighbouring DW-310 tests hardcode it too); "ledger/spec status is stale" (`deferred-work.md` is orchestrator-owned; `in-review` was correct mid-run); "the tests belong in the `misconfiguration warnings are said once` suite" (the DW-310 drift tests already live in `describe("searchByVector")`).

## Design Notes

The re-arm is deliberately asymmetric with the rest of the Set, and the comment must say so. The three env/binding identities encode "your deployment is configured wrong" — nothing inside the process fixes that, so carrying "resolved" state for them would be dead weight. Drift is different in kind: `rebuildVectorStore` runs in the same process and is exactly the fix, and `searchByVector` already computes the proof it worked (`kept.length > 0`) on the line above the return. Re-arming there costs one `Set.delete` on a path that already ran a vector query.

Shape at the call site:

```ts
const kept = matches.filter((m) => modelMatches(m.metadata, currentModel));
if (kept.length > 0) {
  // A kept match proves the corpus is answerable under this active model:
  // the drift (if any) is over, so a LATER drift under M must speak again.
  rearmWarningAbout(`drift:${currentModel}`);
} else if (matches.length > 0) {
  warnOnceAbout(`drift:${currentModel}`, /* ...existing sentence... */);
}
```

Either an `if/else if` or two independent `if`s is fine — the branches are mutually exclusive because `kept ⊆ matches`. What is not fine is re-deriving `currentModel` for the delete: the DW-313 one-snapshot invariant is what makes the key trustworthy, and a second `getEmbeddingModelName()` read could straddle the 5 s config-cache TTL and re-arm the wrong identity.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/embeddings.test.ts` -- expected: all tests pass, including the new rebuild-then-re-drift case.
- `pnpm test` -- expected: full suite passes with no new failures.
- `pnpm lint` -- expected: clean.
- `npx tsc --noEmit` -- expected: no type errors.


## Auto Run Result

Status: done

### Implemented change

DW-332. `drift:<active model>` is now the one identity in `warnedMisconfigurations`
that re-arms. On a successful `searchByVector` read where the model filter kept at
least one match, the key is deleted through a new module-private
`rearmWarningAbout`, so a corpus that drifts, is rebuilt, and drifts again under the
same active model is audible a second time. The delete uses the same DW-313 config
snapshot the filter compared against — never a re-derived `getEmbeddingModelName()`.
The three env/binding identities are untouched and still never clear. The drift
sentence itself is byte-identical, and no new API is exported.

### Files changed

- `../../src/lib/embeddings.ts` — added `rearmWarningAbout`; turned the drift branch
  into `if (kept.length > 0) { re-arm } else if (matches.length > 0) { warn once }`;
  rewrote the `warnedMisconfigurations` trade-off paragraph and the `searchByVector`
  JSDoc to record drift as the single deliberate exception and what the `kept` signal
  does and does not establish.
- `../../src/lib/__tests__/embeddings.test.ts` — seven new tests in
  `describe("searchByVector")` (rebuild-then-re-drift both simulated and through the
  real `rebuildVectorStore`; still-standing drift; healthy never-drifted corpus;
  other warning families keep their keys; other drift identities keep theirs; the
  one-snapshot rule for the delete; a throwing query does not re-arm) plus two
  existing new-in-this-run tests strengthened to pin cause as well as effect.

### Review findings breakdown

- Patches applied: 10 (5 medium, 5 low) — see `## Review Triage Log`.
- Items deferred: 3 (2 medium, 1 low) — recorded in frontmatter `deferred`; all three
  would require narrowing or relocating the `kept.length > 0` trigger the 2026-08-21
  decision names verbatim, which is a decision this run does not hold.
- Items rejected: 4 (low).

### Follow-up review recommendation

`true`. Patched findings by severity: high 0, medium 5, low 5. Score =
3 x 5 + 1 x 5 = 20, which is >= 5.

### Verification performed

- `npx vitest run src/lib/__tests__/embeddings.test.ts` — 156 passed (was 151 at
  baseline).
- `npx vitest run` — 270 files, 6004 tests, all passing.
- `npx tsc --noEmit` — exit 0.
- `npx eslint` — exit 0. `pnpm lint` and `pnpm test` themselves fail in this checkout
  with `ERROR packages field missing or empty`, a pre-existing pnpm
  workspace-resolution problem (there is no `pnpm-workspace.yaml`) unrelated to this
  change; `npx` runs the identical commands from `package.json` scripts.
- Mutation checks, run and then reverted: replacing the delete with
  `warnedMisconfigurations.clear()` now fails 3 tests (0 before the review patches);
  re-deriving the model name for the delete now fails 1 (0 before); removing the
  re-arm entirely fails the rebuild-then-re-drift tests.
- Matrix test audit: all four I/O matrix rows are covered by tests that ran and
  passed.

### Residual risks

- The three deferred findings above are real and demonstrated. The most consequential
  is the mixed-model corpus: because `queryEmbeddings` slices to `topK` before the
  model filter and `rebuildVectorStore` upserts page by page, the drift line can
  repeat per query for the duration of a live rebuild — the noise DW-310's throttle
  was written to remove. It is bounded (log volume only; results are unaffected) and
  is a direct consequence of the trigger the recorded decision specifies.
- A snapshot-straddling mis-fire is now self-correcting rather than permanently
  burning the key, so the `searchByVector` docblock no longer claims the burn lasts
  "the rest of the process". That is an improvement, but it does change a documented
  invariant other readers may have relied on.
