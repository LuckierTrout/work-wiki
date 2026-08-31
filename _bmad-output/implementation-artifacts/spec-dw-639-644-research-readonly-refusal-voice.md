---
title: 'Research read-only refusal voice at the canvas (DW-639, DW-644)'
type: 'bugfix'
created: '2026-08-31'
baseline_revision: '37a615a0e167cbf6dd118442f36e4186c1435dfa'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Deep Research canvas HIDES its two row controls under `readOnly` — Cancel at `src/components/workbench/ResearchCanvas.tsx:410` and Start/Retry at `:416` render only when `!readOnly` — so on a read-only deployment the owner meets a card with no controls and no reason, a third shape beside `disabled` and `aria-disabled` and the one that explains least. Their door is `POST /api/research/[id]/run`, whose sentence `RESEARCH_MUTATE_READ_ONLY_COPY` therefore has no Workbench voice at all (DW-644). DW-639, the same bundle's route half, is ALREADY FIXED at this baseline: `DELETE /api/research/[id]`'s catch carries the `isReadOnlyError` → 403 branch (`route.ts:126`) added by commit `3a28c2a5`, pinned by `research-run-route.test.ts:422-457`.

**Approach:** Give the two row controls the shipped standing-refusal shape DW-531 set at the Graph and Review canvases — rendered, `disabled` reserved for transient state, `aria-disabled` for the standing refusal, `aria-describedby` pointing at one list-level note carrying `RESEARCH_MUTATE_READ_ONLY_COPY`, and a handler that returns before any request (both already do). Name the two visibility rules as pure predicates in `research-panel.ts` so the row and the note guard cannot drift, and give `.wb-set-action` the `aria-disabled` face the stylesheet only has for `.wb-todos-btn` today. DW-639 is verified, not re-implemented.

## Boundaries & Constraints

**Always:**
- The sentence arrives BY NAME from `@/lib/research-panel`. No literal of any `READ_ONLY_REFUSAL` sentence is typed into the canvas — `read-only-copy-parity.test.ts` scans the whole table against that file.
- Cancel and Start/Retry keep their existing non-read-only visibility rules exactly: Cancel iff the row is live, Start/Retry iff not live, status in `draft`/`failed`/`cancelled`, and `!completion || deliveryBlocked`.
- `readOnly` sets `aria-disabled`, never `disabled`: a `disabled` button leaves the tab order and announces no description, which is what makes the note unreachable.
- ONE note for the whole list, rendered after it with a `useId()` id — not inside the `.map()`, which would mint one id per card.
- The note is rendered only when a control it describes is actually on screen.
- `cancel()` and `runExisting()` keep their `if (readOnly) return;` first line: a reachable control means the handler is what refuses.
- A writable deployment renders no note, no `aria-disabled`, and no `aria-describedby`, and still reaches the door.

**Block If:** the two row controls turn out to meet different doors (they do not — both call `POST /api/research/[id]/run`, which answers `READ_ONLY_REFUSAL.researchMutate`), or DW-639's branch is found absent at `src/app/api/research/[id]/route.ts` after all.

**Never:**
- Do not re-add or re-edit the `DELETE` read-only branch or its tests — DW-639 is closed at this baseline; only verify it.
- Do not touch the create form's **Start Deep Research** button. Its real `disabled` is DW-529's deliberate choice, documented at the call site, and its create-door sentence is already rendered in `wb-set-hint`.
- Do not change any control's visibility on a WRITABLE deployment, and do not add a third refusal wording, a new `READ_ONLY_REFUSAL` key, or a `role="alert"` — nothing failed; this is the deployment's standing state.
- Do not edit `KnowledgeStudio.tsx`, `GraphCanvas.tsx`, `ReviewCanvas.tsx`, or any route.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Read-only, live row | `readOnly`, status `collecting` | **Cancel** rendered, focusable, `aria-disabled="true"`, describes `RESEARCH_MUTATE_READ_ONLY_COPY`; note rendered once | Click issues no request |
| Read-only, draft row | `readOnly`, status `draft`, no completion | **Start** rendered with the same shape and the same note | Click issues no request |
| Read-only, failed row | `readOnly`, status `failed` | **Retry** rendered with the same shape | Click issues no request |
| Read-only, two rows | `readOnly`, two live projects | Two Cancels, ONE note node, both `aria-describedby` resolving to it | n/a |
| Read-only, no offered control | `readOnly`, status `complete` with a delivered completion | Neither control rendered AND no mutate note | n/a |
| Read-only, empty list | `readOnly`, `projects: []` | No mutate note (the create hint still renders) | n/a |
| Writable, live row | status `collecting` | Cancel carries no `aria-disabled`/`aria-describedby`; no note; click POSTs `{action:"cancel"}` | Request failure sets the existing error line |
| Writable, draft row | status `draft` | Start reaches `POST /api/research/[id]/run` unchanged | unchanged |

</intent-contract>

## Code Map

- `src/components/workbench/ResearchCanvas.tsx` — `ResearchCanvasProps.readOnly` (:24, default at :61); handlers `cancel` (:184, `if (readOnly) return;` at :185) and `runExisting` (:200, guard at :201) ALREADY early-return, so only the render changes; the create form's hint renders `RESEARCH_CREATE_READ_ONLY_COPY` (:271) and its button's real `disabled` is justified in place (:255-260) — leave both. `shown` is the sorted list rendered at :285-296. `ResearchTask` (:324) takes `readOnly` (:308) and holds the two hidden controls at :410 (`{live && !readOnly ? …}`) and :415-423 (`{!live && !readOnly && [...].includes(project.status) && (!project.completion || project.deliveryBlocked) ? …}`). `live` is `RESEARCH_ACTIVE_STATUSES.includes(project.status)` (:334). No `useId` import yet.
- `src/lib/research-panel.ts` — client-safe, React-free copy/predicate owner. `RESEARCH_ACTIVE_STATUSES` (:25), `researchIsPolling` (:38), `RESEARCH_MUTATE_READ_ONLY_COPY` (:189) which today has exactly ONE consumer, `KnowledgeStudio.tsx`. New predicates belong here — the module docblock states the reason.
- `src/components/workbench/GraphCanvas.tsx` (:607-618 control, :631-640 notes) and `src/components/workbench/ReviewCanvas.tsx` (:305-313 control, :328-336 notes) — the shipped shape to copy verbatim: `aria-disabled={readOnly || undefined}`, `aria-describedby={readOnly ? noteId : undefined}`, `const noteId = useId()` in the parent, note in a `<p className="wb-todos-meta">` guarded on a matching row existing.
- `src/components/KnowledgeStudio.tsx:940-961` — the same shape with the mutate sentence, including the "ONE note per DOOR, rendered once for the whole list" comment.
- `src/app/globals.css` — `.wb-todos-btn[aria-disabled="true"]` (:3335) is DW-531's face and its comment explains why one is needed; `.wb-set-action` (:4945) and `.wb-set-action:hover` (:4953) have NO `[disabled]` or `[aria-disabled]` rule, so a refused row control would render at full opacity with a pointer cursor and light up on hover. `.wb-wiki-switch-action:hover:not([disabled]):not([aria-disabled="true"])` (:3796) is the hover-exclusion precedent.
- `src/app/api/research/[id]/route.ts:118-131` — DW-639's branch, PRESENT. `src/lib/__tests__/research-run-route.test.ts:415-470` — its three pins (mid-request refusal, foreign `ReadOnlyError`, and the control that the branch swallows nothing else). Read-only evidence: nothing here is to be changed.
- `src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx` — DW-531's suite. Helpers `describedBy` (:72) and `expectStandingRefusal` (:81) are exactly the assertions this shape needs; its docblock (:1-20) names only Graph and Review and must be widened. It mocks `@/lib/workbench-request`'s `send`/`writeFailure` (:24-31) — the same mock `ResearchCanvas` needs.
- `src/components/workbench/__tests__/research-panel-canvas.test.tsx:605-626` — `Research Panel — read-only` today asserts `queryByRole("button", { name: "Cancel" })).toBeNull()`; that pin encodes the defect and must be replaced. `project()` fixture at :30.
- `src/lib/__tests__/read-only-copy-parity.test.ts:531-551` — "the Deep Research canvas renders the constant, never a retyped sentence": scans the canvas source for the constant NAME and asserts no `READ_ONLY_REFUSAL` sentence is spelled there. Its comment already anticipates "a future hint that copies `researchMutate` beside Cancel".
- `src/lib/__tests__/workbench-settings.test.ts:5462-5491` — "gives the aria-disabled faces a rule, and takes them off the hover face", the CSS pin to extend.
- `src/lib/__tests__/research-panel.test.ts` — the node-project suite for `research-panel.ts`'s pure functions.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-panel.ts` -- add two exported predicates over a `ResearchProject`: one for "this row offers Cancel" (the live rule) and one for "this row offers Start/Retry" (the not-live + editable-status + no-delivered-completion rule), each with a short docblock naming `POST /api/research/[id]/run` as the door both meet. -- the row and the list-level note guard must read ONE rule; two copies of the Start/Retry condition is how a note appears beside a control that is not there.
- `src/components/workbench/ResearchCanvas.tsx` -- import `useId`, the two new predicates and `RESEARCH_MUTATE_READ_ONLY_COPY`; mint `mutateNoteId` in `ResearchCanvas` and pass it to `ResearchTask`; render both row controls through the predicates regardless of `readOnly`, adding `aria-disabled={readOnly || undefined}` and `aria-describedby={readOnly ? mutateNoteId : undefined}`; render one `<p id={mutateNoteId} className="wb-todos-meta">` after the list, guarded on `readOnly` and on some shown row offering either control. -- this is DW-644: the refusal becomes visible and announced instead of the controls vanishing.
- `src/app/globals.css` -- add `.wb-set-action[aria-disabled="true"]` with the dimmed face and `cursor: default`, and exclude both `[disabled]` and `[aria-disabled="true"]` from `.wb-set-action:hover`, with a comment naming DW-644 and the `.wb-todos-btn` precedent. -- `aria-disabled` gets none of the browser's own treatment and no mounted test can see it, so a refused control would otherwise look live.
- `src/lib/__tests__/research-panel.test.ts` -- cover both predicates across every `ResearchProjectStatus`, plus the `completion` / `deliveryBlocked` split that decides Retry. -- the guard the note rides on is now a pure function, so it is assertable without mounting.
- `src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx` -- widen the docblock to the three canvases and add a `Research canvas — read-only` describe using the existing `expectStandingRefusal`/`describedBy` helpers, covering the I/O matrix's read-only and writable rows: live row, draft row, failed row, two rows sharing ONE note node, a row offering neither control rendering no note, an empty list rendering no note, no request on click, and a writable deployment carrying neither attribute while still reaching the run door. -- one file owns the definition of this shape across canvases.
- `src/components/workbench/__tests__/research-panel-canvas.test.tsx` -- replace the `offers no Cancel` assertion in `Research Panel — read-only` with the refused-and-announced expectation (keeping the create-hint and read-only-input assertions), and rename the case. -- the pin that encoded the hidden control must not survive the fix.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- extend the Deep Research canvas case to require `RESEARCH_MUTATE_READ_ONLY_COPY` by name alongside `RESEARCH_CREATE_READ_ONLY_COPY`. -- the canvas now mirrors two doors, and the no-retyped-sentence scan must cover both.
- `src/lib/__tests__/workbench-settings.test.ts` -- add `.wb-set-action[aria-disabled="true"]` and the two `:hover:not(...)` exclusions to the CSS face case. -- the stylesheet rule is invisible to jsdom, so this scan is its only guard.

**Acceptance Criteria:**
- Given a read-only deployment, when the Deep Research canvas renders a project offering Cancel or Start/Retry, then that control is present, focusable, not `disabled`, marked `aria-disabled="true"`, and its `aria-describedby` resolves to a node reading exactly `READ_ONLY_REFUSAL.researchMutate`.
- Given a read-only deployment with several such rows, when the canvas renders, then exactly one node carries that sentence and every refused control points at it.
- Given a writable deployment, when the canvas renders and a control is activated, then no refusal attribute or note is present and `POST /api/research/[id]/run` is still called exactly as before this change.
- Given `DELETE /api/research/[id]` at this baseline, when its writer throws a read-only refusal mid-request, then the door already answers 403 with that sentence and no code or test for it is modified (DW-639 verification).

## Spec Change Log

## Review Triage Log

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 0
- reject: 14: (high 0, medium 0, low 14)
- addressed_findings:
  - `[low]` `[patch]` `.wb-set-action` gained an `[aria-disabled]` face but no `[disabled]` one, while the new `:hover:not([disabled])` exclusion took away the hover background that was the disabled state's only feedback — and the class's one real-`disabled` consumer, the create form's Start Deep Research, is disabled on every load until a topic and a query are typed. Added `.wb-set-action[disabled]` in the `.wb-todos-btn` pair's shape, with a matching pin in `workbench-settings.test.ts`.
  - `[low]` `[patch]` The `researchOffersCancel` status sweep asserted `toBe(RESEARCH_ACTIVE_STATUSES.includes(status))` — the function body restated, so a reword of the constant would have been carried along rather than caught. Rewritten with literal offered/withheld lists, the shape the `researchOffersRun` case already used.
  - `[low]` `[patch]` No predicate case exercised a completion whose `phase` is not `"done"` — the branch a still-draining row actually sits in. Added one asserting that row is offered nothing while `researchIsPolling` keeps re-reading it, and is offered Retry once the delivery is declared blocked.
  - `[low]` `[patch]` The `ResearchCanvas` docblock named neither door, unlike `GraphCanvas` and `ReviewCanvas`, so the two-door split was legible only from inline comments 300 lines down. Added the "TWO DOORS, TWO SENTENCES" paragraph.

## Design Notes

The shipped shape, from `ReviewCanvas.tsx`, applied to a row control:

```tsx
<button
  type="button"
  className="wb-set-action"
  aria-disabled={readOnly || undefined}
  aria-describedby={readOnly ? mutateNoteId : undefined}
  onClick={onCancel}
>
  Cancel
</button>
```

`aria-disabled={readOnly || undefined}` rather than `={readOnly}`: React drops an
attribute set to `undefined`, so a writable deployment emits nothing at all —
which is what the writable cases assert.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/research-panel.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/research-run-route.test.ts` -- expected: all pass, including the untouched DW-639 pins.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx src/components/workbench/__tests__/research-panel-canvas.test.tsx` -- expected: all pass.
- `pnpm test` -- expected: the full two-project run is green.
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm exec eslint src/components/workbench/ResearchCanvas.tsx src/lib/research-panel.ts` -- expected: clean.

## Auto Run Result

Status: done

### What was implemented

DW-644: the Deep Research canvas's two row controls — **Cancel** and **Start/Retry** — no longer vanish under `readOnly`. They render with `aria-disabled="true"`, stay focusable, and point through `aria-describedby` at one list-level note carrying `RESEARCH_MUTATE_READ_ONLY_COPY`, the sentence `POST /api/research/[id]/run` answers. Their handlers already refused before any request and still do. The two visibility rules moved into `research-panel.ts` as pure predicates so the rows and the note guard read one rule. `.wb-set-action` gained the `[aria-disabled]` and `[disabled]` faces the class never had, since `aria-disabled` gets none of the browser's own treatment.

DW-639 was VERIFIED, not re-implemented: `DELETE /api/research/[id]`'s catch already carries the `isReadOnlyError` → 403 branch (`src/app/api/research/[id]/route.ts:118-131`), added at commit `3a28c2a5` by the sibling `research-readonly-cas-sentinel` bundle earlier in this same sweep run, and pinned by three cases in `src/lib/__tests__/research-run-route.test.ts:415-470`. The ledger entry's premise ("the DELETE handler's catch is the unchanged `ClientInputError ? 400 : 500` shape") is stale. No route or route test was modified; those pins ran green.

### Files changed

- `src/components/workbench/ResearchCanvas.tsx` — row controls rendered-not-hidden with the standing-refusal shape; one `useId()` mutate note after the list; docblock now names both doors.
- `src/lib/research-panel.ts` — new `researchOffersCancel` / `researchOffersRun` predicates over the pre-existing visibility rules.
- `src/app/globals.css` — `.wb-set-action[disabled]` and `.wb-set-action[aria-disabled="true"]` faces; hover narrowed to exclude both.
- `src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx` — new `Research canvas — read-only` describe (9 cases) beside Graph's and Review's, reusing `expectStandingRefusal` / `describedBy`.
- `src/components/workbench/__tests__/research-panel-canvas.test.tsx` — the `offers no Cancel` pin, which encoded the defect, replaced with the refused-and-announced expectation.
- `src/lib/__tests__/research-panel.test.ts` — four cases over the two predicates, including the draining-completion branch.
- `src/lib/__tests__/read-only-copy-parity.test.ts` — the canvas must now name `RESEARCH_MUTATE_READ_ONLY_COPY` too.
- `src/lib/__tests__/workbench-settings.test.ts` — CSS pins for both new faces and the hover exclusion.

### Review findings breakdown

Patches applied: 4 (all low) — the missing `.wb-set-action[disabled]` face, a tautological `researchOffersCancel` assertion, the uncovered non-`done` completion branch, and the docblock's silence on the two doors. Items deferred: 0. Items rejected: 14 — chiefly pre-existing shapes this change did not cause (the create button's real `disabled`, deliberate at DW-529; `KnowledgeStudio`'s own copies of the status rules; no busy guard on the row controls; the bare-return refusal, which `GraphCanvas.tsx:406-415` explicitly endorses as the door-facing shape beside a described control) and test-hygiene residue the project's leftover rule excludes.

Follow-up review recommended: **false** — patched findings were 0 high, 0 medium, 4 low; score = 3×0 + 1×4 = 4, below 5.

### Verification

- `pnpm exec vitest run --project node` on the four spec'd files — 352 passed, including the untouched DW-639 route pins.
- `pnpm exec vitest run --project dom` on the two spec'd files — 48 passed.
- `pnpm test` — 354 files, 8411 passed, 1 skipped, 0 failed.
- `pnpm exec tsc --noEmit` — clean. `pnpm exec eslint` on both source files — clean.
- Matrix audit: all eight I/O rows are covered by cases that ran and passed in the two mounted suites.

### Residual risks

- The CSS faces are pinned only as stylesheet text (`workbench-settings.test.ts` reads `globals.css`), since jsdom applies no stylesheet — the repo's established idiom for this, but a selector that stops matching the button would keep every test green.
- `src/lib/__tests__/research-runtime.test.ts` — untouched here — restores `YOPEDIA_READONLY` only in a `finally`, so when that test hits vitest's 5s timeout under load the flag leaks and fails four later tests in the same file. Seen twice during this run's full-suite passes and reproducible at the baseline; the file passes alone and the suite passes on re-run.
