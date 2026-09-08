---
title: 'Prove and state the drift key''s burn/re-arm sequencing: the interleave and the render door'
type: 'bugfix'
created: '2026-09-04'
baseline_revision: 'b916072354895abf5cc4c4550f80113cf6484f85'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Two open entries say the `drift:<active model>` key can be un-burnt without a rebuild — a late-resolving concurrent read applying a re-arm gathered before another read burnt the key (DW-602), and the per-render door alternating warn and re-arm across anchors on a partially rebuilt corpus (DW-687). Both were written against the gate as it stood BEFORE the rebuild epoch landed at `b4a4460d`/`b9160723`; DW-687 names that very epoch as what would close it. Against today's code neither failure is reachable — the re-arm reads no property of any window and compares a freshly-read monotone counter strictly greater than the watermark recorded at burn — but nothing in the repo proves it, no test exercises a concurrent interleave or a repeated render, and the canonical docblock still states outright that "Concurrent interleaving of a burn and a bump is NOT closed here (DW-602)".

**Approach:** Verify both entries against the current gate, pin each named failure as a deterministic test at the door it is reported against, and rewrite the canonical statement so it says what the gate now guarantees — that the epoch IS the burn sequence number DW-602 asked for, that the recorded watermark is monotone under every interleaving, and that the render door re-arms deliberately and on corpus-level evidence only. Behaviour does not change; what changes is that the guarantee is proven and stated instead of assumed.

## Boundaries & Constraints

**Always:**
- Production behaviour of both doors stays byte-identical. This bundle adds tests and corrects comments; if a pin fails, that is a discovered defect to fix, not a licence to reshape the gate.
- Every new pin is deterministic — a controlled interleave built from resolvable promises and spies, never a timer, a race against real concurrency, or a retry.
- The re-arm keeps reading exactly one signal: a freshly-read `EMBEDDING_REBUILD_EPOCH_KEY` strictly greater than the epoch recorded at burn. No window conjunct is reintroduced at either door.
- Both doors keep sharing the one key `drift:<active model>`, keep the epoch read confined to the burnt/about-to-burn states, and keep returning what they return today.
- Every claim written into a docblock in this bundle is either pinned by a test added here or already pinned; residue that stays open is named as residue, with the direction it errs in.

**Block If:**
- A new pin shows the gate actually CAN be un-burnt without a completed rebuild — that is a behaviour defect, and fixing it changes the shape of a gate two prior bundles settled.

**Never:**
- Do not change `searchByVector`'s or `relatedByVector`'s return values, the warn conditions (`matches.length === 0 && rejected > 0 && topK > 0` and its `others` twin), or the `topK > 0` conjunct.
- Do not make the render door warn-only. The decision this bundle records is the opposite one, and the reason is in Design Notes.
- Do not add a second epoch read, a pre-query epoch read, or any per-render caching/throttling of the epoch read — the "no epoch read on a healthy never-burnt read" criterion is pinned at both doors and must stay true.
- Do not re-file the Vectorize best-effort window; it is already carried as a `medium` deferred item on `spec-dw-598-599-vector-drift-window-and-epoch.md`.
- Do not widen scope to `spec-dw-598-599-602-vector-drift-rearm-soundness.md` or `spec-dw-404-405-406-embedding-drift-rearm-gate.md` — both sit at `status: in-review`, never implemented, owned elsewhere.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DW-602 interleave, query door | Read A's `queryEmbeddings` (healthy window) is held unresolved; read B runs to completion and burns the key; A then resolves | A does not re-arm; a later drifted read stays silent — ONE line total | No error expected |
| DW-602 interleave, render door | Same, with `relatedByVector` as the late-resolving reader on a burnt key | A does not re-arm; ONE line total | No error expected |
| DW-602 interleave, cross-door | `relatedByVector`'s query held; `searchByVector` burns underneath; render then resolves | Render does not re-arm; ONE line total | No error expected |
| Watermark cannot move backwards | Read A reads epoch 1; a rebuild lands (epoch 2); read B burns at 2; A then reaches its burn with its stale epoch 1 | The recorded watermark stays 2 — a later read at epoch 2 does not re-arm; only epoch 3 does | No error expected |
| Late re-arm on a REAL rebuild | Read A's query held; key burnt at epoch 1; a rebuild completes (epoch 2); A resolves | A DOES re-arm — the bump is strictly after the watermark, which is sound evidence | No error expected |
| DW-687 alternating renders | Corpus partially rebuilt: `anchor-stale` cluster stale, `anchor-fresh` cluster current; key burnt; renders alternate across the two anchors four times, no epoch bump | ONE line total; the key never re-arms — a following full re-drift is silent | No error expected |
| DW-687 cluster-local rebuild | Key burnt; only one topical cluster is re-tagged current, no epoch bump; an anchor INSIDE that cluster renders with a wholly-current neighbour window | No re-arm; a later drift under the same model stays silent | No error expected |
| DW-687 warn evidence is corpus-level | Anchor is current; its nearest neighbours are all stale; a current vector sits far away in the corpus | No drift line — the pre-slice `accept` makes `matches` the nearest ACCEPTED corpus-wide, so `others` is non-empty | No error expected |
| Healthy never-burnt render | Key never burnt, corpus healthy, repeated renders | Still zero `getIndex` calls for the epoch key | No error expected |

</intent-contract>

## Code Map

- `src/lib/embeddings.ts:161-234` -- the `drift:<active model>` bullet on the `warnedMisconfigurations` docblock, the CANONICAL statement of the gate. `:225-231` is the residue paragraph; its last line ("Concurrent interleaving of a burn and a bump is NOT closed here (DW-602).") is the sentence this bundle rewrites. `:236-260` is the two-door paragraph (DW-406) and the accepted orphan-anchor false positive — where the DW-687 render-door statement belongs.
- `src/lib/embeddings.ts:318-337` -- `warnedMisconfigurations` (`Map<string, number | null>`) and `warnOnceAbout(key, message, observedEpoch)`. `warnOnceAbout`'s `if (has(key)) return` is what makes the recorded watermark MONOTONE under interleaving: a late read holding a stale epoch cannot lower a watermark another read already set. That property is load-bearing for DW-602 and currently unstated and unpinned.
- `src/lib/embeddings.ts:339-365` -- `rearmDriftIfRebuilt(key, observedEpoch)`: `epochAtBurn == null` → no-op, else delete only on `observedEpoch > epochAtBurn`. Its docblock already argues monotonicity; it needs the DW-602 conclusion named.
- `src/lib/embeddings.ts:64-125` -- `readRebuildEpoch()` (fail-soft `0`) and `bumpRebuildEpoch()`. Read-only here; the `0`-at-burn direction is already documented at `:73-83`.
- `src/lib/embeddings.ts:1360-1400` -- `searchByVector`'s gate: `drifted` at `:1367`, `burnt` at `:1368`, then one `await readRebuildEpoch()` at `:1373`, `rearmDriftIfRebuilt` at `:1380`, `warnOnceAbout` at `:1386`. The `await` DW-602 names is `queryEmbeddings` at `:1341`.
- `src/lib/embeddings.ts:1419-1500` -- `relatedByVector`. Stale-anchor early return with its unconditional re-arm + burn at `:1428-1452`; the window branch at `:1462-1497` (`others` split at `:1472`, `drifted` at `:1478`, epoch read at `:1487`). This is the render door DW-687 is filed against.
- `src/lib/search.ts:291-325` -- `findSimilarPages`, the only production caller: `relatedByVector(slug, limit + 10)` at `:299`, reached from `ArticleView.tsx:169` on every article render. Read-only — DW-687's "high-frequency" claim is about this call site, not about anything to change in it.
- `src/lib/__tests__/embeddings.test.ts:503-1020` -- the `relatedByVector` suite. Helpers `seedAnchorSet` (`:519`), and at file scope `seedVector` (`:85`), `bumpRebuildEpoch` (`:106`, a bare `incrementIndex`), `withWarnSpy` (`:181`), `DEFAULT_TEST_MODEL` (`:78`). Real filesystem storage in a temp `DATA_DIR`. Nearest existing pins: "does NOT re-arm — or warn — on a partially rebuilt (MIXED) window" (`:725`) is one render; DW-687's claim is REPEATED alternation across DIFFERENT anchors, which nothing holds. "reads NO epoch at all on a healthy render whose key was never burnt" (`:827`) is the `getIndex`-spy idiom to reuse.
- `src/lib/__tests__/embeddings.test.ts:1165-2130` -- the `searchByVector` suite. `:1485` ("does NOT re-arm when the epoch read FAILS") is the `vi.spyOn(storage, "getIndex")`-with-passthrough idiom; the same shape over `queryEmbeddings` is how the interleave is staged deterministically. `:1729` (DW-599, epoch alone) and `:1541` (strictly-greater from a non-zero watermark) are the closest neighbours; neither runs two reads concurrently.
- `_bmad-output/implementation-artifacts/spec-dw-598-599-vector-drift-window-and-epoch.md` -- the landed bundle whose Auto Run Result explicitly declines to claim DW-602 closed, and whose frontmatter `deferred` already carries the Vectorize window. Read-only evidence for why this bundle's answer is "already closed, unproven".

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/embeddings.test.ts` -- add a deterministic-interleave helper beside `bumpRebuildEpoch`: spy on `getStorage().queryEmbeddings` with passthrough, hold the NEXT call's promise open on an externally-resolvable deferred, and expose "release it". Document that a timer or real race would make these pins flaky and prove less -- the interleave has to be staged, not hoped for.
- `src/lib/__tests__/embeddings.test.ts` (`searchByVector` suite) -- add the DW-602 rows: a held healthy read that resolves after another read burnt the key does not re-arm; the same held read DOES re-arm when a real epoch bump landed in the gap; and the watermark-monotonicity row (a stale-epoch burn arriving after a higher-epoch burn must not lower the watermark) -- the first two are the entry's own reproduction and its sound mirror image, the third is the property that makes them hold.
- `src/lib/__tests__/embeddings.test.ts` (`relatedByVector` suite) -- add the render-door interleave and the cross-door interleave -- DW-602 is filed at `searchByVector` but the shared key means the per-render door is where a late re-arm would be hit most often.
- `src/lib/__tests__/embeddings.test.ts` (`relatedByVector` suite) -- add the three DW-687 rows: repeated alternation across two anchors on a partially rebuilt corpus says ONE line and never re-arms; a cluster-local re-tag with no epoch bump never re-arms; and an anchor whose NEAREST neighbours are all stale does not warn while a current vector exists elsewhere in the corpus -- the third is what shows the warn evidence became corpus-level when `accept` moved before the slice, which is the other half of DW-687's complaint.
- `src/lib/embeddings.ts` -- rewrite the residue paragraph's closing line on `warnedMisconfigurations`: state that the epoch IS the burn sequence number DW-602 asked for, that a late-resolving read re-arms only on a bump strictly after the watermark it is beating, and that the recorded watermark is monotone because `warnOnceAbout` never overwrites -- keep the two watermark-skew residues that DO remain (a bump landing during a drifted read's own query, erring toward silence for one cycle; a failed epoch read at burn recording `0`, erring toward one extra line) and say plainly that neither is the DW-602 interleave.
- `src/lib/embeddings.ts` -- extend the two-door paragraph with the render door's standing (DW-687): it is the high-frequency door (`findSimilarPages` on every article render), it re-arms deliberately rather than being warn-only and why, it re-arms on the epoch alone so warn/re-arm alternation across anchors is structurally impossible, and its warn evidence is corpus-level because `accept` is applied before the top-K slice.
- `src/lib/embeddings.ts` -- name the monotonicity guarantee where it is implemented: one line on `warnOnceAbout` (the early return is what stops a stale-epoch burn lowering a watermark) and one on `rearmDriftIfRebuilt` (this is the sequence DW-602 asked to be threaded through the door) -- both are load-bearing and currently read as incidental.

**Acceptance Criteria:**
- Given a read whose window was gathered before the drift key was burnt, when it resolves after the burn and no rebuild completed in between, then it does not re-arm and the standing drift is still said exactly once — at both doors and across the two doors.
- Given the same held read, when a completed rebuild bumped the epoch after the burn, then it DOES re-arm and the next drifted read speaks — the fix suppresses the unsound half only.
- Given any interleaving of concurrent burns, when the reads carry different observed epochs, then the epoch recorded beside the key is the highest one any of them observed, never a lower one that arrived later.
- Given a partially rebuilt corpus and no completed rebuild, when article renders alternate between a stale-neighbourhood anchor and a current-neighbourhood anchor any number of times, then exactly one drift line is emitted and the key never re-arms.
- Given the drift key is burnt, when a topical cluster is re-tagged current with no rebuild completing, then no render inside that cluster re-arms the process-wide key.
- Given every existing embeddings, storage-fs and storage-r2 test, when the suite runs after this change, then all still pass — no production behaviour moved.

## Spec Change Log

## Review Triage Log

### 2026-09-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 0
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The rewritten residue paragraph claimed "Those two are the WHOLE residue" and "three legs, all pinned", but a third skew exists and was unnamed: a rebuild bump landing WHILE the burn's own `readRebuildEpoch()` is in flight is unseen by that read, so the watermark sits below what is already on disk and the next drifted read re-arms and speaks with no rebuild after the burn. Named, distinguished from its documented sibling (which errs toward silence), the closure claim rescoped to what is true and pinned, and the residue pinned with `holdNextEpochRead`.
  - `[medium]` `[patch]` The new DW-687 paragraph documents `relatedByVector`'s stale-anchor early-return re-arm (`src/lib/embeddings.ts:1520`) as what bounds the orphan false positive to one rebuild cycle, but nothing pinned it — verified by replacing the line with a no-op and seeing all 214 tests pass. Added the orphan burn → epoch bump → same-still-stale render → genuine drift pin; the same mutation now fails exactly that one test.
  - `[low]` `[patch]` The corpus-wide DW-687 test's comment named the wrong two nearest vectors (`n1`/`n2`); the query is the anchor's own vector, so unfiltered the top two are the ANCHOR and `n1` — which is why the door over-fetches by `topK + 1`. Conclusion unchanged, cause corrected.
  - `[low]` `[patch]` `HeldCall` turned a regression into an opaque 5s vitest timeout: `announce()` now runs in a `finally` so a rejecting real call cannot strand `arrived`, `restore()` releases before un-spying so a throw between `arrived` and `release()` cannot leave the door parked, and `arrived` is raced against a 2s timeout that names which seam was never reached.
  - `[low]` `[patch]` `holdNextEpochRead`'s comment claimed the epoch-key filter avoided parking the "and then a rebuild landed" step; filesystem `incrementIndex` reads the same key through the same `getIndex` inside its `index:<key>` file lock, so it does not. Comment corrected to what the filter buys, with the real constraint stated.
  - `[low]` `[patch]` A reader of the diff alone would take "That one IS closed here" for a change made here when no production line moved. The attribution now names the persisted rebuild epoch (DW-598/DW-599) as what closed it and this change as the proof plus the retraction.

## Design Notes

Why the answer is "already closed, unproven" rather than a new guard. DW-602 asks for "a burn sequence number threaded through the door"; DW-687 says closing it "needs the corpus-level rebuild-epoch signal both entries name". `EMBEDDING_REBUILD_EPOCH_KEY` is exactly that signal and it landed one commit ago. The soundness argument, in full:

```ts
// Read B burns at t_b having read epoch E_B; read A reaches this at t_a > t_b.
const burnt = warnedMisconfigurations.has(driftKey); // false ⇒ branch not entered at all
const epoch = await readRebuildEpoch();              // read at t_a, so epoch ≥ E_B (monotone)
if (burnt) rearmDriftIfRebuilt(driftKey, epoch);     // deletes only on epoch > E_B
```

`incrementIndex` never moves backwards, so `epoch > E_B` holds only if a rebuild COMPLETED in `[t_b, t_a]` — sound evidence, not pre-burn evidence. And if A arrives before the burn, `burnt` and `drifted` are both false and A never enters the branch. The window A gathered is not consulted on the re-arm path at all, which is what DW-598/DW-599 changed. The remaining piece — a late read must not *lower* the watermark — is `warnOnceAbout`'s `if (has(key)) return`: first burn wins, and every later burn attempt is silent. That is the whole proof, and none of its three legs is currently pinned.

Why the render door re-arms rather than being warn-only, which the bundle intent asks to be decided. Making it warn-only would leave a deployment whose only vector traffic is page renders unable to ever clear the key, and it is precisely that door that produces the one accepted false positive — a stale ORPHAN anchor burning the process-wide key on one page's evidence. The re-arm on the render path is what bounds that false positive to one rebuild cycle. Its cost was the reason to consider warn-only (a high-frequency writer alternating with the query door), and the epoch removed that cost: the render door can no longer re-arm on anything it observes locally, only on a counter a completed rebuild moved. So it re-arms, and the reason is now written down instead of inferred.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/embeddings.test.ts` -- expected: all pass, including the new DW-602 and DW-687 pins.
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm lint` -- expected: no new errors or warnings.
- `pnpm test` -- expected: full suite green; no production behaviour changed, so nothing else may move.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** DW-602 and DW-687 were both filed against the drift gate as it stood BEFORE the persisted rebuild epoch landed (`b4a4460d`/`b9160723`), and DW-687's own entry names that epoch as what would close it. Verified against today's code, neither failure is reachable: the re-arm reads no property of any window, and the only input is an `EMBEDDING_REBUILD_EPOCH_KEY` read taken AFTER the read's own query resolved and compared strictly greater against the watermark recorded at burn — so a late-resolving read re-arms only on a rebuild that COMPLETED after the burn's watermark, and `warnOnceAbout`'s "first burn wins" early return stops a stale-epoch burn lowering that watermark. None of that was pinned, and the canonical docblock still asserted the opposite ("Concurrent interleaving of a burn and a bump is NOT closed here (DW-602)"). This change proves the guarantee with eleven deterministic pins and states it accurately, including the residue it does NOT close. Production behaviour is byte-identical — a non-comment filter over `git diff src/lib/embeddings.ts` returns empty.

**Files changed.**
- `src/lib/embeddings.ts` -- comments only. The residue paragraph on `warnedMisconfigurations` now states the three legs of the sequencing argument, attributes the closure to the epoch (DW-598/DW-599) rather than to this change, and names all three skews that remain with the direction each errs in. A new paragraph records the DW-687 decision: the render door re-arms deliberately, on the epoch alone, and its warn evidence is corpus-level. `warnOnceAbout` and `rearmDriftIfRebuilt` now say where the monotone watermark and the burn sequence live.
- `src/lib/__tests__/embeddings.test.ts` -- `holdNextVectorQuery`/`holdNextEpochRead` stage interleaves deterministically (bounded arrival timeout, release-on-restore); eleven new pins covering all nine matrix rows plus the accepted burn/bump residue and the stale-anchor early-return re-arm.

**Review findings.** 6 patches applied (2 medium, 4 low; 0 high), 0 deferred, 6 rejected. Four reviewers ran: blind hunter, edge-case hunter, verification-gap and intent-alignment. The two medium findings were both claims this change wrote without evidence — an exhaustive-residue assertion that missed a third skew, and a load-bearing re-arm line that could be deleted with the whole suite green. Rejected: the untouched ledger and untracked spec (orchestrator-owned by contract), the file's pre-existing unfiltered warn-count convention (an observed flake that did not reproduce in 14 further runs and took a pre-existing test with it), coverage through `findSimilarPages` rather than `relatedByVector` (the call site adds visibility and threshold filtering, nothing the gate reads), further door/role permutations of an interleave already pinned in both directions and across doors, the corpus-wide pin being booked here though it holds DW-598's behaviour (it is the other half of DW-687's complaint), and "nothing added guards the render-door decision" (the pre-existing `completes a warn/re-arm cycle through THIS door alone` does).

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 2, low 4. Score: no high-severity patch, so no further iteration.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/embeddings.test.ts` -- 216 passed (205 before this bundle).
- `pnpm exec tsc --noEmit` -- clean.
- `pnpm lint` -- exit 0 (three pre-existing `jsx-ast-utils` notices).
- `pnpm test` -- 386 files, 9623 passed, 1 skipped.
- Production diff filtered to non-comment lines -- empty, confirming behaviour is unchanged.
- Mutation checks run in this session: replacing `rearmDriftIfRebuilt` on the stale-anchor early return with a no-op fails exactly the new orphan pin (1 failed, 215 passed) where before the patch it left 214 green. Reported by the implementer and not re-run here: `>` to `>=` fails 23 tests, and turning `warnOnceAbout`'s early return into an overwrite fails only the monotonicity pin.
- Matrix test audit: all 9 I/O rows covered by named tests that ran and passed.

**Residual risks.**
- Two entries are closed on the strength of an argument plus pins rather than a behaviour change. If a future change re-gates the re-arm on any window property, the pins fail — that is the intended protection — but nothing prevents a change to `readRebuildEpoch`'s fail-soft `0` from re-opening the speaking-direction skew without a test objecting, since that `0` is deliberate.
- The interleaves are staged at the storage boundary under a scripted ordering. What is proven is "under this ordering the gate cannot un-burn", not "the doors are race-free" in a scheduler sense; the argument for the general case is the monotone counter, written out on `warnedMisconfigurations`.
- The third skew (a bump landing during the burn's own epoch read) stays open by choice and is now pinned as accepted residue rather than as a bug. Its cost is one extra breadcrumb line — the side of DW-310's trade this module takes everywhere.
- The corpus-wide DW-687 pin exercises the client-ranking filesystem provider. On Vectorize the window is best-effort over a bounded over-fetch; that residue is already carried as a `medium` deferred item on `spec-dw-598-599-vector-drift-window-and-epoch.md` and is not re-filed here.
