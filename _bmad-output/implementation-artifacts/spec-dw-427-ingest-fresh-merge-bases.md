---
title: 'Ingest read-modify-write bases read fresh, not through pageCache'
type: 'bugfix'
created: '2026-08-31'
baseline_revision: 'f1c69c6a8cb3132df7da8ab0e3a82adfa00caa0c'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The realm-fork guard at src/lib/ingest.ts:1952 reads through `pageCache` and
      flattens a non-ENOENT storage failure to `null`, so a provider blip skips the
      fork and lets a non-owner's ingest overwrite the BODY of someone else's private
      page.
    evidence: |-
      Traced during the DW-427 review (not executed). `const resolvedExisting = await
      readWikiPageWithFrontmatter(slug)` at src/lib/ingest.ts:1952 is the only gate
      that forks to a free slug when the resolved slug landed on another owner's
      PRIVATE page. Without `strict` a blip answers `null`, the guard is skipped, and
      the ingest proceeds to the merge base at :2068 — which DOES find the private
      page, preserves its `owner`/`visibility` (:2140-2146) and writes the actor's
      body over it. `writeWikiPageWithSideEffects` in lifecycle.ts carries no
      authorization of its own, so nothing downstream re-decides the fork. The DW-427
      bundle named this line only as one of the "roughly eight pure existence probes"
      to leave alone; it did not name this harm, and the intent's Never clause kept it
      out of scope for this session.
    location: >-
      src/lib/ingest.ts:1952
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two read-modify-write bases in `src/lib/ingest.ts` still read through the module-global `pageCache` and swallow non-ENOENT storage failures as `null`: `reingest()` (which then throws a bogus `page "x" not found`, poisoning the queued task at 422 instead of retrying) and `attachIngestTrigger()` (which then returns `null`, so the caller falls through to a full ingest that mints a DUPLICATE page and whose `expectedContent` CAS precondition was derived from possibly-stale cached bytes).

**Approach:** Adopt the established DW-195/DW-379 write-base pattern — `{ fresh: true, strict: true }` — on exactly those two reads, and pin that a non-ENOENT blip now surfaces the storage error (which `POST /api/tasks/run` already classifies ahead of its `/not found/i` poison row) rather than a bogus absence.

## Boundaries & Constraints

**Always:**
- Use `{ fresh: true, strict: true }` — the same option pair every other write base in this repo uses (`src/lib/ingest.ts:2051`, `src/mcp.ts:258`, `src/lib/lifecycle.ts`, `src/cli.ts:465`). `fresh` alone never throws, so it cannot deliver the error classification this fix is for.
- An absent page (ENOENT) must still answer `null` under strict — `reingest` keeps its `not found` throw for a genuinely missing page, and `attachIngestTrigger` keeps returning `null` on true index drift.
- Every new test row must fail against the pre-change code. Follow the two-row idiom already in `src/lib/__tests__/mcp.test.ts:564-660`: one STRICT row (one-shot non-ENOENT `storage.readFile` blip) and one FRESH row (stale `pageCache` entry via `beginPageCache()`), because `strict` alone cannot pin `fresh`.

**Block If:**
- Adding `strict: true` makes an existing test fail for a reason other than the two behaviours above (i.e. some caller genuinely depends on a storage blip being read as an absence).

**Never:**
- Do not touch the ~10 pure existence/decision probes in `src/lib/ingest.ts` (lines 275, 1098, 1106, 1123, 1141, 1416, 1779, 1908, 1917, 1935). They are hot dedup/slug loops, not write bases.
- Do not re-do `src/lib/ingest.ts:2051` — the third base named in the bundle intent (the re-ingest merge base carrying `created`/`source_count`/`tags`) already carries `{ fresh: true, strict: true, owner }` as of commit `39cf8ca2`/`2de96b4e`. Verify and record; change nothing.
- Do not add an `owner` routing hint to either read — that changes which silo a global miss may recover and is outside this intent.
- Do not change the `/not found/i` vs `isStoreFault` ordering in `src/app/api/tasks/run/route.ts`; it is already correct (DW-482) and already pinned.
- Do not touch `src/app/api/ingest/reingest/route.ts`'s own ACL read, or any other file's reads.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Re-ingest, page present | `reingest("s")`, page stored with `source_url` | Re-fetches and updates in place, unchanged from today | No error expected |
| Re-ingest, page absent | `reingest("s")`, no such page (ENOENT everywhere) | Throws `Cannot re-ingest: page "s" not found` | Unchanged; `POST /api/tasks/run` still 422-poisons it |
| Re-ingest, storage blip | `reingest("s")`, `storage.readFile` throws a non-ENOENT error for `s.md` | Rejects with THAT storage error | Message must not contain `not found`; `isStoreFault` row in `tasks/run` maps an errno failure to a retryable 500 |
| Re-ingest, stale page cache | `beginPageCache()` open holding a stale entry for `s`; stored bytes have a different `source_url` | Re-fetches the STORED `source_url`, not the cached one | No error expected |
| Dedup attach, storage blip | `attachIngestTrigger`/`ingestUrl` on a dup slug whose read blips (non-ENOENT) | Rejects with THAT storage error | No duplicate page is created; no write lands |
| Dedup attach, index drift | Source index names a slug with no stored page | Returns `null`; caller ingests normally | Unchanged |
| Dedup attach, stale page cache | `beginPageCache()` open holding stale bytes for the dup slug | Merge base and `expectedContent` come from the STORED bytes | No error expected |

</intent-contract>

## Code Map

- `src/lib/ingest.ts:543` -- **Site 1.** `reingest()`'s `readWikiPageWithFrontmatter(slug)`. Its result feeds the `source_url` that the whole re-ingest rewrites from; `null` becomes `throw new Error('Cannot re-ingest: page "…" not found')` at :545.
- `src/lib/ingest.ts:530-534` -- `reingest`'s JSDoc, incl. the `@throws` line that currently claims only "page doesn't exist or has no source_url".
- `src/lib/ingest.ts:1432` -- **Site 2.** `attachIngestTrigger()`'s `readWikiPageWithFrontmatter(slug)`. Read-modify-write: frontmatter merged at :1445-1472, re-serialized at :1475 via `serializeFrontmatter(frontmatter, existing.body)`, written at :1476-1486 with `expectedContent: existing.content` as the CAS precondition. `if (!existing) return null;` at :1433 is the "index drifted" fall-through.
- `src/lib/ingest.ts:2051` -- **Site 3, ALREADY DONE.** `{ fresh: true, strict: true, owner }`. Read-only evidence for this spec; do not modify.
- `src/lib/ingest.ts:275, 1098, 1106, 1123, 1141, 1416, 1779, 1908, 1917, 1935` -- the probes to leave alone (X-teaser check, concept/alias resolution, `findFreeSlug`, SHA-256 dedup, prebuilt-H1 title, realm guard).
- `src/lib/ingest.ts:288, 386, 458, 1534` -- `attachIngestTrigger` call sites (`ingestUrl`, `ingestImage`, `ingestPdf`, `recordSourceResee`). All sit on request/queue paths whose catch turns a throw into a 5xx; none needs a new branch.
- `src/lib/wiki.ts:338-415, 416-570` -- `ReadWikiPageOptions` (`fresh` bypasses `pageCache` only; `strict` rethrows non-ENOENT storage failures at :459, :483 and via `getPageIndex({ strict })` at :470) and `readWikiPage`/`readWikiPageWithFrontmatter`. Read-only.
- `src/lib/wiki.ts:257` -- `beginPageCache()`, needed by the FRESH test rows.
- `src/app/api/tasks/run/route.ts:259` -- `maintain:staleness` → `reingest`. `route.ts:841-950` is the catch: `isStoreFault(err)` → 500 (bounded retry) is deliberately AHEAD of `/not found/i` → 422 (poison). No change needed; this is the classification the fix relies on.
- `src/lib/errors.ts:56-75` -- `isStoreFault` (true for `StoreFaultError` or an `Error` with an `E…` `code`) and `isEnoent`. `src/lib/storage/r2.ts:472-479` -- `R2NotFoundError` carries `code = "ENOENT"`, so a missing R2 object still reads as an absence.
- `src/lib/__tests__/mcp.test.ts:564-660` -- the two-row STRICT/FRESH idiom to copy (one-shot `vi.spyOn(storage, "readFile")` blip; `beginPageCache()` + a direct flat write to plant stale bytes).
- `src/lib/__tests__/ingest.test.ts:3337+` -- the `describe("reingest")` block; `:3495` imports `getStorage`. Dedup/attach coverage lives around `:2280-2320` and `:2600-2680`.
- `src/lib/__tests__/tasks-route.test.ts:741-874` -- `maintain:staleness` dispatch and the existing 422/500 classification rows (`mockedReingest`).

## Tasks & Acceptance

**Execution:**
- `src/lib/ingest.ts` -- at :543 pass `{ fresh: true, strict: true }`, and extend the `reingest` JSDoc `@throws` to say a non-ENOENT storage failure is rethrown rather than reported as a missing page -- so the re-fetch is driven by the stored `source_url` and a blip is retryable instead of 422-poisoned.
- `src/lib/ingest.ts` -- at :1432 pass `{ fresh: true, strict: true }`, and amend the `if (!existing) return null;` comment so it reads as "ENOENT only — a storage fault now throws" -- so the merge base and `expectedContent` precondition describe the stored bytes, and a blip can no longer mint a duplicate page.
- `src/lib/__tests__/ingest.test.ts` -- add four rows covering the matrix's blip and stale-cache scenarios for both sites (STRICT + FRESH per site), following the `mcp.test.ts` idiom -- each must fail without the corresponding flag.
- `src/lib/__tests__/tasks-route.test.ts` -- add one row: `mockedReingest` rejects with an errno-coded `Error` (e.g. `code = "EIO"`), and `maintain:staleness` answers 500, not the 422 poison -- pins the shape `reingest` now throws against the classifier the fix depends on.

**Acceptance Criteria:**
- Given `src/lib/ingest.ts:2051` already carries `{ fresh: true, strict: true, owner }`, when the implementer inspects it, then it is left byte-for-byte unchanged and the ~10 probe reads listed in the Code Map remain unqualified.
- Given the full suite, when `pnpm test` and `pnpm lint` run, then both pass with no new failures.
- Given each newly added row, when it is run against the code with its flag removed, then it fails — verified once per row before the run is reported complete.

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 1, low 6)
- defer: 1: (high 0, medium 0, low 1)
- reject: 12
- addressed_findings:
  - `[medium]` `[patch]` `strict` forwards into `getPageIndex({ strict })`, so an unreadable or unparseable `derived-indexes/pages.json` now fails BOTH bases closed instead of degrading to the scan fallback — demonstrated empirically by the reviewer, pinned by nothing. Added two ablation rows (`breakPageIndex` helper + `assertBothFailClosed`) that break only the index read while every page file stays readable, and assert fail-closed at both sites plus nothing fetched, nothing written, no second page.
  - `[low]` `[patch]` `reingest`'s `@throws` claimed "a store fault is classified ahead of it and retried" unconditionally; that holds only for a `StoreFaultError` or an errno-coded `Error` (`isStoreFault`, src/lib/errors.ts:56-66). An R2 provider failure carries neither. Reworded to split the landing zones honestly — both are retried, neither is the 422 poison.
  - `[low]` `[patch]` The stale-attach row installed no fetch mock, so a regression would hit the real network at example.com instead of failing fast. Added the mock, restored in `finally`, and asserted it was never called.
  - `[low]` `[patch]` The reingest blip row's one-shot spy keyed only on the filename, so a read introduced ahead of the merge base would silently swallow the blip. Anchored with a `pageReads` counter (exactly one read) and a never-called fetch mock.
  - `[low]` `[patch]` The block header claimed "every row fails with its own flag removed" (false once the invariant rows were added) and "the two read-modify-write bases" (there are three). Corrected, with an explicit ABLATION-vs-INVARIANT split.
  - `[low]` `[patch]` Neither blip row asserted that nothing was written. Both now capture `before` and assert the stored bytes are unchanged byte for byte; the dedup row additionally asserts its fetch mock was never called, which separates "no duplicate landed" from "no fall-through happened".
  - `[low]` `[patch]` The index-drift row pinned only the matrix's first clause (`null`), not "caller ingests normally". Added a companion row that points the warm source index at a never-stored slug and asserts `ingestUrl` falls through and produces the page.

## Design Notes

`fresh` and `strict` fix two different halves and neither substitutes for the other. `fresh` bypasses the module-global `pageCache`, which a concurrent bulk scan (`lint.ts`, `search.ts`, `query.ts`) can hold open across a request with entries that predate the bytes this write is about to merge into. `strict` makes a non-ENOENT storage failure rethrow instead of flattening to `null` — the half that turns "the provider blipped" into an honest error rather than "there is no such page". Site 1's harm is the bogus 422 poison; site 2's is a duplicate page plus a CAS precondition computed from bytes nobody stored.

Example of the shape both sites take:

```ts
const existing = await readWikiPageWithFrontmatter(slug, { fresh: true, strict: true });
if (!existing) return null; // ENOENT only — a storage fault throws above.
```

## Verification

**Commands:**
- `pnpm test -- src/lib/__tests__/ingest.test.ts` -- expected: all pass, including the four new rows
- `pnpm test -- src/lib/__tests__/tasks-route.test.ts` -- expected: all pass, including the new errno row
- `pnpm test` -- expected: no new failures anywhere in the suite
- `pnpm lint` -- expected: clean
- `grep -n "readWikiPageWithFrontmatter" src/lib/ingest.ts` -- expected: exactly three qualified reads (543, 1432, 2051); the rest unqualified

## Auto Run Result

Status: done

**Implemented change.** Two of the three ingest read-modify-write bases now read `{ fresh: true, strict: true }` — the repo's established write-base pattern — instead of going through the module-global `pageCache` and flattening a non-ENOENT storage failure into `null`. `reingest` no longer answers a provider blip with a bogus `Cannot re-ingest: page "…" not found`, the sentence `POST /api/tasks/run` poisons at 422; `attachIngestTrigger` no longer answers one with "index drifted", which fell through to a full ingest that minted a DUPLICATE page and preconditioned its CAS write on bytes nobody stored. The third base named in the bundle intent (the re-ingest merge base carrying `created`/`source_count`/`tags`, now `src/lib/ingest.ts:2068`) already carried `{ fresh: true, strict: true, owner }` from commits `39cf8ca2`/`2de96b4e` and was verified and left byte-for-byte unchanged. The ~10 pure existence probes are untouched.

**Files changed**
- `src/lib/ingest.ts` — `{ fresh: true, strict: true }` at the `reingest` base read (:552) and the `attachIngestTrigger` base read (:1447), each with a comment naming the harm it closes; `reingest`'s `@throws` extended to state where a rethrown storage fault actually lands.
- `src/lib/__tests__/ingest.test.ts` — new `describe("ingest — write bases read fresh + strict (DW-427)")` block, 9 rows: 4 flag-ablation rows (strict/fresh × both sites), 2 invariant rows (ENOENT still an absence; drift `null` still returned), 1 fall-through row (the drift `null` still lets `ingestUrl` ingest normally), and 2 rows pinning `strict`'s wider reach into the page index.
- `src/lib/__tests__/tasks-route.test.ts` — one row: `maintain:staleness` whose `reingest` rejects with an `EIO`-coded error worded like a miss answers 500 (bounded retry), never the 422 poison.

**Review findings breakdown.** 7 patches applied (1 medium, 6 low) — see the Review Triage Log for each. 1 item deferred (`src/lib/ingest.ts:1952`, pre-existing, recorded in frontmatter `deferred`). 12 findings rejected: missing `owner` routing hints (explicitly forbidden by this spec's Never clause), wrapping storage-adapter failures in `StoreFaultError` (an adapter-wide change the intent does not reach), locking the attach's read-modify-write, tenant-silo and image/PDF attach coverage, the private-realm `null` return, comment duplication, the ingest auto-retry cap's deliberate 422 at `queueAttempt >= 3`, and the probe at `:275`.

**Follow-up review recommendation:** `true`. Patched findings by severity — high 0, medium 1, low 6. Score = 3 × 1 + 1 × 6 = 9, which is ≥ 5.

**Verification performed**
- `npx vitest run src/lib/__tests__/ingest.test.ts src/lib/__tests__/tasks-route.test.ts` → 312 passed.
- `npx vitest run` (full suite) → 357 files, 8575 passed, 1 skipped, 0 failed.
- `npx tsc --noEmit` → exit 0. `npx eslint` → exit 0.
- `grep -n "readWikiPageWithFrontmatter" src/lib/ingest.ts` → exactly three qualified reads (552, 1447, 2068); the remaining ten unqualified.
- Every ablation row was confirmed to fail against the code with the behaviour it names removed, with the file restored after each ablation.
- Matrix audit: all seven I/O matrix rows are covered by rows that ran and passed.

**Residual risks**
- A storage error that carries no errno `code` and no `StoreFaultError` identity but whose own message contains "not found" would still be poisoned at 422 by `src/app/api/tasks/run/route.ts:934`. Strictly better than before (where a blip ALWAYS produced that sentence), but not eliminated; closing it properly means wrapping non-ENOENT adapter failures in `StoreFaultError` at `src/lib/storage/*`, which is outside this intent.
- On the `ingest` task kind at `queueAttempt >= 3`, the auto-retry cap deliberately takes the 422 ahead of the store-fault 500 (`route.ts:930`, pinned at `tasks-route.test.ts:860`). A store fault at the cap is therefore still recorded failed — by design, and unchanged by this work.
- Both stale-cache rows plant staleness with `fs.writeFile(seeded.path, …)`, which assumes the local-filesystem backend the test harness uses (the same assumption the `mcp.test.ts` idiom makes). They would need reworking if these suites ever ran against R2.
- Environment note: this session ran alongside other `bmad-loop` sessions in the same working copy. The production and test edits above were swept into commit `484161f4` by a concurrent session's finalize step rather than by this run; they are present and verified at HEAD. `src/lib/backups.ts`, `src/lib/__tests__/backups.test.ts` and `spec-dw-540-backup-walk-order-and-failure.md` belong to another in-flight session and were deliberately left uncommitted and untouched.
