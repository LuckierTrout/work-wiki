---
title: 'Workbench URL param ownership: one scope reader, and the Settings category in the URL'
type: 'refactor'
created: '2026-09-04'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized, multiple-goals]
deferred: []
baseline_revision: '5d20f264ddfdc65ec0675508e7d9b375fc511fd1'
---

<intent-contract>

## Intent

**Problem:** DW-166 — `src/app/wiki/graph/page.tsx:42-43` hand-rolls `new URLSearchParams(window.location.search).get("scope")` under the same "avoid the `useSearchParams` bailout" rationale that `src/lib/workbench-url.ts` was introduced under, so the repo carries two independent conventions for reading a client query param and neither references the other. DW-514 — `?settings=1` names the Settings SURFACE but not which pane it opens on, so a copied link reopens `DEFAULT_SETTINGS_CATEGORY` while the shell's live region (`Workbench.tsx:838/907`) announces the pane the sender was actually reading; the address bar and the announced sentence disagree.

**Approach:** Make `workbench-url.ts` the one place a client query param is read. Add a `scope` reader there and have the graph page call it. Add a validated Settings-category param — written by `surfaceHref` whenever the surface is open on a non-default pane, restored at mount, moved by a category pick, and honoured by `popstate` — and rewrite the header's "NOR IS THE SETTINGS CATEGORY" exclusion paragraph (`workbench-url.ts:36-41`) to record the reversal.

## Boundaries & Constraints

**Always:**
- One reader per param, in `workbench-url.ts`. No `new URLSearchParams(window.location…)` left in `src/app/wiki/graph/page.tsx`.
- The category param is validated by a narrower in `workbench-settings.ts` (the module that owns the vocabulary), shaped exactly like `isWorkbenchModeId` — never a second validator inside `workbench-url.ts`.
- `surfaceHref` stays the ONE builder and stays idempotent on its own normalized output: applying it twice must not produce a third string. The shell's skip-the-write comparison depends on it.
- The category param is DELETED whenever Settings is closed, and omitted when the open pane is `DEFAULT_SETTINGS_CATEGORY` — the same rule the `settings` flag already follows, so the ordinary state has exactly one URL and the existing pinned hrefs (`/?mode=chat&settings=1`) stay byte-identical.
- Restoring a pane from a link is silent: no announcement, no focus move, no history entry. A pane PICK and a traversal onto a different pane both announce, through the existing `settingsAnnouncement(settingsCategory(id).label)`.
- The shell keeps using `window.history` push/replaceState — never `router.push`, never `next/navigation` search-param hooks.
- History writes stay wrapped in the existing `catch {}` degrade, applied AFTER the state change.
- `readScopeFromSearch` validates nothing: the scope vocabulary belongs to `/api/wiki/graph`, which already gates it.

**Block If:**
- The rename or re-shaping of `surfaceHref` would require changing behaviour pinned by `retired-surfaces.test.ts` (`KNOWLEDGE_TREE_HREF`'s pathname and its `mode` param).

**Never:**
- Do not persist the Settings category to `workbench-state.ts` or any storage — the param is the whole of its persistence, exactly as the `settings` flag is.
- Do not touch `src/app/query/page.tsx`, `src/app/api/**`, or `useGraphSimulation` — the graph page's `scope` call site is the only one this bundle names.
- Do not put the tree tab, collapse flag, selection or column widths in the URL.
- Do not change the default pane, the category list, or the announcement sentence.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Scope deep link | `?scope=vault:v1` on `/wiki/graph` | `readScopeFromSearch` → `"vault:v1"`; page graphs that lens | No error expected |
| Scope absent or empty | `""`, `?scope=`, `?q=x` | `readScopeFromSearch` → `null`; page falls back to `"mine"` | No error expected |
| Category deep link | `?mode=chat&settings=1&category=embeddings` | Settings opens on Embeddings, silently; URL unchanged; no entry added | No error expected |
| Unknown / empty category | `?settings=1&category=nope`, `?settings=1&category=` | `readSettingsCategoryFromSearch` → `null`; caller falls back to `DEFAULT_SETTINGS_CATEGORY`; seed rewrites the URL without the param | Narrowed, not trusted |
| Category with the surface CLOSED | `?mode=wiki&category=embeddings` | Param is stray: state stays default, and the mount seed deletes it | No error expected |
| Default pane open | Settings open on `general` | `surfaceHref` writes `?mode=…&settings=1` and no `category` | No error expected |
| Closing Settings | Settings open on `embeddings`, mode picked from the rail | Both `settings` and `category` deleted in one write | No error expected |
| Pane pick | Settings open on `general`, owner picks Embeddings | One history entry, `category=embeddings`, announcement names Embeddings | History failure caught; pane still moves |
| Back off a pane pick | Entry above, `history.back()` | Lands on `general`, announces it, no focus move (the canvas did not swap) | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-url.ts` -- the module gaining ownership. Header exclusion paragraph at `:36-41` is the intent-contract to REWRITE (the reversing decision is recorded on DW-514). `readModeFromSearch:128` and `readSettingsFromSearch:169` are the reader shape to copy (absent / empty / invalid collapse to one answer). `surfaceHref:209` is the one builder; `SETTINGS_ON:73` and the delete-when-closed rule at `:216-217` are the pattern the category follows.
- `src/lib/workbench-settings.ts` -- owns the vocabulary: `SettingsCategoryId:47`, `SETTINGS_CATEGORIES:83`, `DEFAULT_SETTINGS_CATEGORY:99`, `settingsCategory():101`, `settingsAnnouncement():107`. Add the narrower here.
- `src/lib/workbench-modes.ts:176-180` -- `MODE_IDS` + `isWorkbenchModeId`, the exact shape the new narrower mirrors.
- `src/components/workbench/Workbench.tsx` -- every wiring point: state `:229`, `settingsCategoryIdRef:339` (its comment says "Only the ANNOUNCEMENT reads it" and must be updated), mount restore/seed `:446-481`, `applySurface:697`, `applyMode:735`, `pushSurface:751`, `selectMode:763`, popstate guard `:785-818`, `toggleSettings:830`, `openSettings:904`, `selectSettingsCategory:925`, `applyArtifactNavigation`'s `applySurface("wiki", false)` / `pushSurface("wiki", false)` at `:1020-1021`, and the two consumers at `:1814` / `:1883`.
- `src/app/wiki/graph/page.tsx:35-45` -- the hand-rolled read to replace. It already imports from `@/lib/workbench-url` (`KNOWLEDGE_TREE_HREF`, `:8`). `?scope=` is also named in the prose comment at `:169`.
- `src/hooks/useGraphSimulation.ts:182` -- read-only: consumes `scope` and encodes it into `/api/wiki/graph?scope=`. Unchanged.
- `src/lib/__tests__/workbench-url.test.ts` -- node suite that EXECUTES the rules. ~20 `surfaceHref(...)` call sites take a 4th argument; the idempotence loop at `:261-295` and the round-trip at `:229` are the ones that must grow a category dimension.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` -- mounted suite. Helpers `announced()`, `settingsShowing()`, `landingSite()`, `traverse()` and `SETTINGS_ANNOUNCEMENT:206` are the reuse points for the new cases. "puts the mode and the Settings surface in the URL, and nothing else" (`:~610`) must now also say the pane IS in it.
- `src/lib/__tests__/workbench-settings.test.ts:419-430` -- where the category vocabulary is pinned; the narrower's test belongs beside it.
- `src/lib/__tests__/retired-surfaces.test.ts:405-409` -- read-only pin: the graph page must keep importing from `@/lib/workbench-url`. The change strengthens it.
- `src/lib/__tests__/workbench-chrome.test.ts:238-252` -- read-only source scan pinning `initialMode(window.location.search, readStoredMode())` verbatim in `Workbench.tsx`. Keep that expression intact.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- add a `SETTINGS_CATEGORY_IDS` set and `isSettingsCategoryId(value: unknown): value is SettingsCategoryId`, mirroring `workbench-modes.ts:176-180` -- so the URL reader narrows an untrusted string through the module that owns the vocabulary rather than restating the list.
- `src/lib/workbench-url.ts` -- add `GRAPH_SCOPE_PARAM` + `readScopeFromSearch(search): string | null`; add `WORKBENCH_SETTINGS_CATEGORY_PARAM = "category"` + `readSettingsCategoryFromSearch(search): SettingsCategoryId | null`; give `surfaceHref` a required 4th parameter `settingsCategory: SettingsCategoryId` that sets the param only when the surface is open on a non-default pane and deletes it otherwise. Rewrite the `:36-41` exclusion paragraph into the rule that now holds, and widen the header's opening framing so a non-Workbench param (`scope`) has a documented home -- one module, one reader per param.
- `src/app/wiki/graph/page.tsx` -- call `readScopeFromSearch(window.location.search)` in the init effect instead of building a `URLSearchParams`; keep the `?? "mine"` default and the bailout rationale in the comment, pointing it at the module -- DW-166's second convention goes away.
- `src/components/workbench/Workbench.tsx` -- thread the category through the surface: restore it at mount (only when the URL names the surface as open) and feed it to the seed; add it as a parameter to `applySurface` and `pushSurface`; have `selectSettingsCategory` push an entry with the NEW pane; widen the `popstate` guard to the triple and apply the pane it lands on; update the `settingsCategoryIdRef` comment, which no longer describes what reads it.
- `src/lib/__tests__/workbench-url.test.ts` -- update every `surfaceHref` call for the new argument and add coverage for the matrix: the reader's null cases, the omit-at-default and delete-when-closed rules, the round trip, and idempotence across panes.
- `src/lib/__tests__/workbench-settings.test.ts` -- pin `isSettingsCategoryId` against `SETTINGS_CATEGORIES` (accepts every listed id, rejects a mis-cased or unknown one).
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` -- add mounted cases: a `?category=` deep link opens that pane silently; a pane pick writes the param and one entry; Back returns to the previous pane and announces it; a mode pick drops both params.

**Acceptance Criteria:**
- Given a `/wiki/graph?scope=vault:v1` load, when the init effect runs, then the lens is `vault:v1` and the page contains no `new URLSearchParams(` of its own.
- Given `/?mode=chat&settings=1&category=embeddings` opened in a fresh tab, when the shell mounts, then Settings shows the Embeddings pane, the live region is empty, `history.length` is unchanged, and the query string is left as written.
- Given `/?settings=1&category=nope`, when the shell mounts, then the pane is the default and the seed's one `replaceState` leaves a URL carrying no `category`.
- Given Settings open on the default pane, when the owner picks Embeddings, then exactly one history entry is added, the URL gains `category=embeddings`, and the live region says the Embeddings sentence.
- Given the state above, when the owner presses Back, then the pane returns to the default, the announcement names it, Settings stays open, and the keyboard does not move.
- Given Settings open on a non-default pane, when a mode is picked from the rail, then both `settings` and `category` leave the URL in one write.
- Given the skip-link fragment entry (same query, `#wb-canvas`), when Back traverses onto it, then nothing changes — the guard still swallows a traversal in which mode, surface and pane all match.

## Spec Change Log

No amendments — no `bad_spec` finding was raised, so the spec was never looped back.

## Review Triage Log

### 2026-09-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 3, low 4)
- defer: 0
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[medium]` `[patch]` `workbench-url.ts`'s new header asserted "Every client read of a query param in `src/` lands here", which the tree contradicts (`query/page.tsx:136` and `:154-159`, `ActionInbox.tsx:105`, `ReviewDesk.tsx:158`, `useChatConversations.ts:144`). Rewrote it as a DIRECTION plus what is actually enforced, naming the outstanding readers; fixed `GRAPH_SCOPE_PARAM`'s docblock, which claimed `/wiki/graph` owns the param.
  - `[medium]` `[patch]` DW-166 had no test that fails on revert — the new mounted lens cases assert behaviour that is byte-identical before and after, and the pre-existing `retired-surfaces.test.ts` import pin could not see the reader. Added a source-scan case in the `workbench-chrome.test.ts:171` idiom: the graph page must name `readScopeFromSearch` and carry no `new URLSearchParams(`.
  - `[medium]` `[patch]` `settings-shortcut.test.tsx` pressed `g s` only on the default pane, where the threaded pane and `DEFAULT_SETTINGS_CATEGORY` produce the same href, so nothing observed `openSettings`'s new argument. Added a non-default-pane case asserting the URL keeps the pane and a repeat press adds no entry.
  - `[low]` `[patch]` `workbench-mode-url.test.tsx`'s "…and nothing else" title and its "exactly two things" lead comment contradicted the body it grew. Rewritten to name mode, surface and pane.
  - `[low]` `[patch]` The graph fallback case's comment claimed the group marks the default lens, which it cannot — that branch renders identically for every non-`owner:` scope. Comment corrected to what the read actually sees.
  - `[low]` `[patch]` No mounted case reached the default pane by a PICK (only by `history.back()`). Added one: General from Embeddings drops `category`, keeps `settings=1`, pushes one entry.
  - `[low]` `[patch]` The new runtime import of `workbench-settings.ts` into `workbench-url.ts` — and the `providers` / `v1-contract` / `workbench-request` / `write-precondition` chain it pulls into every importer, the graph page included — was undocumented. Recorded beside the validator paragraph with the trade and its escape hatch.

Rejected: `selectSettingsCategory` with the surface closed (unreachable — `SettingsNav` renders only while open); `?scope=owner:` with an empty suffix and an unknown `vault:` id (pre-existing, hand-edited URLs, cosmetic); the lens chips not writing the URL on click (the intent asks for a reader, not a writer); Back walking pane-by-pane after several picks (a recorded design decision, and the pane is the one position-inside-a-surface the shell announces); converting `src/app/query/page.tsx` (a sibling call site the intent does not name); no deferred-work ledger update in the diff (orchestrator-owned).

## Design Notes

Why the pane is omitted at the default rather than always written: the file already argues that "a closed surface is the ordinary state, so the ordinary URL is the one without [the param]". The default pane is the same kind of ordinary state, and omitting it is what keeps `?mode=chat&settings=1` — a string pinned in several suites — meaning exactly what it means today. Both rules are still deterministic and idempotent, so the skip-the-write comparison stays sound.

Why `pushState` on a pane pick rather than `replaceState`: the shell's stated rule is one entry per press the owner made, and a pane pick is such a press — the same reason a rail click pushes. That is what forces the `popstate` guard to widen from the pair to the triple; left at the pair, a Back that moves only the pane would be swallowed and the URL and the surface would part company.

Why `applySurface` takes the pane rather than reading `settingsCategoryIdRef`: the announcement has to name the pane the traversal LANDS on, and the ref still holds the pane it left. Passing it keeps the callback identity stable (no new dependency) while making the announcement correct.

```ts
// surfaceHref's new branch, alongside the flag it mirrors:
if (settingsOpen) {
  params.set(WORKBENCH_SETTINGS_PARAM, SETTINGS_ON);
  if (settingsCategory === DEFAULT_SETTINGS_CATEGORY) params.delete(WORKBENCH_SETTINGS_CATEGORY_PARAM);
  else params.set(WORKBENCH_SETTINGS_CATEGORY_PARAM, settingsCategory);
} else {
  params.delete(WORKBENCH_SETTINGS_PARAM);
  params.delete(WORKBENCH_SETTINGS_CATEGORY_PARAM);
}
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-url.test.ts src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/retired-surfaces.test.ts src/components/workbench/__tests__/workbench-mode-url.test.tsx` -- expected: all pass, including the new cases.
- `pnpm exec tsc --noEmit` -- expected: no errors (this is what catches a `surfaceHref` call site that was not given the new argument).
- `pnpm test` -- expected: the full suite passes; no other suite regressed.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** `src/lib/workbench-url.ts` is now the home for the client query reads this bundle names. It gained `readScopeFromSearch` (DW-166), which the graph page calls in place of its hand-rolled `URLSearchParams`, and `readSettingsCategoryFromSearch` plus a fourth `surfaceHref` parameter (DW-514), so the open Settings surface's pane is written into `?category=` on a pick, restored at mount, carried by `popstate`, and deleted whenever the surface closes or sits on the default pane. The header's "NOR IS THE SETTINGS CATEGORY" exclusion is rewritten into the reversal and its reason.

**Files changed**
- `src/lib/workbench-url.ts` — the scope and category readers, the param keys, `surfaceHref`'s pane argument, and the rewritten header (ownership rule, the reversal, the validator placement, the new coupling).
- `src/lib/workbench-settings.ts` — `isSettingsCategoryId`, mirroring `isWorkbenchModeId`, so the narrower lives with the vocabulary.
- `src/app/wiki/graph/page.tsx` — calls `readScopeFromSearch`; no `URLSearchParams` of its own.
- `src/components/workbench/Workbench.tsx` — the pane threaded through mount restore, the seed, `applySurface`, `pushSurface`, `selectSettingsCategory`, `openSettings`, `toggleSettings` and the widened `popstate` guard.
- `src/lib/__tests__/workbench-url.test.ts` — both readers, the omit-at-default and delete-when-closed rules, round-trip and idempotence across panes.
- `src/lib/__tests__/workbench-settings.test.ts` — the narrower pinned against `SETTINGS_CATEGORIES`.
- `src/lib/__tests__/retired-surfaces.test.ts` — the DW-166 source pin (names the reader, bans the hand-rolled spelling).
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` — mounted pane cases: silent deep link, unknown value, stray pane on a closed surface, pick and Back, pick back to the default, mode pick dropping both params, skip-link traversal still swallowed.
- `src/components/workbench/__tests__/settings-shortcut.test.tsx` — `g s` on a non-default pane.
- `src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx` — the `?scope=` deep link reaching the simulation, and the owner-lens chrome.

**Review findings.** 7 patches applied (medium 3, low 4); 0 deferred; 7 rejected. See the Review Triage Log above.

**Follow-up review recommendation:** `false`. Patched findings by severity — high 0, medium 3, low 4; the score counts high-severity patches only, and there were none.

**Verification.** `pnpm exec tsc --noEmit` exit 0; `pnpm lint` exit 0; `pnpm test` 386 files, 9647 passed, 1 skipped, 0 failed. Every I/O matrix row is covered by a test that ran and passed in that run. The implementer additionally mutation-checked the three new pins — reverting the graph page's call site, replacing `openSettings`'s pane argument with the default, and removing the omit-at-default branch each fail the intended case and were restored.

**Residual risks.**
- `src/app/query/page.tsx` still hand-rolls its own `?scope=` read, with a different miss default (the public commons, not `mine`). Out of scope on the intent's authority — it names the graph page only — and the header now says so rather than claiming otherwise.
- `workbench-url.ts` now imports `workbench-settings.ts` at runtime, so its importers (the graph page included) pull that module's dependency chain. Documented in the file; no cycle, and both modules are client-safe.
- A pane pick pushes a history entry, so Back after browsing several panes takes one press per pane visited. Deliberate — the pane is the one position-inside-a-surface the shell announces — and argued in Design Notes.
