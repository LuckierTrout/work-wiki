---
title: 'Retire the contributor scan/index residue and correct the two index modules'' stale prose (DW-125, DW-126, DW-535)'
type: 'refactor'
created: '2026-09-02'
baseline_revision: '4fbbc49a04fcc620d5393a59a3b091a51b2ecb12'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The contributor product surfaces are retired (`/wiki/contributors`, `GET /api/contributors[/:handle]` all answer through `RETIRED_SURFACES`), yet `contributors.ts` still exports three profile builders reached only from tests, and the daily maintenance scan still pays for a full-wiki `rebuildContributorIndex()` whose output nothing reads. Separately, `discuss-stats-index.ts` and `contributor-index.ts` still describe callers in `talk.ts` that DW-390 deleted.

**Approach:** Delete `buildContributorProfile`, `buildContributorProfiles` and `listContributors` (plus the helpers and imports that only they used) and their orphaned tests, keeping `computeScanData`/`computeTrustScore`; drop the `["contributors", rebuildContributorIndex]` step from `rebuildDerivedIndexes` and the now-dead contributor-index writes on the lifecycle path; then correct the stale prose on both index modules so it describes what actually reaches them today.

## Boundaries & Constraints

**Always:**
- Keep `computeScanData`, `computeTrustScore` and the pure reducers (`reduceActivity`, `mergeTalkActivity`, `reduceReverts`, `emptyActivity`) exported from `src/lib/contributors.ts` — `contributor-index.ts` imports the first two.
- Keep `src/lib/contributor-index.ts` and `src/lib/discuss-stats-index.ts` as modules with every export intact; this pass changes their PROSE only.
- Prose corrections must describe the true current state (no production caller), in the honest-inventory style `src/lib/talk.ts:17-51` already uses for the same situation.
- Preserve semantic coverage of the surviving scan/trust behavior: any deleted test whose real subject is `computeScanData`/`computeTrustScore` (agent-page exclusion, automation-actor folding, talk counting, revert detection, first/last seen, trust formula) must be re-pointed at a surviving surface, not simply dropped.
- Keep every removal fail-soft-neutral: the lifecycle write path must still complete its other derived-index steps unchanged.

**Block If:**
- A production (non-test, non-retired) reader or writer of the contributor index turns up that this plan would break.

**Never:**
- Do not delete `src/lib/contributor-index.ts`, `src/lib/contributors.ts`, or any export of `discuss-stats-index.ts` — the recorded decisions retain them.
- Do not touch the other six derived-index rebuild steps, `recordEditForAuthor`/`reverseEditForAuthor`/`recordTalkForAuthor` bodies, or the `RETIRED_SURFACES` entries.
- Do not edit the deferred-work ledger.
- Do not re-open the retired contributor product surfaces.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Daily scan rebuild | `rebuildDerivedIndexes()` on a seeded wiki | Result keys are exactly `pages, commons, owner-slugs, backlinks, discuss-stats, recent` — no `contributors` key, and no wiki-wide contributor scan runs | Per-step fail-soft unchanged |
| Page write | Lifecycle write op with an `author` | Page + all other derived indexes update; the contributor index is left untouched | No error expected |
| Page delete | Lifecycle delete op with an `author`, idempotency receipt present | Delete completes; no contributor decrement and no `.contributor` receipt file is written | No error expected |
| Scan data still correct | `computeScanData(null)` over pages + discuss fixtures | Activity, revert and talk counts unchanged from today's values | No error expected |
| Index rebuild on demand | `rebuildContributorIndex()` called directly | Still serializes the scan into the index shape (repair tool retained) | No error expected |

</intent-contract>

## Code Map

- `src/lib/contributors.ts:278-381` -- delete `buildContributorProfile`, `buildContributorProfiles`, `listContributors`, plus `buildProfileFromActivity` (:234) and `isRealContributor` (:371), which only they call. Then drop the now-unused imports: `logger` (:20, used only at :292/:374), `isAutomationActor` (:21, only at :372) and the `ContributorProfile` type (:22, only in `buildProfileFromActivity`). `Principal` (:16) stays — `computeScanData(:204)` takes it. Header comment (:1-12) still describes profile building; retune to the scan's real role.
- `src/lib/contributor-index.ts` -- imports `computeScanData`/`computeTrustScore` (:39-43), so `contributors.ts` must keep them. Prose to correct: header :5-6 (`homepage and /wiki/contributors` are retired), :22-30 (the incremental-vs-rebuild split — the lifecycle write hook and the talk hook are both gone; "daily rebuild" is no longer scheduled), :134-141 (`contributorProfileFromIndex` names `/u/<handle>` + `/api/contributors/<handle>`), :165-168 and :190-194 (lifecycle write/delete hooks), :213-217 ("talk hook"), :260-264 ("daily self-heal").
- `src/lib/discuss-stats-index.ts:6-7,64-68` -- prose only: "maintained incrementally directly from `talk.ts`" and "Called from `talk.ts` mutations ... under the `discuss:<slug>` lock" — both callers and that lock are gone (DW-390). Live writers today: `deleteDiscussions` → `removeDiscussStatsForSlug`, and `rebuildDiscussStatsIndex` from the daily scan.
- `src/lib/maintenance.ts:208-236` -- remove the `["contributors", ...]` step at :236; the "seven derived KV indexes" prose at :212-220 and the parenthetical index list must become six and drop `contributors` (and the "coarse contributor fields left to rebuild" clause at :215).
- `src/lib/lifecycle.ts` -- delete the import at :42, the whole `3b-iv. Contributor index` block (:815-841) including its comment, and the now-unreferenced `contributorIdempotencyPath` plumbing (type field :327, construction :1282). Renumber nothing else; the neighbouring `3b-iii`/`3b-v` blocks stay as they are.
- `src/lib/talk.ts:17-51` -- reference model for the prose style; also verify :39-41 stays true (`contributors.ts` still scans `discuss/` via `getDiscussRelPrefix` inside `computeScanData`).
- `src/lib/__tests__/contributors.test.ts` -- whole file is written through the three deleted functions. Rewrite against the surviving exports (`computeScanData`, `computeTrustScore`, `reduceReverts`), preserving the semantic cases named in **Always**; drop the cases whose only subject is a deleted function (batch ordering :457-506, zeroed-profile-for-unknown-handle :257-268/:358-364, index fast-path :152-186/:203-231).
- `src/lib/__tests__/contributor-index.test.ts:13,99-123` -- the `listContributors fast path == fallback scan` parity case is orphaned by the deletion; remove it and the `../contributors` import. The rest of the file (incremental hooks, `profilesFromIndex`) exercises retained exports and stays.
- `src/lib/__tests__/revert-attribution.test.ts:172-204` -- `contributor index reflects the reverter's edit` pins the lifecycle write being removed; delete that case (and the file-header bullet naming it at :8). Its `rebuildContributorIndex`/`getContributorIndex` imports go with it.
- `SCHEMA.md:68-69,173-178,196-235` -- documents `buildContributorProfile()`/`listContributors()` as the builders and the contributor index as "maintained on every write and rebuilt by the daily maintenance scan". Correct to the post-change truth.
- Read-only evidence: `src/app/api/contributors/route.ts`, `src/app/api/contributors/[handle]/route.ts` and `src/app/wiki/contributors/page.tsx` are three-line `retiredRoute()`/`retiredPage()` bodies; a repo-wide grep for every contributor-index export finds no other production caller. `src/app/api/tasks/scan/route.ts`, `src/app/api/admin/reset/route.ts` and `src/lib/portable-archive.ts` call `rebuildDerivedIndexes()` but never key off `contributors`, and no test asserts that key.

## Tasks & Acceptance

**Execution:**
- `src/lib/contributors.ts` -- delete the three public builders plus `buildProfileFromActivity`/`isRealContributor` and the imports only they used; retune the module header to describe the scan the index consumes -- removes the test-only surface DW-125 named while keeping `contributor-index.ts` compiling.
- `src/lib/maintenance.ts` -- drop the `["contributors", ...]` rebuild step and correct the seven→six index prose -- DW-126: the daily scan must stop walking the whole wiki for contributor data.
- `src/lib/lifecycle.ts` -- delete the contributor-index import, the `3b-iv` write/decrement block, and the `contributorIdempotencyPath` field and its construction -- the writes are dead once nothing reads the index, and the receipt path existed only to guard the decrement.
- `src/lib/contributor-index.ts` -- correct the header, the incremental-vs-rebuild split, the read-path doc comments and the "talk hook"/"daily self-heal" wording to state the module has no production writer or reader left and is retained as a rebuild/repair tool -- DW-535.
- `src/lib/discuss-stats-index.ts` -- correct the header (:6) and `syncDiscussStatsForSlug`'s doc (:64-68) to drop the deleted `talk.ts` caller and the `discuss:<slug>` lock -- DW-535.
- `src/lib/__tests__/contributors.test.ts` -- rewrite against `computeScanData`/`computeTrustScore`/`reduceReverts`, keeping the scan-semantics cases and dropping the builder-only ones -- deletes orphaned tests without losing coverage of what survives.
- `src/lib/__tests__/contributor-index.test.ts` -- remove the `listContributors` parity case and its import -- orphaned by the deletion.
- `src/lib/__tests__/revert-attribution.test.ts` -- remove the contributor-index case, its imports, and the header bullet naming it -- its subject is the removed lifecycle write.
- `SCHEMA.md` -- correct the frontmatter-field consumer notes and the "Contributor profiles" section to name the surviving library and the un-scheduled index -- keeps the schema doc from asserting deleted functions.

**Acceptance Criteria:**
- Given the whole repo after the change, when grepping `src/` for `buildContributorProfile`, `buildContributorProfiles` or `listContributors`, then there are no matches in source or tests.
- Given `src/lib/lifecycle.ts`, when grepping it for `contributor-index`, `recordEditForAuthor`, `reverseEditForAuthor` or `contributorIdempotencyPath`, then there are no matches.
- Given `src/lib/contributor-index.ts` and `src/lib/discuss-stats-index.ts`, when reading their comments, then no comment claims a caller in `talk.ts`, a `discuss:<slug>` lock, a lifecycle write hook, a daily contributor rebuild, or a live `/wiki/contributors`, `/u/<handle>` or `/api/contributors/<handle>` reader.
- Given `pnpm test`, when the suite runs, then it passes with no test importing a deleted symbol.
- Given `pnpm lint` and `pnpm exec tsc --noEmit`, when they run, then neither reports an unused import, unused local, or unresolved symbol in the touched files.

## Spec Change Log

No spec amendments — the review pass produced no `bad_spec` or `intent_gap` findings.

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 3, low 7)
- defer: 0
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` `contributor-index.test.ts`'s six-index case asserted the key set but never that any rebuild succeeded — a run where all six fail-softed to `{ ok: false }` would have passed. Added `ok: true` assertions for all six.
  - `[medium]` `[patch]` `scanDataToIndex`'s `firstSeen`/`lastSeen` derivation and `profileFromIndexAuthor`'s distinct `pagesEdited` recount were asserted nowhere once the parity test was deleted (proven by mutation — both could be broken with the suite green). Added a dated-revision case pinning the date sort and a `profilesFromIndex` case with a duplicate-bearing slug list; the latter was re-shaped after mutation testing showed the first form could not distinguish `.size` from `.length`.
  - `[medium]` `[patch]` The `.contributor` receipt assertion in the lifecycle-delete case was decorative: `deleteWikiPage` never populated `contributorIdempotencyPath`, so it passed identically before the change. Pinned on the receipt-bearing path instead — a new `merge.test.ts` case runs `mergePages` and asserts no `.delete.contributor` file plus an unchanged seeded index — and rescoped the lifecycle case's comment to what it actually covers.
  - `[low]` `[patch]` `contributor-index.ts`'s new header claimed the blob holds "a trust score"; it holds raw tallies and the trust formula runs on read. Corrected there and in `SCHEMA.md`.
  - `[low]` `[patch]` `talk.ts`'s RETIRED banner still said both index modules' "entries are (re)built by the rebuild scans" — false for the contributor index after this pass. Rewritten to distinguish the two.
  - `[low]` `[patch]` `merge.ts` still deletes `${operationPath}.<gen>.delete.contributor` at three sites with nothing minting it. Kept the deletes (they reap files older deployments left) and annotated each as legacy.
  - `[low]` `[patch]` `contributor-index.ts`'s retention paragraph implied an operator entry point for `rebuildContributorIndex`. Now states explicitly that no route, CLI, MCP tool or task kind reaches it.
  - `[low]` `[patch]` `discuss-stats-index.ts`'s header let its read site read as live wiring; annotated `getDiscussionStatsForSlugs` -> `browse.ts` as itself unreached, and adopted `talk.ts`'s "authors a thread or a comment" phrasing.
  - `[low]` `[patch]` `write-batching-bounds.test.ts`'s batch-disabled figures ("29 -> 61") were carried past a fixed-cost change untouched. A reproduction attempt measured 19 -> 35 instead, so the unverified pair was retired from the comment with the attempt recorded, rather than swapped for another unverified pair.

Rejected (no action): the loss of `isRealContributor`'s automation/blank-handle filter on `profilesFromIndex` (that read helper has no production caller, so there is no consumer to mislead); `POST /api/admin/reset` leaving a stale contributor blob (inert bytes — nothing reads the key, and an on-demand rebuild overwrites it wholesale); `deleteWikiPage`'s now-unread `author` parameter (annotated in place; removing it would ripple across every REST/MCP/CLI caller for no behavioural gain); the six-index assertion being exact rather than a superset (a future seventh index should update this pin deliberately); symlink-cycle hardening for the test-only tmpdir walker; and `SCHEMA.md`'s duplicated consumer clause across two table rows (style).

## Design Notes

The two ledger decisions retain `contributor-index.ts` even though this pass takes its last production caller — deleting it would decide whether the contributor trust surface ever returns, which is a product call. So the module stays as an on-demand rebuild/repair tool with `computeScanData` behind it, and the prose says exactly that rather than implying live wiring. `src/lib/talk.ts:17-51` is the house pattern for this: a RETIRED banner naming what was deleted, then an honest per-export inventory of what is live, what is unreached, and why it was kept.

Removing the `["contributors", ...]` step is what actually banks DW-126: `rebuildContributorIndex()` calls `computeScanData(null)`, which lists every readable page and reads every page's revisions plus every `discuss/` file. That is the daily cost the ledger wanted to stop paying; the function itself remains callable.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/contributors.test.ts src/lib/__tests__/contributor-index.test.ts src/lib/__tests__/discuss-stats-index.test.ts src/lib/__tests__/revert-attribution.test.ts src/lib/__tests__/maintenance.test.ts src/lib/__tests__/lifecycle.test.ts` -- expected: all pass
- `pnpm test` -- expected: full suite passes, no regressions versus the pre-change baseline
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm lint` -- expected: no new errors or warnings
- `grep -rn --include='*.ts' --include='*.tsx' -w -e buildContributorProfile -e buildContributorProfiles -e listContributors -e contributorIdempotencyPath src/` -- expected: no output

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Retired the contributor scan/index residue that outlived the talk surface (DW-125, DW-126) and corrected the two index modules' stale prose (DW-535). `buildContributorProfile`, `buildContributorProfiles` and `listContributors` are gone, along with their private helpers `buildProfileFromActivity`/`isRealContributor` and the imports only they used; `computeScanData`, `computeTrustScore` and the pure reducers stay for `contributor-index.ts`. `rebuildDerivedIndexes` no longer runs the contributor rebuild, so the daily maintenance scan no longer walks the whole wiki for contributor data, and the lifecycle write/delete path no longer writes the index or mints the `.contributor` idempotency receipt that guarded its decrement. Both index modules keep every export and are re-documented in the honest-inventory style `talk.ts` already uses.

**Files changed.**
- `src/lib/contributors.ts` — three profile builders and their private helpers deleted; header retuned to describe the scan the index consumes.
- `src/lib/contributor-index.ts` — prose only: a RETIRED WIRING block replacing the incremental-vs-rebuild split, corrected read-path/"talk hook"/"daily self-heal" comments, and an explicit note that no route, CLI, MCP tool or task kind calls `rebuildContributorIndex`.
- `src/lib/discuss-stats-index.ts` — prose only: the deleted `talk.ts` caller and `discuss:<slug>` lock removed from the header and `syncDiscussStatsForSlug`; the read site annotated as itself unreached.
- `src/lib/maintenance.ts` — `["contributors", …]` rebuild step dropped; the "seven derived KV indexes" prose corrected to six.
- `src/lib/lifecycle.ts` — contributor-index import, the whole `3b-iv` write/decrement block and the `contributorIdempotencyPath` field plus its construction removed; the delete op's `author` annotated as carried but unread.
- `src/lib/merge.ts` — comments only: the three `.delete.contributor` cleanup deletes annotated as legacy reaping.
- `src/lib/talk.ts` — comment only: its RETIRED banner no longer claims a rebuild scan maintains the contributor index.
- `SCHEMA.md` — frontmatter-field consumer notes and the "Contributor profiles" section corrected to the surviving library, the unscheduled index, and the persist-vs-read-time trust-score split.
- `src/lib/__tests__/contributors.test.ts` — rewritten against `computeScanData`/`computeTrustScore`/`reduceReverts`, preserving every scan semantic the deleted builders used to assert through.
- `src/lib/__tests__/contributor-index.test.ts` — orphaned parity case replaced by a scan→index serialization case (dates, distinct pages, reverts, totals); new `describe` pinning that no production writer and no scheduled rebuild reaches the index.
- `src/lib/__tests__/merge.test.ts` — new case: a merge-delete on the receipt-bearing path mints no `.delete.contributor` and leaves a seeded contributor index untouched.
- `src/lib/__tests__/revert-attribution.test.ts` — the contributor-index case, its imports and its header bullet removed with their subject.
- `src/lib/__tests__/write-batching-bounds.test.ts` — `IMPORT_FLAT_BARRIERS` 12→11 and `IMPORT_NESTED_BARRIERS` 18/34→17/33 (one fewer derived-index write is one fewer fixed-cost barrier; the marginal cost is unchanged), with the unverified batch-disabled figures retired from the comment.

**Review findings breakdown.** 10 patches applied (3 medium, 7 low), 0 deferred, 6 rejected (all low). No `intent_gap` or `bad_spec` findings, so no loopback ran.

**Follow-up review recommendation:** `true`. Patched counts: high 0, medium 3, low 7 → score `3 × 3 + 1 × 7 = 16`, which is ≥ 5.

**Verification performed.**
- `pnpm exec tsc --noEmit` — clean.
- `pnpm lint` — clean (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, unrelated and unchanged).
- Targeted run over `contributors`, `contributor-index`, `discuss-stats-index`, `revert-attribution`, `maintenance`, `lifecycle`, `merge` and `write-batching-bounds` — 8 files / 216 tests passed.
- `pnpm test` — 365 files / 9016 passed, 1 skipped.
- Acceptance greps — `grep -w` for `buildContributorProfile`, `buildContributorProfiles`, `listContributors`, `contributorIdempotencyPath` across `src/` returns nothing, and `lifecycle.ts` matches none of `contributor-index`, `recordEditForAuthor`, `reverseEditForAuthor`, `contributorIdempotencyPath`.
- Matrix audit — every I/O row is covered by a case that ran and passed in the targeted run above: the six-key rebuild case (row 1, with `ok: true` per step), the lifecycle-write case (row 2), the `mergePages` receipt case (row 3), the `computeScanData` suites (row 4) and the scan→index serialization case (row 5).

**Residual risks.**
- `src/lib/__tests__/storage-fs.test.ts > reapStrandedScratchFiles` fails intermittently under full-suite load (its mtime grace windows drift on a loaded machine). It touches nothing in this change, passes in isolation, passed in two of three full-suite runs of this change set, and was reproduced on a stashed, unmodified baseline. Pre-existing flake.
- The contributor index is now fully unwired: nothing writes it, nothing reads it, nothing rebuilds it on a schedule. This is the shape the two 2026-08-19 decisions authorised — deleting the module would decide whether the contributor trust surface returns, which is a product call — but any blob a previous deployment seeded will stay on disk unchanged, and `POST /api/admin/reset` no longer clears it. Inert while there is no reader; a returning surface must rebuild before trusting it.
