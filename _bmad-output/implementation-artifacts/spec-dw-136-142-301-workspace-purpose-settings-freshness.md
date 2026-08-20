---
title: 'Workspace Purpose settings: freshness, degraded-state affordances, and the !wiki tab-order leg'
type: 'bugfix'
created: '2026-08-20'
status: 'done'
baseline_revision: 'edc4691f0ff347616f2b5d05d7de37c52de2453f'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `save()` has no unmount guard, so a PUT that resolves after the form
      unmounts still writes state.
    evidence: |-
      The component's cancelled guard has only ever covered the load path (it
      was `let cancelled` in the mount effect before this change and is
      `cancelledRef`/`answerSeqRef` after it). `save()`'s `.then` path calls
      `placeProfile`, `setVersion`, `setWiki`, `setFeedback` and `setSaving`
      with no such check. Pre-existing; this change did not introduce or widen
      it, and it was surfaced incidentally by review.
    location: >-
      src/components/WorkspacePurposeSettings.tsx (save)
    severity: medium
  - summary: >-
      After a 412 write conflict this form still offers no in-page way to
      re-seed its version; the only recovery is a full reload.
    evidence: |-
      `WRITE_CONFLICT_COPY` tells the owner to copy their text and reload.
      `load("retry")` would now re-seed `version` from a fresh read, but the
      Try again control renders only under `loadFailed`, so the conflict
      banner has no affordance of its own. Out of scope for this bundle — the
      intent names the no-Wiki and load-failed states, not the conflict one.
    location: >-
      src/components/WorkspacePurposeSettings.tsx (save catch / feedback banner)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `WorkspacePurposeSettings` loads once at mount (`}, []`), so an active-Wiki change made anywhere else leaves the form naming — and editing — a Wiki that is no longer current until a full page reload (DW-136). Its two degraded states are dead ends: `loadFailed` is never reset and offers no retry, "Create a wiki first" links nowhere, and the feedback banner announces nothing (DW-142). And the fieldset's `!wiki` leg takes the whole form out of the tab order, so a populated wiki-less body — the case `workspace-purpose-settings.test.tsx` pins by reading `purposeField().value` — is displayed but unreachable by keyboard and screen reader (DW-301).

**Approach:** Extract the load into one reusable function with three call modes (mount, retry, recheck); re-run it when the document becomes visible again and adopt the answer only when the active Wiki id actually changed. Give the load-failed state a Try again control and the no-wiki state a link to `/`, reset `loadFailed` on every attempt, and put the feedback banner in a live region. Drop `!wiki` from the fieldset gate and refuse per control the way the read-only legs already do.

## Boundaries & Constraints

**Always:**
- The recheck adopts state ONLY when `data.wiki?.id ?? null` differs from the id on screen; a same-Wiki recheck touches no state, so an unsaved draft survives it.
- A recheck that FAILS changes no state — the mount and retry paths own the failure surface. Only they set `loadFailed`/`version: null`/error feedback.
- `!wiki` refuses per control (`readOnly` on text fields, `aria-disabled` + handler early-return on the picker and both buttons), never by `disabled`. Every control refused for `!wiki` resolves an on-screen sentence through `aria-describedby`.
- `save()` and `applyTemplate()` early-return on `!wiki` as well as on `readOnly` — an `aria-disabled` control is still activatable, so the early return is the whole refusal.
- The intro paragraph keeps its existing distinction between "no wiki" and "the load failed"; a rejected GET still never claims the registry is empty.
- `version` is never derived client-side; the component only carries back what a response named.
- No new copy for the 412/428 conflict sentences (`write-precondition.test.ts` scans this file).

**Block If:**
- Fixing DW-301 would require weakening the route's `wikiId` mismatch refusal or the `If-Match` precondition.

**Never:**
- No interval polling, no `BroadcastChannel`, no cross-tab storage signal, no new API route, no change to `/api/workspace-profile`.
- Do not re-seed `readOnly`, `profile`, or `version` from a same-Wiki recheck.
- Do not add a second wiki switcher to the Settings surface.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mount, wiki present | GET answers `{profile, readOnly:false, wiki:W, version:V}` | Form seeded, names W, fieldset enabled | No error expected |
| Recheck, same wiki | Tab hidden→visible; GET answers wiki W again, owner has an unsaved draft | No fetchless re-render of fields: draft, version and feedback untouched | Recheck failure is silent |
| Recheck, wiki changed | Tab hidden→visible; GET answers wiki X with profile P2/version V2 | Fields, `savedAt`, `wiki`, `version`, `readOnly` re-seeded from the answer; banner names X; a following save sends X's id and V2 | Recheck failure is silent |
| Load failed | GET rejects | Badge `unavailable`, intro says the wiki could not be loaded, error banner is a live region, **Try again** rendered | `loadFailed=true`, `version=null` |
| Retry after failure | Owner presses Try again; GET succeeds | `loadFailed` cleared, form seeded and editable, error banner replaced | A second failure re-arms the same failed state |
| No wiki | GET answers `wiki:null` with a populated profile | Values readable and focusable, every control refused with a described refusal, no "Last saved", **Create a wiki** links to `/` | Submitting anyway issues NO request |

</intent-contract>

## Code Map

- `src/components/WorkspacePurposeSettings.tsx` — the whole change. Load effect at ~:139-177 (`}, []` at :177); `loadFailed` set at :164 and never cleared; intro paragraph :297-305 (the two degraded sentences); receipt badge :307-319; fieldset gate `disabled={loading || saving || !wiki}` at :349 with the DW-191 rationale comment at :326-348; per-control read-only legs to copy at :361 (`<select>` `aria-disabled`), :388-390 (draft button, `disabled` yields to deployment state), :409/:424/:438/:449/:463/:476 (`readOnly` on the text fields), :491 (submit `disabled={saving || !wiki}`); `describedBy` at :124; `readOnlyNoteId` at :115; feedback banner :518-528; `save()` :201 and `applyTemplate()` :184 early returns.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` — the mounted suite. Cases that pin the OLD `!wiki` contract and must be re-pointed: :326-345, :347-372, :374-387, and :256-279 (which drives a PUT through the submit handler after a failed load). Helpers `formFieldset()`, `badge()`, `purposeField()`, `describedByText()` already exist; `stubGet` replaces `fetch` wholesale.
- `src/components/workbench/DataVersionWatcher.tsx:107-123` — the repo's visibility-recheck convention (`document.visibilityState === "visible"`, listener added in an effect, removed in its cleanup). `src/hooks/useSidecarStatus.ts:52-60` is the same shape. Follow it; do NOT reuse `subscribeDataVersionCheck` — `DataVersionWatcher`'s docstring records that a Wiki switch moves no `dataVersion` at all.
- `src/app/api/workspace-profile/route.ts:53-83` — GET's answer shape and the `wiki: null` branch; `:122-136` the `NO_WIKI`/`WIKI_DRIFTED` refusals a wiki-less or drifted PUT already gets. Read-only, do not change.
- `src/components/WikiWorkbench.tsx:250-300` — precedent for a degraded state: `role="alert"` on the unavailable sentence, and a Create control that stays reachable while refusing.
- `src/app/page.tsx` / `src/components/workbench/WikiSwitcher.tsx:148-191` — `/` is where a Wiki is created and switched; the switcher is never co-mounted with this form, which is why the recheck is visibility-driven.
- `src/lib/__tests__/create-wiki-ui.test.ts:315-325` and `src/lib/__tests__/write-precondition.test.ts:380-400` — source scans over this file. Keep the `SCENARIO_LABELS` import and never spell a conflict sentence here.

## Tasks & Acceptance

**Execution:**
- `src/components/WorkspacePurposeSettings.tsx` — extract the mount effect's body into one `load(mode)` covering `"initial" | "retry" | "recheck"`; keep the cancelled-guard and the `finally` clearing `loading` for the two non-recheck modes — one function so the mount, the retry and the recheck cannot describe the answer three ways.
- `src/components/WorkspacePurposeSettings.tsx` — add a visibility effect that calls `load("recheck")` on `visibilitychange` when `document.visibilityState === "visible"`, removing the listener in cleanup; adopt the answer only on a changed Wiki id and announce the change through the feedback banner — this is DW-136's refetch, and the id comparison is what protects the draft.
- `src/components/WorkspacePurposeSettings.tsx` — clear `loadFailed` at the start of every `initial`/`retry` attempt and on success; render a **Try again** button in the load-failed state that calls `load("retry")`, and a `next/link` **Create a wiki** to `/` in the no-wiki state; give the feedback banner `role={feedback.ok ? "status" : "alert"}` — DW-142's three dead ends.
- `src/components/WorkspacePurposeSettings.tsx` — change the fieldset gate to `disabled={loading || saving}`; refuse `!wiki` per control (`readOnly` on the five text fields, `aria-disabled` on the picker, the draft button and submit, with the draft button's `!selectedTemplate` leg yielding to it exactly as it yields to `readOnly`); add `!wiki` early returns to `save()` and `applyTemplate()`; give the intro paragraph an id and append it to `describedBy` while `!loading && !wiki` — DW-301, using the mechanism the file's own :326-348 comment names.
- `src/components/WorkspacePurposeSettings.tsx` — update the comments at :85-88, :161-162 and :326-348 so they describe the load that now re-runs and the gate that no longer carries `!wiki`; stale rationale here is what DW-301 grew out of.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` — re-point the three `!wiki` cases to the new contract (readable, focusable, described refusal, no request on submit), convert :256-279 into a proof that a wiki-less submit issues NO PUT, and add cases for the recheck (same wiki leaves a draft alone; changed wiki re-seeds and a following save carries the new id and version), the retry, and the banner's role.

**Acceptance Criteria:**
- Given a loaded form naming Wiki W and an unsaved draft, when the tab is hidden and made visible again while the GET still answers W, then no field, version or feedback changes.
- Given a loaded form naming Wiki W, when the tab becomes visible again and the GET answers Wiki X, then the intro names X, the fields hold X's profile, no "Last saved" from W survives, and the banner states that the active wiki changed.
- Given a form whose load failed, when the owner activates Try again and the GET succeeds, then the `unavailable` badge and the error banner are gone and the form is editable.
- Given a response with `wiki: null` and a populated purpose, when the form settles, then the purpose textarea holds that text, is focusable, reports `readOnly`, is not `disabled`, and its `aria-describedby` resolves to an on-screen sentence explaining the refusal.
- Given `wiki: null`, when the form is submitted by any route, then no PUT is issued.
- Given a read-only deployment with a Wiki present, when the form settles, then everything `read-only-copy-parity.test.ts` and the DW-191 cases already assert still holds.

## Design Notes

Why visibility and not a subscription: `WikiSwitcher` lives only in the Workbench (`/`) and this form only on `/settings` and `/studio`, so the two are never mounted together — a client pub/sub would never fire. The switch that strands this form is made in another tab, and `visibilitychange` is the signal the repo already uses for exactly that (`DataVersionWatcher`, `useSidecarStatus`).

Adopting on a changed Wiki discards an unsaved draft. That is the lesser harm and it is stated, not silent: the route already refuses such a save with `WIKI_DRIFTED`, and keeping the draft on screen under a new Wiki's name is the mislabeling DW-136 names. A same-Wiki recheck never touches it.

`describedBy` composes rather than replaces, as the existing comment at :116-123 requires:

```ts
const refusedForNoWiki = !loading && !wiki;
const describedBy =
  [readOnly ? readOnlyNoteId : null, refusedForNoWiki ? noWikiNoteId : null]
    .filter(Boolean).join(" ") || undefined;
```

`noWikiNoteId` goes on the existing intro paragraph rather than on new copy, so the "no wiki" / "load failed" distinction has one owner.

## Verification

**Commands:**
- `pnpm vitest run src/components/__tests__/workspace-purpose-settings.test.tsx` -- expected: all cases pass, including the new recheck, retry and tab-order cases
- `pnpm vitest run src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/lib/__tests__/write-precondition.test.ts` -- expected: pass, the source scans over this file unbroken
- `pnpm test` -- expected: no new failures against the pre-change baseline
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** `WorkspacePurposeSettings` now re-reads the active Wiki instead of loading once at mount, both degraded states have a way out of themselves, and no state removes the form from the tab order any more.

- **DW-136** — the mount effect's body became one `load(mode)` shared by the mount, the Try again retry and a recheck. The recheck runs when the document becomes visible again and when the window regains focus (two side-by-side windows never fire `visibilitychange`), and adopts the answer only when the active Wiki id actually moved, so a same-Wiki recheck leaves an unsaved draft, its version and its feedback untouched. A monotonic answer token, bumped by `load()` and by `save()`, abandons any run whose answer is superseded; a recheck also re-reads its stand-down after the await and refuses to overlap another recheck. A failed recheck changes nothing.
- **DW-142** — `loadFailed` is cleared at the start of every mount/retry attempt and on success; the load-failed state offers **Try again** (mounted through its own request, so keyboard focus is never dropped); the no-Wiki state offers a `Create a wiki` link to `/`, suppressed on a read-only deployment where `/` would refuse; the feedback banner is a live region, `role="alert"` for a refusal and `role="status"` otherwise.
- **DW-301** — the fieldset gate is `disabled={loading || saving}`. `!wiki` (which is also true after a failed load) refuses per control: `readOnly` on the six text fields, `aria-disabled` on the picker and both buttons with the draft button's value-state leg yielding to it, and `!wiki` early returns in `save()` and `applyTemplate()`. Every refused control resolves the intro paragraph — already the one place "no wiki yet" and "the load failed" are told apart — through a composed `aria-describedby` that carries the read-only sentence too when both hold.

**Files changed.**
- `src/components/WorkspacePurposeSettings.tsx` — the whole behavioural change above, plus rewritten rationale comments where the old ones described the load that ran once and the gate that carried `!wiki`.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` — 22 → 42 cases: the three `!wiki` cases re-pointed to the readable/focusable/described-refusal contract, the failed-load precondition case converted to "issues no PUT at all", and new suites for the retry, the recheck (same wiki, changed wiki, wiki gone, failed, stood down while loading/saving/failed, one at a time, listener removal), the window-focus path, the banner roles and wording, and the composed `aria-describedby`.

**Review findings breakdown.** 11 patches applied (1 high, 6 medium, 4 low); 2 items deferred (frontmatter `deferred`); 9 rejected. No intent gaps and no spec repairs.

**Follow-up review recommendation:** `true`. Patched counts this pass: high 1, medium 6, low 4. A high-severity patch was applied, which sets the recommendation regardless of the score (`3 × 6 + 1 × 4 = 22`).

**Verification.**
- `npx vitest run src/components/__tests__/workspace-purpose-settings.test.tsx` — 42/42 passed.
- `npx vitest run src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/lib/__tests__/write-precondition.test.ts` — 60/60 passed; the source scans over this file are unbroken.
- `npx vitest run` — 255 files, 5468 tests, all passed (baseline `edc4691` was 5456; no pre-existing failures and none introduced).
- `npx eslint` — exit 0. `npx tsc --noEmit` — clean.
- Every I/O matrix row is covered by a case that ran and passed in the first command.

**Residual risks.**
- The recheck is driven by `visibilitychange` and window `focus`, not by a signal from the switcher, because the switcher (Workbench only) and this form (`/settings`, `/studio`) are never co-mounted and `PUT /api/wikis/current` moves no `dataVersion`. A tab left in the foreground the whole time still never rechecks; that premise is stated in a comment and is not pinned by a test, so a future surface that hosts both would silently reintroduce the staleness.
- Adopting a changed Wiki discards an unsaved draft. It is announced, and only when the form was actually dirty, but the text itself is not recoverable from the form.
- The feedback banner's `ok` flag now means "was anything lost", not "did something succeed" — documented at the call site, but it is a second meaning for one field.
- The banner is a conditionally-mounted live region (the `WikiWorkbench` and `SettingsCanvas` precedent). `role="alert"` on insertion is well supported; `role="status"` on insertion is less consistently announced across screen readers.
- A `window` `focus` recheck costs one small GET per window re-entry.
