---
title: 'Refusal and failure copy fidelity: no empty PATCH path, no unknown verdict over a landed body, no silent dead control'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
baseline_revision: 'f94da1fba290490bb863c718c94c24312f6e1aa4'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [multiple-goals, oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Three owner-facing sentences say something other than what happened. `autoFixRefusal(type, "")` — the value BOTH doors deliberately pass when no usable slug arrived — renders `Reconcile the conflicting claims in ""` and `PATCH /api/wiki/` with an empty path segment, a request that 404s if pasted, contradicting the copy-pasteability rationale the clause states. `WikiEditor`'s outer `catch` reports the one unconfirmed sentence even when `bodyLanded` is true, so a `PATCH` whose `fetch` never came back leaves the owner reading "the outcome is unknown" over a body already on disk — and retyping or reloading over it. `MarkMeetingControl` folds a door that really does refuse (`POST /api/sources/meeting` answers `READ_ONLY_REFUSAL.sourceMeeting`) into bare `disabled=`, so the refusal leaves the tab order with no sentence and no client mirror.

**Approach:** Branch each sentence on the state it is describing. `disputedClearGuidance` and the `disputed-page` refusal drop the un-pasteable clause when the slug is empty, sharing the qualifier tail so the two variants cannot drift. `WikiEditor` gains a second owner-facing constant beside `partialSaveMessage` stating only the provable half — the text was saved, the metadata outcome is unknown — wired to the one branch where the metadata request left and nothing at all came back. `MarkMeetingControl` takes the shipped DW-531/DW-643 shape: an exported character-identical mirror of `READ_ONLY_REFUSAL.sourceMeeting`, `aria-disabled` in place of standing `disabled`, and a note the control points at.

## Boundaries & Constraints

**Always:**
- `disputedClearGuidance` stays the ONE home for the clear-the-flag clause; the `disputed-page` refusal and the `disputed-page` issue `suggestion` both keep rendering it rather than restating it. Both slug variants share the "admin- or service-only …" qualifier rather than typing it twice.
- A non-empty slug produces today's sentences CHARACTER-FOR-CHARACTER at every caller (`fixLintIssue`, both doors, `lint-checks`).
- The new editor constant is client copy and lives beside `partialSaveMessage` in `WikiEditor.tsx`. It never claims the metadata change "was not" applied, and carries no transport vocabulary.
- The new editor sentence renders only when the body leg was answered `ok` AND the metadata request was actually sent AND nothing came back to answer it. Every other failure branch keeps today's message verbatim.
- `SOURCE_MEETING_READ_ONLY_COPY` is character-identical to `READ_ONLY_REFUSAL.sourceMeeting` and pinned by `read-only-copy-parity.test.ts`, like every other client mirror.
- `MarkMeetingControl` keeps `disabled` for the transient `busy` state only; `readOnly` becomes `aria-disabled` + `aria-describedby`, and `mark()` keeps its early return.

**Block If:**
- Making `disputedClearGuidance` honest for an empty slug would require changing what a NON-empty slug renders.
- Wiring the editor's new sentence cannot be done without changing what a refused (`!res.ok`) metadata leg or a refused `PUT` reports.

**Never:**
- Do not touch server copy: `READ_ONLY_REFUSAL`, `unconfirmedWriteMessage`, `partialSaveMessage`'s own wording, or anything in `src/lib/read-only.ts`, `src/lib/write-precondition.ts`, `src/lib/workbench-request.ts`.
- Do not prefix or re-word a `PUT` failure, a metadata leg that never fired because the body was clean, the `PUT`'s dying 2xx body read, or a metadata leg a GATEWAY answered (502/504). The gateway branch is a different branch than the one DW-703 opens and keeps today's message and its existing pin.
- Do not add a success/partial-success banner, a retry-just-the-metadata affordance, or an `unconfirmed`-style verdict field to `WikiEditor`.
- Do not widen `MarkMeetingControl` beyond its one write control: no new door, no `TODOS_NON_MEETING_COPY` rewording, no change to `SourcesTree`/`PreviewColumn` call sites.
- Do not relax the `read-only-copy-parity.test.ts` cases that assert a door serves its constant by NAME.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Slug-less non-fixable refusal | `autoFixRefusal("disputed-page", "")` | Sentence names no page in quotes and contains no `/api/wiki/` path; still says the toggle is cleared in the page editor and that the write is admin- or service-only on a public knowledge page | Refusal string, unchanged shape |
| Slugged non-fixable refusal | `autoFixRefusal("disputed-page", "contested-page")` | Byte-identical to today: `… in "contested-page", then … (PATCH /api/wiki/contested-page with metadata { disputed: false }) — …` | Refusal string, unchanged |
| Door with no slug | `POST /api/lint/fix` body `{"type":"disputed-page"}`; `fix_lint_issue` args `{type:"disputed-page"}` | 400 / thrown `Error` carrying the slug-less variant — no `/api/wiki/` with an empty segment, no `""` | 400 body `{ error }`; MCP `Error` |
| Unrecognized type | `autoFixRefusal("nope", "")` | `Auto-fix not supported for this issue type`, unchanged | — |
| Metadata request left, nothing answered | `PUT` answered `ok`; `PATCH` `fetch` rejects (`TypeError`) or aborts | The new sentence: text saved, metadata outcome unknown. Form stays open, no navigation | Message only; no retry affordance |
| Metadata refused by the route | `PUT` ok; `PATCH` `!res.ok` non-gateway | `partialSaveMessage(served)`, unchanged | Unchanged |
| Metadata refused by a gateway | `PUT` ok; `PATCH` 504 | `unconfirmedWriteMessage(EDIT_PAGE_SAVE_ACTION)`, unchanged; no "Your text was saved" | Unchanged |
| `PUT`'s 2xx body read dies | `PUT` ok, `res.json()` throws `TypeError`; metadata never sent | `unconfirmedWriteMessage(EDIT_PAGE_SAVE_ACTION)`, unchanged; no "Your text was saved" | Unchanged |
| Body clean, metadata leg alone fails | `bodyDirty` false, `PATCH` rejects | `unconfirmedWriteMessage(...)`, unchanged | Unchanged |
| Mark-as-meeting, read-only | `<MarkMeetingControl readOnly />` on a non-meeting Source | Button focusable, `disabled` absent, `aria-disabled="true"`, `aria-describedby` resolving to `SOURCE_MEETING_READ_ONLY_COPY`; click issues no request | No request, no error text |
| Mark-as-meeting, writable | `readOnly` false | Today's behaviour: `disabled` only while `busy`, no note rendered | `writeFailure(...)` message, unchanged |

</intent-contract>

## Code Map

- `src/lib/lint-types.ts:106-113` -- `disputedClearGuidance(slug)`, the ONE home for the clear-the-flag clause; its docblock already states the `""` contract ("a caller with no usable slug should pass `""` rather than invent one"). Branch here; keep both variants sharing one qualifier tail.
- `src/lib/lint-fix.ts:922-923` -- `NOT_AUTO_FIXABLE["disputed-page"]`, the second interpolation: `Reconcile the conflicting claims in "${slug}"`. Empty slug must drop the quoted name, not render `""`.
- `src/lib/lint-fix.ts:994-1002` -- `autoFixRefusal(type, slug)`; its docblock states the same `""` contract. `fixLintIssue` (:1030) always has a real slug.
- `src/app/api/lint/fix/route.ts:136-160` -- door 1. `type: z.enum(AUTO_FIXABLE_CHECK_TYPES)` rejects `disputed-page`, so a body `{"type":"disputed-page"}` (no slug) falls to `autoFixRefusal(record.type, "")` and answers 400 with the empty-path sentence today.
- `src/lib/mcp-http.ts:751` -- door 2: `autoFixRefusal(a.type, slug ?? "")`, thrown as `Error`.
- `src/lib/lint-checks.ts:766` -- `suggestion` renders the same helper with `entry.slug`, always non-empty; must stay byte-identical.
- `src/lib/__tests__/lint-fix.test.ts:1385-1410` -- existing pins for the slugged sentence and for "built from `disputedClearGuidance`, not restated". Extend beside these; `disputedClearGuidance` is already imported (:98).
- `src/lib/__tests__/lint-checks.test.ts:974` -- `toContain(disputedClearGuidance("contested-page"))`; unaffected.
- `src/components/WikiEditor.tsx:47-67` -- `partialSaveMessage` and its docblock (which states the unknown-outcome branch is deliberately excluded). The new constant goes beside it; the docblock's last paragraph needs to point at it rather than say the branch keeps the thrown message.
- `src/components/WikiEditor.tsx:283-411` -- `handleSave`. `bodyLanded` (:299) is set after the `PUT`'s `res.ok`; the `PUT`'s dying `res.json()` rethrows AFTER that, before the metadata leg. Metadata leg starts :356. Outer `catch` :396-411 currently `setError(writeFailure(err, EDIT_PAGE_SAVE_ACTION).message)`.
- `src/lib/workbench-request.ts:239-247, 312-320` -- `unconfirmedCause` (true for `TimeoutError`/`AbortError`/`TypeError`, and for `RequestFailedError` with 502/504) and `writeFailure`. READ-ONLY: the verdict owner stays untouched; the editor consults `WriteFailure.unconfirmed` and `err instanceof RequestFailedError` rather than re-deriving.
- `src/components/__tests__/page-write-read-only.test.tsx:796-826` -- gateway 504 case; asserts `/Your text was saved/` absent. Must stay green untouched.
- `src/components/__tests__/page-write-read-only.test.tsx:831-865` -- "makes no claim about a metadata leg whose fetch never came back"; this is the pin to flip.
- `src/components/__tests__/page-write-read-only.test.tsx:874-935` -- dying-2xx-body-read case; asserts `/Your text was saved/` absent and `fetchMock` called once. Must stay green untouched.
- `src/components/workbench/MarkMeetingControl.tsx` -- one write control (`mark()`, :46-60), rendered only when `meeting === false`; `disabled={readOnly || busy}` at :71. `mark()` already early-returns on `readOnly`.
- `src/components/workbench/TodosCanvas.tsx:40-58, 248-266, 543-548` -- the shape to copy: exported mirror constant with docblock, `disabled={!readOnly && busy}` + `aria-disabled={readOnly || undefined}` + `aria-describedby={readOnly ? noteId : undefined}`, `useId()` note rendered only when a refusable control is on screen.
- `src/lib/read-only.ts:429-433` -- `READ_ONLY_REFUSAL.sourceMeeting`, the sentence to mirror. Server-only; never imported by a `"use client"` module.
- `src/lib/__tests__/read-only-copy-parity.test.ts:26-50, 492-533` -- the mirror imports and the Graph/Review/Todos parity cases to add a sibling beside. `sources/meeting/route.ts` is already pinned by NAME at :423.
- `src/components/workbench/__tests__/todos-canvas.test.tsx:184-191` -- the existing `MarkMeetingControl` describe (`Mark as meeting copy`), where a read-only row fits.

## Tasks & Acceptance

**Execution:**
- `src/lib/lint-types.ts` -- branch `disputedClearGuidance` on an empty `slug`: the slugged variant stays byte-identical; the slug-less one drops the parenthetical and re-points its qualifier ("that metadata write is admin- or service-only …") so nothing dangles. Extract the shared qualifier tail into one local so the two cannot drift. Update the docblock's `""` paragraph to state what the empty case now renders and why -- an un-pasteable path is worse than no path.
- `src/lib/lint-fix.ts` -- branch `NOT_AUTO_FIXABLE["disputed-page"]` the same way: no `""` in the sentence when there is no slug. Note in the comment that both doors pass `""` by contract, so this is the door path, not a hypothetical.
- `src/lib/__tests__/lint-fix.test.ts` -- add cases beside the existing disputed-page pins: `autoFixRefusal("disputed-page", "")` contains neither `/api/wiki/` nor `""`, still names the editor toggle and the admin-or-service qualifier, and is built from `disputedClearGuidance("")` rather than restated; and the slugged sentence is unchanged.
- `src/app/api/lint/fix/route.ts` (test only: `src/lib/__tests__/lint-fix-route.test.ts`) -- pin the door: `{"type":"disputed-page"}` with no slug answers 400 whose `error` is `autoFixRefusal("disputed-page", "")` and contains no empty path segment.
- `src/components/WikiEditor.tsx` -- export a constant beside `partialSaveMessage` stating the provable half (text saved; nothing came back to confirm the metadata change, so that half is unknown; check what the page shows before trying again), with a docblock saying which single branch it describes and why the gateway and dying-read branches are excluded. Track that the metadata request was actually SENT (a plain local beside `bodyLanded`), and in the outer `catch` render the new constant when the verdict is `unconfirmed`, the body landed, the metadata request was sent, and the cause is not a `RequestFailedError` (i.e. nothing answered at all). Amend `partialSaveMessage`'s closing paragraph to point at the sibling instead of claiming the branch keeps the thrown message.
- `src/components/__tests__/page-write-read-only.test.tsx` -- flip the "makes no claim about a metadata leg whose fetch never came back" case to expect the new constant (asserting the exported constant, never a retyped sentence), keeping its existing assertions that the partial-save wording and the raw transport message are both absent; leave the gateway-504 and dying-read cases untouched and green; add a case that a metadata-only save (body clean) whose `fetch` rejects still shows `unconfirmedWriteMessage`.
- `src/components/workbench/MarkMeetingControl.tsx` -- export `SOURCE_MEETING_READ_ONLY_COPY`, character-identical to `READ_ONLY_REFUSAL.sourceMeeting`, with a docblock recording the door it mirrors and why the server constant cannot be imported. Give the button the DW-531 shape (`disabled` for `busy` only, `aria-disabled`, `aria-describedby`) and render a `useId()` note only when the button is on screen and `readOnly`.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- import the new constant and add a case pinning it to `READ_ONLY_REFUSAL.sourceMeeting`, stating why the surface needed a mirror (the key's only client stood in front of it with no sentence) and that it is distinct from the Todos sentence it sits beside on the same surface.
- `src/components/workbench/__tests__/todos-canvas.test.tsx` -- add a read-only row to the existing `Mark as meeting copy` describe: focusable, `disabled` absent, `aria-disabled="true"`, `aria-describedby` resolving to `SOURCE_MEETING_READ_ONLY_COPY`, and a click that issues no `POST`.

**Acceptance Criteria:**
- Given a caller that passes `""` for the slug, when either lint-fix door refuses `disputed-page`, then the owner-facing sentence contains no `/api/wiki/` path and no empty quoted page name, while a call with a real slug renders exactly the sentence it renders today.
- Given the `disputed-page` issue `suggestion` and the auto-fix refusal, when both are rendered for the same real slug, then both still come from `disputedClearGuidance` and read identically to today.
- Given a save whose body `PUT` was answered `ok` and whose metadata `PATCH` request left and was never answered, when the outer `catch` reports, then the owner is told the text was saved and the metadata outcome is unknown, the form stays open on the draft, and no navigation happens.
- Given a save whose metadata leg was answered by the route (any non-gateway status), by a gateway 502/504, or whose `PUT` 2xx body read died before the metadata leg fired, when the failure is reported, then the message is byte-identical to today's.
- Given a read-only deployment, when `MarkMeetingControl` renders its Mark-as-meeting button, then the button is focusable and `aria-disabled`, its `aria-describedby` resolves to the sentence `POST /api/sources/meeting` answers, and pressing it issues no request.
- Given a writable deployment, when `MarkMeetingControl` renders, then no read-only note is present and the button behaves exactly as it does today.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 0
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[low]` `[patch]` `metadataSent` stayed true after the `PATCH` was answered, so a `TypeError` thrown by `router.push`/`router.refresh()` inside the same `try` would have claimed an unknown metadata outcome over a write the route confirmed. Renamed to `metadataOutstanding` and lowered the moment the `Response` returns; pinned by a new navigation-throw case.
  - `[low]` `[patch]` `lint-types.ts`'s new docblock said "both lint-fix doors" pass `""`. `src/mcp.ts`'s exported `handleFixLintIssue` passes `args.slug ?? ""` as a third caller; the docblock now names all three and why the registered tool's `z.enum` normally blocks that path.
  - `[low]` `[patch]` `lint-fix.test.ts`'s new docblock claimed `fixLintIssue` "always holds a real slug"; `src/cli.ts`'s `--fix` loop passes the `slug: ""` issues `lint-checks.ts` emits at :388/:540/:993. Reworded to the true claim — none of those rows carries type `disputed-page`.
  - `[low]` `[patch]` `EDIT_PAGE_METADATA_UNCONFIRMED_COPY`'s docblock claimed the reconciliation is phrased "exactly as `unconfirmedWriteMessage`" while saying "page" where that sentence says "screen". Sentence kept; the exactness claim corrected.
  - `[low]` `[patch]` Nothing pinned the transient half of the rewritten `disabled={!readOnly && busy}` on `MarkMeetingControl` — deleting `busy` left every row green. Added an in-flight pin on a writable deployment.
  - `[low]` `[patch]` `MarkMeetingControl`'s docblock placed the Todos sentence "on the same canvas" (the control is rendered only by `SourcesTree` and `PreviewColumn`), and its `readOnly && meeting === false` note guard was argued but unpinned. Prose corrected and an already-a-meeting row added.

Rejected (not this story's problem, or not real): the empty-slug branch being truthiness-only rather than trimming a whitespace slug and percent-encoding the path — pre-existing, and `slugify` emits no spaces while `decodeSlugParam` already handles non-ASCII; the `MarkMeetingControl` rows living in `todos-canvas.test.tsx` rather than `canvas-read-only-refusal.test.tsx` — the spec chose that home and the control is not a canvas; the absence of a test threading `readOnly` from `SourcesTree`/`PreviewColumn` — pre-existing prop wiring, unchanged here; and the broad reading of DW-703 that would also re-word the gateway-502/504 branch — the ledger scopes the harm to "that one branch", and DW-624's frozen decision and pin own the gateway one.

## Design Notes

**Why the editor's new sentence is scoped to one branch.** Four post-`PUT` failures reach the same `catch`, and only one of them is the branch DW-703 opens:

| Branch | What is known | Message |
|---|---|---|
| `PATCH` `fetch` rejected / aborted | body saved; metadata request left, nothing answered | NEW constant |
| `PATCH` answered 502/504 | same information state, but DW-624 froze this as the one unconfirmed sentence and pinned it | unchanged |
| `PATCH` answered `!res.ok` otherwise | body saved; metadata refused, with a served reason | `partialSaveMessage(served)`, unchanged |
| `PUT`'s 2xx body read died | body saved; metadata NEVER SENT | unchanged (a "metadata outcome unknown" sentence would be a false claim about our own knowledge) |

The "metadata was sent" local is what keeps the fourth row honest — `bodyLanded` alone is true there too, and its pin (`fetchMock` called once, no "Your text was saved") is what proves the distinction is real rather than theoretical.

**Shape for the empty-slug clause** — the qualifier is shared, not typed twice:

```ts
const CLEAR_QUALIFIER =
  `admin- or service-only, so an owner who is not an admin has to ask one ` +
  `to clear the flag`;
// slug:  `… editor (PATCH /api/wiki/${slug} with metadata { disputed: false }) — on a public knowledge page that PATCH is ${CLEAR_QUALIFIER}`
// none:  `… editor — on a public knowledge page that metadata write is ${CLEAR_QUALIFIER}`
```

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/lint-fix.test.ts src/lib/__tests__/lint-checks.test.ts src/lib/__tests__/lint-fix-route.test.ts src/lib/__tests__/mcp-http.test.ts` -- expected: all pass; the slugged sentence pins are untouched.
- `npx vitest run src/components/__tests__/page-write-read-only.test.tsx` -- expected: all pass, including the untouched gateway-504 and dying-read cases.
- `npx vitest run src/lib/__tests__/read-only-copy-parity.test.ts src/components/workbench/__tests__/todos-canvas.test.tsx src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx` -- expected: all pass.
- `npx tsc --noEmit` -- expected: no errors.
- `npm run lint` -- expected: no new errors.
- `npm test` -- expected: no regressions attributable to this change.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Three owner-facing sentences now say what actually happened. The `disputed-page` refusal and `disputedClearGuidance` branch on an empty slug, so the `""` all three lint-fix callers pass by contract no longer produces `Reconcile the conflicting claims in ""` above a `PATCH /api/wiki/` whose path segment is empty — a request that 404s the moment it is pasted, which is the opposite of the copy-pasteability the interpolation exists for. The two variants share one qualifier local, so the DW-121/DW-389 correction cannot rot in half of them, and the slugged sentence is byte-identical and pinned as such. `WikiEditor` gained a second owner-facing constant beside `partialSaveMessage`: when the body `PUT` was answered `ok` and the metadata `PATCH` left without anything coming back, the owner is told the text is saved and the metadata half is unknown, instead of a flat whole-save verdict that sends them to retype over a body already on disk. `MarkMeetingControl` stopped folding a real 403 into bare `disabled=`: it exports the character-identical mirror of `READ_ONLY_REFUSAL.sourceMeeting` — the last `READ_ONLY_REFUSAL` key with no client reference — and its one write control is now focusable, `aria-disabled`, and described by that sentence.

**Files changed.**
- `src/lib/lint-types.ts` -- `disputedClearGuidance` branches on an empty slug and shares its qualifier tail between both variants.
- `src/lib/lint-fix.ts` -- the `disputed-page` refusal drops the quoted page name when there is no slug; `autoFixRefusal`'s docblock records that `""` is handled rather than tolerated.
- `src/components/WikiEditor.tsx` -- new `EDIT_PAGE_METADATA_UNCONFIRMED_COPY` and the `metadataOutstanding` local that keeps it to the one branch it is true of.
- `src/components/workbench/MarkMeetingControl.tsx` -- exported `SOURCE_MEETING_READ_ONLY_COPY`, the DW-531 `aria-disabled` shape, and a note rendered only beside the control it describes.
- `src/app/globals.css` -- the refused button's dimmed face, mirroring `.wb-todos-btn[aria-disabled="true"]`.
- `src/lib/__tests__/lint-fix.test.ts`, `src/lib/__tests__/lint-fix-route.test.ts`, `src/lib/__tests__/mcp-http.test.ts` -- the slug-less refusal at the helper and at both doors, plus the byte-identity pin on the slugged sentence.
- `src/components/__tests__/page-write-read-only.test.tsx` -- the flipped "makes no claim" pin, the metadata-only save, and the navigation-throw case; the gateway-504 and dying-2xx-read pins untouched.
- `src/lib/__tests__/read-only-copy-parity.test.ts`, `src/components/workbench/__tests__/todos-canvas.test.tsx` -- the client-mirror parity case and the read-only / writable / in-flight / already-a-meeting rows.

**Review findings breakdown.** 6 patches applied (0 high, 0 medium, 6 low); 0 items deferred; 4 items rejected.

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 0, low 6; score 0 high, so no further pass is recommended.

**Verification performed.**
- `npx vitest run` over the eight suites named in `## Verification` -- 513 passed, 0 failed.
- `npx tsc --noEmit` -- exit 0, no output.
- `npm run lint` -- clean; the three `TSNonNullExpression` notices are pre-existing and unchanged in count.
- `npm test` -- 392 files, 9861 passed, 1 skipped, 0 failed.
- Matrix test audit: every I/O row has a covering test that ran and passed, including the two rows added during the audit (the MCP door's slug-less refusal, and an unrecognized type with an empty slug).

**Residual risks.**
- The gateway-answered metadata leg (502/504) and the `PUT`'s dying 2xx body read still report the flat unconfirmed sentence over a landed body. Both are deliberate: DW-624 froze the first and pins it, and the second never sent a metadata request at all, so an unknown-metadata sentence would be a false claim about our own knowledge.
- `.wb-mark-meeting-btn[aria-disabled="true"]` is the only part of the change no test covers — CSS has no suite here, and without it the refused button would render as live.
