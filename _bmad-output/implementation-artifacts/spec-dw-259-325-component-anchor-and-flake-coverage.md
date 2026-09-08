---
title: 'Rendered-anchor coverage for the last three converted components, and a deterministic recheck wait (DW-259, DW-325)'
type: 'chore'
created: '2026-08-29'
baseline_revision: 'e99ce1fb4819820587c565c2ac545a4171e21a02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true # this pass: patch 1 medium + 5 low -> 3x1 + 5 = 8 >= 5
context: []
warnings: ['oversized', 'multiple-goals']
deferred:
  - summary: >-
      Three more call sites from the same 308-shim conversion -- IngestSuccess, BatchItemRow (via
      BatchIngestForm) and useGlobalSearch's router.push -- are still unpinned, so reverting any of
      them to slugPath passes the whole run.
    evidence: |-
      This story's intent enumerated three components (RecentIngests, ActionInbox,
      BulkDocumentImport) and those are now pinned. `src/components/IngestSuccess.tsx:20,35`
      (rendered by `src/app/ingest/page.tsx:71`), `src/components/BatchItemRow.tsx:43` (fed
      `hrefForSlug` as a prop from `src/components/BatchIngestForm.tsx:319`) and
      `src/hooks/useGlobalSearch.ts:197` (`router.push(hrefForSlug(slug))`, consumed by
      `GlobalSearch.tsx`) come from the same sweep, and no `*.test.ts`/`*.test.tsx` under `src/`
      references any of the three. Demonstrated during review: all four sites were reverted to a
      `/u/yopedia/${slug}` answer at once and `pnpm test` was byte-identical to the unmutated
      tree -- 13 failed / 331 passed files, 233 failed / 7728 passed tests -- not one extra
      failure. `IngestSuccess` and `BatchItemRow` take plain props and drop straight into
      `owner-scoped-anchors.test.tsx`; `useGlobalSearch` is a navigation, so it fits that file's
      existing `nav.router.push` mock instead of an href assertion.
    location: >-
      src/components/IngestSuccess.tsx:20
    severity: medium
  - summary: >-
      On Node 26 the runtime's own localStorage global shadows jsdom's, so `window.localStorage` is
      undefined in the dom project and 13 workbench suites (233 tests) fail before any assertion.
    evidence: |-
      Reproduced at the baseline revision with both of this story's files stashed:
      `pnpm exec vitest run --project dom` gives 13 failed files / 233 failed tests, every one
      `TypeError: Cannot read properties of undefined (reading 'clear')` (248 occurrences) or
      `(reading 'remove')` (18) from a `window.localStorage.clear()` in a suite's own setup --
      e.g. `src/components/workbench/__tests__/icon-rail.test.tsx:62`,
      `activity-dock.test.tsx:27`, `workbench-split-wiring.test.tsx:97`. Node here is v26.8.1 and
      the run prints `ExperimentalWarning: localStorage is not available because
      --localstorage-file was not provided`. Pre-existing and unrelated to this change (the
      failing set is identical before and after it), but it means `pnpm test` cannot be green on a
      Node 26 machine, and the repo's own convention says a capability jsdom lacks belongs in
      `vitest.setup.dom.ts` behind `@/test/dom-helpers` rather than in each suite.
    location: >-
      vitest.setup.dom.ts
    severity: medium
  - summary: >-
      DW-325 closed the flake class for one case; ~14 structurally identical `returnToTab()` +
      `waitFor` cases in the same describe keep the same millisecond-budget exposure.
    evidence: |-
      `src/components/__tests__/workspace-purpose-settings.test.tsx` still contains ~83 `waitFor(`
      calls, and the describe at `:796` holds roughly fourteen cases with the same
      `render -> waitFor(fieldset enabled) -> returnToTab() -> waitFor(badge/status)` shape --
      including `await waitFor(() => expect(badge()).toBe("no wiki"))` at `:1008`, which is the
      literal assertion whose expiry produced the observed red. This story's intent named one case
      and its spec forbade widening, so the scoping is deliberate; the exposure is simply still
      there, and `settleUntil` now exists in the file as the clock-free replacement.
    location: >-
      src/components/__tests__/workspace-purpose-settings.test.tsx:796
    severity: low
  - summary: >-
      ActionInbox never reads `ActionItem.sourceMissing`, so a to-do whose cited Source was
      cascade-deleted still renders a live `source · <slug>` link into a page that is gone.
    evidence: |-
      `src/lib/action-items.ts:26` declares `sourceMissing` with the comment "The cited Source was
      cascade-deleted. The todo itself is kept." `grep -c sourceMissing
      src/components/ActionInbox.tsx` is 0, and the chip at `:387` is gated only on
      `item.sourceSlug`. Pre-existing production behaviour, surfaced because this story gave the
      component its first test of any kind; pinning or fixing it is a separate change.
    location: >-
      src/components/ActionInbox.tsx:387
    severity: low
---

<intent-contract>

## Intent

**Problem:** (DW-259) DW-86 converted six client components to owner-scoped links, but `owner-scoped-anchors.test.tsx` only pinned four: `RecentIngests.tsx:574,655`, `ActionInbox.tsx:387` and `BulkDocumentImport.tsx:531` still call `hrefForSlug` with no rendered-anchor assertion — no suite under `src/` even references `ActionInbox` — so reverting any of those call sites to `slugPath()` leaves the whole run green. (DW-325) `workspace-purpose-settings.test.tsx`'s "adopts a recheck that answers no wiki at all" (`:1017-1046`) waits for the recheck's effect on a default 1s `waitFor` budget; it was observed failing once under full-suite load (the badge still read "not configured") and passing in isolation, so it can red an unrelated CI run.

**Approach:** Add one `describe` per remaining component to the existing `owner-scoped-anchors.test.tsx` harness, asserting the rendered `href` against the same distinguishable slug→tenant map. Separately, replace that one flaky test's wall-clock `waitFor`s with the file's own `settle()` helper, so every wait is a fixed number of event-loop turns rather than a timeout budget.

## Boundaries & Constraints

**Always:**
- Assert on the outermost surface: the rendered `href` of a real anchor, reached by driving the component's own UI — never on whether a module imports a hook.
- Reuse `owner-scoped-anchors.test.tsx`'s existing map (`target`→alice, `other`→bob), route table, `fetch` stub and `hrefOf` helper. The canonical answer must stay distinguishable from the `DEFAULT_TENANT` (`/u/yopedia/…`) href a reverted call site emits.
- Every new case ends with a link whose text identifies it, so a component that rendered no anchor at all fails rather than passing vacuously.
- Where a component needs a timer to reach the anchor, advance it with the repo's `act` + `vi.advanceTimersByTimeAsync` idiom (`data-version-watcher.test.tsx`), and restore real timers in that `describe`'s own `afterEach`.
- Keep `cleanup()` the FIRST statement of the file's own `afterEach`, per the DOM-project convention.

**Block If:** Reaching one of the three anchors requires changing the component under test (a test-only prop, seam or export) rather than driving its UI and mocking its module boundary.

**Never:**
- Change `RecentIngests.tsx`, `ActionInbox.tsx`, `BulkDocumentImport.tsx` or `WorkspacePurposeSettings.tsx` behaviour — both halves are test-only work.
- Mock `useSlugTenants` in the new cases (that is exactly what makes `recent-ingests-read-only.test.tsx` blind to a revert).
- Widen the DW-325 fix beyond the one named test, or change what it asserts.
- Add a shim to `src/`, a second vitest config/project, or a new npm script.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| RecentIngests, ledger row | `/api/ingest/history?limit=20` answers one entry, `primary_slug: "target"` | the row's link href is `/u/alice/target` | none |
| RecentIngests, email row | `/api/ingest/jobs?source=email&limit=20` answers a `done` job with `slug: "other"` | the subject link's href is `/u/bob/other` | none |
| ActionInbox, cited source | `/api/action-items` answers one inbox item with `sourceSlug: "target"` | the `source · target` chip's href is `/u/alice/target` | none |
| BulkDocumentImport, imported doc | a picked file uploads (`{queued, jobId}`), then the status poll answers `{status:"done", slug:"target"}` | the row's `Open page →` href is `/u/alice/target` | none |
| Recheck answers no wiki | mount GET settles, then `returnToTab()` with a queued no-wiki answer | badge reads `no wiki` and the status names the gone wiki, after a fixed settle rather than a 1s budget | none |

</intent-contract>

## Code Map

Investigation is done; every path and line below was read against the working tree at the baseline revision.

**The harness to extend (DW-259)**
- `src/components/__tests__/owner-scoped-anchors.test.tsx` (432 lines) -- EXTEND. Already holds everything the three new describes need: `SLUG_TENANTS = { target: "alice", other: "bob", sibling: "dana" }`, the `ALICE_TARGET` / `BOB_OTHER` constants, a per-test `routes` table consulted by one `fetch` stub that THROWS on an unlisted url, `await loadSlugTenants()` in `beforeEach` to warm the module-level session cache (so the map is present on first paint), `hrefOf(name)`, and `next/navigation` + `@clerk/nextjs` mocks. Its `afterEach` runs `cleanup()` first, then `vi.unstubAllGlobals()`.
- `src/hooks/useSlugTenants.ts:94` -- `hrefForSlug` = `hrefFromMap(map, slug)`; the map arrives from `/api/wiki/routes`, already in the route table.

**RecentIngests (`src/components/RecentIngests.tsx`)**
- `:79` reads the hook; `:655` is the ledger row's `Link` (text = `e.primary_slug`), `:574` the email row's (text = `job.email?.subject || job.title || job.slug`).
- `:106-215` one effect, three reads: `/api/ingest/history?limit=20` -> `{ entries, readOnly }`, `/api/ingest/jobs?source=email&limit=20` -> `{ jobs }`, then one `/api/ingest/status/<id>` per id in `getRecentJobIds()` (localStorage, `yopedia_recent_ingests`). With no stored ids and no queued/processing job, `polls < 90 && stillRunning` is false and NO 4s timer is armed — no fake timers needed.
- `historyEntries` filters out `source_type === "email"`; the email list keeps only `done`/`failed`. `hostOf(e.source_url)` is try/catch'd. `LedgerEntry` needs `ingest_id, source_url, primary_slug, finished_at, status, source_type`; `EmailJob` needs `jobId, status, slug, createdAt` (+ optional `email`, `title`).
- `src/components/__tests__/recent-ingests-read-only.test.tsx:23` -- the reason this component is uncovered: it MOCKS `useSlugTenants` to a `/u/yopedia/${slug}` stub, which is precisely the reverted answer.

**ActionInbox (`src/components/ActionInbox.tsx`)**
- `:61` reads the hook; `:387` is the chip — rendered only when `item.sourceSlug` is set, text `source · <slug>`, inside the NON-editing branch.
- `:75-91` mount: `request<{items}>("/api/action-items")`, plus `new URLSearchParams(window.location.search).get("source")`. No timers. `ActionItem` (`src/lib/action-items.ts:15`) requires `id, title, priority, status, createdAt, updatedAt`.
- The default tab is `inbox`, so the fixture item needs `status: "inbox"`.

**BulkDocumentImport (`src/components/BulkDocumentImport.tsx`)**
- `:85` reads the hook; `:531` is the `Open page →` link, rendered only for `item.status === "done" && item.slug`.
- Reaching it: put a file on a `input[type=file]` (`Object.defineProperty(input, "files", …)` then `fireEvent.change`, the idiom `bulk-document-accept-parity.test.tsx:120-128` establishes) -> click `Import 1 document` (`:576-587`) -> `uploadItem` POSTs `/api/ingest/document` and needs `{ queued: true, jobId }` (`:169-200`), calling `rememberRecentJob(jobId)` (writes localStorage) -> a `setTimeout(…, 2500)` poll (`:222-290`) GETs `/api/ingest/status/<jobId>` and adopts `{ status: "done", slug }`.
- `new File([new Uint8Array(4)], "report", { type: "application/pdf", lastModified: 1 })` is a proven-accepted selection for `selectBulkDocuments`.
- The 2500ms timer is the only reason this case needs fake timers; `src/components/workbench/__tests__/data-version-watcher.test.tsx:96-101` is the `settle`/`act` idiom to copy.

**The flaky test (DW-325)**
- `src/components/__tests__/workspace-purpose-settings.test.tsx:1017-1046` -- "adopts a recheck that answers no wiki at all". Two `await waitFor(...)` calls after `returnToTab()`, each on RTL's default 1s budget; the observed failure was the first one expiring with the badge still reading `not configured`.
- `:86-96` -- `settle()`, already in the file: `await act(async () => { await new Promise(r => setTimeout(r, 0)); })`. One macrotask turn drains the microtask chain a load is made of and flushes React's passive effects, with no wall clock in it. The same test's tail already uses it.
- `:98-100` -- file `beforeEach` stubs the base GET as `{ profile: PROFILE, readOnly: false, wiki: WIKI, version: VERSION }`; `mockResolvedValueOnce` queues the recheck's answer for the next call only.
- `:797-801` -- `returnToTab()` fires `visibilitychange` hidden then visible.
- `src/components/WorkspacePurposeSettings.tsx:771` -- `<fieldset disabled={loading || saving}>`, so `formFieldset().disabled === false` is the mount load having landed; `:356` -- `load("recheck")` returns early while `screenRef.current.standDown` (`loading || loadFailed || saving`, written by the effect at `:272`) is true.

## Tasks & Acceptance

**Execution:**
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- reset this browser's remembered ingest jobs in the existing `beforeEach` -- `BulkDocumentImport`'s upload calls `rememberRecentJob`, and jsdom keeps one store for the whole file, so `RecentIngests` (the only component here that reads stored job ids) must never start a case holding another case's. Done through the module's own readers, `forgetRecentJobs(getRecentJobIds())`, rather than `window.localStorage.clear()`: both swallow a storage failure the way the components do, so the line no-ops safely on a runtime that publishes no `window.localStorage` instead of throwing before the first assertion. Ordering-independent hygiene rather than a fix for an observed failure — `RecentIngests` try/catches each of its reads, and its describe is declared first.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- add a `RecentIngests` describe -- stub the two list reads and assert both converted call sites: the ledger row resolves `target` to `/u/alice/target`, and a done email job resolves `other` to `/u/bob/other` (two owners, so one tenant for the whole list is a failure).
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- add an `ActionInbox` describe -- answer `/api/action-items` with one inbox item carrying `sourceSlug: "target"` and assert the `source · target` chip's href is `/u/alice/target`. This is the component's FIRST test of any kind.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- add a `BulkDocumentImport` describe with its own fake-timer `beforeEach`/`afterEach` -- drive pick -> import -> status poll and assert the `Open page →` href is `/u/alice/target`; assert the manifest row exists before asserting the link, so an upload that never completed cannot pass vacuously.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` -- rewrite "adopts a recheck that answers no wiki at all" (`:1017-1046`) to settle deterministically -- `await settle()` after `render` (asserting the fieldset is enabled, so the mount load is proven landed rather than assumed), then `await settle()` after `returnToTab()`, then assert the badge, the status sentence and the existing refusal expectations directly. Keep the case's claims identical; only the waiting changes. Comment the flake it closes.

**Acceptance Criteria:**
- Given the full suite passes, when any one of `RecentIngests.tsx:574`, `RecentIngests.tsx:655`, `ActionInbox.tsx:387` or `BulkDocumentImport.tsx:531` is reverted to `slugPath(...)`, then `pnpm test` fails naming that component's describe.
- Given the full suite passes, when the new cases' fixtures are left in place but the component renders no anchor at all (e.g. the row's `Link` is dropped), then the case fails rather than passing on an absent element.
- Given `workspace-purpose-settings.test.tsx`, when its "adopts a recheck that answers no wiki at all" case runs, then no assertion in it depends on a `waitFor` timeout budget, and the case still fails if the recheck stops adopting a no-wiki answer.
- Given `pnpm test` on an otherwise unmodified tree, then both projects run green with no unhandled errors and no suite reported as empty.

## Spec Change Log

## Review Triage Log

### 2026-08-29 -- Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 4: (high 0, medium 2, low 2)
- reject: 14: (high 0, medium 0, low 14)
- addressed_findings:
  - `[medium]` `[patch]` The DW-325 rewrite replaced a millisecond budget with a single bare
    `settle()`, which gives a POSITIVE state transition a margin of exactly one macrotask turn:
    measured during review, inserting two extra async hops into `WorkspacePurposeSettings.load()`
    hard-redded the case while all ~14 `waitFor`-based siblings in the same describe still passed.
    That trades a flaky red for a brittle one, and it inverted the file's own convention (its
    `settle()` docblock says the helper exists to bound NEGATIVE claims). Added `settleUntil` --
    settle, check, repeat, bounded by TURNS with no clock in the loop and the last turn's assertion
    error propagating -- and routed both of the case's waits through it. Re-verified in both
    directions: the two-extra-hop mutation now leaves 46/46 green, and making the recheck refuse a
    `null` wiki still reds the case in 20ms.
  - `[low]` `[patch]` The file docblock still read "The four components below were converted in the
    same sweep"; the file now holds seven describes. Corrected, keeping its point by saying why the
    per-hook suites cannot see which components ask them.
  - `[low]` `[patch]` The new `beforeEach` reset comment overstated its hazard twice: `RecentIngests`
    try/catches every one of its reads, so a strict-stub throw only sets `errored` and could never
    red a later case, and its describe is declared before `BulkDocumentImport`'s anyway. Reworded to
    what the line is -- ordering-independent hygiene -- keeping the Node 26 runtime note.
  - `[low]` `[patch]` The ledger fixture used `status: "done"`, a wire shape the ingest ledger never
    writes (`src/lib/ingest.ts:1506,2325` write `"completed"`, which the sibling fixture
    `recent-ingests-read-only.test.tsx:35` uses). Changed to `"completed"`.
  - `[low]` `[patch]` The `BulkDocumentImport` case had four rough edges: the file input was cast
    without a null check (a rename would surface as an opaque `Object.defineProperty` TypeError);
    the pre-click assertion's message claimed the file "was not queued" when at that point it proves
    only selection; nothing pinned that the upload actually queued, so a rejected POST read as a
    missing link 2500ms later; and the bare `2500` named no source. All four fixed, and the new
    queued assertion was checked load-bearing by forcing the POST answer to be rejected.
  - `[low]` `[patch]` The spec's own Execution and Verification text had drifted from what shipped:
    it prescribed `localStorage.clear()` (which throws on this runtime), claimed 42 tests for a
    46-test file behind an unfalsifiable hedge, and named `npx eslint` where `package.json` defines
    `pnpm lint`. All three corrected outside `<intent-contract>`.

## Design Notes

The map is already built so every wrong answer is distinguishable, and the three new components must keep it that way: `target` is alice's and `other` is bob's, so a reverted call site emits `/u/yopedia/target` and a single-tenant shortcut emits one owner for both rows. Using two owners inside `RecentIngests` is what makes the second claim testable at all.

`BulkDocumentImport` is the only case that needs a clock. The shape, following `data-version-watcher.test.tsx`:

```tsx
async function settle(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
// pick -> import -> the 2500ms status poll lands "done"
fireEvent.change(input);
fireEvent.click(screen.getByRole("button", { name: /^Import 1 document/ }));
await settle();          // the POST resolves and arms the poll
await settle(2500);      // the poll answers { status: "done", slug: "target" }
```

`vi.useRealTimers()` belongs in that describe's own `afterEach`, which vitest runs BEFORE the file-level one — so `cleanup()` still unmounts on a real clock.

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/components/__tests__/owner-scoped-anchors.test.tsx` -- expected: every describe passes, including the three new ones.
- `pnpm exec vitest run --project dom src/components/__tests__/workspace-purpose-settings.test.tsx` -- expected: 46/46 pass.
- `pnpm test` -- expected: both projects green, no unhandled errors, no empty suite.
- `npx tsc --noEmit` -- expected: clean.
- `npx eslint src/components/__tests__/owner-scoped-anchors.test.tsx src/components/__tests__/workspace-purpose-settings.test.tsx` (the changed files) and `pnpm lint`, the script `package.json` defines -- expected: clean.

**Manual checks (if no CLI):**
- Mutation-check each of the four converted call sites by hand (revert to `slugPath(...)`, run the suite, confirm it reds, restore) — the acceptance criterion above is only real if it was executed.

## Auto Run Result

Status: done

**What was implemented.** Coverage and test-determinism only — no production source changed. (DW-259) The three converted client components DW-86 left unpinned now have rendered-anchor assertions in the harness the earlier bundle built, driven through each component's own UI with nothing mocked but the network. (DW-325) The one named flaky case no longer waits on a millisecond budget: it waits a bounded number of event-loop turns instead, through a new `settleUntil` helper.

**Files changed**
- [`../../src/components/__tests__/owner-scoped-anchors.test.tsx`](../../src/components/__tests__/owner-scoped-anchors.test.tsx) — +3 describes, +5 cases (DW-259). `RecentIngests` (both call sites, two rows given DIFFERENT owners so one tenant for the whole list is a distinguishable failure), `ActionInbox` (the component's first test of any kind) and `BulkDocumentImport` (pick → import → the 2500ms status poll, on fake timers scoped to that describe). The file `beforeEach` also resets this browser's remembered job ids through `forgetRecentJobs(getRecentJobIds())` rather than `window.localStorage`, so it behaves on a runtime that publishes no `window.localStorage`.
- [`../../src/components/__tests__/workspace-purpose-settings.test.tsx`](../../src/components/__tests__/workspace-purpose-settings.test.tsx) — "adopts a recheck that answers no wiki at all" (DW-325) now waits through the new `settleUntil(check, turns)` for both the mount-load precondition and the `badge() === "no wiki"` transition, and asserts everything past the transition directly. The case's claims are unchanged; only the waiting is.

**Review findings breakdown.** 6 patches applied (1 medium, 5 low), 4 items deferred (2 medium, 2 low), 14 rejected. No intent gaps and no spec repairs.

**Follow-up review recommendation:** `true`. Patched this pass: 0 high, 1 medium, 5 low → 3 × 1 + 5 = 8, which is ≥ 5.

**Verification performed**
- `pnpm exec vitest run --project dom src/components/__tests__/owner-scoped-anchors.test.tsx src/components/__tests__/workspace-purpose-settings.test.tsx` — 63/63 pass (17 + 46).
- **Mutation-checked all four newly-pinned call sites**, independently of the implementer: reverting `RecentIngests.tsx:574` → 2 failures, `:655` → 2, `ActionInbox.tsx:387` → 1, `BulkDocumentImport.tsx:531` → 1, each naming that component's describe, each restored afterwards. Acceptance criterion 1 holds.
- **Mutation-checked DW-325**: making `load("recheck")` refuse a `null` wiki reds the case, in 20ms rather than on a budget. Acceptance criterion 3 holds. The opposite mutation — two extra async hops inside `load()` — leaves 46/46 green, which is what `settleUntil` bought over a bare `settle()`.
- `npx tsc --noEmit` — exit 0. `npx eslint <the two changed files>` — exit 0. (`pnpm lint` is the repo-wide form.)
- `pnpm test` — 331 passed / 13 failed files, 7728 passed / 233 failed / 1 skipped tests. **The 13 failing files are pre-existing and unrelated**: all are `src/components/workbench/__tests__/*` dying at `window.localStorage.clear()` on Node v26.8.1, whose own `localStorage` global shadows jsdom's. Verified by stashing both of this story's files and re-running at the baseline revision: the same 13 files and 233 tests fail, and the failing set after this change is byte-identical to that baseline. Deferred as its own item.

**Residual risks**
- The spec's acceptance criterion "both projects run green" is not literally satisfiable on this machine because of the Node 26 issue above. It is satisfiable on any Node < 26, and this change adds zero failures either way.
- Three sibling call sites from the same conversion (`IngestSuccess`, `BatchItemRow` via `BatchIngestForm`, `useGlobalSearch`) remain unpinned — outside this story's enumerated intent, deferred with a demonstration that reverting all four at once still leaves the suite green.
- `settleUntil`'s `turns = 10` is a bound, not a proof: a `load` that ever needed more than ten macrotask turns would red this case. Ten is roughly an order of magnitude more than the two the current round trip costs.
