---
title: 'Read-only refusal parity for the Workbench canvases, and the record for the Studio panels that stand in front of doors which do not refuse'
type: 'bugfix'
created: '2026-08-30'
status: 'done'
baseline_revision: '218cfcf912dfd773a45eb019e5ac1e5df4f51bdd'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The Workbench Todos canvas still folds the standing read-only refusal into
      plain `disabled=`, in front of a door that DOES refuse.
    evidence: |-
      `src/components/workbench/TodosCanvas.tsx` gates every write control with
      `disabled={readOnly || …}` (216, 224, 266, 286, 307, 316, 319, 356, 364,
      376, 388, 398, 406, 419, 428) and renders no read-only sentence at all,
      while `POST /api/todos` and `PATCH`/`DELETE /api/todos/[id]` answer
      `READ_ONLY_REFUSAL.todos`. It takes the same `readOnly` from the same
      parent (`ModeCanvas.tsx:226`) as the two canvases DW-531 named, uses the
      same `.wb-todos-btn` class this change gave an `aria-disabled` face, and
      has no client mirror and no parity-suite row. `todos-canvas.test.tsx:145-158`
      pins the OLD shape, so adopting the new one is a test change too. Not in
      DW-531's five controls, so left alone rather than widened into this change.
    location: >-
      src/components/workbench/TodosCanvas.tsx:216
    severity: medium
  - summary: >-
      The Deep Research canvas HIDES its row controls under read-only instead of
      refusing them, so `RESEARCH_MUTATE_READ_ONLY_COPY` has no Workbench voice.
    evidence: |-
      `src/components/workbench/ResearchCanvas.tsx:403,409` render Cancel and
      Start/Retry only when `!readOnly`, so on a read-only deployment the
      controls vanish rather than standing refused with a reason — a third shape
      beside `disabled` and `aria-disabled`, and the one that explains least.
      Their door is `POST /api/research/[id]/run`, whose sentence
      `RESEARCH_MUTATE_READ_ONLY_COPY` this change moved into
      `src/lib/research-panel.ts` for the canvases and which still has exactly
      one consumer, the Studio. DW-531 named only the five `disabled=` controls
      in Graph and Review, and the bundle intent excluded ResearchCanvas, so the
      hidden rows were left as they are.
    location: >-
      src/components/workbench/ResearchCanvas.tsx:403
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three read-only gaps remain on the client. `ResearchCanvas.tsx:265` renders a fourth research refusal sentence inline, owned by nobody and pinned by nothing (DW-529). `GraphCanvas` (2 controls) and `ReviewCanvas` (3 controls) pass `readOnly` straight into `disabled`, so the standing refusal leaves the tab order and can never be announced with its reason — the exact defect DW-191/DW-299 removed elsewhere (DW-531). DW-530 asks for the same treatment on the Studio's Setup, Skills and Portability panels on the premise that they "meet their refusal afterwards" — but `POST /api/vaults`, `POST`/`PATCH`/`DELETE /api/agent-skills[/id]` and `POST /api/archive/import` carry no read-only gate at any layer, and DW-268 records that boundary as deliberate (vaults and agent profiles still mutate under `YOPEDIA_READONLY`).

**Approach:** Move the three research copy constants out of `KnowledgeStudio.tsx` into the client-safe `research-panel.ts` so the Workbench can mirror them without importing the Studio, and have the canvas render `RESEARCH_CREATE_READ_ONLY_COPY` in place of its literal. Give the five `disabled={readOnly…}` controls the shipped shape — transient `disabled` yielding to standing `aria-disabled`, an early-returning handler, and one identified note per distinct door sentence. For DW-530, correct the record instead of inventing an unenforced refusal: state the verified reason in the Studio module note and add a parity case that FAILS the moment one of those four doors starts refusing, so the client mirror cannot be forgotten then.

## Boundaries & Constraints

**Always:**
- A client constant that mirrors a door's sentence is CHARACTER-IDENTICAL to it and pinned in `read-only-copy-parity.test.ts`.
- Every refused control names ITS OWN door's sentence through `aria-describedby` — the policy the DW-386 review settled on.
- `disabled` stays for TRANSIENT state only (`busy`, `item.status === "creating"`) and YIELDS to the standing refusal, so a stalled request cannot take the one control carrying the sentence out of the tab order.
- A note is rendered only when at least one control pointing at it is on screen (the DW-386 review's `insights.length > 0` rule).
- `READ_ONLY_REFUSAL` stays server-only: no `"use client"` module imports `@/lib/read-only`.
- `research-panel.ts` stays React-free and client-safe — it is imported by three canvases and by the Studio.

**Block If:**
- Making DW-530's premise true would require gating `createVault`, the three agent-skill writers or `importPortableArchive`. That widens what `YOPEDIA_READONLY` refuses, which DW-268 records as an open operator-facing question — HALT rather than decide it here.

**Never:**
- Do not add a read-only gate to `src/lib/vault.ts`, `src/lib/agent-skills.ts`, `src/lib/portable-archive.ts` or their routes.
- Do not render a read-only refusal on SetupPanel, SkillsPanel or PortabilityPanel: those doors write on a read-only deployment, so the sentence would be false and would mirror nothing.
- Do not touch `ResearchCanvas`'s `disabled={!canStart}` on Start — its comment documents why an action-only control may leave the tab order, and it is out of DW-531's five.
- Do not change the ResearchCanvas row controls (Cancel / Start / Retry), which are hidden rather than `disabled` under `readOnly`.
- No `<fieldset disabled>`; no second read-only fetch — every canvas already receives `readOnly` from `ModeCanvas`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Deep Research canvas, read-only | `ResearchCanvas` with `readOnly` | The hint reads `RESEARCH_CREATE_READ_ONLY_COPY`, character-identical to what `POST /api/research` answers | Handler already returns before `fetch` |
| Graph insights, read-only | `GraphCanvas` with `readOnly` and both insight kinds | Dismiss and Deep Research are `aria-disabled`, still focusable, and describe the dismiss and create sentences respectively; activating either sends no request and opens no dialog | Handlers return before `send` |
| Review queue, read-only | `ReviewCanvas` with `readOnly` and a card carrying queries | Deep Research, Create Page and Skip are `aria-disabled` and focusable; Deep Research describes the create sentence, the other two the review-queue sentence; no request, no dialog | Handlers return before `send` |
| Transient busy, writable | `readOnly` false, `busy` or `status === "creating"` | The three Review controls stay plainly `disabled` exactly as today | No error expected |
| Stalled state, read-only | `readOnly` true AND `busy` true | Controls are `aria-disabled` and NOT `disabled` — the refusal keeps its place in the tab order | No error expected |
| Writable deployment | `readOnly` false on any of the three canvases | No note rendered, no `aria-disabled`, every control behaves as today | Existing error banners |
| A Studio panel's door starts refusing | `vaults`/`agent-skills`/`archive/import` gains `isReadOnly()` or `assertWritable` | `read-only-copy-parity.test.ts` FAILS, naming the panel that now needs a client mirror | Test failure is the intended signal |

</intent-contract>

## Code Map

- `src/lib/research-panel.ts` -- client-safe, React-free research vocabulary already imported by `ResearchCanvas`, `GraphCanvas` and `ReviewCanvas`. New home for the three research copy constants (`RESEARCH_CREATE_READ_ONLY_COPY` 118, `RESEARCH_MUTATE_READ_ONLY_COPY` 122, `RESEARCH_COLLECT_READ_ONLY_COPY` 126, currently in `KnowledgeStudio.tsx`), for the `workbench-settings.ts` reason: one owner, and the Workbench must not import the Studio for a string.
- `src/components/KnowledgeStudio.tsx` -- lines 95-127 hold the three constants and the module note; 141 `RESEARCH_COLLECT_EMPTY_COPY` stays (Studio-only, not a read-only sentence). Consumers at 706, 890, 937, 940. `SetupPanel` 411 (`POST /api/vaults` 427), `SkillsPanel` 961 (POST 984, PATCH 1002, DELETE 1020, `window.confirm` 1017), `PortabilityPanel` 1055 (`POST /api/archive/import` 1065).
- `src/components/workbench/ResearchCanvas.tsx:263-269` -- the `wb-set-hint` span carrying the unowned literal; `disabled={!canStart}` at 259 stays (documented exception); rows hide Cancel/Start at 403-415.
- `src/components/workbench/GraphCanvas.tsx` -- `dismissInsight` 363 (`POST /api/graph/insights`), `confirmResearch` 377 (`POST /api/research`, no `readOnly` guard yet), Dismiss button 546-553, Deep Research button 555-566, insights aside 517-573.
- `src/components/workbench/ReviewCanvas.tsx` -- `act` 92 (`POST /api/review-queue/[id]`, already guards `readOnly`), `confirmResearch` 115 (no guard), Deep Research 227-237, Create Page 239-246, Skip 247-254, card list 190-258.
- `src/app/api/graph/insights/route.ts:30-31` -- serves `READ_ONLY_REFUSAL.graphInsightDismiss`. `src/app/api/review-queue/[id]/route.ts:21-22` -- `READ_ONLY_REFUSAL.reviewQueue`. `src/app/api/research/route.ts:76-79` -- `READ_ONLY_REFUSAL.researchCreate`. `research/route.ts` is already in the parity suite's constant-served door loop; the other two are not.
- `src/app/api/vaults/route.ts`, `src/app/api/agent-skills/route.ts`, `src/app/api/agent-skills/[id]/route.ts`, `src/app/api/archive/import/route.ts` -- VERIFIED: no `isReadOnly`, no `READ_ONLY_REFUSAL`, no `isReadOnlyError`. `src/lib/vault.ts:121` `createVault`, `src/lib/agent-skills.ts:81/98/120`, `src/lib/portable-archive.ts` `importPortableArchive` -- VERIFIED: no `assertWritable`. Confirmed against `deferred-work.md` DW-268 (open), which records vaults and agent profiles as outside the flag's boundary.
- `src/components/EmailIngestSettings.tsx:34,65,75,355-366,376-383` -- the golden example for the control shape: `disabled={!readOnly && transient}`, `aria-disabled={readOnly || undefined}`, `aria-describedby={refusalIds}`, `useId()` note, early-returning handler.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- `routeSource()` 63, `servedAs()` 76, research-desk case 379-407, the constant-served door loop at 340. Imports the three research constants from `@/components/KnowledgeStudio` (39-43) — repoint to `../research-panel`.
- `src/app/globals.css:3306-3328` -- `.wb-todos-btn` and its `[disabled]` face; 3797-3808 is the precedent for giving `[aria-disabled="true"]` the same face.
- `src/components/workbench/__tests__/graph-lint-review-canvas.test.tsx` -- existing canvas suite; 405-414 and 565-574 assert the TRANSIENT `disabled` (must stay green). `research-panel-canvas.test.tsx:603-618` asserts the old literal — repoint to the constant.
- `src/components/__tests__/studio-research-read-only.test.tsx:6-8` -- imports the three constants from `@/components/KnowledgeStudio`; repoint.
- `AGENTS.md` "Test environments" -- `*.test.tsx` ⇒ `dom`, `*.test.ts` ⇒ `node`; suites live under `__tests__`.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-panel.ts` -- move `RESEARCH_CREATE_READ_ONLY_COPY`, `RESEARCH_MUTATE_READ_ONLY_COPY` and `RESEARCH_COLLECT_READ_ONLY_COPY` here with their docs, naming the doors each mirrors -- one owner, reachable from the Workbench without importing the Studio.
- `src/components/KnowledgeStudio.tsx` -- import the three from `@/lib/research-panel` instead of declaring them; keep `RESEARCH_COLLECT_EMPTY_COPY`; rewrite the "ONLY the Research desk" paragraph to state the VERIFIED reason the other panels carry no read-only term: their doors do not refuse (no `isReadOnly()`, no `assertWritable`), DW-268 records that boundary, and the parity suite now fails if that changes -- the note was previously read as an oversight and re-filed as DW-530.
- `src/components/workbench/ResearchCanvas.tsx` -- render `RESEARCH_CREATE_READ_ONLY_COPY` in the hint instead of the inline literal -- the canvas stops being a fourth wording for a door that owns one.
- `src/components/workbench/GraphCanvas.tsx` -- export `GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY` (mirrors `graphInsightDismiss`); add a `readOnly` early return to `confirmResearch`; convert Dismiss and Deep Research to `aria-disabled` + `aria-describedby` + no-op handler; render one `useId()` note per sentence, only when an insight of that kind is listed.
- `src/components/workbench/ReviewCanvas.tsx` -- export `REVIEW_QUEUE_READ_ONLY_COPY` (mirrors `reviewQueue`); add `readOnly` early returns to the Deep Research opener and to `confirmResearch`; convert the three controls to `disabled={!readOnly && (busy || creating)}` + `aria-disabled` + `aria-describedby`; render the create note only when some card offers Deep Research, and the queue note whenever cards are listed.
- `src/app/globals.css` -- give `.wb-todos-btn[aria-disabled="true"]` the same dimmed, default-cursor face as `[disabled]` -- a control that refuses every click must not look live.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- repoint the three research imports to `../research-panel`; pin `GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY` and `REVIEW_QUEUE_READ_ONLY_COPY` against their sentences; add `graph/insights/route.ts` and `review-queue/[id]/route.ts` to the constant-served door loop; add a case asserting the four Studio-panel doors and their three writers carry NO read-only treatment, with a comment saying what to do when it fails.
- `src/components/workbench/__tests__/research-panel-canvas.test.tsx` -- assert the hint against the imported constant rather than a retyped literal.
- `src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx` -- new mounted suite covering every I/O matrix row for `GraphCanvas` and `ReviewCanvas`: focusable and `aria-disabled` under `readOnly`, the announced sentence is the control's own door's, activation sends nothing and opens no dialog, transient `disabled` yields to the standing refusal, and nothing is rendered when writable.

**Acceptance Criteria:**
- Given a read-only deployment, when the owner opens the Graph, Review or Deep Research canvas, then every refused control keeps its place in the tab order and is described by a note stating the sentence its own door answers.
- Given a read-only deployment, when the owner activates any of those controls, then no request is issued and no Deep Research dialog opens.
- Given `pnpm exec vitest run --project node src/lib/__tests__/read-only-copy-parity.test.ts`, when it runs, then the two new client constants are pinned against their server sentences and the four ungated Studio doors are pinned as ungated.
- Given a future change that gates `POST /api/vaults`, the agent-skill writers or the archive import, when the suite runs, then it fails and names the Studio panel that now needs a client mirror.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 4, low 5)
- defer: 2: (high 0, medium 1, low 1)
- reject: 11: (high 0, medium 1, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The new DW-530 wording claimed the Studio panels render no read-only term at all — FALSE: `SetupPanel` embeds `<WorkspacePurposeSettings />`, a different door that does refuse and does render its mirror. All three wordings (`KnowledgeStudio.tsx`, `read-only.ts`, the parity case) now scope the claim to the panels' OWN write controls and name the embedded exception.
  - `[medium]` `[patch]` The ungated-door tripwire missed `PATCH`/`DELETE /api/vaults/[id]`, equally ungated — the suite that exists to catch a new gate would have stayed green on vault rename/delete. Row added.
  - `[medium]` `[patch]` Nothing pinned the new `.wb-todos-btn[aria-disabled="true"]` face. It is load-bearing — `readOnly` no longer sets `disabled`, and jsdom applies no stylesheet — so deleting it left all five controls looking live with every test green. Pinned in `workbench-settings.test.ts`'s existing aria-disabled-face case.
  - `[medium]` `[patch]` `ResearchCanvas` was still named nowhere in `read-only-copy-parity.test.ts`, which the intent asked for by name. It owns no constant, so a source-scan case now pins that it renders `RESEARCH_CREATE_READ_ONLY_COPY` by name, has lost the retired literal, and retypes no other `READ_ONLY_REFUSAL` sentence.
  - `[low]` `[patch]` The tripwire's `not.toContain("isReadOnly")` was self-defeating: a future comment explaining why a route does not gate would redden it, and the case forbids relaxing the assertion. Now matched as call forms (`isReadOnly(`, `isReadOnlyError(`, `assertWritable(`), with the distinction stated.
  - `[low]` `[patch]` The rewritten Studio note accounted for three of the six panels the old one enumerated, leaving Compile, Original sources and Connections without a verdict. All six restored: the first two write nothing, and Connections' one write (`DELETE /api/sync/status`) is ungated too.
  - `[low]` `[patch]` Nothing pinned "one note per LIST, not per card" — every mounted case rendered a single row, so a note moved inside the `.map()` (duplicate ids, broken `aria-describedby`) passed everything. Two-item cases added for both canvases, asserting one note and one shared target.
  - `[low]` `[patch]` The Graph note guard was tested in one direction only; the mirrored `isolated`-only case now pins the other.
  - `[low]` `[patch]` The two new `confirmResearch` guards refused SILENTLY, leaving the dialog open with no reason if ever reached. They now state `RESEARCH_CREATE_READ_ONLY_COPY` before returning.

## Design Notes

DW-530 is NOT implemented as written, and this is the finding rather than a shortfall. Its premise — "each still submits and meets its refusal afterwards" — is false: none of `POST /api/vaults`, `POST`/`PATCH`/`DELETE /api/agent-skills`, or `POST /api/archive/import` refuses on a read-only deployment, at the route or in `src/lib`. Rendering "…cannot be created while this deployment is read-only." beside those controls would state a deployment property that is not true, mirror no server sentence, and remove a capability the deployment still permits. Making it true means widening what `YOPEDIA_READONLY` refuses, which DW-268 records as an open, operator-facing decision. So the change corrects the record and installs the tripwire instead.

The control shape, from `EmailIngestSettings`:

```tsx
disabled={!readOnly && (busy || item.status === "creating")}
aria-disabled={readOnly || undefined}
aria-describedby={readOnly ? reviewNoteId : undefined}
onClick={() => { if (readOnly) return; void act(item.id, "skip"); }}
```

Two notes per canvas, not one: Graph's Deep Research and Review's Deep Research meet `POST /api/research` while Dismiss meets the insights door and Create Page / Skip meet the review queue, and the DW-386 review settled that every refused control names its own door.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-copy-parity.test.ts` -- expected: all pass, including the new pins and the ungated-door case.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx src/components/workbench/__tests__/graph-lint-review-canvas.test.tsx src/components/workbench/__tests__/research-panel-canvas.test.tsx src/components/__tests__/studio-research-read-only.test.tsx` -- expected: all pass.
- `pnpm exec vitest run --project node` -- expected: no new failures against the baseline revision.
- `pnpm exec vitest run --project dom` -- expected: no new failures against the baseline revision (measure the baseline; do not assume green).
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm exec eslint src` -- expected: no new findings.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Every read-only refusal the Workbench canvases show now belongs to the door behind it. The Deep Research canvas stopped spelling a fourth wording of the create sentence and renders the owned constant; the five `disabled={readOnly…}` controls on the Graph and Review canvases became focusable, `aria-disabled`, described by a note stating their OWN door's sentence, and refused by an early-returning handler. DW-530 was NOT implemented as written: its premise is false, and the change corrects the record and installs a tripwire instead of inventing a refusal.

**Files changed.**
- `src/lib/research-panel.ts` -- now owns `RESEARCH_CREATE_READ_ONLY_COPY`, `RESEARCH_MUTATE_READ_ONLY_COPY` and `RESEARCH_COLLECT_READ_ONLY_COPY`, moved out of `KnowledgeStudio.tsx` so three canvases can mirror the doors without importing a page component.
- `src/components/KnowledgeStudio.tsx` -- imports the three; the module note now states the VERIFIED reason the other panels carry no term for their own write controls, names the embedded Workspace Purpose door as the exception, and gives all six panels a verdict.
- `src/lib/read-only.ts` -- the client-mirror registry updated: two new constants listed, the four mirrors that live in shared modules explained, and a paragraph recording that the Studio's own panel doors refuse nothing (DW-268's boundary).
- `src/components/workbench/ResearchCanvas.tsx` -- the hint renders the create constant; `disabled={!canStart}` and the hidden row controls untouched, per the intent.
- `src/components/workbench/GraphCanvas.tsx` -- exports `GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY`; Dismiss and Deep Research carry `aria-disabled` + `aria-describedby`; two `useId()` notes, each guarded on an insight of its kind; `confirmResearch` refuses and says why.
- `src/components/workbench/ReviewCanvas.tsx` -- exports `REVIEW_QUEUE_READ_ONLY_COPY`; the three controls keep `disabled` for `busy`/`creating` only and yield it to the standing refusal; two notes, guarded on the list they describe; the Deep Research opener and `confirmResearch` refuse.
- `src/app/globals.css` -- `.wb-todos-btn[aria-disabled="true"]` gains the dimmed, default-cursor face `[disabled]` had.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- research imports repointed; the two new constants pinned; `graph/insights` and `review-queue/[id]` added to the constant-served door loop; a source-scan case for `ResearchCanvas`; and the ungated-door tripwire over five Studio-panel routes and three writers.
- `src/lib/__tests__/workbench-settings.test.ts` -- the new CSS face pinned beside the existing `aria-disabled` faces.
- `src/components/workbench/__tests__/canvas-read-only-refusal.test.tsx` -- new mounted suite (14 cases) covering every I/O matrix row.
- `src/components/workbench/__tests__/research-panel-canvas.test.tsx`, `src/components/__tests__/studio-research-read-only.test.tsx` -- assert through the constants rather than retyped literals / repointed imports.

**Review findings breakdown.** 9 patches applied, 2 deferred, 11 rejected, 0 intent gaps, 0 spec repairs.

**Follow-up review recommendation:** true. Patched severities: high 0, medium 4, low 5. Score = 3x4 + 1x5 = 17, at or above 5.

**Verification.**
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-copy-parity.test.ts` -- 25 passed.
- `pnpm exec vitest run --project dom` on the four targeted suites -- 85 passed.
- `pnpm exec vitest run --project node` -- 286 files, 7249 passed, 1 skipped, 0 failed.
- `pnpm exec vitest run --project dom` -- 68 files, 1019 passed, 0 failed. (The 13-file `window.localStorage` failure set a prior spec measured at its baseline is gone on this machine; both projects are green, so no baseline comparison was needed.)
- `pnpm exec tsc --noEmit` -- exit 0. `pnpm exec eslint src` -- exit 0 (three pre-existing `jsx-ast-utils` tool notices, present at baseline, are not rule findings).
- Matrix audit: all seven rows are covered by cases that ran and passed. The last row asserts a FAILURE, so it was proven by mutation instead: appending `isReadOnly` to `vaults/route.ts` reddened the tripwire naming SetupPanel, and the file was restored (`git diff` empty). The same mutation proof was run for the CSS pin, the prose-vs-call distinction, the one-note guard and the retired literal.

**Residual risks.**
- DW-530 is resolved by correction, not by implementation. Its ledger premise is false — `POST /api/vaults`, `PATCH`/`DELETE /api/vaults/[id]`, the three agent-skill verbs and `POST /api/archive/import` write on a read-only deployment — so the panels got no refusal. Whether `YOPEDIA_READONLY` SHOULD cover them is DW-268's open operator-facing decision, and nothing here forecloses it; the tripwire makes the client mirror unforgettable when it is taken.
- The tripwire is a source scan over five routes and three writers. A gate landing further down the write path (`storage.ts`, `lock.ts`, `wiki.ts`'s `updateIndexUnsafe`) would not trip it — judged remote, since such a gate would redden hundreds of other suites first.
- The `read-only-copy-parity.test.ts` node suite now imports `GraphCanvas.tsx` and `ReviewCanvas.tsx` for their constants. That follows the suite's existing habit of importing client components for exported copy, but a future top-level browser-only import in either canvas would break a suite about strings.
- The `if (readOnly) return;` in both `confirmResearch` functions is unreachable today (the only opener refuses first), so no test exercises it. It is defence-in-depth for a future opener and now announces its reason rather than dropping the confirm silently.
- Two findings are recorded in frontmatter `deferred`: the Todos canvas still uses plain `disabled=` in front of a door that does refuse, and the Deep Research canvas hides its row controls under read-only rather than refusing them.
