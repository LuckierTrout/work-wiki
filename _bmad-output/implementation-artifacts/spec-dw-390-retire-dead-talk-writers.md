---
title: 'DW-390: retire the dead talk thread writers'
type: 'refactor'
created: '2026-08-28'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Deleting talk.ts's derived-index hooks left syncDiscussStatsForSlug and
      recordTalkForAuthor with zero production callers, and their doc comments
      still describe the deleted talk.ts caller.
    evidence: |-
      `src/lib/talk.ts`'s `syncDiscussStatsHook` and `recordTalkContributorHook`
      were the only production callers of `syncDiscussStatsForSlug`
      (discuss-stats-index.ts:69) and `recordTalkForAuthor`
      (contributor-index.ts:218). After DW-390 both are reached only from their
      own unit tests. Their prose is now stale: discuss-stats-index.ts:6 says
      the index is "maintained incrementally directly from talk.ts", :65 says
      the function is "called from talk.ts mutations ... under the discuss:<slug>
      lock" (that lock is gone), and contributor-index.ts:25 and :214 still call
      it "the talk hook". Both modules were deliberately left untouched: the
      DW-390 decision says to leave the discuss-stats/contributor indexes
      exactly as they are, so this is recorded rather than resolved. This is the
      DW-390 shape one module out.
    location: >-
      src/lib/discuss-stats-index.ts:69, src/lib/contributor-index.ts:218
    severity: medium
baseline_revision: '1c08183070a5c69804d1dd061aa8a4bda99995d1'
---

<intent-contract>

## Intent

**Problem:** Deleting the reconciliation-thread writer (DW-230) took the last non-test caller of `listThreads`, `createThread`, `getThread`, `addComment`, `resolveThread` and `hasOpenThread` in `src/lib/talk.ts`; the talk HTTP surfaces that once drove them are retired 404s, so the six exports are dead weight that reads like live API.

**Approach:** Apply the recorded 2026-08-21 decision — delete those six exports and the private helpers they were the sole users of, keep `deleteDiscussions`, `getDiscussRelPrefix` and `getDiscussionStatsForSlugs` byte-identical, and re-point every surviving suite that used the writers only as a discuss-file *fixture builder* at a shared test-only fixture helper so their real coverage of the surviving readers is preserved.

## Boundaries & Constraints

**Always:**
- `deleteDiscussions`, `getDiscussRelPrefix`, `getDiscussionStatsForSlugs` and the private `readDiscussFile` keep their current bodies unchanged — `browse.ts:184`'s per-page count, `lifecycle.ts`'s teardown, the discuss-stats index and the contributor index must behave exactly as they do today.
- The on-disk `discuss/<slug>.json` format is unchanged; fixtures write the same shape the deleted `createThread`/`addComment` wrote.
- The RETIRED banner in `talk.ts` stays, rewritten so it describes the surface as it now is (writers gone, three readers live) rather than claiming the writers are "deliberately NOT deleted".
- Every assertion that survives keeps testing the same behaviour of the same surviving module. Coverage of a surviving reader may change how its fixture is built, never what it asserts.
- The one shared fixture helper is the only new module; do not hand-roll a per-suite copy (the DW-117 drift lesson).

**Block If:**
- Deleting an export would require changing the observable behaviour of `deleteDiscussions`, `getDiscussionStatsForSlugs`, `discuss-stats-index.ts`, `contributor-index.ts`, `contributors.ts` or `browse.ts`.

**Never:**
- Do not touch `src/lib/discuss-stats-index.ts`, `src/lib/contributor-index.ts`, `src/lib/contributors.ts`, `src/lib/browse.ts` or `src/lib/lifecycle.ts`. `syncDiscussStatsForSlug` and `recordTalkForAuthor` losing their last production caller is an accepted, recorded consequence — leave both modules exactly as they are.
- Do not delete `getDiscussDir` or `ensureDiscussDir` — the decision enumerates exactly six exports.
- Do not retire `browse.ts`'s discussion count, the discuss-stats index, or the contributor index.
- Do not edit the deferred-work ledger.
- Do not touch the `## Page conventions` section of `SCHEMA.md` (loaded into LLM prompts at runtime).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stats over fixture-written threads | `discuss/page-a.json` holds 2 threads, 1 `open` | `getDiscussionStatsForSlugs(["page-a"])` → `{ total: 2, open: 1 }` | No error expected |
| Stats with no discuss dir | `DATA_DIR` has no `discuss/` | every requested slug → `{ total: 0, open: 0 }` | ENOENT swallowed, zeros returned |
| Delete drops the index entry | seeded stats index + `discuss/p.json` | `deleteDiscussions("p")` removes the file and the `p` index entry | missing file is a no-op |
| Index rebuild from fixtures | `discuss/a.json` (1 open), `discuss/b.json` (1 resolved) | `rebuildDiscussStatsIndex()` → `a {1,1}`, `b {1,0}` | No error expected |
| Contributor scan over fixtures | one thread, comments by alice, bob, alice | alice `commentCount 2` / `threadsCreated 1`; bob `1` / `0` | malformed file skipped silently |

</intent-contract>

## Code Map

- `src/lib/talk.ts` -- the edit's centre. DELETE: `listThreads` (123), `getThread` (128), `createThread` (141), `hasOpenThread` (217), `addComment` (232), `resolveThread` (285), plus the internals they solely used — `syncDiscussStatsHook` (27) and `recordTalkContributorHook` (39) (both dynamic-import hooks), `writeDiscussFile` (109), and the `lastTimestamp` / `uniqueTimestamp` / `_resetTimestamp` block (82-92). Then drop the imports that go dead: `withFileLock` and the `TalkComment` type. KEEP untouched: `getDiscussDir` (59), `ensureDiscussDir` (64), `discussRelPath` (68), `getDiscussRelPrefix` (74), `readDiscussFile` (99, still used by stats), `DiscussionStats`, `getDiscussionStatsForSlugs` (325), `deleteDiscussions` (390) — `deleteDiscussions` keeps its own inline `removeDiscussStatsForSlug` dynamic import and is the sole remaining user of `logger`. REWRITE the RETIRED comment block at 188-210.
- `src/lib/browse.ts:27,184` -- read-only evidence: sole production caller of `getDiscussionStatsForSlugs`. Must not change.
- `src/lib/lifecycle.ts:4,677` -- read-only evidence: sole production caller of `deleteDiscussions`. Must not change.
- `src/lib/discuss-stats-index.ts:16,100` / `src/lib/contributors.ts:18,30` -- read-only evidence: sole production callers of `getDiscussRelPrefix`. Must not change.
- `src/lib/__tests__/discuss-fixtures.ts` -- NEW shared test-only helper (not `*.test.ts` — `test-infra-conventions.test.ts` collects any such name as an empty suite). Writes/reads `discuss/<slug>.json` through `getStorage()` at `discuss/<slug>.json`, exactly the relative path `discussRelPath` uses, so tenant-scoped storage resolves identically.
- `src/lib/__tests__/talk.test.ts` -- drop every `describe` for the six deleted exports (`createThread` 55, `addComment` 113, `resolveThread` 231, `listThreads` 295, `getThread` 314, `concurrent writes` 348, `hasOpenThread` 441) and the `_resetTimestamp` import/call. KEEP `ensureDiscussDir` (44), `deleteDiscussions` (327) and `getDiscussionStatsForSlugs` (369) rebuilt on fixtures. The DW-230 explanatory block at 426-439 stays, extended for this change.
- `src/lib/__tests__/discuss-stats-index.test.ts` -- lines 12-19 import block, and the `talk mutations maintain the index` describe (100-119): its first case (103) tested the now-deleted hooks and is genuinely orphaned — delete it; keep `deleteDiscussions removes the slug entry` (114) and the rebuild case (122) on fixtures. Lines 141-149 already write a discuss file by hand — that is the idiom the helper generalises.
- `src/lib/__tests__/contributors.test.ts:8,124,230,298,512` -- five fixture sites plus `_resetTimestamp` (25). Real coverage of `contributors.ts`'s live discuss scan; keep every assertion.
- `src/lib/__tests__/contributor-index.test.ts:9,16,107` -- one fixture site inside `rebuild + read parity`; the index is null at that point so the deleted hook was a no-op — a fixture write is equivalent. Drop `_resetTimestamp`.
- `src/lib/__tests__/migrate-to-tenants.test.ts:8,141` -- one fixture site; the assertion is that `tenants/alice/discuss/doc.json` lands in the silo.
- `src/lib/__tests__/maintenance.test.ts:12,96,218` -- two fixture sites pinning "a disputed page with a thread produces no maintenance task".
- `src/lib/__tests__/ingest.test.ts:763`, `src/lib/__tests__/merge.test.ts:33,925`, `src/lib/__tests__/patch-metadata.test.ts:19,375,400` -- four DW-230 regression pins asserting *no* thread was written. Re-express through the fixture helper's read side; the assertion stays "no threads".
- `SCHEMA.md:181-187` -- the "Present but unreached" paragraph names the six deleted functions. Section is `## Talk pages (Phase 2)`, NOT `## Page conventions`, so editing is safe.
- `AGENTS.md` "Test environments" section -- states "There are three" shared test helpers and names them; adding a fourth makes that prose stale.
- `src/lib/__tests__/test-infra-conventions.test.ts:160-176` -- the enforcing half: a hardcoded list of shared helpers asserted to exist and to avoid the `*.test.ts(x)` suffix. Add the new helper to it.
- Read-only, no change needed: `src/lib/__tests__/discuss-route.test.ts` (route handlers, aliased names only), `src/lib/__tests__/browse.test.ts:16` and `src/lib/__tests__/lint.test.ts:20` (both `vi.mock` `getDiscussionStatsForSlugs`, which survives), `src/mcp.ts:2542` and `src/lib/mcp-http.ts:557` (comments about the retired MCP discussion tools, not about which exports exist).

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/discuss-fixtures.ts` -- create the shared fixture helper: `writeDiscussFixture(pageSlug, threads)` building well-formed `TalkThread[]` from a terse spec (per thread: optional `title`/`status`, and a list of `{ author, body?, created? }` comments) and writing it via `getStorage().writeFile("discuss/<slug>.json", …)`; `readDiscussFixture(pageSlug)` returning the parsed array (`[]` when absent). Mint comment `id`s deterministically per file; default `created` to now. -- one writer for the nine suites, instead of nine hand-rolled copies that drift (DW-117).
- `src/lib/talk.ts` -- delete the six exports and the internals/imports listed in the Code Map; rewrite the RETIRED block to say the writers are gone and name the three surviving readers with their callers. -- the decision's substance.
- `src/lib/__tests__/talk.test.ts` -- delete the describes for the deleted exports and the `_resetTimestamp` import/call; rebuild the surviving `deleteDiscussions` and `getDiscussionStatsForSlugs` cases on `writeDiscussFixture`; extend the DW-230 note to record this retirement. -- the orphaned tests go with their subjects; the readers keep theirs.
- `src/lib/__tests__/discuss-stats-index.test.ts` -- drop the orphaned hook case and the talk-writer imports; rebuild the delete and rebuild cases on fixtures. -- the hook it pinned no longer exists.
- `src/lib/__tests__/contributors.test.ts` -- replace all five `createThread`/`addComment` fixture sites with `writeDiscussFixture`; drop `_resetTimestamp`. -- preserves `contributors.ts` scan coverage verbatim.
- `src/lib/__tests__/contributor-index.test.ts` -- replace the one fixture site; drop `_resetTimestamp`. -- same.
- `src/lib/__tests__/migrate-to-tenants.test.ts` -- replace the one fixture site. -- same.
- `src/lib/__tests__/maintenance.test.ts` -- replace the two fixture sites. -- same.
- `src/lib/__tests__/ingest.test.ts`, `src/lib/__tests__/merge.test.ts`, `src/lib/__tests__/patch-metadata.test.ts` -- swap the four `listThreads(...)` assertions for `readDiscussFixture(...)`, keeping the "no threads written" assertion identical. -- the DW-230 pins must survive their reader's deletion.
- `SCHEMA.md` -- rewrite the "Present but unreached" paragraph: the thread-writing half is deleted; `getDiscussionStatsForSlugs` remains the one export whose only caller (`browse.ts`) has no reachable importer. -- the doc must not name functions that no longer exist.
- `AGENTS.md` -- update the shared-test-helper bullet from three to four, naming `lib/__tests__/discuss-fixtures.ts`. -- the prose half of a convention whose enforcing half is being extended.
- `src/lib/__tests__/test-infra-conventions.test.ts` -- add `lib/__tests__/discuss-fixtures.ts` to the shared-helper list. -- the new helper must be covered by the guard, not exempt from it.

**Acceptance Criteria:**
- Given `src/lib/talk.ts` after the change, when its exports are enumerated, then `listThreads`, `getThread`, `createThread`, `hasOpenThread`, `addComment`, `resolveThread` and `_resetTimestamp` are absent and `getDiscussDir`, `ensureDiscussDir`, `getDiscussRelPrefix`, `getDiscussionStatsForSlugs`, `deleteDiscussions` and `DiscussionStats` are present.
- Given `git diff src/lib/talk.ts`, when the surviving exports are inspected, then the bodies of `getDiscussRelPrefix`, `getDiscussionStatsForSlugs`, `deleteDiscussions` and `readDiscussFile` are unchanged.
- Given `git status`, when the changed paths are listed, then `src/lib/browse.ts`, `src/lib/lifecycle.ts`, `src/lib/discuss-stats-index.ts`, `src/lib/contributor-index.ts` and `src/lib/contributors.ts` are untouched.
- Given the full suite, when `pnpm test` runs, then it passes with no suite skipped and no `*.test.ts` importing a deleted symbol.
- Given `pnpm exec tsc --noEmit`, when it runs, then it reports no errors.
- Given the RETIRED comment block in `talk.ts`, when read, then it states the six writers are deleted and names `deleteDiscussions`, `getDiscussRelPrefix` and `getDiscussionStatsForSlugs` with their live callers — and no longer claims they are "deliberately NOT deleted".
- Given `SCHEMA.md`, when searched for `listThreads`, `createThread`, `getThread`, `addComment`, `resolveThread` or `hasOpenThread`, then there are no matches, and the `## Page conventions` section is byte-identical.

## Spec Change Log

## Review Triage Log

### 2026-08-28 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 6, low 1)
- defer: 1: (high 0, medium 1, low 0)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` `talk.ts`'s new banner claimed the three survivors were "all with live callers" while `SCHEMA.md` in the same change filed `getDiscussionStatsForSlugs` under "present but unreached" — rewrote the banner to grade each survivor by actual reachability and to state that `getDiscussDir`/`ensureDiscussDir` have no non-test caller either.
  - `[medium]` `[patch]` `discuss-fixtures.ts` re-declared `DISCUSS_DIR_NAME` and a private `discussRelPath`, a second source of truth in a helper whose docstring cites the DW-117 anti-drift lesson — it now derives the path from production's exported `getDiscussRelPrefix()`, which also puts the DW-230 pins back on the production path.
  - `[medium]` `[patch]` `discuss-stats-index.test.ts`'s read-parity case still wrote `discuss/a.json` through raw `fs`, falsifying the "one shared writer" claim this change asserts in three places — migrated it to `writeDiscussFixture` and dropped the obsolete justifying comment.
  - `[low]` `[patch]` `talk.test.ts` had dropped `_resetLocks()` from `beforeEach` although the surviving `deleteDiscussions` case still reaches `withFileLock` via `removeDiscussStatsForSlug` — restored it with a comment naming why.
  - `[medium]` `[patch]` `SCHEMA.md` claimed the discuss format is "read-only in production", but `silo.ts:138-142,175` still copies and deletes the file and `deleteDiscussions` deletes it on teardown — reworded to "nothing authors a thread or comment", and the `TalkComment.id` row no longer implies the fixture's id scheme is the documented production format.
  - `[medium]` `[patch]` The `AGENTS.md` shared-helper count was incremented from a wrong three to a wrong four; six helpers exist on disk — corrected the count and list, dropped the changelog aside, and added the two missing helpers to `test-infra-conventions.test.ts`'s guard so prose and enforcement stay paired.
  - `[medium]` `[patch]` Nothing pinned the deletion, and this repo has restored a talk write-half after a previous removal — added an export-surface case to `talk.test.ts` asserting the seven deleted names are absent and the five survivors present.

## Design Notes

The fixture helper is the crux: six suites used the writers purely to *build a discuss file*, and their assertions cover surviving modules (`contributors.ts`, `contributor-index.ts`, `discuss-stats-index.ts`, `migrate-to-tenants.ts`, `maintenance.ts`) — those tests are not orphaned and must not be deleted. Only two cases genuinely die with their subject: `talk.test.ts`'s writer describes, and `discuss-stats-index.test.ts`'s `createThread / addComment / resolveThread keep stats fresh`, which pinned the deleted hooks.

Shape, matching what `createThread`/`addComment` wrote:

```ts
await writeDiscussFixture("page-a", [
  { title: "A1", status: "open", comments: [{ author: "alice", body: "open" }] },
  { title: "A2", status: "resolved", comments: [{ author: "alice", body: "r" }] },
]);
```

Write through `getStorage()`, never `fs` — `migrate-to-tenants.test.ts` and the tenant-scoped provider depend on the same relative path `discussRelPath` builds.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: exit 0, no errors.
- `pnpm exec vitest run src/lib/__tests__/talk.test.ts src/lib/__tests__/discuss-stats-index.test.ts src/lib/__tests__/contributors.test.ts src/lib/__tests__/contributor-index.test.ts src/lib/__tests__/migrate-to-tenants.test.ts src/lib/__tests__/maintenance.test.ts src/lib/__tests__/patch-metadata.test.ts src/lib/__tests__/test-infra-conventions.test.ts --project node` -- expected: all pass.
- `pnpm test` -- expected: both projects green, no new failures against the pre-change baseline.
- `pnpm lint` -- expected: no new warnings or errors (in particular no unused-import warnings in `talk.ts`).
- `grep -rn "listThreads\|createThread\|getThread\|addComment\|resolveThread\|hasOpenThread\|_resetTimestamp" src/ SCHEMA.md` -- expected: matches only in `discuss-route.test.ts` (local aliases for retired route handlers), never resolving to `src/lib/talk.ts`.

## Auto Run Result

Status: done

### Summary

Applied the recorded 2026-08-21 DW-390 decision: deleted the six talk thread
exports that lost their last non-test caller when the DW-230
reconciliation-thread writer went, together with the private helpers only they
used. The three surviving readers keep byte-identical bodies, so `browse.ts`'s
per-page discussion count, `lifecycle.ts`'s teardown and the
discuss-stats/contributor indexes behave exactly as before. Six suites had been
using the deleted writers only to BUILD a `discuss/<slug>.json` so they could
exercise a surviving reader; their assertions are unchanged and now build that
file through one shared fixture helper.

### Files changed

- `src/lib/talk.ts` — deleted `listThreads`, `getThread`, `createThread`, `hasOpenThread`, `addComment`, `resolveThread`, plus `writeDiscussFile`, the monotonic-timestamp block with `_resetTimestamp`, both derived-index hooks, and the `withFileLock` / `TalkComment` imports; rewrote the RETIRED banner to grade each surviving export by reachability.
- `src/lib/__tests__/discuss-fixtures.ts` — NEW shared test-only writer/reader for `discuss/<slug>.json`, pathed off production's `getDiscussRelPrefix()` and written through `getStorage()`.
- `src/lib/__tests__/talk.test.ts` — dropped the writers' describes, rebuilt the surviving reader coverage on fixtures, added the export-surface deletion pin.
- `src/lib/__tests__/discuss-stats-index.test.ts` — dropped the orphaned hook-sync case; delete, rebuild and read-parity cases now run on fixtures.
- `src/lib/__tests__/contributors.test.ts`, `contributor-index.test.ts`, `migrate-to-tenants.test.ts`, `maintenance.test.ts` — fixture builder swapped, every assertion preserved.
- `src/lib/__tests__/ingest.test.ts`, `merge.test.ts`, `patch-metadata.test.ts` — the four DW-230 "no thread was written" pins now read through `readDiscussFixture`.
- `src/lib/__tests__/test-infra-conventions.test.ts` — shared-helper guard list corrected to the six helpers on disk.
- `SCHEMA.md` — `## Talk pages` updated: the thread-writing half is deleted, nothing authors a thread, and the file is still read, copied by `silo.ts` and deleted on teardown. `## Page conventions` byte-identical.
- `AGENTS.md` — shared-test-helper bullet corrected from three to the six that exist.

### Review findings breakdown

- Patches applied: 7 (medium 6, low 1) — see the Review Triage Log entry.
- Items deferred: 1 (medium) — `syncDiscussStatsForSlug` / `recordTalkForAuthor` are now production-callerless with stale doc comments, in the two index modules the decision forbids touching.
- Items rejected: 10 — closing the DW-390 ledger entry (this run is forbidden to edit it), `PRODUCT.md`'s pre-existing "discussion" copy, `lint.test.ts`'s pre-existing stale `../talk` mock, `ensureDiscussDir`'s docstring (already tracked as DW-465), and six input-validation/ergonomics suggestions for a test-only helper that is called with literal fixtures.

### Follow-up review recommendation

`true`. Patched findings: high 0, medium 6, low 1. Score = 3x6 + 1x1 = 19, which is at or above 5, so another pass is worthwhile even though no patched finding was high severity.

### Verification performed

- `pnpm exec tsc --noEmit` — exit 0, no output.
- `pnpm exec vitest run --project node` over the ten affected suites — 10 files, 389 tests, all pass.
- `pnpm test` — 13 failed files / 229 failed tests, IDENTICAL to the pre-change baseline measured by stashing every change and re-running (`13 failed | 323 passed`, `229 failed | 7522 passed`). All 13 are dom-project component suites failing at `window.localStorage` in `beforeEach`; none is a file this change touches. Passing count moved 7522 -> 7491 purely from the deleted writer cases plus the two added pins.
- `pnpm lint` — no errors or warnings beyond the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices.
- `pnpm exec vitest run --project node` over `brand-copy`, `english-only`, `workbench-chrome` and `test-infra-conventions` after the `AGENTS.md` edits — 75 tests, all pass.
- `git diff src/lib/talk.ts` filtered to added non-comment lines yields exactly one line (`import type { TalkThread }`), confirming the surviving export bodies are byte-identical.
- `git status` shows `browse.ts`, `lifecycle.ts`, `discuss-stats-index.ts`, `contributor-index.ts`, `contributors.ts` and `silo.ts` untouched, and the deferred-work ledger unedited.
- Matrix audit: all five I/O rows are covered by tests that ran and passed — rows 1/2 by `talk.test.ts`'s `getDiscussionStatsForSlugs` cases, row 3 by `discuss-stats-index.test.ts`'s `deleteDiscussions removes the slug entry`, row 4 by its rebuild case, row 5 by `contributors.test.ts`'s `counts talk comments and threads`.

### Residual risks

- The deferred item above is the real one: two exported index-maintenance functions are now production-callerless, and the modules that hold them were deliberately left untouched by the decision.
- `getDiscussDir` and `ensureDiscussDir` survive with no non-test caller, because the decision enumerated exactly six writers. The banner now says so plainly rather than leaving it implied.
- The migrated suites now write their discuss fixtures from a test module rather than a production writer. The path is derived from production's `getDiscussRelPrefix()` and the shape is centralised in one helper, but no production writer remains to arbitrate the format if `TalkThread` gains a field the readers depend on.
