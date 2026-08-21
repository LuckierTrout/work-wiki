---
title: 'DW-382: deleteWiki carries the dataVersion tail'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 2
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `setCurrentWiki` moves no `dataVersion`, so switching the current Wiki
      leaves every OTHER open client rendering the previous Wiki's artifacts
      with nothing to un-stale them.
    evidence: |-
      A Preview and the Files tree both resolve `purpose.md`/`schema.md` through
      `registry.currentId` read server-side at fetch time
      (src/app/api/workbench/preview/route.ts:214-222,
      src/app/page.tsx:98-101 -> src/lib/workbench-files.ts:298-321). A switch is
      therefore the ONLY operation that changes which bytes those surfaces
      resolve to — and `WikiSwitcher`'s own `router.refresh()` covers just the
      acting client. This is a strictly stronger form of the DW-382 argument:
      DW-382's ledger premise ("a Preview open on those artifacts in a second
      client keeps rendering bytes whose Wiki is gone") is false for delete, but
      TRUE for a switch. Raised independently by review layers on all three
      passes of this story. Pre-existing; `setCurrentWiki`'s no-bump exemption is
      a recorded decision (src/lib/__tests__/workbench-data-version.test.ts,
      the bump-site guard's rationale comment), so changing it needs its own
      story rather than a drive-by.
    location: >-
      src/lib/wikis.ts (setCurrentWiki)
    severity: medium
  - summary: >-
      `renameWiki`'s JSDoc quotes the Preview fetch dep list as
      `[selection, dataVersion, editing]`; the real deps include `retryNonce`.
    evidence: |-
      src/lib/wikis.ts:1313 versus src/components/workbench/PreviewColumn.tsx:563
      (`[selection, dataVersion, editing, retryNonce]`). Pre-existing prose
      drift, not introduced here — this story's own new paragraph was held to
      quote-exactly-or-omit and omits the list.
    location: >-
      src/lib/wikis.ts:1313
    severity: low
  - summary: >-
      Several docblocks in `wikis.ts` enumerate the writers that carry the
      `bumpDataVersion` tail, and none of the enumerations is complete.
    evidence: |-
      src/lib/wikis.ts:1310 ("the same tail `createWiki` and
      `applyScenarioTemplate` carry") omits `writeWikiArtifact` and now
      `deleteWiki`; :1250-1251 and :374-375 list the same set incompletely. Each
      was already short before this story and is one entry shorter now that
      `wikis.ts` has five bump sites. The executable guard
      (src/lib/__tests__/workbench-data-version.test.ts) is complete and
      authoritative; these are prose only.
    location: >-
      src/lib/wikis.ts:374,1250,1310
    severity: low
baseline_revision: '597ae32abab6784f6a145756f86b35eb705eba38'
---

<intent-contract>

## Intent

**Problem:** `deleteWiki` (`src/lib/wikis.ts`) removes a Wiki's registry entry *and* its `tenants/<t>/wikis/<id>/` directory — including the `purpose.md` and `schema.md` a Preview may be rendering — then returns with no `bumpDataVersion()` tail, unlike every sibling registry writer (`writeWikiArtifact`, `createWiki`, `applyScenarioTemplate`, `renameWiki`). A delete never touches `currentWikiId` (the current Wiki is refused outright), so the Workbench's selection-reset effect never fires, and the Preview's fetch is keyed on `[selection, dataVersion, editing]` — leaving the counter as the only thing that can tell a second open client its bytes are gone. `WikiSwitcher.tsx` calls `router.refresh()` itself, which covers only the client that performed the delete.

**Approach:** Give `deleteWiki` the same tail the other four writers carry: capture the locked body's result, then `bumpDataVersion()` **outside** the lock, fail-soft, and only when the locked body actually committed a removal. Pin the behaviour with rows in the existing refresh-signal suite in `src/lib/__tests__/wikis.test.ts`.

## Boundaries & Constraints

**Always:**
- The bump is OUTSIDE `withWikiLock` — `bumpDataVersion` takes `DATA_VERSION_LOCK` and `withFileLock` is not reentrant.
- The bump is fail-soft (`try`/`catch` + `logger.warn("wikis", …)`), matching `createWiki`/`applyScenarioTemplate`/`renameWiki` verbatim in shape: a delete whose registry write landed must never be reported as failed because the counter did not move.
- The bump fires ONLY when the locked body returned a `WikiRecord`. An unknown id returns `null` and writes nothing; the current-Wiki refusal throws a `ClientInputError` before any write.
- It bumps even when `deleteDirectory` or the inline `sweepOrphans` failed: the registry entry is gone, so the Wiki has genuinely disappeared from every read in the app — the same reasoning that makes `renameWiki` bump after a failed `retitlePurpose`.
- Preserve `deleteWiki`'s existing contract exactly: return value, `ClientInputError` on the current Wiki, `null` on an unknown id, `assertWritable` before the lock, both fail-soft byte-removal steps, ordering (registry, then directory).

**Block If:**
- The existing `wikis` suite fails on `main`-equivalent code before any edit (a pre-existing break would make verification meaningless).

**Never:**
- Do not move any other writer's tail, add a tail to `sweepOrphanWikiDirectories`, or change `sweepOrphans`.
- Do not re-point `currentId` or relax the current-Wiki refusal.
- Do not add a bump inside the locked body, and do not make the delete throw on a bump failure.
- Do not touch `DELETE /api/wikis/[id]` or `WikiSwitcher.tsx` — the client-side `router.refresh()` stays as it is; this change is what covers the *other* clients.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Delete a non-current Wiki | Two Wikis, `currentId` on the other one | Entry and directory removed; `dataVersion` is exactly `before + 1` | No error expected |
| Unknown / traversal-shaped id | Registry has no such id | Returns `null`; `dataVersion` unchanged | No error expected |
| Delete the current Wiki | `registry.currentId === wikiId` | Throws `ClientInputError`; nothing removed; `dataVersion` unchanged | Caller (route) answers 400 |
| Directory removal fails | `deleteDirectory` rejects | Delete still resolves with the record; `dataVersion` is `before + 1` (the entry is gone) | `logger.warn` from the existing handler; bytes left for the sweep |
| Counter store rejects `putIndex` | `putIndex` rejects | Delete still resolves; entry and directory gone; `dataVersion` unchanged | `data-version`'s own warn (`bump failed; the signal did not move`) |

</intent-contract>

## Code Map

- `src/lib/wikis.ts:1686-1731` (`deleteWiki`) -- the edit site. Today `return withWikiLock(owner, async () => { … })` with no tail. Needs the result captured (`const deleted = await withWikiLock(…)`), an early `if (!deleted) return null;`, then the fail-soft bump, then `return deleted;`. Its JSDoc (`:1657-1685`) gains a paragraph naming DW-382 and DW-209's rule, in the register of the surrounding docs — but see **Design Notes** for the mechanism it must and must not claim.
- `src/lib/wikis.ts:1327-1363` (`renameWiki`) -- the closest template: null-guard comment (`// Unknown id: nothing was written, so there is nothing to refresh to.`), `try { await bumpDataVersion(); } catch (error) { logger.warn("wikis", \`the refresh signal did not move after renaming wiki "${renamed.id}"\`, error); }`. Copy this shape; swap the verb.
- `src/lib/wikis.ts:1298-1326` -- `renameWiki`'s JSDoc, the prose model for the new paragraph (why outside the lock, why fail-soft, why only on the committed path).
- `src/lib/wikis.ts:1047-1103` (`createWiki`) and `:1134-1200` (`applyScenarioTemplate`) -- two of the four existing tails; `:852-1015` (`writeWikiArtifact`) bumps at `:1002` and is the one the module's other docblocks cite as the shape's origin (`:1039`). The new paragraph must name all four siblings, not three.
- `src/lib/wikis.ts:466` -- reads "Both are FAIL-SOFT in the same shape as `deleteWiki`'s tail", where "tail" means the swallowed `deleteDirectory`/`sweepOrphans` handlers. After this change "`deleteWiki`'s tail" also names the bump. Disambiguate this one line (e.g. "`deleteWiki`'s byte-removal handlers") so the cross-reference keeps pointing at the construct it means.
- `src/lib/wikis.ts:1520-1524` (`sweepOrphans`) -- its first storage call is `getStorage().listFiles(wikisRootPath(owner))`. Rejecting THAT is how a test makes the sweep fail without also failing the deleted Wiki's own `deleteDirectory`; a blanket `deleteDirectory` mock conflates the two failure modes.
- `src/lib/wikis.ts:61` -- `bumpDataVersion` is already imported; `logger` is already in scope. No new imports.
- `src/lib/data-version.ts:130-145` -- `bumpDataVersion` swallows its own failures and answers `0` rather than throwing, so the caller's `catch` is redundant defence kept for uniformity (see the note at `src/lib/__tests__/wikis.test.ts:505-521`). READ-ONLY.
- **`src/lib/__tests__/workbench-data-version.test.ts:1030-1134`** -- **the module-wide guard this change MUST update, and the reason the first attempt shipped a red suite.** `it("has exactly four sites inside wikis.ts, each outside the tenant lock")` hard-pins the count at `:1074-1075` (both the `bumpDataVersion\s*\(` and the `await bumpDataVersion\(\);` forms) and walks a four-name list at `:1093-1099` (`writeWikiArtifact`, `createWiki`, `applyScenarioTemplate`, `renameWiki`) asserting each bump falls AFTER its `withWikiLock` close. Its rationale comment at `:1035-1055` currently places `deleteWiki` in the deliberately-absent list, on the premise that it removes bytes "only for a Wiki that is by then unreachable … so no Preview can be open on what they take" — the exact premise DW-382 overturns.
- **`src/components/workbench/DataVersionWatcher.tsx:14-30`** -- the recorded statement of the DW-209 rule. Says the switcher keeps its own `router.refresh()` because "switching the current Wiki, deleting one — are not kernel page writes and move no `dataVersion` at all" (`:17-20`) and "The switcher's own refresh stays because switch and delete still move nothing" (`:27-28`). Both become false for delete. Not covered by the intent contract's **Never** list, which names only `WikiSwitcher.tsx` and the route.
- `src/lib/__tests__/wikis.test.ts:345-632` -- `describe("create, re-template and rename move the refresh signal (DW-49, DW-57, DW-209)")`. New rows go here; extend the describe title to name delete and DW-382. Module-level helpers usable from here: `readDataVersion`, `DATA_VERSION_KEY`, `wikiDir` (`:901`), `exists` (`:905`), `ageDirectory` (`:923`), `abs` (`:53`), `setCurrentWiki`, `getStorage`, `logger`, `BUMP_FAILED_WARN` (`:522`). NOTE: `plantOrphan` (`:1153`) is scoped to `describe("the orphan-directory sweep")` and is NOT reachable from here — plant inline (`fs.mkdir(wikiDir(id), { recursive: true })` + a `purpose.md`) and then `ageDirectory`.
- `src/lib/__tests__/wikis.test.ts:1059-1150` -- `describe("deleting a wiki")`, the existing behavioural coverage (removal, current-Wiki refusal, unknown id, `deleteDirectory` failure). READ-ONLY reference: do not duplicate those assertions, only the counter ones.
- `src/app/page.tsx:98-101` and `:112` -- READ-ONLY, and the evidence behind the corrected mechanism: the Files tree comes from `listWorkbenchFilePaths(handle, registry.currentId, …)`, so it is scoped to the CURRENT Wiki and is unaffected by deleting another; `registry.wikis` at `:112` is the Wiki list that genuinely does go stale in a second client.
- `src/lib/workbench-files.ts:298-321` -- READ-ONLY. Pushes the bare names `purpose.md`/`schema.md` for the one Wiki id it is handed; the tree never names a Wiki, which is why a non-current Wiki's deletion changes nothing in it.
- `src/lib/__tests__/workbench-data-version.test.ts:1050-1055` -- the sentence "their CALLERS carry the tail instead; that is the whole reason the FOUR above are callers" refers specifically to `putWikiArtifact`/`seedWikiArtifacts`/`retitlePurpose` delegating upward. `deleteWiki` calls none of them, so this numeral must STAY four; the previous attempt bumped it to five mechanically and turned a true sentence false.
- `src/app/api/workbench/preview/route.ts:211-224` -- READ-ONLY, and the evidence behind the Design Notes mechanism correction: a Preview artifact fetch resolves `purpose.md`/`schema.md` through `registry.currentId` read server-side at fetch time, never through an arbitrary Wiki id.
- `src/components/workbench/PreviewColumn.tsx:563` -- READ-ONLY. The fetch effect's real dep list is `[selection, dataVersion, editing, retryNonce]`. Quote it correctly or do not enumerate it.
- `src/app/api/wikis/[id]/route.ts:58-79` -- `DELETE` handler. READ-ONLY: it just forwards to `deleteWiki`; nothing changes here.
- `src/components/workbench/WikiSwitcher.tsx:288-326` -- the acting client's own `router.refresh()`. READ-ONLY evidence that only the deleting client is covered today.

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- in `deleteWiki`, capture the `withWikiLock` result into a local, return `null` early when it is null, then run `bumpDataVersion()` in a fail-soft `try`/`catch` that warns `` `the refresh signal did not move after deleting wiki "${deleted.id}"` `` under the `"wikis"` scope, and return the record -- gives the delete the tail its four siblings carry, so a second open client stops rendering a workspace whose Wiki is gone.
- `src/lib/wikis.ts` -- extend `deleteWiki`'s JSDoc with a paragraph on the tail: that it bumps (DW-382) under the rule DW-209 established, naming all FOUR siblings (`writeWikiArtifact`, `createWiki`, `applyScenarioTemplate`, `renameWiki`); why the tail sits outside the lock; why it is fail-soft; why it fires only on the committed path; and why a failed `deleteDirectory`/`sweepOrphans` still bumps. State the staleness mechanism EXACTLY as **Design Notes** specifies -- the stale surface is the second client's Wiki list, not its Files tree and not a Preview fetch -- and do not enumerate the Preview dep list unless it is quoted exactly.
- `src/lib/wikis.ts` -- at `:466`, disambiguate "in the same shape as `deleteWiki`'s tail" so it still names the byte-removal handlers rather than the newly-added bump -- one word in one line; the module now has two constructs answering to "`deleteWiki`'s tail".
- `src/lib/__tests__/workbench-data-version.test.ts` -- update the bump-site guard: both length assertions at `:1074-1075` become `5`, `"deleteWiki"` joins the name list at `:1093-1099` so its bump is pinned OUTSIDE `withWikiLock` like the other four, the `it(...)` title stops saying "four", and the rationale comment at `:1035-1055` moves `deleteWiki` out of the deliberately-absent list into the bumping list with its DW-382 reason (stated per **Design Notes**), leaving `sweepOrphanWikiDirectories` (whose directories are unreferenced) and `setCurrentWiki` behind on reasons that still hold for them alone. TWO NUMERALS THAT MUST NOT MOVE MECHANICALLY: the lead-in that currently opens "Four, since DW-209" needs rewording so it does not read as a second count contradicting the title (e.g. "Four from DW-49 and DW-209"), and "that is the whole reason the four above are callers" must STAY four -- it names the writers that delegate upward out of the lock, which `deleteWiki` does not do -- without this the delivered change leaves the repository's own suite red, and the "outside the lock" property the new JSDoc advertises is the one property nothing pins.
- `src/components/workbench/DataVersionWatcher.tsx` -- update the header comment so delete joins create, re-template and rename as an operation that bumps and reaches this watcher, and so the sentence explaining why `WikiSwitcher` keeps its own `router.refresh()` rests only on the operation that still moves nothing (the switch). Note the consequence the comment already accepts for create and rename: the deleting client now refreshes twice, which stays cheaper than the switcher guessing which of its operations bumped. **Delete is the odd one of the four and the comment must say so rather than flattening it**: create, re-template and rename bump because they WRITE bytes a Preview renders; delete bumps because it removes a Wiki from the list every other client is still offering. Do not write "all four move bytes a Preview renders", and do not state artifact removal as a guarantee -- the file is the recorded statement of the DW-209 rule and would otherwise contradict both the code and `deleteWiki`'s own JSDoc.
- `src/lib/__tests__/wikis.test.ts` -- rename the refresh-signal describe to cover delete and DW-382, and add rows there: (a) bumps exactly ONCE per delete even when the same call also reclaims two aged inline-planted orphan directories, so "once, not once per removed directory" is actually exercised and the bump is shown earned (the target's directory is gone); (b) does not bump for an unknown id; (c) does not bump when the current-Wiki refusal throws -- assert the counter only, since the registry and directory are already pinned in `describe("deleting a wiki")`; (d) bumps when the Wiki's own `deleteDirectory` rejects, with the bytes shown still on disk; (e) bumps when the inline `sweepOrphans` fails -- reject `listFiles` so the sweep fails while the Wiki's own directory removal succeeds, rather than a blanket `deleteDirectory` mock that conflates both; (f) still resolves the delete with the counter unmoved and `data-version`'s own warn logged when `putIndex` rejects. Rows (d) and (e) must each assert something that is ONLY true on their failure path and must capture and assert the `"wikis"`-scoped `logger.warn` their handler emits, per **Design Notes** -- as written the first time, row (e) would have passed identically with the sweep succeeding. Row (b) covers a traversal-shaped id alongside the well-formed one, since the I/O matrix names both. Every row starts from a non-zero counter, and no row's comment may claim the setup `setCurrentWiki` is the invariant -- the claim is that the DELETE moves no pointer.
- `src/lib/__tests__/wikis.test.ts` -- hoist `plantOrphan` (currently at `:1153`, scoped to `describe("the orphan-directory sweep")`) up to module scope beside `wikiDir`, `exists` and `ageDirectory`, and use it from both describes -- the previous attempt re-implemented the fixture inline because it was out of scope, leaving the file with two orphan fixtures that can drift.

**Acceptance Criteria:**
- Given a workspace with two Wikis, `currentId` on the one being kept, and two aged orphan directories planted under `wikis/`, when `deleteWiki` removes the other Wiki, then `readDataVersion()` returns exactly the pre-delete value plus one, the deleted Wiki's directory no longer exists, and both orphan directories are gone.
- Given a workspace with at least one Wiki, when `deleteWiki` is called with an id no registry entry names, then it returns `null` and `readDataVersion()` is unchanged.
- Given a workspace where the target id is the current Wiki, when `deleteWiki` is called, then it rejects with `ClientInputError` and `readDataVersion()` is unchanged.
- Given `getStorage().deleteDirectory` rejects, when a non-current Wiki is deleted, then the call still resolves with the record, the registry entry is gone, and `readDataVersion()` is the pre-delete value plus one.
- Given `getStorage().listFiles` rejects so the inline `sweepOrphans` throws and an aged orphan directory was planted beforehand, when a non-current Wiki is deleted, then the call still resolves with the record, `readDataVersion()` is the pre-delete value plus one, the orphan is STILL on disk (proving the sweep really failed), and the `"wikis"`-scoped sweep-failure warning was logged.
- Given `getStorage().deleteDirectory` rejects, when a non-current Wiki is deleted, then the `"wikis"`-scoped directory-removal warning was logged.
- Given a traversal-shaped id such as `../../etc/passwd`, when `deleteWiki` is called, then it returns `null` and `readDataVersion()` is unchanged.
- Given `getStorage().putIndex` rejects, when a non-current Wiki is deleted, then the call still resolves with the record, the entry and the directory are both gone, `readDataVersion()` is unchanged, and a `data-version`-scoped warning containing `bump failed; the signal did not move` was logged.
- Given the whole repository suite, when it is run, then `src/lib/__tests__/workbench-data-version.test.ts` passes with its bump-site guard counting five sites in `wikis.ts` and pinning `deleteWiki`'s bump outside `withWikiLock`.

## Spec Change Log

### 2026-08-21 — Review pass 1 (bad_spec loopback)

**Triggering findings.** Three review layers independently found that the first implementation left the repository's own suite red: `src/lib/__tests__/workbench-data-version.test.ts:1030` (`"has exactly four sites inside wikis.ts, each outside the tenant lock"`) hard-pins the `bumpDataVersion` call-site count in `wikis.ts` at four, and the new tail makes it five. Verified by running it: `AssertionError: expected [...] to have a length of 4 but got 5`. The same guard's rationale comment names `deleteWiki` in its deliberately-absent list on the exact premise DW-382 overturns, and `src/components/workbench/DataVersionWatcher.tsx:17-30` — the recorded statement of the DW-209 rule — says in two places that delete moves no `dataVersion`. Separately, two layers showed the new JSDoc's causal story is not how the Preview resolves artifacts (`src/app/api/workbench/preview/route.ts:214-222` resolves them through `currentId` alone), that the Preview dep list was quoted with one dep missing, that the sibling list omitted `writeWikiArtifact`, that the prose claim "bumps even when `sweepOrphans` failed" had no test, and that "once, not once per removed file" was not distinguishable in a fixture with a single directory.

**What was amended.** Only sections outside `<intent-contract>`. The Code Map gained `workbench-data-version.test.ts`, `DataVersionWatcher.tsx`, `wikis.ts:466`, `sweepOrphans`' `listFiles` seam, `preview/route.ts` and `PreviewColumn.tsx:563`, plus a note that `plantOrphan` is not in scope for the refresh-signal describe. Tasks gained the guard update, the watcher-comment update and the `:466` disambiguation, and the test task was rewritten row by row. Acceptance gained the sweep-failure row, the orphan-reclaim arithmetic and a whole-suite criterion. Design Notes gained the mechanism correction. Verification now runs the guard file and the full suite.

**Known-bad state avoided.** A change that ships green on the two files its own spec named while leaving a third test file failing, and that writes a new statement of the DW-209 rule into one docblock while two other recorded statements of the same rule keep asserting the opposite.

**KEEP — must survive re-derivation.** (1) The tail itself, byte-identical to `renameWiki`'s: `const deleted = await withWikiLock(...)`, the `// Unknown id: nothing was written, so there is nothing to refresh to.` comment, `if (!deleted) return null;`, the fail-soft `try`/`catch` with the `"wikis"`-scoped warn, `return deleted;`. The locked body must stay byte-for-byte unchanged. (2) All five original test rows' intent — they were sound; only the fixture details and two comments were wrong. (3) The `putIndex` row asserting on `data-version`'s own `BUMP_FAILED_WARN` rather than the caller's unreachable sentence. (4) Every row starting from a verified non-zero counter. (5) The docblock's structure — bump paragraph, outside-the-lock/fail-soft/committed-path paragraph, bumps-anyway paragraph — in the register of `renameWiki`'s JSDoc.

### 2026-08-21 — Review pass 2 (bad_spec loopback)

**Triggering findings.** Two review layers independently showed that the corrected mechanism this spec introduced in pass 1 is itself half wrong, and that the implementation wrote the wrong half into all four files it touched. Verified in the repo: `src/app/page.tsx:98-101` builds the Files tree with `listWorkbenchFilePaths(handle, registry.currentId, …)` and `src/lib/workbench-files.ts:298-321` pushes only the bare names `purpose.md`/`schema.md` for that one current Wiki — so a second client's Files tree is byte-identical after a non-current Wiki is deleted, and naming it as a stale surface is false. The reliably stale surface is `registry.wikis` (`page.tsx:112`), the Wiki list `WikiSwitcher` renders. `DataVersionWatcher.tsx` additionally flattened delete into "All four move bytes a Preview renders" — the exact claim the pass-1 correction exists to rule out — and stated artifact removal as a guarantee, which a row in the same change disproves. Separately: the guard comment's "that is the whole reason the FOUR above are callers" was bumped to five mechanically, turning a true sentence false (`deleteWiki` delegates to none of the lock-internal writers that sentence names); the sweep-failure row asserted only things that hold when the sweep SUCCEEDS, so it would silently become a duplicate of the happy-path row; neither failure-path row captured the `logger.warn` its handler's whole contract is about; the traversal-shaped id in the I/O matrix had no counter row; and `plantOrphan` was re-implemented inline rather than hoisted.

**What was amended.** Only sections outside `<intent-contract>`. Design Notes replaced the mechanism paragraph with the Wiki-list-only statement plus the two forbidden wordings, added the "prove the sweep failed" requirement and the warn-capture requirement. The Code Map gained `page.tsx`, `workbench-files.ts` and the do-not-move-this-numeral anchor. Tasks gained the delete-is-the-odd-one instruction for the watcher comment, the two frozen numerals in the guard comment, the assert-the-failure-path and capture-the-warn requirements, the traversal id, and the `plantOrphan` hoist. Acceptance gained three criteria.

**Known-bad state avoided.** A change that corrects a causal story in one file and then restates a fresh, differently-wrong version of it in four; and two failure-path tests that pass whether or not the failure they name occurs.

**KEEP — must survive re-derivation.** Everything KEPT from pass 1 still holds, plus, from the pass-2 implementation, which was green on the full suite (273 files / 6156 tests) and correct apart from the prose and the two weak rows: (1) the tail in `deleteWiki`, unchanged and byte-identical to `renameWiki`'s, with the locked body untouched. (2) The `workbench-data-version.test.ts` guard update — counts 4→5 in both length assertions, `"deleteWiki"` appended to the ordering walk, the title saying five, the closing "five DISJOINT bodies" — everything except the two numerals named above. (3) The `wikis.ts:466` disambiguation to "`deleteWiki`'s byte-removal handlers". (4) The `BUMP_FAILED_WARN` docblock refresh from "three call sites" to five. (5) The six-row test structure and every row's fixture EXCEPT rows (d) and (e)'s assertions: keep the two aged orphans in the once-per-delete row, the `listFiles` seam for the sweep row, the counter-only assertion in the current-Wiki row, and the non-zero-counter discipline throughout. (6) `WikiSwitcher.tsx` and `src/app/api/wikis/[id]/route.ts` untouched.

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 11: (high 1, medium 4, low 6)
- patch: 0
- defer: 2: (high 0, medium 1, low 1)
- reject: 8: (high 0, medium 2, low 6)
- addressed_findings:
  - `[high]` `[bad_spec]` `workbench-data-version.test.ts:1030` pins exactly four `bumpDataVersion` sites in `wikis.ts`; the tail makes five and the suite goes red. Spec amended to name the guard in the Code Map, add the update as a task (count, name list, title, rationale comment) and run that file in Verification.
  - `[medium]` `[bad_spec]` That guard's rationale comment (`:1044-1055`) lists `deleteWiki` as deliberately absent on the premise DW-382 overturns. Amendment requires moving it into the bumping list and re-justifying the sweep's and `setCurrentWiki`'s exemptions on their own terms.
  - `[medium]` `[bad_spec]` `DataVersionWatcher.tsx:17-30` states twice that delete moves no `dataVersion`. Added to the Code Map and given its own task; the intent contract's **Never** list never covered this file.
  - `[medium]` `[bad_spec]` The new JSDoc asserts a second client is rendering the deleted Wiki's `purpose.md`/`schema.md`, but `preview/route.ts:214-222` resolves those through `currentId` alone. Design Notes now specify what the paragraph may claim.
  - `[medium]` `[bad_spec]` "Bumps even when `sweepOrphans` failed" was asserted in prose with no test, and the `deleteDirectory` mock conflated both failure modes. Added a row rejecting `listFiles`, plus an acceptance criterion.
  - `[low]` `[bad_spec]` "Once, not once per removed file" was indistinguishable with one directory. Row now plants two aged orphans inline and still expects `before + 1`.
  - `[low]` `[bad_spec]` Preview dep list quoted as `[selection, dataVersion, editing]`; the real deps at `PreviewColumn.tsx:563` include `retryNonce`. Quote-exactly-or-omit rule added.
  - `[low]` `[bad_spec]` Sibling list in the new paragraph omitted `writeWikiArtifact`, the tail's origin. Task now says all four.
  - `[low]` `[bad_spec]` `wikis.ts:466` cross-references "`deleteWiki`'s tail" meaning the byte-removal handlers; the word now has two referents. Disambiguation added as a task.
  - `[low]` `[bad_spec]` A row's comment claimed the setup `setCurrentWiki` is why no `currentWikiId` moves, immediately before calling it. Task forbids that phrasing.
  - `[low]` `[bad_spec]` The current-Wiki row re-asserted registry and directory state already pinned in `describe("deleting a wiki")`, against the Code Map's own instruction. Task now says counter-only.

### 2026-08-21 — Review pass 2
- intent_gap: 0
- bad_spec: 8: (high 0, medium 3, low 5)
- patch: 0
- defer: 3: (high 0, medium 1, low 2)
- reject: 9: (high 0, medium 2, low 7)
- addressed_findings:
  - `[medium]` `[bad_spec]` The new prose names a second client's **Files tree** as a stale surface in all four changed files; `page.tsx:98-101` + `workbench-files.ts:298-321` show it is built from `currentId` alone and is unaffected. Design Notes rewritten to the Wiki list only, with the evidence, and the Code Map gained both files.
  - `[medium]` `[bad_spec]` `DataVersionWatcher.tsx` wrote "All four move bytes a Preview renders" and stated artifact removal as a guarantee. Task now requires delete to be described as the odd one of the four and names both forbidden wordings.
  - `[medium]` `[bad_spec]` The sweep-failure row asserted only outcomes that also hold when the sweep succeeds. Task and acceptance now require an aged orphan planted beforehand and asserted still present.
  - `[low]` `[bad_spec]` "that is the whole reason the four above are callers" was bumped to five mechanically, making a true sentence false. Code Map pins the numeral; task names it.
  - `[low]` `[bad_spec]` The "Four, since DW-209" lead-in now reads as a rival count under an `it()` titled "five". Task requires rewording.
  - `[low]` `[bad_spec]` Neither failure-path row captured the `logger.warn` its handler exists to emit, unlike every sibling row, leaving real warnings in stderr. Design Notes and task now require capture-and-assert.
  - `[low]` `[bad_spec]` The I/O matrix names a traversal-shaped id; no counter row covered one. Task and acceptance now do.
  - `[low]` `[bad_spec]` `plantOrphan` was re-implemented inline rather than hoisted, leaving two orphan fixtures. Task now says hoist it to module scope.
- deferred_this_pass (carried, not yet written to frontmatter — moot under the bad_spec branch, to be recorded on a pass that reaches defer processing):
  - `[medium]` `setCurrentWiki` moves no `dataVersion`, so a switch leaves every OTHER open client rendering the previous Wiki's artifacts with nothing to un-stale them — a strictly stronger form of the DW-382 argument. Pre-existing; raised in both passes.
  - `[low]` `renameWiki`'s JSDoc (`src/lib/wikis.ts:1313`) quotes the Preview dep list as `[selection, dataVersion, editing]`; the real deps include `retryNonce`. Pre-existing.
  - `[low]` Sibling-enumeration drift: `src/lib/wikis.ts:1310`, `:1250-1251` and `:374-375` each list the bumping writers and none is complete. Pre-existing, made staler by the fifth site.

### 2026-08-21 — Review pass 3
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 3: (high 0, medium 1, low 2)
- reject: 11: (high 0, medium 2, low 9)
- addressed_findings:
  - `[low]` `[patch]` `DataVersionWatcher.tsx` said "the list this switcher renders" — but this file is the watcher, not the switcher; the sentence had been transplanted from `deleteWiki`'s JSDoc. Now names `WikiSwitcher` explicitly. Found by three layers independently.
  - `[low]` `[patch]` The `BUMP_FAILED_WARN` docblock in `wikis.test.ts` had its call-site numeral refreshed to five but the sentence above it still enumerated only `createWiki` and `applyScenarioTemplate`. Now names all four wrappers.
  - `[low]` `[patch]` The reworded guard lead-in ("Four from DW-49 and DW-209") folded `writeWikiArtifact`'s DW-57 credit under two other ticket numbers, disagreeing with the sibling describe title. Now credits DW-57.

Notable rejections this pass, with reasons: no client- or route-level test of the refreshed Wiki list (the intent says "pin it in the wikis suite", and no sibling writer has route-level counter coverage); no read-only "does not bump" row (already covered — `read-only-kernel-gate.test.ts:416`'s whole-tree `snapshot()` walks `.indexes/data-version.json`, so a bump escaping the gate fails it); no row driving BOTH fail-soft handlers at once (the claim is a disjunction and each disjunct has a row; the handlers are independent); `WikiSwitcher` delete-dialog churn from the new cross-client refresh (already guarded at `WikiSwitcher.tsx:354` and `:591`, and create/rename bumps already produced that refresh); retry/timeout guards around `bumpDataVersion` (deviate from the uniform sibling tail the intent requires); the un-closed ledger entry (orchestrator-owned; this run is forbidden to edit it).

## Design Notes

The tail is a verbatim transplant of `renameWiki`'s, which is itself the shape `createWiki`, `applyScenarioTemplate` and `writeWikiArtifact` all use. The only structural work is that `deleteWiki` currently `return`s the `withWikiLock` call directly:

```ts
  const deleted = await withWikiLock(owner, async () => { /* unchanged body */ });

  // Unknown id: nothing was written, so there is nothing to refresh to.
  if (!deleted) return null;
  try {
    await bumpDataVersion();
  } catch (error) {
    logger.warn(
      "wikis",
      `the refresh signal did not move after deleting wiki "${deleted.id}"`,
      error,
    );
  }
  return deleted;
```

The current-Wiki `ClientInputError` throws from inside the locked body and propagates past the tail, so no extra guard is needed for it.

**The mechanism, stated accurately — and this is the paragraph the last two review passes kept catching.** A Preview artifact fetch resolves `purpose.md`/`schema.md` through `registry.currentId` read server-side at fetch time (`src/app/api/workbench/preview/route.ts:214-222`), and the current Wiki is undeletable — so no second client can ever FETCH the deleted Wiki's artifacts. **Nor is its Files tree affected**: `src/app/page.tsx:98-101` builds the listing with `listWorkbenchFilePaths(handle, registry.currentId, …)`, and `src/lib/workbench-files.ts:298-321` pushes the bare names `purpose.md`/`schema.md` for that ONE current Wiki — the tree never names a Wiki id, so deleting a non-current Wiki leaves every other client's tree byte-identical. Do not claim the Files tree goes stale; the previous attempt did, in all four places it wrote the mechanism, and it is wrong.

What DOES reliably go stale in a second client is **the Wiki list**: `src/app/page.tsx:112` hands `registry.wikis` to `WorkbenchDataProvider`, and `WikiSwitcher` renders it as the switch/rename/delete pickers and gates its controls on `wikis.length > 1`. A second client therefore keeps offering a Wiki that no longer exists — and acting on it 404s — until something re-renders the server component. A delete moves no `currentWikiId`, so no selection-reset effect fires; the counter is the only thing that can. That, and only that, is the harm the tail repairs. (A client that is also showing artifact bytes from back when the deleted Wiki was current was ALREADY stale before the delete — that window is opened by `setCurrentWiki`, which by recorded decision does not bump — so the delete's bump repairs it incidentally and must not be credited with it.)

**Write that mechanism identically in every place this change states it** — `deleteWiki`'s JSDoc, `DataVersionWatcher.tsx`, the `workbench-data-version.test.ts` rationale comment, and the `wikis.test.ts` row comment. Two further wordings to avoid, both from the previous attempt's `DataVersionWatcher.tsx`: "All four move bytes a Preview renders" (a delete moves no bytes any Preview renders — that is the whole point of the paragraph above), and "delete removes a Wiki's entry AND its artifacts" stated as a guarantee (`deleteDirectory` is fail-soft, and a row in this very change pins that the bump is earned by the registry entry alone when the bytes survive).

Why the `catch` even though `bumpDataVersion` never throws: the test file's own note (`:505-521`) records that the wrappers at the other call sites are deliberate redundant defence, kept so the tail reads identically everywhere and stays correct if `bumpDataVersion` ever stops swallowing. The new rows therefore assert on `data-version`'s warn, not on the `"wikis"` sentence — asserting on the latter would pin nothing either way.

**Making the sweep fail without failing the delete — and PROVING it failed.** `sweepOrphans`' first storage call is `getStorage().listFiles(wikisRootPath(owner))` (`src/lib/wikis.ts:1522`). Rejecting `listFiles` makes the sweep throw into `deleteWiki`'s second fail-soft handler while the Wiki's own `deleteDirectory` still succeeds, which is what separates the two failure modes a single `deleteDirectory` mock conflates. Restore the spy before asserting.

The row must then assert something that is ONLY true when the sweep failed. The previous attempt asserted the counter, the target's directory and the registry list — all three hold identically when the sweep succeeds, so the row would have silently become a duplicate of the happy-path row the day the `listFiles` seam moved. Plant an aged orphan before the delete and assert it is STILL THERE afterwards, the mirror of what the `deleteDirectory` row does with `exists(...) === true`.

**Both failure-path rows capture `logger.warn`.** Every other failure-path row in this file mocks `logger.warn` and inspects `warn.mock.calls`; these two drive handlers whose entire contract is "warn and swallow" and asserted nothing about the warn, so they passed identically against a handler that swallowed silently — and left real warnings in the suite's stderr. Capture the calls before restoring (`mockRestore` clears them) and assert on the `"wikis"`-scoped sentence each handler actually emits.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/wikis.test.ts` -- expected: all rows pass, including the new delete refresh-signal rows.
- `npx vitest run src/lib/__tests__/workbench-data-version.test.ts` -- expected: all pass, with the bump-site guard now counting five sites and pinning `deleteWiki`'s bump outside the lock. **Run this before declaring done — the first attempt shipped with it red.**
- `npx vitest run src/lib/__tests__/wikis-routes.test.ts` -- expected: unchanged, all pass (the route contract did not move).
- `npx vitest run` -- expected: the full suite is green; no other file asserts on the number or identity of `wikis.ts` bump sites, on delete not bumping, or on `DataVersionWatcher`'s comment text.
- `npx eslint src/lib/wikis.ts src/lib/__tests__/wikis.test.ts src/lib/__tests__/workbench-data-version.test.ts src/components/workbench/DataVersionWatcher.tsx` -- expected: clean.
- `npx tsc --noEmit` -- expected: clean.

Note: `pnpm vitest` / `pnpm exec` fail in this environment with `ERROR packages field missing or empty`, unrelated to this change; use `npx`.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `deleteWiki` now carries the `bumpDataVersion()` tail its four sibling registry writers already had (DW-382), under the rule DW-209 established. The locked body is byte-for-byte unchanged; the tail sits outside `wikis:<tenant>` (because `bumpDataVersion` takes `DATA_VERSION_LOCK` and `withFileLock` is not reentrant), is fail-soft, and fires only when the locked body returned a record — an unknown id writes nothing, and the current-Wiki refusal throws before the registry write.

**A correction the ledger entry should carry.** DW-382's stated premise is false, and two review passes were spent discovering it: a second client can never have a Preview open on the deleted Wiki's artifacts, because a Preview resolves `purpose.md`/`schema.md` through `registry.currentId` read server-side at fetch time (`src/app/api/workbench/preview/route.ts:214-222`) and the current Wiki is undeletable. The Files tree resolves the same way (`src/app/page.tsx:98-101` -> `src/lib/workbench-files.ts:298-321`). What genuinely goes stale in a second open client is **the Wiki list** — `page.tsx:112` hands `registry.wikis` down and `WikiSwitcher` renders it as the switch/rename/delete pickers and gates its controls on `wikis.length > 1` — so that client keeps offering a Wiki that is gone, and acting on it 404s. The bump is still the right fix; the reason recorded in the ledger is not the reason it works. The ledger was not edited (this run is forbidden to). The staleness DW-382's premise actually describes belongs to `setCurrentWiki` and is filed in `deferred` above.

**Files changed.**
- `src/lib/wikis.ts` — the tail in `deleteWiki`; its JSDoc gained three paragraphs (the bump and the corrected mechanism, outside-the-lock/fail-soft/committed-path, bumps-anyway); `:466`'s cross-reference disambiguated from "`deleteWiki`'s tail" to "`deleteWiki`'s byte-removal handlers", which the new bump would otherwise have made ambiguous.
- `src/lib/__tests__/wikis.test.ts` — `plantOrphan` hoisted to module scope (one fixture, two describes); six rows added to the refresh-signal suite, whose title and docblock now cover delete and DW-382.
- `src/lib/__tests__/workbench-data-version.test.ts` — the module-wide bump-site guard: counts 4 -> 5 in both forms, `"deleteWiki"` added to the ordering walk so its bump is pinned OUTSIDE the tenant lock, title and closing comment updated, rationale comment rewritten to move `deleteWiki` into the bumping list while leaving `sweepOrphanWikiDirectories` and `setCurrentWiki` on reasons that hold for them alone.
- `src/components/workbench/DataVersionWatcher.tsx` — the recorded statement of the DW-209 rule, which asserted twice that delete moves no `dataVersion`; delete now has its own paragraph as the odd one of the four.

**Review findings breakdown.** Three passes. Pass 1: 11 bad_spec (1 high), 2 deferred, 8 rejected — the high finding was that the change shipped a red suite, because `workbench-data-version.test.ts` hard-pinned four bump sites and the spec had never named it. Pass 2: 8 bad_spec (3 medium), 3 deferred, 9 rejected — the corrected mechanism was itself half wrong (the Files tree does not go stale) and had been written into all four files. Pass 3: 3 patches applied (all low), 3 deferred (recorded in frontmatter), 11 rejected; the verification-gap layer reported no gaps. Two `bad_spec` loopbacks, both reverting the code and re-deriving from an amended spec; `review_loop_iteration` ended at 2 of 5.

**Follow-up review recommendation.** Counting only this pass's `patch` findings: 0 high, 0 medium, 3 low. Score = 3x0 + 1x3 = 3, which is below 5, and no patched finding was high — so `followup_review_recommended: false`.

**Verification performed.**
- `npx vitest run` (full suite) — 273 files / 6156 tests passed.
- `npx vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/workbench-data-version.test.ts src/lib/__tests__/wikis-routes.test.ts` — 163 passed (wikis 85, up from 79; guard 58; routes 20 unchanged).
- `npx tsc --noEmit` — clean. `npx eslint` on all four changed files — clean.
- Matrix test audit: every row of the I/O & Edge-Case Matrix is covered by a row that ran and passed — delete-non-current, unknown/traversal id, current-Wiki refusal, `deleteDirectory` rejects, `putIndex` rejects.
- Mutation check performed by the implementation agent: with the tail removed, 4 of the 6 new rows fail and the two "does not bump" rows correctly still pass.
- Note: `pnpm vitest` / `pnpm exec` fail in this environment with `ERROR packages field missing or empty`, which reproduces on an unmodified checkout and is unrelated to this change; `npx` was used throughout.

**Residual risks.**
- The chain from "the counter moved" to "a second client's Wiki list is refreshed" is asserted only in prose. That is what the intent asked for ("pin it in the wikis suite") and matches every sibling writer, none of which has route- or component-level counter coverage — but it does mean no test joins the two ends.
- The three deferred items above are real and untouched; the `setCurrentWiki` one is the strongest, since it is the staleness DW-382's own premise described.
- The deferred-work ledger still shows DW-382 `status: open` — deliberately, as the orchestrator records resolution.
