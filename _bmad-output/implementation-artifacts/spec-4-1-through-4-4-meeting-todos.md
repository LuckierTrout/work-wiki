---
title: 'Stories 4.1–4.4: Meeting Todos'
type: 'feature'
created: '2026-08-23'
status: 'done'
baseline_revision: '342d53fd822130c89b2ddfc174e180ebb229c1fc'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/.yoyo/learnings.md'
warnings:
  - multiple-goals
  - oversized
deferred:
  - summary: >-
      Overdue filter compares due strings to UTC YYYY-MM-DD, so local late-evening
      dates can land on the wrong day.
    evidence: |-
      TodosCanvas visible() uses toISOString().slice(0, 10) against item.due.
    location: >-
      src/components/workbench/TodosCanvas.tsx
    severity: low
  - summary: >-
      LLM due values are stored as uttered text; a relative phrase will not sort
      or mark overdue correctly.
    evidence: |-
      collapseTodoTitles keeps proposal.due verbatim; the date input expects ISO.
    location: >-
      src/lib/todos.ts
    severity: low
  - summary: >-
      Meeting extract targeting checks the task path or the first cited Source,
      not every cited Source on the compiled page.
    evidence: |-
      meetingExtractTarget returns on the first matching cited path.
    location: >-
      src/lib/source-meeting.ts
    severity: low
  - summary: >-
      Due sort/filter and the Open-empty-while-other-tabs-populated given are
      kernel-covered but not clicked in the canvas contract.
    evidence: |-
      todos-canvas.test.tsx covers tabs, Approve POST, dock, and empty copy only.
    location: >-
      src/components/workbench/__tests__/todos-canvas.test.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** After a Plaud or marked-meeting compile, the Workbench Todos rail is still the empty sentence. Christian cannot approve real aftermath actions, and Plaud’s own list must not become the list.

**Approach:** After a successful meeting compile, the kernel proposes Candidates (never auto-Todos). Workbench Todos is Candidates | Open | Done with due dates, owner delete, and Preview links back to the meeting Page or Source.

## Boundaries & Constraints

**Always:**
- Extract only when two-step Ingest succeeds (`!skipped`) and the Source is Plaud-origin (`origin === "plaud"`) or marked meeting. PPT/PDF/URL/office default off — no classifier. Failed or SHA256-skipped compiles enqueue no Candidates.
- Candidates are kernel JSON via `getStorage()` (AD-23), not `wiki/todos.md`, not frontmatter, not sidecar/`agent-workspace/`, not `action-items.json`. Shape: `{ id, wikiId, sourceId, pageSlug?, title, rationale, due?, speaker?, context?, decision?: approve|reject, decidedAt?, actor?, sourceMissing?, status?: open|done, createdAt, updatedAt }`. A Candidate is not a Todo until approve. Nothing auto-promotes (FR-27, NFR-8).
- Persist decision, timestamp, and actor on approve/reject. Rejected never appear in Open. Rejected and completed persist until owner delete — no TTL (AD-20). Completing keeps Source/Page links. Edit title/due after approve without breaking links (FR-28).
- Every Candidate/Todo links to the originating Source and the meeting Page when one exists. The meeting action docks Preview on the Page if present, otherwise the Source transcript (FR-29). Source delete marks `sourceMissing` — it does not delete Todos (FR-12).
- Do not copy Plaud action-item lists into Todos (FR-30). Extraction may read transcript + summary + compiled page and collapse duplicate titles into one Candidate. Precision over recall (SM-C2). A successful meeting extract always refreshes Candidates, including zero (“none found”).
- Mark as meeting (Sources or Preview) persists a kernel flag for that Source path. The next or already-queued compile reads the flag at run time and uses the FR-26 path. Marking does not invent a classifier and does not force a SHA-skip compile to extract.
- Workbench surface: rail Todos after Lint; badge = pending Candidate count, hidden at 0, accessible name `Todos, N todo candidates`; tabs Candidates | Open | Done; empty Candidates copy exactly `No candidates. Meeting ingest will propose them.`; Open may be empty while other tabs have items; Approve is the one primary; Reject is a destructive ghost (red label, no filled red bar); both in the tab order, not hover-only; bulk Approve/Reject in the toolbar. Copy `This Source is not a meeting. Mark as meeting to extract Todos.` on a non-meeting Source. English-only. System sans chrome; Georgia stays Preview body. No sidecar required.
- Todo APIs: `requireOwnerPrincipal`; unauthenticated → 401 `Sign in required.` Read-only → 403 via `assertWritable`. Frozen `yopedia` / `WORKWIKI_*` identifiers. Page writes still go through `lifecycle.ts` only.

**Block If:**
- Satisfying an AC requires Plaud OAuth, office/email extract, Chat/sidecar Agent, Graph, Review UI, Deep Research, MCP/skill/shell, `wiki/todos.md`, or renaming a frozen identifier.
- Extraction would run in the sidecar or the browser, or Candidates would persist only in localStorage.
- Meeting extract would write through `proposeActionItems` / `/api/action-items` / `ActionInbox`.

**Never:**
- Auto-approve or copy Plaud’s action-item section into Todos.
- A meeting classifier on PPT/PDF/URL/office.
- Candidates from skipped or failed compiles.
- Silent Todo delete on Source cascade.
- Mounting `/tasks` `ActionInbox` as the Workbench Todos canvas.
- Editing `SCHEMA.md` or `llm-wiki.md` to steer extraction — load `loadPageConventions()` at runtime.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Plaud compile succeeds | `task.origin === "plaud"`, `!skipped` | Enqueue meeting extract; zero or more Candidates stored; badge/list refresh including none found | Extract failure visible + retryable; Source/Page already written |
| Marked-meeting compile | Source flag `meeting` true, `!skipped` | Same FR-26 extract as Plaud | Same |
| Non-meeting compile | Not Plaud, not marked | No Candidates; legacy `extract-actions` may still run | No error expected |
| SHA skip / failed compile | `result.skipped` or ingest throw | No Candidates from that compile | Skip: job `skipped`; fail: existing retry |
| Mark as meeting | Non-Plaud Source, Sources or Preview | Flag persists; next/queued compile uses FR-26; copy available on non-meeting Source | 401/403 on write |
| Approve / Reject | Pending Candidate, single or bulk | Decision + timestamp + actor stored; approve → Open; reject never in Open; no auto-promote | 401/403; read-only disables controls |
| Open / Done | Approved Todo | Set/clear due; edit title/due; mark done (links remain); sort/filter due + status; owner delete | Empty Open does not hide other tabs |
| Meeting link | Candidate or Todo with Source and optional Page | One action docks Preview on Page if it exists, else Source transcript | `sourceMissing` stays inspectable; no silent drop |
| Source cascade | Confirm-gated Source delete | Linked Candidates/Todos get `sourceMissing`; items remain | Cascade still marks legacy action-items too |
| Unauthenticated API | No principal | 401 `Sign in required.` | No leak of items |

</intent-contract>

## Code Map

- `src/lib/action-items.ts` / `src/lib/action-extractor.ts` / `src/app/api/action-items/**` / `src/components/ActionInbox.tsx` -- Legacy non-Plaud inbox (`inbox\|accepted\|dismissed\|done`, `tenants/{t}/action-items.json`). **Read-only for this epic.** Do not route meeting Candidates through `proposeActionItems`. Keep Plaud skip of `extract-actions` (`tasks.ts:86-87`, `tasks/run/route.ts:494-500`).
- `src/app/api/tasks/run/route.ts:436-544` -- After `ingest()`, `result.skipped` returns with no post-hooks (`:436-449`). Successful compile enqueues `extract-actions` (non-Plaud), `extract-knowledge`, after-ingest agents. **Hook here:** if Plaud or meeting-marked, enqueue `extract-todo-candidates` (not inline LLM in the ingest request). Failed compile catch (`:564-656`) stays extract-free.
- `src/lib/tasks.ts:86-87,107-110,201-213,503-516` -- Add task kind `extract-todo-candidates` (`slug`, `owner`, `sourcePath?`) to the union **and** `TASK_KINDS` (tsc pins both directions). Parse like `extract-actions`.
- `src/lib/ingest.ts` / `src/lib/ingest-analysis.ts` / `src/lib/schema.ts:52-68` -- Two-step compile already kernel-owned. Extract reads compiled page + cited raw Sources (`parseSources`). Load `loadPageConventions()` into the extract prompt. Do not add a second page writer.
- `src/lib/types.ts:102-120` / `src/lib/sources.ts:30-41,134-148` -- `SourceEntry.origin?: "plaud"` only. Do not stuff `meeting` into YAML `sources[]` (frontmatter parser + cascade identity). Meeting flag is a separate kernel record keyed by Source path.
- `src/lib/source-cascade.ts:8-12,280-286` -- Already calls `markActionItemsSourceMissing`. Also mark kernel Todos `sourceMissing` using the same `sourceIdentityKeys`. Do not delete Todos.
- `src/lib/chat.ts:155-195` -- Persistence pattern: `tenants/{t}/….json` + `withFileLock`. Mirror for Todos (CAS/lock, not a markdown page).
- `src/lib/owner-route.ts:8-14` -- `requireOwnerPrincipal` + 401 `Sign in required.` (same as Chat).
- `src/lib/read-only.ts` -- `assertWritable` on Todo writes.
- `src/lib/workbench-request.ts:57-88,227` -- Client `send` / `writeFailure` for Todos + mark-as-meeting.
- `src/lib/workbench-modes.ts:46,63-66,115-117` -- Keep empty copy and `BADGE_MODE_NOUNS.todos`. Add the non-meeting sentence here (one definition). Do not inline copy in the canvas.
- `src/lib/workbench-tree.ts:417-423` -- `shouldDockPreview` is wiki/chat/search only. Extend with `"todos"` so a meeting link docks Preview. `selectionFromContentPath` already maps `wiki/<slug>.md` and `raw/sources/…`.
- `src/components/workbench/ModeCanvas.tsx:137-179` -- Chat/Search stay mounted-hidden. Replace the Todos stub with a stay-mounted `TodosCanvas` the same way. Do not unmount Wiki.
- `src/components/workbench/IconRail.tsx:43-72` / `Workbench.tsx:162,189,1387` / `src/app/page.tsx:137` -- `todoCount` exists and defaults 0; home does not pass it. Drive the badge from pending Candidate count (client fetch after load is fine; do not invent a second rail).
- `src/components/workbench/SourcesTree.tsx` / `PreviewColumn.tsx:1089-1131` -- Mark as meeting on a `raw/sources/` pick (Sources tree and/or Preview header). Confirm-gated Source delete already lives on the tree (`Workbench.tsx` `onDelete`).
- `src/lib/portable-archive.ts:67-91` -- Tenant walk already ships any new `tenants/{t}/*.json`. No filename rename. Add a test that Todos ride along (do not put Todos in Obsidian stubs).
- `src/lib/__tests__/tasks-route.test.ts:692-738` -- Extend: Plaud success enqueues `extract-todo-candidates`; skip/fail does not; non-meeting does not; marked-meeting does.
- `src/lib/__tests__/lifecycle.test.ts:1210-1224` -- Cascade already pins legacy action-items `sourceMissing`. Add the same assertion on kernel Todos.
- `src/lib/__tests__/workbench-tree.test.ts:251-267` -- Today `todos` is in the “never dock” set. Flip Todos to dock when a selection exists.
- `_bmad-output/planning-artifacts/ux-designs/ux-work-wiki-2026-08-12/mockups/todos.html` -- Density/chrome reference (seg tabs, primary Approve, ghost Reject, path row, toolbar bulk). Do not invent a restyle.
- `sidecar/` -- Read-only. Todos must work with the sidecar down.

New (expected):
- `src/lib/todos.ts` -- Kernel SoR `tenants/{t}/todos.json`: enqueue/replace pending for a source, list by tab, approve/reject (bulk), patch title/due/status, delete, `markTodosSourceMissing`.
- `src/lib/source-meeting.ts` -- Kernel flag map Source path → meeting. Read at ingest-run and from Preview/Sources.
- `src/lib/todo-extract.ts` -- Meeting-only LLM extract → `enqueueTodoCandidates`. Prompt: commitments from transcript/summary/page; do not copy Plaud action lists; collapse dup titles; optional due/speaker/context; `loadPageConventions()`.
- `src/app/api/todos/route.ts` / `src/app/api/todos/[id]/route.ts` -- Owner list + mutate. 401/403.
- `src/app/api/sources/meeting/route.ts` -- Persist Mark as meeting.
- `src/components/workbench/TodosCanvas.tsx` -- Candidates | Open | Done; cards; bulk; sort/filter; meeting link → `onDockPreview(selectionFromContentPath)`; source-missing.

## Tasks & Acceptance

**Execution:**
- `src/lib/todos.ts` + `src/lib/source-meeting.ts` -- Kernel persist (lock + `getStorage()`). Replace pending Candidates for a Source on a new successful extract; keep decided rows. Identity keys match cascade (`sourceId` = Source path / `raw_id` keys).
- `src/lib/todo-extract.ts` + `src/lib/tasks.ts` + `src/app/api/tasks/run/route.ts` -- Gate + enqueue + run extract only after successful meeting compile. Visible/retryable failure. Never on skip/fail/non-meeting. Do not call `proposeActionItems`.
- `src/app/api/todos/**` + `src/app/api/sources/meeting/route.ts` -- `requireOwnerPrincipal`, 401, `assertWritable`.
- `src/lib/source-cascade.ts` -- `markTodosSourceMissing` beside the action-items mark.
- `src/lib/workbench-modes.ts` + `workbench-tree.ts` + `ModeCanvas.tsx` + `TodosCanvas.tsx` + `Workbench.tsx` / `page.tsx` / `PreviewColumn.tsx` / `SourcesTree.tsx` -- Todos surface, badge, mark-as-meeting, dock Preview, stay-mounted hidden like Chat/Search.
- `src/lib/__tests__/todos.test.ts` + `todo-extract.test.ts` + `tasks-route.test.ts` + `lifecycle.test.ts` + `workbench-tree.test.ts` + canvas contract tests -- Pin the I/O matrix (gate, skip, none-found, HITL, links, cascade, 401, copy).

**Acceptance Criteria:**
- Given a Plaud-origin or marked-meeting Source, when two-step Ingest succeeds, then zero or more Candidates are stored (title, rationale, optional due, speaker/context if present) and the Candidates list updates, including none found.
- Given a Source that is not Plaud-origin and not marked meeting, when Ingest succeeds, then no Candidates are created.
- Given Ingest fails or is SHA256-skipped, when that job ends, then no Candidates are created from that compile, and Plaud action-item lists are not copied into Todos.
- Given a non-Plaud Source, when I choose Mark as meeting on Sources or Preview, then the next or queued Ingest for that Source uses the FR-26 path.
- Given Candidates exist, when I open Todos, then I see Candidates | Open | Done, each Candidate has Approve (primary) and Reject (destructive ghost) in the tab order, and the rail badge shows pending count as `N todo candidates` when non-zero.
- Given I Approve or Reject (single or bulk), when the decision saves, then nothing auto-promotes, decision/timestamp/actor are stored, and rejected Candidates never appear in Open.
- Given Candidates is empty, when the list shows, then copy is `No candidates. Meeting ingest will propose them.`
- Given an approved Todo, when I view Open, then I can set or clear a due date, mark done, edit title/due without breaking Source/Page links, and sort/filter by due date and status.
- Given I complete a Todo, when it moves to Done, then links remain, and rejected Candidates and completed Todos persist until I delete them.
- Given Open is empty, when Candidates or Done still have items, then Open can be empty without hiding the other tabs.
- Given a Candidate or Todo from a meeting Ingest, when I follow its meeting link, then Preview opens the meeting Page if one exists, otherwise the Source transcript.
- Given I delete that Source, when I look at linked Todos, then they show source-missing and are not silently deleted.
- Given I am signed out, when I call a Todo API, then the response is 401.

## Spec Change Log

## Review Triage Log

### 2026-08-23 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 15: (high 1, medium 8, low 6)
- defer: 4: (high 0, medium 0, low 4)
- reject: 14
- addressed_findings:
  - `[high]` `[patch]` Bump dataVersion after Todo store writes so the rail badge and list refresh after extract
  - `[medium]` `[patch]` assertWritable on extract-error and source-missing writes
  - `[medium]` `[patch]` Stamp Plaud meeting flag in dispatch so inline ingest and Retry see a meeting Source
  - `[medium]` `[patch]` Retry returns 409 when dispatch skips instead of claiming success
  - `[medium]` `[patch]` Toolbar Approve/Reject acts only on the selected set
  - `[medium]` `[patch]` Failed Todos load clears stale items
  - `[medium]` `[patch]` Pin ingest-async dispatch, queued extract error, GET tab, retry, Plaud flag, Approve POST, and TodosCanvas mount
  - `[low]` `[patch]` Trim extract slugs; require sourceId; keep decided rows under the store cap; tolerate corrupt JSON; sequence badge fetches; do not treat a failed meeting GET as “not a meeting”

## Design Notes

Kernel Todos are a new JSON SoR, not a rename of `action-items.json`. Legacy `/tasks` extract-actions stays for non-Plaud pages; mixing those inbox rows into Candidates would violate the meeting-only rule.

Mark-as-meeting is a path-keyed flag read at compile run. A SHA-skip still creates no Candidates (the skip *is* that compile). Replacing pending Candidates on a later successful meeting extract keeps decided rows so a re-compile cannot un-approve.

Extraction prompt must say: propose commitments implied by the transcript/summary/page; do not transcribe a Plaud “Action items” list. If both artifacts are cited on the compiled page, read both and collapse duplicate titles.

```ts
// enqueue after successful meeting compile — not inside ingest.ts page write
if (!result.skipped && isMeetingSource) {
  await enqueueTask({ kind: "extract-todo-candidates", slug, owner, sourcePath });
}
```

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean
- `pnpm exec vitest run src/lib/__tests__/todos.test.ts src/lib/__tests__/todo-extract.test.ts src/lib/__tests__/tasks-route.test.ts src/lib/__tests__/lifecycle.test.ts src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-modes.test.ts src/components/workbench/__tests__/icon-rail.test.tsx` -- expected: pass, I/O matrix pinned
- `pnpm exec vitest run src/lib/__tests__/brand-copy.test.ts` -- expected: no new frozen-identifier drift

## Auto Run Result

Status: done

**Summary:** Stories 4.1–4.4 ship kernel meeting Todos. Successful Plaud or marked-meeting compiles enqueue (or inline) Candidate extract. Workbench Todos is Candidates | Open | Done with approve/reject, dues, owner delete, Preview links, and source-missing after cascade.

**Files:** New kernel/API/canvas (`todos.ts`, `todo-extract.ts`, `todo-dispatch.ts`, `source-meeting.ts`, `/api/todos`, `/api/sources/meeting`, `TodosCanvas`, `MarkMeetingControl`). Ingest/task hooks, cascade, rail badge, Preview dock, archive inclusion.

**Review:** 15 patches applied (1 high, 8 medium, 6 low). 4 low items deferred on the spec. 14 findings rejected (extract-now on SHA-skip, dual meeting links, ActionInbox reuse, cosmetic chrome).

**Follow-up review:** true — 1 high patch; score `3 × 8 medium + 6 low = 30`.

**Verification:** `pnpm exec tsc --noEmit` clean. Spec suite plus review pins: 452 tests green. No browser E2E; closest substitute is canvas/RTL + route/kernel tests.

**Residual risks:** Extract still needs an LLM key. Relative due phrases from the model will not sort. Mark-as-meeting on an already-compiled SHA-identical Source waits for a later non-skip compile, by spec.
