---
title: 'Give relatedByVector the same drift breadcrumb and re-arm searchByVector already has'
type: 'bugfix'
created: '2026-08-31'
baseline_revision: '63f09c4092ddee40feaa4780f3dd79d48fc22566'
baseline_commit: '63f09c4092ddee40feaa4780f3dd79d48fc22566'
status: 'done'
review_loop_iteration: 0
context: []
warnings: ['oversized']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `relatedByVector` applies `modelMatches` at two points — the stale-anchor early return and the window filter — but never warns and never re-arms, so a deployment whose only vector traffic is page-render related lookups (`findSimilarPages`) observes neither embedding-model drift nor its recovery. The second half is the sharper defect: since DW-332 made drift CLEARABLE state, a rebuild proven out only through this door never clears `drift:<model>`, so a later genuine drift under the same active model ships silent for the rest of the process.

**Approach:** Widen the door to full parity with `searchByVector`. Warn once before the stale-anchor early return, and over the self-dropped window re-arm on the SAME strict gate `searchByVector` uses (whole-window match plus positive proof of an active-model-labelled vector) or warn once when the filter dropped everything. Same `drift:${currentModel}` key, so the two doors share one piece of news rather than each getting their own.

## Boundaries & Constraints

**Always:**
- Re-arm only on the canonical gate `kept.length === others.length && kept.some((m) => m.metadata.model === currentModel)`. A second door must not reintroduce the looseness the 2026-08-22 decisions (DW-404, then DW-405) closed in the first.
- One config snapshot per call: keep the single existing `getEmbeddingModelName()` read and use that same `currentModel` for the anchor check, the window filter, the warn text and the key. Never add a second read (DW-313).
- Key on `drift:${currentModel}` — the same identity `searchByVector` uses. Warn through `warnOnceAbout`, re-arm through `rearmWarningAbout`; add no third mutator of `warnedMisconfigurations`.
- What the door RETURNS is unchanged in every case, including the two new warn paths. `ARCHITECTURE-SPINE.md:108` — a model mismatch stays a cache miss falling back to tokenized retrieval.
- Both window branches stay inside the existing `try`, so a dimension-mismatch throw still degrades to `[]` without warning or re-arming.

**Ask First:**
- Any change to `modelMatches`, to `searchByVector`'s gate, or to what either door returns.
- Any attempt to close the accepted false positive below by making the two doors' keys differ.

**Never:**
- Do not touch `searchByVector`, `modelMatches`, `rebuildVectorStore`, `warnOnceAbout`, `rearmWarningAbout`, `_resetEmbeddingWarnings`, the DW-401 `ollama-endpoint:sdk-default` re-arm, or the three never-clearing env/binding identities.
- Do not add a null-active-model branch. Both new window branches are already false when `currentModel` is null (see matrix) — the silence is structural, not an omission.
- Do not resolve, reword, or re-status any ledger entry, including DW-406 itself.

## I/O & Edge-Case Matrix

`others` = the top-K+1 window with the anchor's own vector dropped; `kept` = `others` after `modelMatches`.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stale anchor (DW-406's named case) | Anchor's stored vector labelled with a model other than the active M | `[]` as today, AND the drift line said ONCE from this door however many renders run | N/A |
| Rebuild proven out here | `kept.length === others.length` and one kept vector labelled M; key burnt earlier by `searchByVector` | Key re-armed — a later real drift speaks again | N/A |
| Mixed window | Some others labelled M, some stale (dropped) | No re-arm, no warn — results returned as today | N/A |
| Whole-window unlabelled | Every other vector carries no `model` key | No re-arm (no positive proof), no warn (nothing dropped) | N/A |
| Filter dropped everything | `others.length > 0`, `kept.length === 0`, anchor itself unlabelled so it passed | Drift line said ONCE | N/A |
| Healthy, never drifted | All others labelled M | Silent re-arm — no line spoken | N/A |
| Lone page / empty window | `others.length === 0` | Silent — an empty window is not evidence in either direction | N/A |
| Null active model | No embedding provider resolves | Silent — both branches false, `drift:null` never spoken | N/A |
| Mixed-dimension store | Cosine scan throws | `[]`, existing `logVectorQueryFailure` line only; no warn, no re-arm | Caught by existing `try`/`catch` |

</frozen-after-approval>

## Code Map

- `src/lib/embeddings.ts:1078-1102` -- `relatedByVector`, the only file to change. Line 1086 is the stale-anchor early return; line 1095 is the combined `m.id !== slug && modelMatches(...)` filter that must split into `others` then `kept`.
- `src/lib/embeddings.ts:992-1071` -- `searchByVector`. Read-only, and the source of the gate to copy verbatim: line 1044 re-arms, line 1055 warns. Copy the PREDICATE; do not restate its rationale — the canonical statement lives on `warnedMisconfigurations`.
- `src/lib/embeddings.ts:146-181` -- `warnedMisconfigurations`, `warnOnceAbout`, `rearmWarningAbout`. The doc block at lines 65-124 is the canonical residue statement; extend the `drift:<active model>` bullet to say the key now has TWO doors, and record the new false positive.
- `src/lib/embeddings.ts:841-844` -- `modelMatches`. Read-only. It returns `true` on a null model or an unlabelled vector, which is why the null and all-unlabelled rows above fall out for free.
- `src/lib/embeddings.ts:540-546` -- `getEmbeddingModelName(cfg = loadConfigSync())`. `relatedByVector` calls it with no argument; that one read is the snapshot.
- `src/lib/__tests__/embeddings.test.ts:486-556` -- `describe("relatedByVector")` with `seedAnchorSet` and its own tmpdir/`_resetStorage` lifecycle. New pins belong here. Line 537's "returns [] when the anchor's vector is from a different model (stale)" now also emits a line — extend it rather than leaving that unasserted.
- `src/lib/__tests__/embeddings.test.ts:169-182` -- `withWarnSpy`, the shared `logger.warn` capture. Line 132 (root `beforeEach`) already calls `_resetEmbeddingWarnings()`, so no new reset wiring is needed.
- `src/lib/search.ts:299` -- `findSimilarPages`, the sole production caller (article render path). Read-only; unchanged because the return shape is unchanged.
- `src/lib/__tests__/search.test.ts:19` -- mocks `relatedByVector` wholesale, so no search-suite fallout.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/embeddings.ts` -- in `relatedByVector`, warn once before the stale-anchor early return, then split the combined filter into `others` (anchor dropped) and `kept` (model filter); re-arm on the canonical gate over `others`, else warn once when `kept.length === 0 && others.length > 0`. Preserve the `.slice(0, topK)` and the returned shape exactly. -- Closes both halves of DW-406 without changing what the door answers.
- [x] `src/lib/embeddings.ts` -- extend the `drift:<active model>` bullet on `warnedMisconfigurations` to name both doors and record the accepted false positive; add a short doc line on `relatedByVector` pointing at that canonical statement rather than restating the gate. -- The residue is stated once, in one place, as the module already insists.
- [x] `src/lib/__tests__/embeddings.test.ts` -- extend the line-537 stale-anchor test to assert the warning, and add pins for: the stale-anchor line said ONCE across repeated renders; a related lookup over an all-current window re-arming a key `searchByVector` burnt; a mixed window neither re-arming nor warning; an all-unlabelled window silent in both directions; a never-drifted corpus silent; a null-active-model corpus silent. -- Covers every matrix row that is new behaviour.

**Acceptance Criteria:**
- Given a corpus drifted under active model M and vector traffic consisting ONLY of page renders, when `findSimilarPages` runs repeatedly, then exactly one drift line is logged for the process and it names `active="M"`.
- Given `searchByVector` has burnt `drift:M`, when a subsequent `relatedByVector` reads a window the model filter dropped nothing from that holds at least one M-labelled vector, then a later genuinely drifted `searchByVector` speaks a second time.
- Given a partially rebuilt (mixed-model) corpus, when `relatedByVector` runs, then `drift:M` is neither burnt nor re-armed by this door.
- Given any scenario above, when `relatedByVector` returns, then its results are identical to those at `baseline_revision`.

## Design Notes

The gate is read off `others`, not the raw `matches` window: the anchor's own vector was already vetted by the early return, so counting it as proof would let a page vouch for a corpus it is the only current member of. Dropping it first also keeps this branch talking about the same set the door returns from, exactly as `searchByVector` reads its proof off `kept`.

The stale-anchor warn is what makes the fix reach DW-406's actual case. On a fully drifted corpus EVERY anchor is stale, so control never reaches the window at all — without that first warn the door stays mute in precisely the situation the entry names.

Accepted cost, to be recorded in the doc block rather than engineered around: one stale ORPHAN anchor — a renamed or re-embedded page whose old vector `rebuildVectorStore` never deletes — burns the process-wide `drift:M` key on one page's evidence, on an otherwise healthy corpus. `searchByVector` cannot produce that false positive, because its warn requires the filter to have dropped the WHOLE window. This is the mirror of DW-599's cost and is accepted deliberately: the key is shared so that drift is one piece of news, and a burnt key costs a suppressed line, not a wrong answer.

```ts
// after the stale-anchor warn + early return:
const others = matches.filter((m) => m.id !== slug);
const kept = others.filter((m) => modelMatches(m.metadata, currentModel));
if (kept.length === others.length && kept.some((m) => m.metadata.model === currentModel)) {
  rearmWarningAbout(`drift:${currentModel}`);
} else if (kept.length === 0 && others.length > 0) {
  warnOnceAbout(`drift:${currentModel}`, /* … */);
}
return kept.slice(0, topK).map((m) => ({ slug: m.id, score: m.score }));
```

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/embeddings.test.ts src/lib/__tests__/search.test.ts` -- expected: all pass, including every pre-existing drift test in `searchByVector` unchanged.
- `npx tsc --noEmit` -- expected: clean.
- `npx eslint src/lib/embeddings.ts src/lib/__tests__/embeddings.test.ts` -- expected: clean.
- Mutation checks (run, then revert): deleting the stale-anchor `warnOnceAbout` must fail the stale-anchor pins; loosening the re-arm gate to `kept.length > 0` must fail the mixed-window pin; dropping the `kept.some(...)` conjunct must fail the all-unlabelled pin; re-arming off `matches` instead of `others` must fail the all-unlabelled pin.

## Suggested Review Order

**The design decision (start here)**

- The whole change in one paragraph: why a second door exists and what it shares.
  [`embeddings.ts:117`](../../src/lib/embeddings.ts#L117)

- The accepted cost. Read before judging the stale-anchor warn below.
  [`embeddings.ts:131`](../../src/lib/embeddings.ts#L131)

- Why null needs no branch here even though it IS reachable at this door.
  [`embeddings.ts:148`](../../src/lib/embeddings.ts#L148)

**The behaviour**

- The stale-anchor warn — DW-406's named case, and the only branch a fully drifted corpus reaches.
  [`embeddings.ts:1128`](../../src/lib/embeddings.ts#L1128)

- The filter split into `others`, so the anchor cannot supply its own proof.
  [`embeddings.ts:1152`](../../src/lib/embeddings.ts#L1152)

- The gate, copied predicate-for-predicate from `searchByVector` rather than re-derived.
  [`embeddings.ts:1155`](../../src/lib/embeddings.ts#L1155)

- The door's own docblock, pointing at the canonical statement instead of restating it.
  [`embeddings.ts:1111`](../../src/lib/embeddings.ts#L1111)

**The pins that hold the design (added under review)**

- The shared key, cross-door: a render warn silences the search door.
  [`embeddings.test.ts:815`](../../src/lib/__tests__/embeddings.test.ts#L815)

- The render-only deployment, end to end: warn, rebuild, re-arm, drift, warn again.
  [`embeddings.test.ts:843`](../../src/lib/__tests__/embeddings.test.ts#L843)

- The accepted false positive, pinned so a later "fix" cannot delete it silently.
  [`embeddings.test.ts:884`](../../src/lib/__tests__/embeddings.test.ts#L884)

**Supporting tests**

- DW-405's proof conjunct held at this door; also catches reading the gate off `matches`.
  [`embeddings.test.ts:744`](../../src/lib/__tests__/embeddings.test.ts#L744)

- The re-arm that makes rebuild-then-re-drift audible a second time.
  [`embeddings.test.ts:663`](../../src/lib/__tests__/embeddings.test.ts#L663)

- The pre-existing stale-anchor test, now asserting the branch-distinguishing line.
  [`embeddings.test.ts:537`](../../src/lib/__tests__/embeddings.test.ts#L537)
