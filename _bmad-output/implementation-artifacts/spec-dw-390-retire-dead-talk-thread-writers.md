---
title: 'DW-390: retire the readerless talk thread writers'
type: 'refactor'
created: '2026-08-22'
status: 'done'
baseline_revision: 'f89da9ad0a119975d230bc54743e2d1d5ceb92b0'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Deleting talk.ts's derived-index hooks left `syncDiscussStatsForSlug` and
      `recordTalkForAuthor` with no non-test caller — the same readerless-export
      condition DW-390 was raised to fix, one module over.
    evidence: |-
      `grep -rn "syncDiscussStatsForSlug|recordTalkForAuthor" src/ --include=*.ts`
      outside `__tests__` now returns only the two definitions. Their only
      production callers were `syncDiscussStatsHook` and
      `recordTalkContributorHook` in `talk.ts`, both deleted here. Neither index
      is broken: `rebuildDiscussStatsIndex` / `rebuildContributorIndex` still
      scan storage, and `removeDiscussStatsForSlug` still runs from
      `deleteDiscussions`. Not resolved in this story because the DW-390 decision
      explicitly kept the discuss-stats and contributor indexes "exactly as they
      are"; both doc comments were corrected to record the state.
    location: >-
      src/lib/discuss-stats-index.ts:69, src/lib/contributor-index.ts:218
    severity: medium
  - summary: >-
      `getDiscussDir` and `ensureDiscussDir` now have no non-test caller either,
      and `ensureDiscussDir` is an explicit no-op.
    evidence: |-
      Neither appears in the DW-390 delete list nor the keep list, so they were
      out of scope. After this change the only importers are `talk.test.ts`
      (which uses `getDiscussDir` to locate the file it seeds) and `SCHEMA.md`
      prose. `ensureDiscussDir` has had an empty body since the storage-provider
      migration — the provider creates parent directories on write.
    location: >-
      src/lib/talk.ts:47-52
    severity: low
---

<intent-contract>

## Intent

**Problem:** DW-230 deleted the reconciliation-thread writer, which took the last non-test caller of `talk.ts`'s thread API with it. `listThreads`, `createThread`, `getThread`, `addComment`, `resolveThread` and `hasOpenThread` now exist only to be exercised by tests, behind a retirement banner that says so.

**Approach:** Delete those six exports and the private machinery only they used, then re-point every test that leaned on them. Tests that only *asserted no thread was written* keep that assertion by reading the discuss file directly; tests that used `createThread`/`addComment`/`resolveThread` as **fixtures** for other modules (contributors, contributor-index, discuss-stats-index, maintenance, tenant migration) seed `discuss/<slug>.json` directly through a shared test fixture helper. Tests that covered only the deleted functions' own behavior are deleted.

## Boundaries & Constraints

**Always:**
- `deleteDiscussions`, `getDiscussRelPrefix` and `getDiscussionStatsForSlugs` keep their exact current behavior and signatures. Their existing test coverage survives — only how those tests *seed* discuss files changes.
- `browse.ts`'s per-page discussion count, `discuss-stats-index.ts`, `contributor-index.ts` and `contributors.ts` are untouched.
- The on-disk `discuss/<slug>.json` shape stays exactly as documented in `SCHEMA.md` — the fixture helper writes that shape, it does not invent a new one.
- Every seeded fixture preserves the observable property the test depends on (comment authors and order, thread `status`, comment `created` dates), because `contributors.ts` derives counts and date ranges from them.
- Deleting an export means deleting its now-unused private support code too, so no dead module-level code is left behind.

**Block If:**
- Removing a deleted function's fixture role would silently drop coverage of a *surviving* module (contributors, the two indexes, maintenance, tenant migration) with no faithful direct-seed equivalent.

**Never:**
- Do not touch `getDiscussDir` or `ensureDiscussDir` — not named for deletion.
- Do not retire the discuss-stats index, the contributor index, or `browse.ts:184`'s discussion count. The human decision explicitly kept them.
- Do not edit `work-wiki-concept.md` (product-vision doc, pre-existing drift, out of scope) or the deferred-work ledger.
- Do not change `src/app/api/wiki/[slug]/discuss/**` route handlers or `discuss-route.test.ts` — those aliases are route handlers, not `talk.ts` symbols.
- Do not add a new production export to `talk.ts` to serve tests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Seed then read stats | Fixture writes `discuss/page-a.json` with 2 threads, 1 `open` | `getDiscussionStatsForSlugs(["page-a"])` → `{ total: 2, open: 1 }` | No error expected |
| Read absent discuss file | No `discuss/<slug>.json` on disk | Fixture reader returns `[]` (same as the deleted `listThreads`) | ENOENT swallowed, returns `[]` |
| Disputed write must open nothing | Ingest / merge / patch-metadata flips `disputed` to `true` | Fixture reader returns `[]` for that slug | No error expected |
| Delete discussions | Seeded discuss file + seeded stats entry for `p` | `deleteDiscussions("p")` removes the file and the index entry | Missing file is a no-op |
| Talk activity in profiles | Fixture seeds one thread whose comments are `alice`, `bob`, `alice` | `alice`: 2 comments / 1 thread created; `bob`: 1 comment / 0 threads | No error expected |

</intent-contract>

## Code Map

- `src/lib/talk.ts` -- the edit target. Delete `listThreads` (123), `getThread` (128), `createThread` (141), `hasOpenThread` (217), `addComment` (232), `resolveThread` (285). Also delete the now-unused private support: `lastTimestamp`/`uniqueTimestamp` (82-88), the test-only `_resetTimestamp` (91), `writeDiscussFile` (110), and both derived-index hooks `syncDiscussStatsHook` (27) and `recordTalkContributorHook` (39) — the deleted writers were their only callers. Drop the now-unused `withFileLock` and `TalkComment` imports. `readDiscussFile` STAYS (still used by `getDiscussionStatsForSlugs`). Rewrite the `RETIRED (DW-230)` banner (188-212) so it records that the readerless thread API is now gone, not "deliberately NOT deleted".
- `src/lib/talk.ts` survivors -- `getDiscussDir`, `ensureDiscussDir`, `getDiscussRelPrefix`, `readDiscussFile`, `DiscussionStats`, `getDiscussionStatsForSlugs`, `deleteDiscussions`. Unchanged.
- `src/lib/discuss-stats-index.ts` / `src/lib/contributors.ts` -- read discuss files straight from storage; they import only `getDiscussRelPrefix` from `talk.ts`. READ-ONLY evidence that direct file seeding is faithful — no behavior flows through the deleted writers.
- `src/lib/contributors.ts:102-124` (`mergeTalkActivity`) -- `comments[0].author` is the thread creator; every comment bumps `commentCount` and pushes `comment.created` into the date range. The fixture must honor this.
- `vitest.config.ts:92` -- node project include is `src/**/__tests__/**/*.test.ts`, so a non-`.test.ts` helper in `__tests__/` is importable but never collected as a suite. `src/lib/__tests__/email-ingest-wire.ts` is the existing precedent.
- `src/lib/__tests__/talk.test.ts` -- own-module suite. Delete the `createThread`/`addComment`/`resolveThread`/`listThreads`/`getThread`/`hasOpenThread` describes and the `concurrent writes` describe (349-366, it pinned `withFileLock` inside `addComment`). KEEP and re-seed: `ensureDiscussDir` (44), `deleteDiscussions` (326), `getDiscussionStatsForSlugs` (367-424). Update the DW-230 prose block (426-438).
- `src/lib/__tests__/ingest.test.ts:676`, `src/lib/__tests__/merge.test.ts:27,230`, `src/lib/__tests__/patch-metadata.test.ts:15,371,396` -- `listThreads(...) === []` regression guards for the retired writer. Swap to the fixture reader; the assertion text stays `toEqual([])`.
- `src/lib/__tests__/contributors.test.ts:8,25,124-125,230-236,298-302,512-513` -- talk fixtures for comment/thread counts and trust score. Note `lint-fix` at 125 must stay a comment author (it pins automation-actor folding).
- `src/lib/__tests__/contributor-index.test.ts:16,29,107` -- one `createThread` seed inside the rebuild/read-parity test; the index is absent at that point, so the write's incremental hook was a no-op. Direct seed is equivalent.
- `src/lib/__tests__/discuss-stats-index.test.ts:13-18,33,103-125` -- delete the `createThread / addComment / resolveThread keep stats fresh` test (it covers only deleted code). Re-seed `deleteDiscussions removes the slug entry` (seed file + `syncDiscussStatsForSlug`) and `rebuildDiscussStatsIndex` (seed two files).
- `src/lib/__tests__/maintenance.test.ts:12,96,218` -- the seeded thread is the regression guard that a disputed page with a thread still produces no maintenance task.
- `src/lib/__tests__/migrate-to-tenants.test.ts:8,141` -- needs a real `discuss/doc.json` so the migration copies it into the tenant silo.
- `src/lib/__tests__/discuss-route.test.ts` -- READ-ONLY. Its `listThreads`/`createThread`/`addComment` are aliased route handlers, not `talk.ts`. Leave it alone.
- `SCHEMA.md:177-181` -- "Still live" paragraph claims `talk.ts` "reads and writes `discuss/<slug>.json`". After this change it only reads and deletes. Correct that sentence; the schema tables (125-150) and the retired-surface list stay as-is.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/discuss-fixture.ts` -- NEW non-suite helper. Export `discussComment(author, body?, created?)`, `discussThread(pageSlug, { title?, status?, authors, created? })` (builds one comment per author, in order, index 0 = creator), `seedDiscussFile(pageSlug, threads)` (writes `discuss/<slug>.json` via `getStorage().writeFile`, `JSON.stringify(threads, null, 2)`), and `readDiscussThreads(pageSlug)` (reads it back, returns `[]` on ENOENT via `isEnoent`) -- one faithful seeding/reading path so five suites do not each hand-roll the JSON.
- `src/lib/talk.ts` -- delete the six exports plus their orphaned private support and imports; rewrite the retirement banner -- the whole point of the change.
- `src/lib/__tests__/talk.test.ts` -- drop the suites for deleted exports (including `concurrent writes`); re-seed the surviving `deleteDiscussions` / `getDiscussionStatsForSlugs` / `ensureDiscussDir` suites through the fixture; drop the `_resetTimestamp` import and call; refresh the DW-230 prose block to also cover DW-390 -- keeps the survivors covered without the deleted API.
- `src/lib/__tests__/discuss-stats-index.test.ts` -- delete the `createThread / addComment / resolveThread keep stats fresh` test; re-seed `deleteDiscussions removes the slug entry` and `rebuildDiscussStatsIndex` through the fixture; drop `_resetTimestamp` -- the deleted test covered only deleted code; the other two cover surviving code.
- `src/lib/__tests__/contributors.test.ts` -- replace all `createThread`/`addComment` fixture calls with `seedDiscussFile`, preserving each comment's author and order; drop `_resetTimestamp` -- these tests are about `contributors.ts`, not `talk.ts`.
- `src/lib/__tests__/contributor-index.test.ts` -- replace the single `createThread` seed with `seedDiscussFile`; drop `_resetTimestamp` -- same reason.
- `src/lib/__tests__/maintenance.test.ts` -- replace both `createThread` seeds with `seedDiscussFile` -- preserves the "a thread does not resurrect a maintenance task" guard.
- `src/lib/__tests__/migrate-to-tenants.test.ts` -- replace the `createThread` seed with `seedDiscussFile` -- the test only needs the file to exist for the silo copy.
- `src/lib/__tests__/ingest.test.ts`, `src/lib/__tests__/merge.test.ts`, `src/lib/__tests__/patch-metadata.test.ts` -- swap `listThreads` for `readDiscussThreads` in the three "no thread was written" assertions -- keeps the DW-230 regression guard observable at each former call site.
- `SCHEMA.md` -- correct the "Still live" sentence so it no longer claims `talk.ts` writes discuss files, and note that the thread-writing library API is retired -- prevents doc drift introduced by this change.

**Acceptance Criteria:**
- Given the repo after the change, when `grep -nE "listThreads|createThread|getThread|addComment|resolveThread|hasOpenThread|_resetTimestamp" src/lib/talk.ts` runs, then it prints no matches.
- Given `src/lib/talk.ts` after the change, when its exports are listed, then exactly `getDiscussDir`, `ensureDiscussDir`, `getDiscussRelPrefix`, `DiscussionStats`, `getDiscussionStatsForSlugs` and `deleteDiscussions` remain, and no module-level function or import in the file is unreferenced.
- Given the whole test suite, when `pnpm test` runs, then every suite passes and no suite imports a deleted `talk.ts` symbol.
- Given `pnpm lint` and `npx tsc --noEmit`, when they run, then neither reports an error (in particular no unused-import or unused-local error in `src/lib/talk.ts`).
- Given `src/lib/__tests__/discuss-fixture.ts` exists, when `pnpm test` runs, then it is not collected as its own suite (no zero-test-file failure), because it does not match `*.test.ts`.
- Given `SCHEMA.md` after the change, when the "Talk pages (Phase 2)" section is read, then it no longer states that `src/lib/talk.ts` writes `discuss/<slug>.json`, while the `TalkThread`/`TalkComment` field tables are unchanged.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 1, low 8)
- defer: 2: (high 0, medium 1, low 1)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` `readDiscussThreads` had no positive assertion anywhere — all four uses are `toEqual([])`, which an ENOENT from a WRONG path satisfies just as happily, so the three DW-230 regression guards could rot into vacuous passes. Added a seed-then-read round-trip assertion in `talk.test.ts`'s `deleteDiscussions` case.
  - `[low]` `[patch]` `talk.test.ts` prose pointed `withFileLock` coverage at `concurrency.test.ts`, which only covers `mapWithConcurrency`. Repointed to `lock.test.ts`.
  - `[low]` `[patch]` `SCHEMA.md` **Location:** line still said the discuss file is "created on demand by `ensureDiscussDir()`", contradicting the Retired-library-API paragraph added in the same change. Rewritten.
  - `[low]` `[patch]` `discussComment` shipped as a new export with no external caller, in a change whose premise is deleting readerless exports. Made module-private.
  - `[low]` `[patch]` `discussThread` accepted `authors: []`, seeding a zero-comment thread production could never write. Now throws.
  - `[low]` `[patch]` `discussThread` accepted blank/whitespace authors, which the retired `createThread` rejected. Now throws.
  - `[low]` `[patch]` `seedDiscussFile` did not check that each thread's own `pageSlug` matches the file it is written under, so a copy-paste could seed a state `contributors.ts` would silently mis-attribute. Now throws.
  - `[low]` `[patch]` `seedDiscussFile`'s docstring claimed it writes "exactly as the retired writer used to"; it overwrites where `createThread` appended. Corrected.
  - `[low]` `[patch]` `seedDiscussFile` writes only the file — with a discuss-stats index present, `getDiscussionStatsForSlugs` takes its fast path and reports stale counts. Caveat documented.

## Design Notes

The fixture helper exists so the five re-pointed suites keep a single faithful writer of the on-disk shape. Sketch:

```ts
// src/lib/__tests__/discuss-fixture.ts  (NOT a suite — no *.test.ts suffix)
export function discussThread(
  pageSlug: string,
  opts: { title?: string; status?: TalkThread["status"]; authors: string[]; created?: string },
): TalkThread { /* one comment per author, comments[0].author === creator */ }

export async function seedDiscussFile(pageSlug: string, threads: TalkThread[]): Promise<void> {
  await getStorage().writeFile(`discuss/${pageSlug}.json`, JSON.stringify(threads, null, 2));
}
```

Why direct seeding is faithful and not a weakening: `discuss-stats-index.ts` and `contributors.ts` both scan `discuss/` through `getStorage()` and import only `getDiscussRelPrefix` from `talk.ts`. Nothing they assert ever flowed through the deleted writers — the writers just happened to be the most convenient way to produce a file.

One genuine coverage loss is accepted and intended: `talk.test.ts`'s `concurrent writes` case pinned `withFileLock` inside `addComment`. Both the lock use and the function are being deleted, so the case has nothing left to protect. `withFileLock` itself keeps its own coverage in `concurrency.test.ts`.

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: exits 0, no unused-local/import diagnostics
- `pnpm lint` -- expected: exits 0
- `pnpm test` -- expected: full suite green
- `grep -rnE "from \"\.\./talk\"|from \"\./talk\"" src/` -- expected: only `getDiscussRelPrefix`, `getDiscussionStatsForSlugs`, `deleteDiscussions`, `getDiscussDir`, `ensureDiscussDir` are imported anywhere

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** DW-390: deleted the six readerless thread-writing exports from `src/lib/talk.ts` — `listThreads`, `getThread`, `createThread`, `addComment`, `resolveThread`, `hasOpenThread` — together with the private machinery only they used (`lastTimestamp`/`uniqueTimestamp`, the test-only `_resetTimestamp`, `writeDiscussFile`, and the `syncDiscussStatsHook` / `recordTalkContributorHook` derived-index hooks) and the now-unused `withFileLock` / `TalkComment` imports. `deleteDiscussions`, `getDiscussRelPrefix`, `getDiscussionStatsForSlugs`, `getDiscussDir` and `ensureDiscussDir` are unchanged; `browse.ts`, `discuss-stats-index.ts`, `contributor-index.ts` and `contributors.ts` keep their behavior. Seven suites had used the deleted writers only as *fixtures* for other modules, so they now seed `discuss/<slug>.json` directly through a new shared test helper.

**Files changed.**
- `src/lib/talk.ts` — the six exports and their orphaned private support removed; retirement banner rewritten to record the deletion.
- `src/lib/__tests__/discuss-fixture.ts` (new, non-suite) — `discussThread` / `seedDiscussFile` / `readDiscussThreads`; writes and reads the `SCHEMA.md` shape through `getStorage()`, with guards against shapes production could never write.
- `src/lib/__tests__/talk.test.ts` — suites for deleted exports removed; surviving `ensureDiscussDir` / `deleteDiscussions` / `getDiscussionStatsForSlugs` coverage re-seeded through the fixture.
- `src/lib/__tests__/discuss-stats-index.test.ts` — the incremental-hook test deleted (it covered only deleted code); the other two re-seeded.
- `src/lib/__tests__/contributors.test.ts`, `contributor-index.test.ts`, `maintenance.test.ts`, `migrate-to-tenants.test.ts` — fixtures re-pointed, preserving comment authors and order.
- `src/lib/__tests__/ingest.test.ts`, `merge.test.ts`, `patch-metadata.test.ts` — the three DW-230 "no thread was written" guards now read the discuss file directly.
- `src/lib/discuss-stats-index.ts`, `src/lib/contributor-index.ts` — doc comments only: they no longer claim a `talk.ts` caller that no longer exists.
- `SCHEMA.md` — the Talk-pages Location line and the "Still live" paragraph corrected; a "Retired library API" paragraph added.

**Review findings.** 9 patches applied (1 medium, 8 low), 2 items deferred (1 medium, 1 low), 10 rejected, 0 intent gaps, 0 spec defects. See the Review Triage Log above.

**Follow-up review recommended:** true. Patched severities: high 0, medium 1, low 8 → score = 3x1 + 1x8 = 11, which is >= 5.

**Verification performed.**
- `npx tsc --noEmit` — exit 0, no unused-local/import diagnostics.
- `npx eslint` — exit 0.
- `npx vitest run` — 275 files / 6276 tests, all passing. File count unchanged, confirming `discuss-fixture.ts` is not collected as a suite.
- `grep -nE "listThreads|createThread|getThread|addComment|resolveThread|hasOpenThread|_resetTimestamp" src/lib/talk.ts` — no matches.
- Cross-module `talk` imports are exactly `deleteDiscussions` (lifecycle.ts), `getDiscussRelPrefix` (discuss-stats-index.ts, contributors.ts), `getDiscussionStatsForSlugs` (browse.ts).
- Every I/O matrix row is covered by a named test that ran and passed in this session's output.
- Note: `pnpm lint` / `pnpm test` fail in this environment with `ERROR packages field missing or empty`, caused by a stray `~/pnpm-workspace.yaml` outside the repo. Confirmed pre-existing by reproducing it on a stashed working tree. The `npx` invocations above run the same binaries.

**Residual risks.**
- Deliberate coverage loss: `talk.test.ts`'s `concurrent writes` case pinned `withFileLock` inside `addComment`; both are gone. `withFileLock` keeps its own coverage in `lock.test.ts`.
- Coverage of the discuss readers no longer flows through any production writer — none exists. Producer/consumer agreement on the on-disk format is now held by `SCHEMA.md` plus the fixture's guards and its seed-then-read round-trip assertion, rather than by one module being both.
- Fixture threads use a fixed `2025-01-01T00:00:00.000Z`. No current assertion depends on talk-derived `firstSeen`/`lastSeen`; a future date-range test must pass `created` explicitly.
