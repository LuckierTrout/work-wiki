---
title: 'Test coverage and flake fixes (DW-158, DW-259, DW-325)'
type: 'chore'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
baseline_revision: '6d4a42a2ea2454394ec3b303cb7035a1c97a4c67'
deferred:
  - summary: >-
      Four live `useSlugTenants` consumers still have no rendered-anchor pin, so
      reverting their `hrefForSlug` call sites to a default-tenant path leaves
      the whole suite green — the same gap DW-259 closed for three components.
    evidence: |-
      `src/components/IngestSuccess.tsx:20` and `:35` (two anchors, rendered by
      `src/app/ingest/page.tsx`), `src/hooks/useGlobalSearch.ts:197`
      (`router.push(hrefForSlug(slug))`, reached from `NavHeader.tsx`), and the
      `hrefForSlug={hrefForSlug}` wiring at `src/app/lint/LintClient.tsx:100`
      down into `src/components/LintIssueCard.tsx:101`. A repo-wide grep finds
      zero test references to `IngestSuccess` or `useGlobalSearch`, and
      `LintClient` appears in tests only inside a comment. The one nearby suite,
      `src/components/__tests__/lint-check-parity.test.tsx:166,230`, injects its
      own `hrefForSlug` stub returning `/u/yopedia/<slug>` — so it asserts its
      own stub and is blind by construction to what `LintClient` actually passes
      down, exactly the pattern `owner-scoped-anchors.test.tsx` was written to
      replace. Consequence: the post-ingest confirmation link, every
      global-search navigation, and every lint-issue link can regress to a
      wrong-handle `/u/yopedia/<slug>` hop with CI green. Pre-existing; DW-259
      scoped itself to the three components its ledger entry named.
    location: >-
      src/components/IngestSuccess.tsx:20
    severity: medium
  - summary: >-
      The production half of the DW-325 race is unaddressed: a real browser
      recheck fired between the load commit and the passive mirror flush is
      dropped silently, with no retry.
    evidence: |-
      `standDown` reaches `screenRef` through a PASSIVE effect (the `screenRef`
      mirror effect in `src/components/WorkspacePurposeSettings.tsx`), while
      `load("recheck")` reads it as its first early return. Between the commit
      that clears `loading` and the passive-effect flush, a `visibilitychange`
      calls `load("recheck")`, reads a stale `standDown: true`, and returns
      without issuing the GET — so the form goes on naming a wiki that is no
      longer active until something else triggers a re-read. DW-325's own intent
      offered "or derive `standDown` during render" as the alternative remedy;
      this bundle took the test-side reading, which closes the flake but leaves
      the component's window open and unpinned. Two independent review layers
      raised it against this diff.
    location: >-
      src/components/WorkspacePurposeSettings.tsx
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Three named test gaps let real regressions land green: neither `lint-checks.ts` LLM detector has a test proving it resolves the ACTIVE Wiki's Schema (pinning both to the repo-root file passes the suite); `RecentIngests`, `ActionInbox` and `BulkDocumentImport` have no rendered-anchor coverage, so reverting their `hrefForSlug` call sites to a default-tenant path stays green; and `workspace-purpose-settings.test.tsx`'s "adopts a recheck that answers no wiki at all" races the visibility recheck against a 1s `waitFor`, so it can red an unrelated CI run.

**Approach:** Close all three at the OUTERMOST observable surface, reusing the harnesses that already exist. Add a Wiki-backed case to `lint.test.ts` that asserts the captured LLM system prompt carries the active Wiki's conventions for BOTH detectors; extend `owner-scoped-anchors.test.tsx` with the three remaining converted components, asserting rendered `href`s against a map whose every wrong answer is distinguishable; and replace the flaky test's timing-budget `waitFor` with the file's own deterministic `settle()` barrier.

## Boundaries & Constraints

**Always:** Assert on the rendered/captured surface (an `href` attribute, a captured system prompt), never on an import or a mocked helper. Keep every new anchor assertion non-vacuous: the expected href must differ from both the `DEFAULT_TENANT` fallback (`/u/yopedia/<slug>`) and from any per-component tenant fallback. Restore every mutated `process.env` value in the same test/hook that set it.

**Block If:** A detector or component turns out to already have equivalent rendered/captured coverage elsewhere, making one of these entries a no-op — record it and continue with the rest rather than inventing a second assertion for the same claim.

**Never:** Do not change production behaviour. In particular do not add a tenant parameter to `loadPageConventions()`/`readActiveWikiSchema()` (DW-19's pins in `wiki-schema-source.test.ts` forbid it), do not alter the `hrefForSlug` call sites, and do not change `WorkspacePurposeSettings.tsx` — the DW-325 flake is a test-harness timing race, so fix it in the test file. Do not mock `useSlugTenants` in the new anchor cases; mocking it is exactly what makes the existing `recent-ingests-read-only.test.tsx` blind to the revert. Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lint detectors, Wiki active | `NEXT_PUBLIC_OWNER_HANDLE=alice` + `createWiki(alice, {scenario:"reading"})`, LLM key present | Both `checkContradictions()` and `checkMissingConceptPages()` pass a system prompt containing the Wiki's scenario prose ("Preserve sequence when it matters"), which the repo-root `SCHEMA.md` does not carry | No error expected |
| Lint detectors, no Wiki | Registry empty (existing cases) | Repo-root conventions still reach the prompt | No error expected |
| RecentIngests anchors | Ledger entry `primary_slug: "target"` (alice) and a done email job `slug: "other"` (bob), map `{target:alice, other:bob}` | Rendered hrefs are `/u/alice/target` and `/u/bob/other` | No error expected |
| ActionInbox anchor | One inbox item with `sourceSlug: "target"` | The `source · target` link's href is `/u/alice/target` | No error expected |
| BulkDocumentImport anchor | One selected file uploaded, status poll answers `{status:"done", slug:"target"}` | The "Open page →" link's href is `/u/alice/target` | No error expected |
| Purpose-form recheck | Mount settled, `visibilitychange` hidden→visible, recheck answers `wiki: null` | A second GET is issued and the badge reads `no wiki` after one deterministic settle — no wall-clock budget involved | Failure names whether the recheck started at all |

</intent-contract>

## Code Map

- `src/lib/lint-checks.ts:408` (`checkContradictions`) and `:564` (`checkMissingConceptPages`) -- the two no-argument `loadPageConventions()` call sites under pin. Both append the section to their system prompt as `\n\nThe wiki follows these conventions (from SCHEMA.md):\n\n${conventions}`.
- `src/lib/schema.ts:52` (`loadPageConventions`) -- prefers the active Wiki's `schema.md`, falls back to repo-root `SCHEMA.md`. Read-only here.
- `src/lib/__tests__/wiki-schema-source.test.ts:29-55` -- the exact Wiki-backed harness to copy: `DATA_DIR=tmpDir`, `NEXT_PUBLIC_OWNER_HANDLE=alice`, `_resetLocks()`, `_resetStorage()`, `createWiki(OWNER, {name, scenario:"reading"})`. Its line 82 establishes "Preserve sequence when it matters" as the reading template's Wiki-only marker.
- `src/lib/__tests__/lint.test.ts:45-81` -- `beforeEach` already sets `WIKI_DIR`/`RAW_DIR`/`DATA_DIR` to a tmpdir and resets storage; `../llm` is mocked at :10 so `mockedCallLLM.mock.calls[0][0]` is the captured system prompt. `:671` is the existing root-only conventions case (leave it). `afterEach` does NOT restore `NEXT_PUBLIC_OWNER_HANDLE` — the new block must.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- the harness to extend: `SLUG_TENANTS = {target:alice, other:bob, sibling:dana}` (:41), a `routes` table + throwing `fetch` stub (:108-124), `loadSlugTenants()` warmed in `beforeEach`, and `hrefOf(name)` (:136).
- `src/components/RecentIngests.tsx:79` (hook), `:574` (email-job link, needs `status:"done"` + `slug`), `:655` (ledger link, needs `primary_slug` and `source_type !== "email"`). Polls `/api/ingest/history?limit=20`, `/api/ingest/jobs?source=email&limit=20`, and `/api/ingest/status/<id>` for ids in `localStorage`.
- `src/components/ActionInbox.tsx:61` (hook), `:387` (link, text `source · <slug>`, needs `item.sourceSlug`). Loads `/api/action-items`; default tab is `inbox`, so the item's `status` must be `"inbox"`.
- `src/components/BulkDocumentImport.tsx:85` (hook), `:531` (link, text "Open page →", needs `status:"done"` + `slug`). Flow: file input `change` → click `Import 1 document` → `POST /api/ingest/document` returns `{queued:true, jobId}` → a 2500ms `setTimeout` polls `GET /api/ingest/status/<jobId>`.
- `src/components/workbench/__tests__/data-version-watcher.test.tsx:95-110` -- the repo's fake-timer + `act(advanceTimersByTimeAsync)` pattern, for driving BulkDocumentImport's 2500ms poll without a real wall-clock wait.
- `src/components/__tests__/workspace-purpose-settings.test.tsx:86-98` (`settle()`, the file's deterministic barrier), `:789-793` (`returnToTab()`), `:1010-1038` (the flaky case).
- `src/components/WorkspacePurposeSettings.tsx:272-300` -- `screenRef`/`standDown` is mirrored by a PASSIVE effect; `:356` early-returns the recheck when `standDown` is still true. Read-only — this is why the fix is a settle barrier, not a production change.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/lint.test.ts` -- add a `describe` block (DW-158) that sets `NEXT_PUBLIC_OWNER_HANDLE`, calls `_resetLocks()`/`_resetStorage()`, creates a `reading`-scenario Wiki for the owner, then runs each detector in turn and asserts the captured system prompt contains the Wiki's scenario prose; assert non-vacuity by showing the repo-root conventions do NOT contain that prose. Restore the env var in the block's own `afterEach`. -- a mutation pinning either detector to `${process.cwd()}/SCHEMA.md` must fail here.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- add `RecentIngests`, `ActionInbox` and `BulkDocumentImport` sections using the existing `routes` table and `hrefOf()`; clear `localStorage` in `beforeEach` so a remembered job id from one case cannot make another case's fetch stub throw. Cover BOTH RecentIngests call sites (ledger entry → alice, email job → bob). -- reverting any of the four call sites to a default-tenant path must fail here.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` -- make "adopts a recheck that answers no wiki at all" deterministic: settle once after the mount load so the `standDown` mirror effect has flushed before the visibility event, assert the recheck GET was actually issued, then settle and assert the badge/status synchronously instead of waiting on a 1s budget. -- removes the wall-clock race without weakening any claim.

**Acceptance Criteria:**
- Given the site owner has an active reading-scenario Wiki, when `checkContradictions()` runs, then the system prompt handed to `callLLM` contains the Wiki's conventions text and not merely the repo-root conventions.
- Given the same state, when `checkMissingConceptPages()` runs, then its system prompt likewise contains the Wiki's conventions text.
- Given the repo-root `SCHEMA.md` is the only Schema (no Wiki), when either detector runs, then the existing root-fallback expectations still hold.
- Given a slug→tenant map that owns `target` to `alice` and `other` to `bob`, when `RecentIngests` renders a ledger entry for `target` and a completed email job for `other`, then the two links resolve to `/u/alice/target` and `/u/bob/other`.
- Given the same map, when `ActionInbox` renders an inbox item whose `sourceSlug` is `target`, then its source link resolves to `/u/alice/target`.
- Given the same map, when a `BulkDocumentImport` upload's status poll answers `done` with slug `target`, then the "Open page" link resolves to `/u/alice/target`.
- Given the purpose form has finished its mount load, when the tab returns and the recheck answers `wiki: null`, then exactly two GETs have been issued and the badge reads `no wiki` without any `waitFor` timeout being involved.

## Spec Change Log

_No bad_spec loopback occurred; this section is empty._

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 1, low 10)
- defer: 2: (high 0, medium 2, low 0)
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[medium]` `[patch]` The empty-registry fallback case pinned `checkContradictions` only — added the matching `checkMissingConceptPages` fallback so that call site cannot stop appending the root conventions on a fresh deployment and stay green.
  - `[low]` `[patch]` `owner-scoped-anchors.test.tsx`'s docstring read as a completeness claim for the slug-tenant sweep — rewritten into an explicit "covered" list plus a "still open" list naming `IngestSuccess`, `useGlobalSearch` and the `LintClient` -> `LintIssueCard` wiring.
  - `[low]` `[patch]` The new lint block said "both LLM detectors" while a third, `checkIncompleteCoverage`, deliberately carries no conventions — documented, and pinned in BOTH directions with a case asserting no conventions reach its prompt even with a Wiki active.
  - `[low]` `[patch]` `capturedSystemPrompt()` read `mock.calls[0][0]` while asserting only `toHaveBeenCalled()` — now asserts the exact call count, so a second/preflight `callLLM` cannot silently retarget the assertion.
  - `[low]` `[patch]` The `localStorage.clear()` comment claimed a leaked job id would throw through the fetch stub and fail the case; both poll paths catch, so the leak is silent — rationale corrected.
  - `[low]` `[patch]` The combined `RecentIngests` case claimed to catch what the single-link cases miss; the implication runs the other way — comment corrected to say the singles name the regression.
  - `[low]` `[patch]` The `BulkDocumentImport` case asserted through `getByRole(...).getAttribute("href")` instead of the file's `hrefOf()` accessor — converted.
  - `[low]` `[patch]` Added a `vi.useRealTimers()` backstop to the anchors file's `afterEach`, so a throw escaping the fake-timer `try/finally` cannot leave the clock faked.
  - `[low]` `[patch]` The `BulkDocumentImport` upload leg had no intermediate observation, so a stub miss surfaced as "link not found" — the case now asserts the row reached `queued` before advancing the poll.
  - `[low]` `[patch]` Two mount sites inlined the mirror barrier with a duplicated comment — extracted `mirrored()` as its single named home, which `formReady()` also calls.
  - `[low]` `[patch]` New prose cited source line numbers that drift (one was already off by one) — replaced with symbol names, keeping the file paths.

## Design Notes

The DW-325 flake has two candidate causes and the fix covers both: (1) `standDown` is mirrored into `screenRef` by a passive effect, so immediately after `waitFor(fieldset enabled)` the mirror can still read `true` and the recheck early-returns at `WorkspacePurposeSettings.tsx:356` — no GET, and the badge never moves; (2) the 1s `waitFor` budget simply expires under full-suite load. A `settle()` before the visibility event closes (1); replacing the badge `waitFor` with `settle()` + a synchronous assertion closes (2). The sibling tests in that describe are not rewritten — they either fire an `act`-wrapped event in between (which flushes effects) or already assert through `settle()`.

BulkDocumentImport's 2500ms poll is driven with scoped fake timers inside its own case rather than a 3s real wait; `findBy*` must not be used while the clock is faked — advance inside `act`, then assert synchronously.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/lint.test.ts src/components/__tests__/owner-scoped-anchors.test.tsx src/components/__tests__/workspace-purpose-settings.test.tsx` -- expected: all pass.
- Mutation check (revert after each): pin both `loadPageConventions()` calls in `src/lib/lint-checks.ts` to `` `${process.cwd()}/SCHEMA.md` `` -- expected: the new DW-158 cases fail. Replace one `hrefForSlug(x)` with `` `/u/yopedia/${x}` `` in each of the three components -- expected: the matching new anchor case fails.
- `pnpm test` -- expected: full suite green.
- `pnpm lint` -- expected: no new errors.

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** Closed three named test gaps, test files only — zero production changes. DW-158: both convention-carrying lint detectors are now pinned to the ACTIVE Wiki's Schema at the captured LLM prompt, with the third detector's deliberate no-conventions behaviour pinned in the other direction. DW-259: the last three converted client components joined the owner-scoped-anchors harness, covering all four `hrefForSlug` call sites with distinguishable owners. DW-325: the flaky recheck case is deterministic, and the same latent mount-to-visibility race was closed across every sibling case in that file via a shared `formReady()`/`mirrored()` barrier.

**Files changed.**
- `src/lib/__tests__/lint.test.ts` -- new DW-158 block: non-vacuity of the Wiki-only marker, one case per convention-carrying detector, an empty-registry fallback case for each, and a case pinning that `checkIncompleteCoverage` carries no conventions at all.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- `RecentIngests` (both call sites, different owners), `ActionInbox` and `BulkDocumentImport` (driven through the real upload/poll round trip under scoped fake timers); shared `beforeEach` clears `localStorage`; `afterEach` restores real timers; docstring now states what is covered and what is still open.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` -- `mirrored()` + `formReady()` barriers replace the implicit reliance on passive-effect flush at ten mount sites; the DW-325 case now asserts the recheck GET was issued and reads the badge synchronously instead of on a 1s `waitFor` budget.

**Review findings breakdown.** 11 patches applied (1 medium, 10 low); 2 items deferred (both medium, recorded in frontmatter `deferred`); 15 rejected. No intent_gap, no bad_spec, no repair loopback.

**Follow-up review recommendation:** true. Patched-only counts: high 0, medium 1, low 10; score = 3x1 + 1x10 = 13, which is >= 5.

**Verification performed.**
- `npx vitest run src/lib/__tests__/lint.test.ts src/components/__tests__/owner-scoped-anchors.test.tsx src/components/__tests__/workspace-purpose-settings.test.tsx` -- 147 passed.
- `npx vitest run` (full suite) -- 274 files / 6186 tests passed.
- `npx eslint` -- exit 0 (only pre-existing `jsx-ast-utils` plugin warnings). `npx tsc --noEmit` -- exit 0.
- Mutation checks, each reverted after: pinning both `loadPageConventions()` calls in `src/lib/lint-checks.ts` to the repo-root file fails exactly the two detector cases; the inverse mutation (appending conventions to `checkIncompleteCoverage`) fails exactly the third-detector case; each of the four `hrefForSlug` call sites reverted individually to `/u/yopedia/<slug>` fails exactly its matching case.
- Flake evidence: the pre-fix tree failed once in 8 runs of the three-file command; the post-fix tree passed 12/12 of the same command plus two clean full-suite runs.
- Matrix audit: every I/O matrix row is covered by at least one case that ran and passed in the runs above.
- `pnpm` itself fails in this checkout with "packages field missing or empty", so the spec's `pnpm test` / `pnpm lint` were run as `npx vitest run` / `npx eslint` -- same binaries, same config.

**Residual risks.**
- The `BulkDocumentImport` case depends on `advanceTimersByTimeAsync` draining the upload's promise chain before the poll effect schedules its timer, and on the component's 2500ms poll interval. It was stable across every repeat run, and a break in the upload leg now names itself rather than surfacing as a missing link.
- DW-158's Wiki-only marker is template prose from the `reading` scenario; rewording that template reds these cases (and two sibling suites that already pin the same string).
- Both deferred items are real and unaddressed by design -- see frontmatter `deferred`.
