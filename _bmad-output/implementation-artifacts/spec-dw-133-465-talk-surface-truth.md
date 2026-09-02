---
title: 'Talk surface tells the truth: ensureDiscussDir comment + wontfix fast-path parity'
type: 'chore'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred: []
baseline_revision: '801390d6bc40b8fab48ac7864479c5ce847e0ae1'
---

<intent-contract>

## Intent

**Problem:** `ensureDiscussDir()`'s doc comment at `src/lib/talk.ts:69` still claims it "Creates the `discuss/` directory if it doesn't exist" over a body that is an explicit no-op (DW-465) — the one place a caller actually reads, while `SCHEMA.md:135` was already corrected. Separately, no test drives a `wontfix` thread through the KV-index **fast path** of `getDiscussionStatsForSlugs`: the parity test in `discuss-stats-index.test.ts` uses only `open` and `resolved`, so `wontfix` never reaches `statsFromThreads()` via the indexed read (DW-133).

**Approach:** Rewrite the `ensureDiscussDir()` doc comment to state what the function actually does and why it exists. Extend the existing fast-path/fallback parity coverage in `discuss-stats-index.test.ts` so a `wontfix` thread flows through the rebuilt index into `statsFromThreads()` and out of `getDiscussionStatsForSlugs()`.

## Boundaries & Constraints

**Always:** Keep `ensureDiscussDir()`'s signature and no-op body exactly as they are — this is a comment-only correction. Keep the corrected comment consistent with `SCHEMA.md:133-136` (storage provider creates parent directories on write) and with the module banner at `src/lib/talk.ts:51-53` (no non-test caller). Build discuss fixtures only through `writeDiscussFixture` from `src/lib/__tests__/discuss-fixtures.ts` — never through `fs` or a hand-built path.

**Block If:** The `wontfix` fast-path assertion fails against current production behavior, i.e. the index path and the scan path disagree on a mixed-status slug. That would be a real counting bug in `statsFromThreads()` / `getDiscussionStatsForSlugs()`, not a test gap, and fixing it is outside this intent.

**Never:** Do not change `statsFromThreads()`, `getDiscussionStatsForSlugs()`, or any production counting logic. Do not delete, revive, or re-plumb `ensureDiscussDir` / `getDiscussDir`. Do not modify the existing scan-path `wontfix` case in `src/lib/__tests__/talk.test.ts:145-157` (it covers the fallback path and stays). Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mixed status, fallback (no index) | `discuss/<slug>.json` with one `open`, one `resolved`, one `wontfix` thread; index absent (`getDiscussStatsIndex()` → `null`) | `getDiscussionStatsForSlugs([slug])` → `{ total: 3, open: 1 }` via the directory scan | No error expected |
| Mixed status, fast path (index present) | Same file, then `rebuildDiscussStatsIndex()` so the index is populated | `getDiscussionStatsForSlugs([slug])` → identical `{ total: 3, open: 1 }`, reached through `statsFromThreads()` in the index | No error expected |
| `statsFromThreads` direct, with `wontfix` | `[thread("open"), thread("resolved"), thread("wontfix")]` | `{ total: 3, open: 1 }` — non-`open` statuses count toward `total`, not `open` | No error expected |

</intent-contract>

## Code Map

- `src/lib/talk.ts:69-72` -- the DW-465 edit site. Line 69 is the stale doc comment; lines 70-72 are `export async function ensureDiscussDir(): Promise<void>` with the single body comment `/* Storage provider creates parent directories on write — no-op. */`. Leave the body untouched.
- `src/lib/talk.ts:44-56` -- the module's retired-surfaces banner; lines 51-53 already state that `getDiscussDir`/`ensureDiscussDir` have no non-test caller and that `ensureDiscussDir` is "a documented no-op". Read-only reference for wording consistency.
- `src/lib/talk.ts:116-173` -- `getDiscussionStatsForSlugs`. Fast path at 129-141 (dynamic-imports `getDiscussStatsIndex`; returns early when `idx !== null`, projecting `{total, open}` per slug); directory-scan fallback at 143-172. Read-only.
- `src/lib/discuss-stats-index.ts:71-76` and `:135` -- `statsFromThreads(threads)` → `{ total: threads.length, open: threads.filter(t => t.status === "open").length }`, and `rebuildDiscussStatsIndex`'s scan calling it per discuss file. That scan is the hop that carries `wontfix` into the index. Read-only.
- `src/lib/__tests__/discuss-stats-index.test.ts:129-162` -- the DW-133 edit site: `describe("getDiscussionStatsForSlugs read parity (fast path vs fallback)")`, holding `it("statsFromThreads counts correctly")` (:130-135) and `it("fallback directory scan (empty index) matches the populated fast path")` (:137-161). The new case belongs in this describe, alongside them.
- `src/lib/__tests__/discuss-stats-index.test.ts:18-41` -- `beforeEach`/`afterEach` (tmpdir `WIKI_DIR`/`RAW_DIR`/`DATA_DIR`, `_resetLocks()`/`_resetStorage()`) and the local `thread(status)` helper, whose parameter is typed `TalkThread["status"]` and so already accepts `"wontfix"`. Reuse both; the added case needs no new setup.
- `src/lib/__tests__/discuss-fixtures.ts:73+` -- `writeDiscussFixture(pageSlug, threadSpecs)`; each spec takes `{ title?, status?, comments }` with `status` typed `TalkThread["status"]`, defaulting to `"open"`. The only sanctioned discuss-file writer. `src/lib/types.ts:147` confirms `wontfix` is a first-class status.
- `src/lib/__tests__/talk.test.ts:144-157` -- the existing scan-path `wontfix` case DW-133 cites as covering only the fallback. Read-only; the new case is its indexed twin.
- `SCHEMA.md:133-136` -- already-corrected prose: "Nothing creates the directory ahead of the first write: `ensureDiscussDir()` is an explicit no-op, because the storage provider creates parent directories itself." The new doc comment must agree with this.

## Tasks & Acceptance

**Execution:**
- `src/lib/talk.ts` -- replace the `/** Creates the `discuss/` directory if it doesn't exist. */` comment above `ensureDiscussDir` (line 69) with one that states the function is a retained no-op and why (the storage provider creates parent directories on write). Do not touch the signature or body. -- DW-465: the comment a caller reads is the last place still asserting the retired behavior.
- `src/lib/__tests__/discuss-stats-index.test.ts` -- add a case to the existing `getDiscussionStatsForSlugs read parity (fast path vs fallback)` describe that writes a mixed-status fixture (`open` + `resolved` + `wontfix`) via `writeDiscussFixture`, asserts the fallback result with the index absent, then `rebuildDiscussStatsIndex()` and asserts the fast-path result is identical and equals `{ total: 3, open: 1 }`. Also extend the `statsFromThreads counts correctly` case to include `thread("wontfix")`. -- DW-133: makes `wontfix` reach `statsFromThreads()` through the indexed path, which nothing currently exercises.

**Acceptance Criteria:**
- Given `src/lib/talk.ts` after the change, when the comment directly above `ensureDiscussDir` is read, then it does not claim the function creates the `discuss/` directory, and it agrees with `SCHEMA.md:133-136` that the storage provider creates parent directories on write.
- Given `src/lib/talk.ts` after the change, when `ensureDiscussDir` is compared to its pre-change form, then its signature, return type and body are byte-identical — only the doc comment differs.
- Given the discuss-stats-index suite after the change, when `getDiscussionStatsForSlugs` is exercised on a slug whose file holds one `open`, one `resolved` and one `wontfix` thread with a rebuilt (non-null) index in place, then the returned stats are `{ total: 3, open: 1 }` and equal the same call's result taken before the rebuild, with the index absent.
- Given the full test suite, when `npm test` runs, then it passes with no new failures and the pre-existing scan-path `wontfix` case in `src/lib/__tests__/talk.test.ts` is unchanged and still passing.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 0
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[medium]` `[patch]` The new fast-path case could not distinguish an index-served read from a silent fallback — `getDiscussionStatsForSlugs`'s fast path is wrapped in `try/catch`, and since the rebuilt index and disk both said `{ total: 3, open: 1 }`, every assertion would still have passed had the dynamic import thrown. Added a sentinel that exists only in the index (`syncDiscussStatsForSlug` upserting `{ total: 99, open: 7 }`, unproducible from the 3-thread file on disk) and asserted the read returns it, so the case now fails if the scan answers.
  - `[low]` `[patch]` The comment on the extended `statsFromThreads counts correctly` case claimed `wontfix` was "the status the indexed path never used to see" — a behavior claim, when `statsFromThreads` has always counted by `status === "open"` and never treated `wontfix` specially. Reworded as the coverage claim it actually is.
  - `[low]` `[patch]` The new fixture was a byte-for-byte copy of `talk.test.ts:145-157` (same slug, titles, authors, bodies), with the titles being `writeDiscussFixture`'s own defaults and no assertion reading the bodies. Trimmed to the load-bearing `status` axis, added a comment naming the scan-path twin so the pair is greppable, and dropped the duplicate assertion that pinned `fast.get(...)` against both the literal and `fallback`.
  - `[low]` `[patch]` The rewritten `ensureDiscussDir` doc comment restated the module banner ~15 lines above it and then pointed back at that same banner, duplicating one rationale within one file and inheriting the banner's loose "six writers" phrasing (three of the six DW-390 deletions were readers). Rewritten to lead with the contract — the name promises directory creation the body does not perform — and defer to the banner for why the export survives.

## Design Notes

The parity test's shape is already established by `it("fallback directory scan (empty index) matches the populated fast path")` at `discuss-stats-index.test.ts:137`: assert with the index absent, rebuild, assert again, compare. The new case is that same shape with a third `wontfix` thread — it does not need a new helper or a new describe, and asserting both paths (rather than only the fast one) is what makes it *parity* coverage rather than a duplicate of the `talk.test.ts` scan case.

`statsFromThreads` is reached on the index side through `rebuildDiscussStatsIndex`'s scan (`discuss-stats-index.ts:135`), not through `getDiscussionStatsForSlugs` itself — the read side only projects `{total, open}` out of the stored index. So the `wontfix` thread must be on disk *before* the rebuild for the DW-133 gap to actually close.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/discuss-stats-index.test.ts src/lib/__tests__/talk.test.ts` -- expected: all cases pass, including the new mixed-status fast-path case and the untouched scan-path case.
- `npm test` -- expected: full suite passes with no new failures.
- `npm run lint` -- expected: no new errors or warnings.

**Manual checks (if no CLI):**
- `sed -n '68,73p' src/lib/talk.ts` -- expected: the doc comment no longer says the function creates the directory; the body is still the single `/* Storage provider creates parent directories on write — no-op. */` line.

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** Closed the two DW entries in the talk/discuss surface. `ensureDiscussDir()`'s doc comment no longer claims it creates the `discuss/` directory (DW-465), and a `wontfix` thread now travels through the discuss-stats index into `statsFromThreads()` and back out of `getDiscussionStatsForSlugs()` under test (DW-133). No production logic changed — the diff is one doc comment and one test file.

**Files changed.**
- `../../src/lib/talk.ts` — `ensureDiscussDir`'s doc comment replaced: leads with the contract (the name promises directory creation the body does not perform, because the storage provider makes parent directories on write, per SCHEMA.md "Talk pages") and defers to the file's retired-surfaces banner for why the export survives. Signature, return type and body byte-identical.
- `../../src/lib/__tests__/discuss-stats-index.test.ts` — extended `statsFromThreads counts correctly` to include `thread("wontfix")` (`{ total: 3, open: 1 }`), and added `a wontfix thread counts the same through the index as through the scan` to the existing read-parity describe: writes an `open`/`resolved`/`wontfix` fixture, asserts the scan result with the index absent, rebuilds, asserts the stored index entry and the fast-path read match it, then pins that the fast path is what answered via an index-only sentinel.

**Review findings breakdown.** 4 patches applied (1 medium, 3 low — see the Review Triage Log entry above); 0 items deferred; 9 items rejected. The rejects were pre-existing coverage gaps and hardening ideas on machinery this bundle did not name — rebuild eviction of vanished slugs, malformed-`discuss/*.json` tolerance, `getDiscussStatsIndex`'s fail-soft contract, the empty-but-present-index rule, `syncDiscussStatsForSlug` with a `wontfix` thread, an `@deprecated` tag on the retained no-ops, and a `filesystem.ts` cross-citation. None is reachable by an owner: `talk.ts`'s surviving readers have no non-test caller (SCHEMA.md files them under "Present but unreached"), so none can produce a wrong answer, lost data, or a broken door.

**Follow-up review recommendation:** `true`. Patched this pass: 0 high, 1 medium, 3 low → `3 x 1 + 1 x 3 = 6`, which is at or above the threshold of 5.

**Verification.**
- `npx vitest run src/lib/__tests__/discuss-stats-index.test.ts src/lib/__tests__/talk.test.ts` — 21/21 pass (12 + 9). The pre-existing scan-path `wontfix` case in `talk.test.ts` is untouched and still passing.
- `npm test` — 365 files, 9017 pass, 1 skipped, 0 failures.
- `npm run lint` — no errors; only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices.
- Manual: `sed -n '68,78p' src/lib/talk.ts` — comment corrected, body still the single `/* Storage provider creates parent directories on write - no-op. */` line.
- Matrix audit: all three I/O matrix rows are covered by cases that ran and passed — fallback with the index absent, fast path after rebuild, and `statsFromThreads` directly with `wontfix`.

**Residual risks.**
- `wontfix` is not a distinct input to any production path: both counters discriminate solely on `status === "open"`, so the new case's `wontfix` thread cannot fail in a way a `resolved` thread would not. This is inherent to the DW-133 request (the ledger entry itself is severity `low` and notes the gap is pre-existing) — the case pins coverage the ledger asked for, and the sentinel is what gives the fast-path half real discriminating power.
- The intent's literal wording ("`wontfix` never reaches `statsFromThreads()` [via] the indexed path") is mis-sited: the fast-path branch inside `getDiscussionStatsForSlugs` only copies stored `{total, open}` scalars and cannot observe a thread status at all. The index side reaches `statsFromThreads` through `rebuildDiscussStatsIndex`'s scan, which is where the test drives it. That is the only satisfiable reading, so it was implemented rather than escalated.
- `src/lib/__tests__/storage-fs.test.ts`'s `reapStrandedScratchFiles` cases time out intermittently under full-suite load (twice during this run; the file passes 95/95 standalone and two full runs finished green). Load-sensitive, in the scratch reaper, and untouched by this diff.
