---
title: 'Preview column refresh affordances: gone-gated Edit, re-announceable live regions, stale announcement, busy Retry'
type: 'bugfix'
created: '2026-08-19'
baseline_revision: 'ce85c655ba53cf77cd1d78fc758dbc0377328739'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Nothing in either vitest project can verify that the live-region repeat mark is
      actually re-announced by assistive technology.
    evidence: |-
      DW-182's fix is an alternating U+200B appended to a repeated sentence. The node and
      jsdom suites prove only that the region's string CHANGED — which was never in
      doubt. Whether NVDA, JAWS or VoiceOver re-utters on that change, and whether any of
      them normalises the mark away before diffing, is asserted in prose only. The DW-182
      ledger entry predicted this ("no test in a node or jsdom project can verify"), and
      the repo already records the equivalent gap for CSS. Without a browser/AT project
      the suite reads as if the mechanism is proven.
    location: >-
      src/lib/live-region.ts and src/components/workbench/__tests__/preview-announcements.test.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** Four refresh outcomes in the docked Preview lie to a reader. (DW-181) The `gone` branch deliberately keeps the last payload, so `canEditPreview(payload)` stays true, the header goes on offering `Edit` over a body a 404 replaced, and `save()`'s guard — which compares against that same stale payload — passes and posts. (DW-182) Both polite regions (the column's and the shell's) rewrite an identical string, and most assistive tech announces only on change, so two consecutive silent refreshes report as one. (DW-183) An unreachable refresh is the only refresh outcome with no announcement at all — the stale strip is purely visual. (DW-184) `Retry` has no in-flight state, so a slow retry is indistinguishable from a broken button.

**Approach:** Make `gone` a first-class input to the edit decision through one executed function, so both the affordance and the write refuse together. Add one shared live-region mechanism — an alternating invisible mark appended to a repeated sentence — and route both announcers through it. Announce the unreachable strip from the column's existing polite region, gated on a consecutive-failure threshold so a single blip stays silent. Give `Retry` a pending flag driving `aria-busy`, `disabled`, and a `Retrying…` label.

## Boundaries & Constraints

**Always:**
- Every decision stays an executed pure function in `src/lib/`, never a condition typed into JSX or an effect — the house rule the whole Preview family follows.
- The `gone` branch still KEEPS the payload (DW-54's deliberate decision). The fix gates the edit affordance on `gone`; it does not clear `payload`.
- One derivation for "is there somewhere for Save to go", used by the affordance, the confirm copy, `startEditing`, and both `save()` guards.
- One live-region mechanism, used in `PreviewColumn.tsx` AND `Workbench.tsx`. The region node stays mounted; only its text changes.
- The unreachable announcement is polite and lands in the column's OWN region (the same one `Preview updated` uses), never `role="alert"` — nothing was lost.
- Source-scan tests in `wiki-schema-edit.test.ts` and `workbench-left-column.test.ts` pin exact `PreviewColumn.tsx` source strings; update them to the new text rather than weakening them.

**Block If:**
- The DOM (`jsdom`) vitest project stops collecting, or `vitest.config.ts` would have to change to test any of this.

**Never:**
- No timer, no polling loop, and no auto-retry — self-healing stays "the next read that already happens".
- Do not clear `payload` on `gone`, do not change `previewBodyState`, `previewStaleNotice`, or `fetchPreview` semantics.
- Do not touch the deferred-work ledger.
- No new colour token; the disabled `Retry` face reuses the shell's existing disabled treatment.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Edit over a 404 | `gone: true`, last-good editable `payload` | `previewEditTarget` → `null`; no `Edit` control; `canEditPreview` false | Write refused by the same derivation |
| Edit over live bytes | `gone: false`, editable `payload` | `previewEditTarget` → the page/artifact target, unchanged from today | No error expected |
| Repeat sentence | region holds `"Preview updated"`, next sentence identical | `nextAnnouncement` returns `"Preview updated" + mark` | n/a |
| Repeat again | region holds `"Preview updated" + mark`, same sentence | returns the plain sentence — the mark alternates | n/a |
| New sentence | region holds `"Preview updated"`, next is `"Preview, Beta"` | returns `"Preview, Beta"` unmarked | n/a |
| Cleared region | next sentence is `""` | returns `""` — a cleared region is never marked | n/a |
| First unreachable read | consecutive failures = 1 | `previewUnreachableAnnouncement` → `null`; strip shows, region silent | Blip stays silent |
| Second consecutive | failures = 2 | → `PREVIEW_STALE_ANNOUNCEMENT_COPY` | n/a |
| Third and beyond | failures = 3+ | → `null` — said once, not on every failure | n/a |
| Read lands again | `ok` or `gone` result | failure run resets to 0 | n/a |

</intent-contract>

## Code Map

- `src/components/workbench/PreviewColumn.tsx` — all four defects land here. `PreviewPane` state block (~`:170-230`): `gone`, `unreachable`, `loading`, `retryNonce`, `refreshAnnouncement`, plus `payloadRef` assigned during render. Fetch effect (~`:236-330`): `previewFetchPlan`, the `plan.reset` block, the three result branches. `startEditing` (~`:385-418`) and `save` (~`:420-482`): the two guards at `:429` and `:448`. Render: `canEdit` (`:496`), `editCopy` (`:501`), the `Edit` button in `<header>`, the stale strip + `Retry` (~`:585-605`), the column's polite region (~`:610-616`).
- `src/lib/workbench-preview.ts` — every Preview decision. `previewWriteTarget` (`:312`), `canEditPreview` (`:152`), copy constants (`:334-495`), `previewStaleNotice` (`:563`), `previewRefreshAnnouncement` (`:609`), `fetchPreview` (`:770`+, returns `ok|stale|gone|unreachable`).
- `src/components/workbench/Workbench.tsx` — the shell's polite region (`:1095-1096`) fed by `setAnnouncement` at `:453`, `:509`, `:575`, `:578`, `:585`, `:628`, `:704`. `announcement` state at `:193`.
- `src/app/globals.css` — `.wb-preview-retry` (`:3395`), `:hover` (`:3412`), `.wb-preview-action[disabled]` (`:3351`) is the disabled treatment to mirror.
- `src/components/workbench/__tests__/preview-announcements.test.tsx` — the mounted suite for DW-34/50/53/54. Helpers `announced()`, `columnAnnounced()`, `previewBodyText()`, `renderShell()`, `refresh()`, and the reassignable `answer` fetch stub. This is where the new mounted assertions go.
- `src/lib/__tests__/workbench-preview.test.ts` — node tests; `canEditPreview` call sites at `:504-540` and `:640-652` must move to the new input shape.
- `src/lib/__tests__/wiki-schema-edit.test.ts` (`:951`, `:964`, `:985`, `:999`) and `src/lib/__tests__/workbench-left-column.test.ts` (`:484`, `:515`) — source-scan expectations that quote the exact lines this change edits.
- `vitest.config.ts` — two projects: `node` (`*.test.ts`) and `dom` (`*.test.tsx` under `__tests__`). READ-ONLY here; a new `.test.ts` needs no config change.

## Tasks & Acceptance

**Execution:**
- `src/lib/live-region.ts` (new) -- export `LIVE_REGION_REPEAT_MARK` (`"​"`), `nextAnnouncement(current, sentence)`, and `announcementSentence(value)` (strips the mark) -- one house-wide mechanism, because DW-182 is a property of both announcers, not of the Preview.
- `src/lib/__tests__/live-region.test.ts` (new) -- execute every row of the live-region matrix, including the alternation over three consecutive identical sentences and the empty-string case.
- `src/lib/workbench-preview.ts` -- add `previewEditTarget({ gone, payload })` as THE write-target derivation (`gone` → `null`, else `previewWriteTarget(payload)`); redefine `canEditPreview` to take the same `{ gone, payload }` input and return `previewEditTarget(...) !== null`; add `PREVIEW_STALE_ANNOUNCEMENT_COPY` (built from `PREVIEW_UNREACHABLE_COPY` so the two cannot drift), `PREVIEW_UNREACHABLE_STREAK = 2`, `previewUnreachableAnnouncement({ failures })` (announces on `=== PREVIEW_UNREACHABLE_STREAK` only), and `PREVIEW_RETRYING_COPY = "Retrying…"` -- keeps every new decision executable by the node suite.
- `src/components/workbench/PreviewColumn.tsx` -- (a) `goneRef` assigned during render beside `payloadRef`; `canEdit`, `editCopy`, `startEditing`, and BOTH `save()` guards go through `previewEditTarget`/`canEditPreview` with `gone`. (b) a `failuresRef` counting consecutive `unreachable` results, reset on `ok`, `gone`, and `plan.reset`; the `unreachable` branch sets the announcement from `previewUnreachableAnnouncement`. (c) every `setRefreshAnnouncement` for a NEW sentence goes through `nextAnnouncement` as a state updater (the `plan.reset` clear stays a plain `""`). (d) a `retrying` flag set by `Retry`'s handler, cleared on every non-stale settle and in `plan.reset`, driving `aria-busy`, `disabled`, and the `Retrying…` label on the control; the strip's sentence does NOT change while a read is in flight -- it is still true.
- `src/components/workbench/Workbench.tsx` -- route all seven `setAnnouncement` sites through one `announce` callback using `nextAnnouncement`, so the shell's region re-announces a repeated surface label.
- `src/app/globals.css` -- `.wb-preview-retry[disabled]` gets the shell's disabled treatment and `:hover` is narrowed to `:not([disabled])` -- a control that refuses every click must not light up.
- `src/lib/__tests__/workbench-preview.test.ts` -- move `canEditPreview` call sites to `{ gone, payload }`, add `previewEditTarget` gone/not-gone cases and the `previewUnreachableAnnouncement` threshold rows.
- `src/lib/__tests__/wiki-schema-edit.test.ts`, `src/lib/__tests__/workbench-left-column.test.ts` -- update the quoted source strings to the new guard, `canEdit`, `editCopy`, and `startEditing` lines.
- `src/components/workbench/__tests__/preview-announcements.test.tsx` -- add mounted cases: `Edit` withdrawn on a 404 refresh and restored when the row answers again; two consecutive body swaps leave the column's region textually different both times; the shell's region likewise re-announces a repeated mode label; one unreachable read is silent and the second announces; `Retry` is `aria-busy` and disabled while the retry is in flight and recovers afterwards. Strip the mark in the existing `announced()`/`columnAnnounced()` helpers so existing assertions keep reading sentences.

**Acceptance Criteria:**
- Given a docked Preview showing editable bytes, when a refresh answers 404, then the body is replaced, the `Edit` control is absent, and a save attempted against the seeded target is refused by `previewEditTarget` returning `null`.
- Given a docked Preview showing editable bytes, when a refresh answers 200 with different bytes, then `Edit` is still offered — the gate closes only on `gone`.
- Given the column's polite region already reading `Preview updated`, when a second silent refresh changes the body again, then the region's `textContent` differs from what it held before, while the sentence a reader hears is unchanged.
- Given the shell's polite region already reading a mode label, when the owner re-picks a surface whose label is identical, then the region's `textContent` differs from what it held before.
- Given a docked Preview whose refresh cannot be reached once, when the read settles, then the stale strip shows and the column's region stays empty.
- Given a second consecutive unreachable read, when it settles, then the column's region reads `PREVIEW_STALE_ANNOUNCEMENT_COPY`, and a third consecutive failure does not repeat it.
- Given a visible stale strip, when `Retry` is pressed and the read has not settled, then the control is `aria-busy="true"`, `disabled`, and labelled `Retrying…`; when it settles unreachable again, the control returns to `Retry` and is pressable.

## Spec Change Log

## Review Triage Log

### 2026-08-19 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 1: (high 0, medium 0, low 1)
- reject: 13: (high 0, medium 2, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The unreachable announcement was gated on the failure count alone while the visual strip additionally requires a payload, so a row whose FIRST read failed announced "showing the last version that loaded" over a body reading `This file couldn't be loaded.` — `previewUnreachableAnnouncement` now takes `{ failures, payload }` and stays silent with no last-good bytes, with a node matrix row and a mounted case where the first read fails.
  - `[low]` `[patch]` A confirm dialog left open across a 404 was silently re-worded from the Schema's copy to the page's, because `editCopy` now resolves through a `null` target — the `gone` branch closes the dialog, asserted in a mounted case built on a Schema payload.
  - `[low]` `[patch]` `LIVE_REGION_REPEAT_MARK` was a raw invisible U+200B in source and its test asserted against a second invisible literal, so anything stripping one would strip both — both are now the `\u200B` escape, with the code point asserted outright.
  - `[low]` `[patch]` `workbench-mode-url.test.tsx` and `preview-dirty-guard.test.tsx` read the live region verbatim and compare it to copy; both helpers now route through `announcementSentence`, so a repeated announcement cannot fail an unrelated suite on an invisible one-character diff.
  - `[low]` `[patch]` The `gone` term in both `save()` guards cannot fire as the column stands (`previewFetchPlan` refuses every same-row read while editing); the comment now says so rather than leaving a reader believing it is the live refusal.
  - `[low]` `[patch]` The "starts the run over" case asserted only `not.toBe(PREVIEW_STALE_ANNOUNCEMENT_COPY)` at a moment when the region held `Preview updated`; it now pins the region's actual value and catches a threshold of 1.

## Design Notes

`nextAnnouncement` is the whole DW-182 decision, and it alternates rather than always-appends so the region never accumulates marks:

```ts
export function nextAnnouncement(current: string, sentence: string): string {
  if (sentence === "") return "";
  if (current === sentence) return sentence + LIVE_REGION_REPEAT_MARK;
  return sentence;
}
```

A zero-width space rather than a keyed node: remounting a live region is the mechanism assistive tech observes least reliably (the region must exist before its content changes), while a text-node edit inside a mounted region is the case every implementation handles. The mark is invisible and unspoken, so the sentence a reader hears is unchanged.

The failure streak is a ref, not state: it is read and written inside the same settle callback and nothing renders from it, so making it state would add a render per failure for a value no element shows.

## Verification

**Commands:**
- `pnpm test` -- expected: both vitest projects green, including the new `live-region` node suite and the extended mounted `preview-announcements` suite.
- `pnpm lint` -- expected: no new errors.
- `npx tsc --noEmit` -- expected: no new type errors (the `canEditPreview` signature change must be clean at every call site).

## Auto Run Result

Status: done

### Implemented change

The docked Preview's four dishonest refresh outcomes (DW-181/182/183/184), each landing as an executed pure function wired into the column.

- **DW-181** — `previewEditTarget({ gone, payload })` is now THE write-target derivation, and `canEditPreview` its boolean face over the same input. `gone` is read at four sites (`canEdit`, `editCopy`, `startEditing`, and both `save()` guards via a new `goneRef`), so the affordance and the write refuse together. The `gone` branch still keeps the payload — DW-54's deliberate decision is untouched — and now also closes any open confirm dialog.
- **DW-182** — one shared mechanism in `src/lib/live-region.ts`: `nextAnnouncement` alternates an invisible U+200B onto a sentence the region is already holding, so a repeat is a text change without changing what a reader hears. Used by the column's region AND by a single `announce` callback that replaces every `setAnnouncement` site in the shell. A mounted region with an edited text node was chosen over a keyed node, which is the mechanism assistive tech observes least reliably.
- **DW-183** — `previewUnreachableAnnouncement({ failures, payload })` says `PREVIEW_STALE_ANNOUNCEMENT_COPY` (built from the strip's own sentence) exactly on the second consecutive unreachable read and never again in that run, and only when there are last-good bytes on screen, so the spoken form and the visual strip cannot disagree. The run lives in a ref and resets on `ok`, on `gone`, and on a fresh pick.
- **DW-184** — a `retrying` flag set by `Retry` and cleared on every non-stale settle drives `aria-busy`, `disabled` and a `Retrying…` label. The strip's sentence is deliberately unchanged while a read is in flight: the bytes below are still the last that loaded, which is what it says.

### Files changed

- `src/lib/live-region.ts` (new) — `LIVE_REGION_REPEAT_MARK`, `nextAnnouncement`, `announcementSentence`.
- `src/lib/__tests__/live-region.test.ts` (new) — executes the whole repeat matrix.
- `src/lib/workbench-preview.ts` — `previewEditTarget`, re-signatured `canEditPreview`, `PREVIEW_STALE_ANNOUNCEMENT_COPY`, `PREVIEW_UNREACHABLE_STREAK`, `previewUnreachableAnnouncement`, `PREVIEW_RETRYING_COPY`.
- `src/components/workbench/PreviewColumn.tsx` — `goneRef`, the gone-gated edit path, the failure run, the repeat mechanism, the `retrying` control state.
- `src/components/workbench/Workbench.tsx` — one `announce` callback wrapping `nextAnnouncement` for all seven announcement sites.
- `src/app/globals.css` — a disabled face for `.wb-preview-retry`, and `:hover` narrowed to `:not([disabled])`.
- `src/components/workbench/__tests__/preview-announcements.test.tsx` — the mounted cases for all four items; `announced()`/`columnAnnounced()` strip the mark, with `…Raw()` readers for "the text actually changed".
- `src/lib/__tests__/workbench-preview.test.ts` — call sites moved to `{ gone, payload }`, plus the `previewEditTarget` and threshold matrices.
- `src/lib/__tests__/wiki-schema-edit.test.ts`, `workbench-left-column.test.ts`, `workbench-chrome.test.ts`, `workbench-settings.test.ts` — source-scan expectations updated to the new lines and strengthened.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx`, `preview-dirty-guard.test.tsx` — region helpers routed through `announcementSentence`.

### Review findings breakdown

- Patches applied: 6 (1 medium, 5 low) — see the Review Triage Log entry for each.
- Items deferred: 1 (low) — no vitest project can verify that the repeat mark is actually re-announced by assistive technology.
- Items rejected: 13 (2 medium, 11 low) — chiefly: replacing `disabled` on the busy `Retry` with `aria-disabled` to keep focus (the intent names `disabled` explicitly, and the shell's Save control already sets the same precedent); adding a recovery sentence when a stale column heals (the intent asks for an entry announcement and a threshold that does not chatter); announcing every failed user-initiated retry; a `min-width` to stop the `Retrying…` label reflowing the strip; and several claims that were false against the tree (the ledger and the implementation spec are orchestrator-owned or already present).

### Follow-up review recommendation

`true`. Patched findings only: high 0, medium 1, low 5 → 3 × 1 + 1 × 5 = 8, which is ≥ 5.

### Verification performed

- `npx vitest run` — 249 files / 5266 tests passed, both projects collecting (`pnpm test` and `pnpm lint` fail in this environment with `ERROR packages field missing or empty`, a pre-existing pnpm workspace-resolution problem unrelated to this change; the underlying binaries were run directly).
- `npx tsc --noEmit` — clean, which is what pins the `canEditPreview` signature change at every call site.
- `npx eslint` — exit 0; the three `jsx-ast-utils` notices are pre-existing and come from files this change does not touch (linting only the changed files is silent).
- Every I/O matrix row is covered by a test that ran and passed, in `live-region.test.ts`, `workbench-preview.test.ts` and `preview-announcements.test.tsx`.

### Residual risks

- The DW-183 threshold is counted in READS, not in elapsed time. In a quiet system a single failed read leaves the stale strip standing indefinitely with the polite region silent, because nothing triggers a second read. The intent selected this trade-off ("a threshold that does not chatter on a single blip") and the no-timer rule forbids the alternative, but it is the one case where a screen-reader user still does not learn the column stopped refreshing.
- The `gone` term inside both `save()` guards is defence in depth and cannot fire as the column stands; it is pinned by source scans rather than by an executed test, because no mounted path can set `gone` under an open editor.
- `PREVIEW_STALE_ANNOUNCEMENT_COPY` and the `Retrying…` label are copy decisions the ledger left open. They read well beside the existing Copy table but have not been seen by a person.
