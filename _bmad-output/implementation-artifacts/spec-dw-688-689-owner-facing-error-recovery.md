---
title: 'Owner-facing error recovery: a Repair control for a wedged research registry, and an owner sentence for an unreadable artifact save'
type: 'bugfix'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `PUT /api/workbench/artifact` still relays a raw storage errno into the owner's
      save banner when the WRITE half of the save fails, not the read half this bundle
      typed.
    evidence: |-
      DW-689 scoped itself to `src/lib/wikis.ts:982` — the pre-overwrite READ — and that
      throw is now an `ArtifactUnreadableError` the route answers with
      `ARTIFACT_UNREADABLE_COPY`. The route's fallthrough is unchanged, so a storage fault
      raised by `putWikiArtifact` (or by `getWikiRegistry` inside the same `try`) still
      reaches `json({ error: getErrorMessage(error) }, 500)` and `savePreviewBody` renders
      it verbatim. `src/lib/__tests__/wiki-schema-edit.test.ts` ("answers a failed storage
      write with 500, and moves nothing") asserts only that the body's `error` is a string,
      and the suite's own stderr shows the raw message travelling that path. So the owner
      can still meet `EACCES: permission denied, open '/…'` in the save banner, by the
      other half of the same door.
    location: >-
      src/app/api/workbench/artifact/route.ts:112-116
    severity: low
baseline_revision: '94b22459b99bc913d941b4fe1cbccb7f179d49e8'
---

<intent-contract>

## Intent

**Problem:** Two owner-facing doors hand the owner something they cannot act on. A wedged research registry answers every research door with `"Research projects file is unreadable. Repair it with POST /api/research/repair, then retry."`, rendered verbatim in the Studio's feedback banner and in the Workbench `ResearchCanvas`, while no control anywhere in the product performs that POST (DW-688). And `PUT /api/workbench/artifact` relays a raw storage errno — message and server filesystem path — into the owner's save banner as its 500 body, because `writeWikiArtifact` rethrows the pre-overwrite read's error unwrapped for a precondition-bearing caller and the route's catch has no branch for it (DW-689).

**Approach:** Give the repair sentence a control: one client-safe predicate and copy set in `research-panel.ts` derived from the store's own `REPAIR_HINT`, and a **Repair** control rendered beside the sentence on both surfaces that POSTs `/api/research/repair` and re-reads. Give the artifact save a typed error: `writeWikiArtifact` throws an `ArtifactUnreadableError` instead of the raw storage error, and the route classifies it into a 500 carrying an owner-worded constant.

## Boundaries & Constraints

**Always:**
- One owner per string. `REPAIR_HINT` stays defined in `src/lib/research-projects.ts` and is exported so the client predicate is derived from it, never retyped.
- The repair door's status contract is unchanged: 200 quarantined, 409 nothing to repair, 503 busy, 403 read-only, 500 fault. The client relays the server's `{ error }` sentence for every refusal.
- `PUT /api/workbench/artifact` keeps answering **500** for a storage fault. Only the message changes.
- The owner-facing sentence for an unreadable artifact read never contains an errno, a filesystem path, or a stack.
- The `ResearchCanvas` **Repair** control follows the DW-644 shape on a read-only deployment: rendered not hidden, `aria-disabled`, `aria-describedby` pointing at the list-level `RESEARCH_MUTATE_READ_ONLY_COPY` note, and the handler is what refuses.

**Block If:**
- The repair sentence would have to be reworded, or `parseRegistry`'s three refusals restructured, to make a control reachable.

**Never:**
- Do not reword `REPAIR_HINT` or any `parseRegistry` refusal; `research-projects.test.ts` pins them.
- Do not add a read-back door for a `.corrupt-*` sibling, and do not change `repairResearchRegistry`.
- Do not change the artifact write's fail-soft behaviour for a caller that supplies no `expectedVersion` — that read stays warned-and-continued.
- Do not touch `POST /api/workbench/artifact/revisions` (it passes no `expectedVersion`, so it never reaches the new throw).
- Do not add a confirm dialog for Repair.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Wedged registry, Studio | `GET /api/research` 500s with a `REPAIR_HINT`-suffixed sentence | Banner shows the sentence AND a **Repair** control with a note saying what it does | No error expected |
| Repair lands | Owner presses **Repair**; door answers 200 | Banner turns success with `RESEARCH_REPAIRED_COPY`; the desk/canvas re-reads and shows an empty list | No error expected |
| Nothing to repair | Door answers 409 | The server's own sentence is shown; no success claim | Relayed verbatim |
| Read-only deployment, canvas | `readOnly` true and a Repair control on screen | Control is `aria-disabled`, described by the mutate note, and no request is sent | Handler early-returns |
| Unrelated research failure | `GET /api/research` fails with any sentence lacking the hint | No Repair control anywhere | No error expected |
| Artifact save, storage read fault | Valid `If-Match`; the pre-overwrite read throws `EACCES: permission denied, open '/…'` | 500 with `ARTIFACT_UNREADABLE_COPY`; nothing written | Errno kept only in the server log, as the error's `cause` |
| Artifact save, absent file | Valid `If-Match`; artifact missing (read resolves `null`) | Unchanged: 412 write conflict | Unchanged |

</intent-contract>

## Code Map

- `src/lib/research-projects.ts:22` -- `const REPAIR_HINT`; export it. Its docblock (and the notes at `:466`, `:497`, `:602`) explain the suffix — extend, do not rewrite. `parseRegistry` (`:501`) throws the three suffixed `StoreFaultError`s; `repairResearchRegistry` (`:~640`) is unchanged.
- `src/app/api/research/repair/route.ts` -- the door. Owner-only, unparameterized, body never read. Four answers plus 401/403. No change.
- `src/app/api/research/route.ts:63-65` -- `GET`'s catch: `{ error: getErrorMessage(error) }`, 500. This is how the hint reaches both clients. No change.
- `src/lib/research-panel.ts` -- client-safe vocabulary module; already imports the runtime value `URL_MAX_CHARS` from `research-projects` (`:1`), so importing `REPAIR_HINT` follows the existing direction and adds no cycle. Read-only copy constants live at `:312-321`. Add the predicate, the path, the label, the note and the success sentence here.
- `src/components/KnowledgeStudio.tsx:344-350` -- the one feedback banner (`studio-feedback error`, `role="status"`); `refresh` at `:230-287` is what surfaces the research error (`:282` rethrows it). `requestJson` at `:170-175` throws `body.error`.
- `src/components/workbench/ResearchCanvas.tsx:240` -- `{error && <p className="wb-todos-error">{error}</p>}`; `load` at `:100-115` sets it; the list-level read-only note at `:326-331` is the `aria-describedby` target and its render condition must widen to cover a Repair control. `readOnly` arrives as a prop from `ModeCanvas.tsx:363`, independent of the failing GET.
- `src/lib/workbench-request.ts` -- `send` (`:87`) throws `RequestFailedError` carrying the server sentence; `writeFailure` (`:274`) is the canvas's verdict helper.
- `src/lib/wikis.ts:975-990` -- `writeWikiArtifact`'s pre-overwrite read; `if (expectedVersion !== undefined) throw error;` at `:982` is the unwrapped rethrow. Docblock at `:917-932` states the rule this preserves.
- `src/app/api/workbench/artifact/route.ts:64-93` -- the `PUT` catch ladder: read-only → write-conflict → `isClientInputError ? 400 : 500`. Add the new branch between write-conflict and the fallthrough.
- `src/lib/config.ts:700-723` -- `CONFIG_UNREADABLE_COPY`, the register and shape to mirror for `ARTIFACT_UNREADABLE_COPY`.
- `src/lib/errors.ts:29-51` -- `isClientInputError`'s structural `name` check: the idiom the new `isArtifactUnreadableError` must copy (module-copy safety).
- Tests: `src/lib/__tests__/research-panel.test.ts` (pure), `src/lib/__tests__/wiki-schema-edit.test.ts` (the artifact `PUT` route against a real temp `DATA_DIR`, principal mocked at `:30-33`), `src/components/workbench/__tests__/research-panel-canvas.test.tsx` (canvas mount), `src/components/__tests__/studio-research-read-only.test.tsx:70-115` (the Studio mount stub to model a new suite on). Read-only parity lives in `src/lib/__tests__/read-only-copy-parity.test.ts:441-446`.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- export `REPAIR_HINT` and note in its docblock that the client predicate is derived from it -- one owner for the marker the banner is recognised by.
- `src/lib/research-panel.ts` -- add `RESEARCH_REPAIR_PATH`, `researchRegistryRepairable(message)`, `RESEARCH_REPAIR_LABEL`, `RESEARCH_REPAIR_NOTE_COPY`, `RESEARCH_REPAIRED_COPY` -- the two surfaces must offer the same control, say the same thing, and post the same place.
- `src/components/KnowledgeStudio.tsx` -- render a **Repair** control plus its note inside the error banner when `researchRegistryRepairable(feedback.message)`; POST `RESEARCH_REPAIR_PATH` through `requestJson`, then `await refresh()`; on success set an `ok` feedback of `RESEARCH_REPAIRED_COPY`, on failure the server's sentence -- the desk is where the wedged tenant meets the instruction.
- `src/components/workbench/ResearchCanvas.tsx` -- same control beside the `wb-todos-error` line, `aria-disabled` + `aria-describedby` under `readOnly`, handler early-returns when `readOnly`; widen the list-level mutate-note condition so the note renders whenever the Repair control is offered -- an `aria-describedby` that resolves to nothing describes nothing.
- `src/lib/wikis.ts` -- add `ARTIFACT_UNREADABLE_COPY`, `ArtifactUnreadableError` (default message = the constant, `cause` preserved) and `isArtifactUnreadableError`; throw it at `:982` in place of the bare rethrow -- the errno must not be the thing that reaches the owner.
- `src/app/api/workbench/artifact/route.ts` -- classify it: log the error (cause included) and answer 500 with `ARTIFACT_UNREADABLE_COPY`, not `getErrorMessage(error)` -- a future throw site carrying a diagnostic message must still not leak.
- `src/lib/__tests__/research-panel.test.ts` -- cover the predicate against all three `parseRegistry` sentences and against an unrelated failure, and pin the copy's register (no route path, no HTTP verb in owner copy).
- `src/lib/__tests__/wiki-schema-edit.test.ts` -- cover the artifact `PUT` with the pre-overwrite read throwing an errno-shaped error under a valid `If-Match`.
- `src/components/workbench/__tests__/research-panel-canvas.test.tsx` -- cover the canvas control: offered, posts, reloads, and refuses under `readOnly` with the note on screen.
- `src/components/__tests__/studio-research-repair.test.tsx` -- new mounted suite for the Studio banner control.

**Acceptance Criteria:**
- Given a tenant whose registry `parseRegistry` refuses, when the owner opens the Studio's Research desk, then the banner shows the store's sentence and a **Repair** control the owner can press.
- Given that control, when it is pressed and `POST /api/research/repair` answers 200, then exactly one request is sent to `/api/research/repair`, the desk re-reads `/api/research`, and the banner states that the unreadable file was set aside and an empty one started.
- Given a research failure whose sentence does not carry `REPAIR_HINT`, when the banner renders, then no **Repair** control is offered on either surface.
- Given `readOnly` is true in the Workbench, when the Repair control renders in `ResearchCanvas`, then it is `aria-disabled`, is described by `RESEARCH_MUTATE_READ_ONLY_COPY`, and pressing it sends no request.
- Given a valid `If-Match` and a pre-overwrite read that fails with a storage errno, when the owner saves the Schema, then the response is 500 with exactly `ARTIFACT_UNREADABLE_COPY`, the body contains neither the errno code nor any filesystem path, and nothing was written.
- Given the same failure, when the server logs it, then the original storage error is still reachable as the thrown error's `cause`.

## Design Notes

Why the Studio control carries no read-only mirror while the canvas one does: the Studio's `readOnly` is adopted only from a `GET /api/research` that SUCCEEDED (`KnowledgeStudio.tsx:247-263` leaves it untouched on failure), and this control exists only when that GET failed — so the flag is stale by construction there, and an `aria-disabled` derived from it would be a guess. The 403's own sentence lands in the same banner. The canvas takes `readOnly` as a prop from `ModeCanvas`, which is trustworthy, so it gets the full DW-644 treatment. State this reasoning in a comment at each site.

The predicate is a substring test on the store's own exported constant, not a message regex at a door — the client is handed only `{ error }` and has no type to switch on, and deriving from `REPAIR_HINT` is what keeps a reworded hint from silently withdrawing the control.

Copy register, mirroring `CONFIG_UNREADABLE_COPY`:

```ts
export const ARTIFACT_UNREADABLE_COPY =
  "The stored version of this file could not be read, so nothing was saved. " +
  "This is usually temporary — copy anything you have unsaved, then reload and try again.";
```

The Repair note must be honest that the projects do not come back (the repair starts empty and quarantines the bytes), and must not contain the route path or an HTTP verb — the sentence in the banner above it already names those.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/research-panel.test.ts src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-repair-route.test.ts src/lib/__tests__/read-only-copy-parity.test.ts` -- expected: all pass
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/research-panel-canvas.test.tsx src/components/__tests__/studio-research-repair.test.tsx src/components/__tests__/studio-research-read-only.test.tsx` -- expected: all pass
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm test` -- expected: full suite green

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Two owner-facing doors that handed the owner something they could not act on now hand them something they can. DW-688: `REPAIR_HINT` is exported from the store and `research-panel.ts` gains one client-safe vocabulary — `RESEARCH_REPAIR_PATH`, `researchRegistryRepairable`, `RESEARCH_REPAIR_LABEL`, `RESEARCH_REPAIR_NOTE_COPY`, `RESEARCH_REPAIRED_COPY` — behind a **Repair** control on both surfaces that render a wedged registry's sentence: the Studio's feedback banner and the Workbench's `ResearchCanvas`. DW-689: `writeWikiArtifact`'s pre-overwrite read now throws a typed `ArtifactUnreadableError` (owner wording by default, storage error preserved as `cause`, caller-input faults passed through) and `PUT /api/workbench/artifact` classifies it into a 500 carrying `ARTIFACT_UNREADABLE_COPY`, so the errno and the server filesystem path reach the log instead of the save banner.

**Files changed.**
- `src/lib/research-projects.ts` — `REPAIR_HINT` exported as the one owner of the marker the clients recognise.
- `src/lib/research-panel.ts` — the repair path, predicate and three owner sentences.
- `src/components/KnowledgeStudio.tsx` — Repair control in the feedback banner, offered on a remembered `registryWedged` fact or a repairable sentence; re-reads before it claims anything.
- `src/components/workbench/ResearchCanvas.tsx` — the same control in the DW-644 read-only shape, with an in-flight guard and a landed-repair statement.
- `src/app/globals.css` — layout for the two controls and the canvas notice.
- `src/lib/wikis.ts` — `ARTIFACT_UNREADABLE_COPY`, `ArtifactUnreadableError`, `isArtifactUnreadableError`, and the wrapped rethrow.
- `src/app/api/workbench/artifact/route.ts` — the classifying branch, still 500, serving the constant rather than the thrown message.
- Tests: `src/lib/__tests__/research-panel.test.ts`, `src/lib/__tests__/research-route.test.ts`, `src/lib/__tests__/wiki-schema-edit.test.ts`, `src/components/workbench/__tests__/research-panel-canvas.test.tsx`, and the new `src/components/__tests__/studio-research-repair.test.tsx`.

**Review findings.** 8 patched (6 medium, 2 low), 1 deferred (low — see frontmatter), 6 rejected. No intent gaps and no spec defects; no loopback was needed.

**Follow-up review recommendation.** `false` — patched findings were 0 high, 6 medium, 2 low, and only a high-severity patch recommends another pass.

**Verification.**
- `pnpm exec tsc --noEmit` — clean.
- `pnpm lint` — no errors or warnings (only the repo's pre-existing `jsx-ast-utils` informational lines, confirmed present on the baseline too).
- `pnpm exec vitest run --project node` over the spec's five files plus `research-route.test.ts` — 6 files, 237 passed.
- `pnpm exec vitest run --project dom` over the spec's three files — 3 files, 59 passed.
- `pnpm test` — 371 files, 9194 passed, 1 skipped.
- Matrix audit: every I/O row is covered by a test that ran and passed — the five research rows across `studio-research-repair.test.tsx` and `research-panel-canvas.test.tsx`, and the two artifact rows in `wiki-schema-edit.test.ts` (the absent-file row being the pre-existing "Schema that VANISHED" 412 case).

**Residual risks.**
- After a 409 from the repair door the Studio keeps the control offered, because `registryWedged` stands until a read proves otherwise; pressing again yields another 409. Harmless, and the direct consequence of preferring a remembered fact over the last sentence.
- The Studio's control rides the desk's one shared banner, so it can appear beside an unrelated failure while the registry is known wedged. That is the honest reading of the fact, but it is a control appearing next to a sentence that did not ask for it.
- The new CSS is not covered by any suite; only token existence was checked, not appearance.
