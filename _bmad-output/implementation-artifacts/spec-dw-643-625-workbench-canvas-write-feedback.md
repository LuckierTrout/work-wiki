---
title: 'Workbench write feedback: the Todos canvas refuses out loud, and the Skills rail re-reads a toggle that may have landed'
type: 'bugfix'
created: '2026-09-02'
baseline_revision: 'f4c16f11618bd61881049dce494d093437d23b57'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `MarkMeetingControl` stands in front of a door that DOES refuse and folds the
      refusal into plain `disabled=`, with no sentence and no client mirror.
    evidence: |-
      `src/components/workbench/MarkMeetingControl.tsx:72` gates its one write with
      `disabled={readOnly || busy}` and renders no read-only term, while
      `POST /api/sources/meeting` answers `READ_ONLY_REFUSAL.sourceMeeting` — pinned by
      NAME in the very door loop `read-only-copy-parity.test.ts:398` runs. `sourceMeeting`
      is the only `READ_ONLY_REFUSAL` key with ZERO client references, so nothing holds a
      client sentence to that 403 and the owner meets a dead control with no reason. The
      control renders on the Todos surface this change hardened (it is exercised in
      `todos-canvas.test.tsx`), but it is a different door and a different component, and
      the bundle intent named only `TodosCanvas`'s own write controls — so it was left
      alone rather than widened into this change.
    location: >-
      src/components/workbench/MarkMeetingControl.tsx:72
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two Workbench canvases give the owner the wrong feedback about a write. `TodosCanvas` folds the standing read-only refusal into bare `disabled={readOnly || …}` on fifteen controls and renders no read-only sentence at all, in front of doors that DO refuse with `READ_ONLY_REFUSAL.todos` — the exact defect DW-191/DW-299/DW-531 removed from its siblings, leaving the refusal out of the tab order and impossible to announce with a reason (DW-643). `SkillsCanvas.toggle` re-scans only on `result.status === "ok"`, so an `"unconfirmed"` or `"unreadable"` verdict — where the enablement flip may ALREADY be stored — leaves the rail showing the pre-toggle state until something else triggers a scan (DW-625).

**Approach:** Give the Todos canvas the shipped DW-531 shape: an exported `TODOS_READ_ONLY_COPY` mirroring `READ_ONLY_REFUSAL.todos`, `disabled` kept for the transient `busy`/empty-selection states only and yielding to a standing `aria-disabled`, one `useId()` note the refused controls point at, and early-returning handlers — repinning `todos-canvas.test.tsx`, which pins the old shape. For the Skills rail, re-scan whenever the save verdict says the store MAY have moved — reusing `verdictClearsHeldVersion` rather than testing verdict names by hand — and set the toggle's sentence after the re-scan so the re-read cannot swallow it.

## Boundaries & Constraints

**Always:**
- `TODOS_READ_ONLY_COPY` is CHARACTER-IDENTICAL to `READ_ONLY_REFUSAL.todos` and pinned in `read-only-copy-parity.test.ts`. `READ_ONLY_REFUSAL` stays server-only: no `"use client"` module imports `@/lib/read-only`.
- `aria-disabled` replaces `disabled` on controls that ACT — a button that issues a write or opens the write form. Fields that merely HOLD input (the candidate checkbox, the edit title and due inputs) keep plain `disabled={readOnly}`: an `aria-disabled` field either lies (it still accepts input) or swallows keystrokes. State that distinction in the source.
- `disabled` stays for TRANSIENT state only (`busy`, an empty bulk selection) and YIELDS to the standing refusal, so a stalled request cannot take the controls carrying the sentence out of the tab order.
- ONE note for the Todos canvas: all thirteen refused controls meet doors that answer the SAME `READ_ONLY_REFUSAL.todos` sentence. It renders once for the whole surface, not per card, and only when at least one control pointing at it is on screen (the DW-386 rule).
- Every refused Todos handler returns before `send`. The existing `readOnly` guards in `decide`, `patch`, `remove` and `retryExtract` already do this; the inline Edit handler needs one.
- `SkillsCanvas` decides whether to re-scan through `verdictClearsHeldVersion(result.verdict)`, never by testing verdict names by hand — the exhaustive `switch` is what forces a fourth verdict to state its own answer.
- The toggle's sentence is the one the owner reads after a failed toggle. A re-scan run for that toggle must not write the rail's own scan message or blank the list.

**Block If:** giving the Todos controls the standing refusal would require gating a door that does not refuse, or `READ_ONLY_REFUSAL.todos` turns out not to be what `POST /api/todos` and `PATCH`/`DELETE /api/todos/[id]` answer.

**Never:**
- Do not change any server sentence, any route, or any kernel writer. Do not add a `READ_ONLY_REFUSAL` key.
- Do not touch `GraphCanvas`, `ReviewCanvas`, `ResearchCanvas`, `SettingsCanvas`, `workbench-settings.ts`'s verdict types or `workbench-request.ts` — DW-531/DW-644/DW-558 settled those and this change consumes them.
- Do not change the Skills toggle button's own `disabled`/`aria-disabled` pair, its copy, or any sentence on either surface; no new owner-facing wording is introduced by this change.
- No `<fieldset disabled>`; no second read-only fetch — `TodosCanvas` already receives `readOnly` from `ModeCanvas.tsx:296`.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Todos candidates, read-only | `TodosCanvas readOnly` with a candidate | Bulk Approve/Reject and the card's Approve/Reject are `aria-disabled`, NOT `disabled`, and describe `TODOS_READ_ONLY_COPY`; activating any sends nothing | Handlers return before `send` |
| Todos open tab, read-only | `readOnly`, tab `open`, one item | Edit, Set/Clear due, Mark done, Delete are `aria-disabled` and focusable, describing the same note; Edit opens no form | Handlers return before `send` |
| Todos done tab, read-only | `readOnly`, tab `done`, an approved item | Reopen and Delete are `aria-disabled` and focusable and describe the note | Handlers return before `send` |
| Todos extract error, read-only | `readOnly`, response carries `extractError` | Retry is `aria-disabled` and describes the note | Handler returns before `send` |
| One note, not one per card | `readOnly`, two candidates listed | Exactly ONE element carries the note text, and every refused control's `aria-describedby` resolves to it | No error expected |
| Note guard | `readOnly`, tab `done`, no items and no extract error | No note rendered — no control points at it | No error expected |
| Fields keep `disabled` | `readOnly`, candidates listed | The select checkbox is `disabled`; it carries no `aria-disabled` | No error expected |
| Transient busy, writable | `readOnly` false, a write in flight | Controls are plainly `disabled` exactly as today, with no `aria-disabled` | No error expected |
| Stalled state, read-only | `readOnly` true AND `busy` true | Controls are `aria-disabled` and NOT `disabled` — the refusal keeps its place in the tab order | No error expected |
| Writable Todos | `readOnly` false | No note, no `aria-disabled`, every control behaves as today | Existing error banner |
| Skills toggle, unconfirmed | `saveWorkbenchSettings` answers `verdict: "unconfirmed"` | The rail RE-SCANS, then shows `result.message` | The sentence survives the re-scan |
| Skills toggle, unreadable | `verdict: "unreadable"` | Same: re-scan, then `result.message` | Same |
| Skills toggle, refused | `verdict: "refused"` | NO re-scan — nothing was applied, the list is still accurate — and `result.message` is shown | Unchanged |
| Skills re-scan itself fails | unconfirmed verdict, then the sidecar read throws | The list the rail already had is KEPT, not blanked, and the toggle's sentence is what the owner reads | The scan's own sentence is not shown over the toggle's |
| Skills toggle, ok | `status: "ok"` | Re-scan and clear the message, exactly as today | Unchanged |

</intent-contract>

## Code Map

- `src/components/workbench/TodosCanvas.tsx` -- the change site. `readOnly` prop :16,42; write handlers already guarding `readOnly`: `decide` :113-130, `patch` :132-149, `remove` :151-166, `retryExtract` :168-187. The fifteen `disabled=` sites: bulk Approve :216, bulk Reject :224, Retry :266, select checkbox :286, edit Title input :307, edit Due input :316, edit Save :319, card Approve :356, card Reject :364, Edit :376, Set/Clear due :388, Mark done :398, Delete :406, Reopen :419, Delete(done) :428. TWELVE are buttons that act; :286/:307/:316 are input FIELDS and keep `disabled`. The Edit button's inline `onClick` :377-381 is the one handler with no guard. `bulkIds` :189; render root `.wb-todos` :192; bulk bar guarded on `tab === "candidates"` :211 (renders even with zero items); extract-error block guarded on `extractError` :260; card list guarded on `visible.length` :274-277. The edit form's Cancel :322-328 has no `readOnly` term and needs none — it closes the form.
- `src/components/workbench/ReviewCanvas.tsx:27-43,67-78,270-336` -- THE GOLDEN EXAMPLE: the exported constant's docblock, the `useId()` note ids with the "one id per DOOR, not one per card" comment, the `disabled={!readOnly && (busy || …)}` / `aria-disabled={readOnly || undefined}` / `aria-describedby` triple, and the guarded notes rendered after the list. Copy the shape; do NOT edit this file.
- `src/lib/read-only.ts:347-350` -- `READ_ONLY_REFUSAL.todos` = `"Todos cannot be changed while this deployment is read-only."`, the sentence to mirror. :28-38 is the module note's enumeration of client mirrors that live beside their component — add `TODOS_READ_ONLY_COPY` there. Everything else in this file is READ-ONLY.
- `src/app/api/todos/route.ts:49-51` and `src/app/api/todos/[id]/route.ts:26-28` (and its `DELETE`) -- VERIFIED: both serve `READ_ONLY_REFUSAL.todos`. Both are ALREADY rows in the parity suite's by-name door loop (DW-646), so no new row is needed there.
- `src/app/globals.css:3325-3357` -- VERIFIED: `.wb-todos-btn`, `.wb-todos-btn[disabled]` and `.wb-todos-btn[aria-disabled="true"]` (dimmed, default cursor) all exist from DW-531, and there is no `.wb-todos-btn:hover` rule. `.wb-todos-meta` :3381 is the note's class, as on Review. NO CSS CHANGE IS NEEDED — the Todos buttons already carry `.wb-todos-btn`.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- imports at :47-48 are the pattern for a canvas constant; the Graph/Review mirror case at :465-487 is the model for the new Todos case. `servedAs()` :123 and the by-name loop :385-424 already cover the todos routes.
- `src/components/workbench/__tests__/todos-canvas.test.tsx:145-158` -- the case pinning the OLD shape (`disabled === true`). `send` is mocked at :5-12 and the default load is stubbed at :36-46; `CANDIDATE` :18-29.
- `src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx` -- the suite that exists for exactly this shape (DW-531/DW-644 header :1-24, `send` mock :28-35). The Todos matrix rows belong here; it needs no Sigma mock for them.
- `src/components/workbench/SkillsCanvas.tsx` -- `scan` :52-74 (`setError(null)` on success :64, `setError(SKILLS_SCAN_FAILED_COPY)` + `setSkills([])` on both failure paths :58-61,:66-73); its two call sites are the mount effect :76-81 (`scan(controller.signal)`) and `toggle` :117. `toggle` :91-123: the failure return :110-113 is DW-625's site.
- `src/lib/workbench-settings.ts:3419-3480` (`SettingsSaveVerdict`), `:3481-3519` (`SettingsSaveResult`), `:3536-3558` (`verdictClearsHeldVersion`) -- READ-ONLY. `verdictClearsHeldVersion` is exactly the "the store may already have moved past what you are holding" rule, exhaustive over the union; import it.
- `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` -- the Skills rail suite. `scanCount()` :107-109 counts sidecar reads, `settingsPut` :117-120 is the swappable `PUT /api/settings` stub, and the "then re-scans" case :182-203 already asserts `scanCount() === 2` on the ok path. New verdict rows go here.
- `AGENTS.md` "Test environments" -- `*.test.tsx` ⇒ `dom`, `*.test.ts` ⇒ `node`; suites live under `__tests__`.

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/TodosCanvas.tsx` -- export `TODOS_READ_ONLY_COPY` with a docblock naming the three doors it mirrors and why one sentence covers all of them; add a `useId()` note id with a comment saying why ONE note (one door sentence, one surface) and why it is guarded; convert the twelve ACTING buttons to `disabled={!readOnly && (busy || <their own transient>)}` + `aria-disabled={readOnly || undefined}` + `aria-describedby={readOnly ? noteId : undefined}`; add a `readOnly` early return to the Edit button's inline handler; render the note once after the card list, guarded on there being a refused control on screen (`tab === "candidates" || extractError !== null || visible.length > 0`); leave the checkbox and the two edit fields on plain `disabled={readOnly}` with a comment stating why a field is not given `aria-disabled`.
- `src/lib/read-only.ts` -- add `TODOS_READ_ONLY_COPY` to the module note's list of client mirrors that live beside their component -- the registry is the map of where each mirror lives, and a mirror missing from it is the next reader's blind spot. No other change to this file.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- import `TODOS_READ_ONLY_COPY` and add a case pinning it against `READ_ONLY_REFUSAL.todos`, saying what DW-643 was (a canvas in front of a door that DOES refuse, folding the refusal into `disabled` with no sentence at all) -- the client half now has something holding it to the 403 the owner would meet.
- `src/components/workbench/__tests__/todos-canvas.test.tsx` -- repin `"disables write controls when read-only"` to the shipped shape: the controls are NOT `disabled`, carry `aria-disabled`, and activating one sends nothing. Rename it to say what it now pins.
- `src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx` -- add a mounted `TodosCanvas` describe covering the remaining matrix rows: the announced sentence is `TODOS_READ_ONLY_COPY` and every refused control's `aria-describedby` resolves to the ONE note (two candidates listed, one note); the open and done tabs' controls; Retry under an `extractError`; the note's absence when no refused control is on screen; the fields that keep `disabled`; transient `busy` yielding to the standing refusal; and nothing rendered when writable. Extend the file's header to say it now covers four canvases.
- `src/components/workbench/SkillsCanvas.tsx` -- import `verdictClearsHeldVersion`; give `scan` an options object with a `quiet` flag meaning "replace the list only if one was read; write no message and blank nothing", and pass `{ signal }` from the mount effect; in `toggle`'s failure branch, re-scan quietly when the verdict clears a held version, then set the toggle's sentence LAST. Comment why: the rail holds no version but it holds a VIEW, and both go stale for the one reason that verdict names.
- `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` -- add cases driving `PUT /api/settings` to each verdict: a gateway status (unconfirmed) and a shapeless 200 (unreadable) both re-scan and still show the save sentence; a 400 refusal does NOT re-scan; and an unconfirmed toggle whose re-scan then fails keeps the listed packs and still shows the save sentence.

**Acceptance Criteria:**
- Given a read-only deployment, when the owner tabs through the Todos canvas on any of its three tabs, then every write control is reachable by keyboard and is described by the sentence its own door answers, and activating one issues no request.
- Given a read-only deployment with two candidates listed, when a screen reader announces either card's Approve, then it reads one shared note — the canvas renders exactly one, not one per card.
- Given a Skills toggle answered by a gateway status or by a 2xx with no payload, when the rail settles, then it has re-read the sidecar AND the owner still reads the sentence about the toggle.
- Given a Skills toggle answered by an arrived refusal, when the rail settles, then it has NOT re-read the sidecar — nothing was applied, so the list on screen is still true.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 4, low 2)
- defer: 1: (high 0, medium 0, low 1)
- reject: 5: (high 0, medium 1, low 4)
- addressed_findings:
  - `[medium]` `[patch]` `SkillsCanvas.toggle` awaited the quiet re-scan BEFORE writing the save's sentence. `loopbackFetch` carries no deadline, so a sidecar that accepts and never answers withheld the one sentence about the toggle and left `busy` set, disabling every switch — a regression against the old code. The sentence is now written first; quiet mode writes no message on any path, which is what makes that ordering safe and is now what the comment argues.
  - `[medium]` `[patch]` The quiet re-scan's contract says it blanks nothing, but its success path ran `setSkills(… : [])` unconditionally — a 200 whose body carries no `skills` array emptied the rail, the "reads as no Skills" outcome the module's own docblock names as wrong. Quiet mode now replaces the list only when an array was actually read, and the docblock enumerates all three no-list ways back.
  - `[medium]` `[patch]` Nothing pinned the property DW-625 is about. The new cases asserted only `scanCount()` and which sentence survived, and both scans answered the same fixture — replacing the quiet success path with `if (quiet) return;` left all of them green while reinstating the defect. The unconfirmed case's SECOND scan now answers a flipped enablement and the case asserts the rail re-rendered it.
  - `[medium]` `[patch]` The note guard's `extractError !== null` disjunct was never the reason the note rendered in any case, so deleting it left both Todos suites green while shipping a refused Retry whose `aria-describedby` resolved to nothing on the Open/Done tab. A Done-tab row with an extract error and zero items now pins it.
  - `[low]` `[patch]` The edit-fields comment claimed both were "unreachable under `readOnly` anyway" — false: nothing closes an already-open form when the flag flips, which the sibling stalled-write case constructs deliberately. Comment corrected, and a row now opens the form writable, flips to read-only, and pins Save's standing refusal beside the two fields' plain `disabled`.
  - `[low]` `[patch]` The spec's Code Map, Tasks and Design Notes said "thirteen" acting buttons where the concrete enumeration gives twelve (fifteen `disabled=` sites minus three fields). The implementation followed the enumeration, which is right; the prose outside `<intent-contract>` was corrected to match. The contract's own copy is read-only and keeps its wording.

## Design Notes

**Why fields keep `disabled` while buttons take `aria-disabled`.** The DW-531 shape exists so a standing refusal stays in the tab order and can be ANNOUNCED with a reason. That argument is about controls that act: a button whose click is refused. It does not transfer to an `<input>`. `aria-disabled` on a text field that still accepts typing states something false; guarding its `onChange` makes a field that silently swallows keystrokes. So the candidate checkbox and the two edit-form fields keep `disabled={readOnly}` — and the acting buttons around them already carry the sentence, so nothing is left unannounced. (Nothing closes an already-open edit form when the flag flips, so the fields ARE reachable read-only — inert, beside a Save that refuses out loud.)

The control shape, from `ReviewCanvas`:

```tsx
disabled={!readOnly && (busy || bulkIds.length === 0)}
aria-disabled={readOnly || undefined}
aria-describedby={readOnly ? todosNoteId : undefined}
onClick={() => void decide(bulkIds, "approve")}
```

**Why the Skills re-scan is decided by `verdictClearsHeldVersion`.** That helper answers "may the store have moved past what you are holding?" with an exhaustive `switch`, so a fourth verdict cannot inherit an answer silently. The rail holds no version, but it holds a rendered LIST that goes stale for exactly the same reason, so it asks the same question rather than re-deriving `verdict !== "refused"` by hand.

**Why `quiet` and why the message is set last.** `scan` owns the rail's message on its own behalf — it clears it on success and writes `SKILLS_SCAN_FAILED_COPY` on failure — and either would swallow the sentence about the toggle. A quiet re-scan updates the list when it reads one and touches nothing else, so a re-scan that fails leaves the last list the rail could actually read on screen instead of an empty rail reading as "no Skills", which this module's own docblock names as the wrong answer.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-copy-parity.test.ts` -- expected: all pass, including the new Todos mirror case.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/todos-canvas.test.tsx src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` -- expected: all pass.
- `pnpm exec vitest run --project node` -- expected: no new failures against the baseline revision.
- `pnpm exec vitest run --project dom` -- expected: no new failures against the baseline revision (measure the baseline; do not assume green).
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm exec eslint src` -- expected: no new findings.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Both Workbench canvases now tell the owner the truth about a write they attempted. The Todos canvas stopped folding the standing read-only refusal into bare `disabled=`: its twelve acting controls are focusable, `aria-disabled`, described by one note stating the sentence all three of its doors answer, and refused in the handler — while the three input FIELDS keep `disabled`, because `aria-disabled` on a field either lies or swallows keystrokes. The Skills rail re-reads the sidecar whenever a save verdict says the store may already have moved, so an unconfirmed or unreadable toggle no longer leaves the pre-toggle enablement on screen.

**Files changed.**
- `src/components/workbench/TodosCanvas.tsx` -- exports `TODOS_READ_ONLY_COPY` (the client mirror of `READ_ONLY_REFUSAL.todos`, one sentence for three doors); twelve acting buttons take `disabled={!readOnly && transient}` + `aria-disabled` + `aria-describedby`; the Edit button's inline handler gained the `readOnly` early return the other four handlers already had; one `useId()` note renders after the list, guarded on a refused control being on screen.
- `src/components/workbench/SkillsCanvas.tsx` -- `scan` takes an options object with `quiet` ("replace the list only when one was actually read; write no message, blank nothing"); `toggle` writes the save's sentence and then quietly re-scans when `verdictClearsHeldVersion(result.verdict)` — the rail holds no version but it holds a VIEW, and both go stale for the reason that verdict names.
- `src/lib/read-only.ts` -- `TODOS_READ_ONLY_COPY` added to the module note's registry of client mirrors. No other change.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- pins the new mirror against `READ_ONLY_REFUSAL.todos` and against the Review sentence it must not become.
- `src/components/workbench/__tests__/todos-canvas.test.tsx` -- the case that pinned the OLD shape (`disabled === true`) repinned and renamed to the shipped one.
- `src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx` -- now four canvases; a `TodosCanvas` describe covers every matrix row, including the one note for two cards, the guard's three disjuncts, the fields that keep `disabled`, the transient/standing split in both directions, and the open edit form under a read-only flip.
- `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx` -- the module mock now spreads `importOriginal()` so the real `send` shapes each verdict (the old wholesale mock collapsed all three into one); four verdict cases, with the unconfirmed one answering a FLIPPED enablement on its second scan and asserting the rail re-rendered it.

**Review findings breakdown.** 6 patches applied, 1 deferred, 5 rejected, 0 intent gaps, 0 spec repairs.

**Follow-up review recommendation:** false. Patched severities: high 0, medium 4, low 2. No `high` patch, so no further loop is recommended.

**Verification.**
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-copy-parity.test.ts` -- 27 passed.
- `pnpm exec vitest run --project dom` on the three targeted suites -- 59 passed.
- `pnpm exec vitest run --project node` -- 295 files, 7990 passed, 1 skipped, 0 failed.
- `pnpm exec vitest run --project dom` -- 74 files, 1152 passed, 0 failed.
- `pnpm exec tsc --noEmit` -- exit 0. `pnpm exec eslint src` -- exit 0 (three pre-existing `jsx-ast-utils` tool notices, present at baseline, are not rule findings).
- Matrix audit: every row in the I/O & Edge-Case Matrix maps to a named case that ran and passed. Four of the review's patches were demonstrated by mutation — each reinstates the reported defect and is now caught.

**Residual risks.**
- The rail's truth source is the sidecar's `GET /api/v1/skills`, which derives enablement from a settings snapshot refreshed on a ~15s poll (`sidecar/server.mjs`), so a re-scan fired milliseconds after the write can still answer the pre-flip state. That lag is pre-existing doctrine — the `ok` path has always re-scanned the same way, and this module's docblock records the choice — and narrowing it would mean changing where the rail reads its truth, which neither ledger entry asks for. This change removes the "never re-reads at all" half.
- `MarkMeetingControl` still folds `READ_ONLY_REFUSAL.sourceMeeting` into plain `disabled=` with no client mirror. Recorded in frontmatter `deferred` rather than widened into this change.
