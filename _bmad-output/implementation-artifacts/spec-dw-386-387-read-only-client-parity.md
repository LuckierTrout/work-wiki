---
title: 'Read-only client parity for Names & Terms, Email ingestion, the Research desk, and the three /settings sentences'
type: 'bugfix'
created: '2026-08-28'
status: 'done'
baseline_revision: '2b5d20f8c1e4584c32cd7e71dea4efd5ed16deff'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A fourth research refusal sentence lives one screen away, inline and
      unowned: the Workbench Deep Research canvas.
    evidence: |-
      `src/components/workbench/ResearchCanvas.tsx:265` renders the literal
      "Deep Research cannot start while this deployment is read-only." in front
      of `POST /api/research` and `POST /api/research/[id]/run` — the same two
      doors this change gave `RESEARCH_CREATE_READ_ONLY_COPY` and
      `RESEARCH_MUTATE_READ_ONLY_COPY`. It is not in `READ_ONLY_REFUSAL`, has no
      parity-suite entry, and is not character-identical to either sentence its
      doors answer, so the Workbench and the Studio now state one deployment
      state three ways. Pre-existing — the canvas is outside this bundle's
      surfaces — but it is the DW-387 shape on a surface DW-387 did not name.
    location: >-
      src/components/workbench/ResearchCanvas.tsx:265
    severity: medium
  - summary: >-
      The Knowledge Studio panels outside the Research desk still compose writes
      in front of doors that refuse, with no read-only term at all.
    evidence: |-
      `SetupPanel` POSTs `/api/vaults` (`src/components/KnowledgeStudio.tsx:412`),
      `SkillsPanel` creates, patches and deletes agent skills (968, 986, 1004),
      and `PortabilityPanel` imports an archive (1049). None reads `readOnly`,
      which the Studio now has on hand, so each still submits and meets its
      refusal afterwards — the DW-386 shape, on the panels this bundle's intent
      did not name (it justified `KnowledgeStudio` solely with "posts to
      `/api/research`"). Recorded in the `KnowledgeStudio.tsx` module note rather
      than widened into this change.
    location: >-
      src/components/KnowledgeStudio.tsx:412
    severity: medium
  - summary: >-
      Three Workbench canvases gate the read-only flag with plain `disabled=`,
      the DW-191/DW-299 shape the rest of the codebase argues against.
    evidence: |-
      `src/components/workbench/GraphCanvas.tsx:549,558` and
      `src/components/workbench/ReviewCanvas.tsx:230,242,250` pass `readOnly`
      straight into `disabled`, and `ResearchCanvas.tsx:259` folds it into
      `disabled={!canStart}`. A `disabled` control leaves the tab order, so the
      standing refusal cannot be reached or announced with its reason — the
      exact defect DW-191 and DW-299 removed from `/settings` and
      `WorkspacePurposeSettings`. Pre-existing; surfaced by this change only
      because its comments restate that rule as if it held everywhere.
    location: >-
      src/components/workbench/ReviewCanvas.tsx:230
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three surfaces compose a write in front of a door that already answers 403 and carry no `readOnly` term at all — `NamesTermsSettings`, `EmailIngestSettings` and `KnowledgeStudio`'s Research desk — so `READ_ONLY_REFUSAL.namesTerms`, `.emailSettings`, `.researchCreate` and `.researchMutate` have no client counterpart and no parity-test entry (DW-386). Separately, `/settings` states three different sentences for one deployment state — the page banner, `PUT /api/settings` and `POST /api/settings/rebuild-embeddings` — none owned by `READ_ONLY_REFUSAL` and none pinned by the parity suite (DW-387).

**Approach:** Give the three surfaces the same disabled-with-reason mirror the `/settings` form and `WorkspacePurposeSettings` already have — an exported client copy constant, `aria-disabled` (never `disabled`) on the standing refusal, an early-returning handler, and one identified note the refused controls point at through `aria-describedby`. Move the two SERVER sentences on `/settings` under `READ_ONLY_REFUSAL` (`settingsSave`, `embeddingRebuild`) in the module's house form, make the banner render the client mirror of `settingsSave` rather than a fourth wording, and extend `read-only-copy-parity.test.ts` to pin every new pair.

## Boundaries & Constraints

**Always:**
- Every new `READ_ONLY_REFUSAL` value obeys the invariants the suite already enforces: starts capitalised, ends in `.`, contains `while this deployment is read-only.`, and is distinct from every other value.
- A client constant that mirrors a door's sentence is CHARACTER-IDENTICAL to it; any deliberate narrowing is recorded in the parity suite as a difference.
- `READ_ONLY_REFUSAL` stays server-only: no `"use client"` module imports `@/lib/read-only`. Client copy lives beside its component (or in an already client-safe `src/lib` module) and is pinned by test.
- The standing read-only refusal is `aria-disabled` + an early-returning handler; `disabled` stays for TRANSIENT state only, so refused controls keep their place in the tab order and can be announced with their reason.
- A control that WRITES NOTHING is not refused (Email's **Copy address**, the form's **Test Connection**).
- A destructive `window.confirm` is refused BEFORE it opens, never in front of a 403.

**Block If:**
- Rewording `PUT /api/settings` would force a matching reword of `PUT /api/workspace-profile`'s inline literal (it must not: that route is a different door, keeps its literal, and its two parity assertions must stay green).

**Never:**
- Do not touch `src/app/api/workspace-profile/route.ts` or `WORKSPACE_PURPOSE_READ_ONLY_COPY`.
- Do not gate the Studio panels outside the Research desk (Setup, Skills, Portability, Compile, Sources, Connections) — their doors are not in this bundle. Record the gap rather than widening the change.
- Do not relax the parity suite's invariants to admit an existing wording.
- Do not add a second read-only fetch where the mounting surface already knows: `/settings` passes `readOnly` down as a prop.
- No `<fieldset disabled>` (the DW-191/DW-299 defect).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Names & Terms, read-only | `/settings` mounted with `readOnly` true | Submit and Remove are `aria-disabled`, still focusable, and describe the note carrying `NAMES_TERMS_READ_ONLY_COPY`; activating either sends no request | No error expected — the handler returns before `fetch` |
| Names & Terms, writable | `readOnly` false | No note rendered, no `aria-disabled`, save and remove behave as today | Existing feedback banner |
| Email ingestion, read-only | `readOnly` true | Save is `aria-disabled` and describes `EMAIL_INGEST_READ_ONLY_COPY`; **Copy address** stays live | Handler returns before `fetch` |
| Research desk, read-only | `GET /api/research` answers `readOnly: true` | Create, Run, Cancel, Collect and Delete are `aria-disabled` and describe the note for THEIR door's sentence; Delete opens no `window.confirm` | Handler returns before `fetch` |
| Rebuild embeddings, read-only | `/settings` with `readOnly` true | The Rebuild button describes `EMBEDDING_REBUILD_READ_ONLY_COPY`, not the form's save sentence | Handler already returns early |
| Any of the above reaching the door anyway | Flag flips after mount | The route answers 403 with the SAME sentence the surface displayed | 403 body mirrors the client copy |

</intent-contract>

## Code Map

- `src/lib/read-only.ts` -- `READ_ONLY_REFUSAL` (server sentence table) + module doc listing the client constants; add `settingsSave` and `embeddingRebuild`, extend the client-constant list. Invariants enforced at parity-test lines 288-301.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- the seam. `routeSource()` reads a handler's source; `servedAs()` pins `error: "…"` for INLINE literals; constant-served doors are pinned by NAME (`error: READ_ONLY_REFUSAL.x`, see the loop at line 267).
- `src/app/api/settings/route.ts:152-157` -- `PUT` gate, inline literal `"Settings are read-only in this deployment."`, served via `Response.json` (not `NextResponse.json`).
- `src/app/api/settings/rebuild-embeddings/route.ts:14-19` -- `POST` gate, inline literal `"Rebuilding embeddings is disabled in read-only mode."`.
- `src/app/api/workspace-profile/route.ts:92` -- serves the SAME literal the settings PUT does today and is pinned twice in the parity suite (lines 144, 186). Out of scope; leave untouched.
- `src/lib/workbench-settings.ts:231-233` -- `SETTINGS_READ_ONLY_COPY`, the Workbench save bar's client mirror of `PUT /api/settings` (`SETTINGS_ROUTE` at line 909). Client-safe module; consumed by `SettingsCanvas.tsx:1496` and four suites BY NAME, so a reword is safe.
- `src/app/settings/page.tsx:196-211` -- the read-only banner (`readOnlyNoteId`, `describedBy` at lines 60-61); `onSubmit` early-return at 99. Renders `<NamesTermsSettings />` and `<EmailIngestSettings />` at 340-341 with no props. Three suites assert the banner contains `"Read-only mode"` (`settings-page-read-only-controls.test.tsx:171,266,302`, `settings-page-legacy-surface-parity.test.tsx:573`) — keep that label.
- `src/components/WorkspacePurposeSettings.tsx:19-30,172-222,936-943` -- the golden example for this change: exported copy, `useId()` note, composed `describedBy`, `aria-disabled` controls, early-returning handlers.
- `src/components/EmbeddingSettings.tsx:107-133,220-237` -- Rebuild button; already `aria-disabled` + early return, but points at the PAGE banner (`describedBy`) rather than its own door's sentence.
- `src/components/NamesTermsSettings.tsx` -- `save()` (104), `remove()` (145, `window.confirm` at 146), submit button (308-313), Remove button (388-395). No `readOnly` term anywhere.
- `src/components/EmailIngestSettings.tsx` -- `save()` (69), `copyAddress()` (106, writes nothing), submit (280-287). No `readOnly` term anywhere.
- `src/components/KnowledgeStudio.tsx` -- `refresh()` (141-170) reads `/api/research`; `InsightsPanel.research()` (524) POSTs `/api/research`; `ResearchPanel` (578) owns `createProject` (614), `collect` (632, POSTs `/api/ingest/batch`), `runAutomated` (652), `cancel` (668), `remove` (686, `window.confirm` at 689). Panels receive props from lines 240-258.
- `src/app/api/research/route.ts:18-58` -- `GET` already calls `isReadOnly()` (to skip reconciliation); it is the natural place to serve `readOnly` to the Studio.
- `AGENTS.md` "Test environments" -- `*.test.tsx` ⇒ `dom` project (jsdom, mount here); `*.test.ts` ⇒ `node`. Suites must live under `__tests__`.

## Tasks & Acceptance

**Execution:**
- `src/lib/read-only.ts` -- add `settingsSave: "Settings cannot be changed while this deployment is read-only."` and `embeddingRebuild: "Embeddings cannot be rebuilt while this deployment is read-only."` with doc comments naming their doors and noting that `PUT /api/workspace-profile` keeps its own narrower literal; extend the module note's client-constant list with the five new mirrors -- one owner per server sentence.
- `src/app/api/settings/route.ts` -- import `READ_ONLY_REFUSAL` and serve `settingsSave` instead of the inline literal -- the door stops owning its own wording.
- `src/app/api/settings/rebuild-embeddings/route.ts` -- same, with `embeddingRebuild` -- ends the third `/settings` sentence.
- `src/lib/workbench-settings.ts` -- reword `SETTINGS_READ_ONLY_COPY` to the `settingsSave` sentence, character-identical, and say in its doc that the parity suite pins it -- the Workbench save bar and the route stay one sentence.
- `src/app/settings/page.tsx` -- render `SETTINGS_READ_ONLY_COPY` in the banner after the `Read-only mode` label; pass `readOnly` to `NamesTermsSettings` and `EmailIngestSettings` -- the page already knows the flag, so no second fetch.
- `src/components/EmbeddingSettings.tsx` -- export `EMBEDDING_REBUILD_READ_ONLY_COPY` (mirrors `embeddingRebuild`), render it as its own identified note while `readOnly`, and point the Rebuild button's `aria-describedby` at that note -- the owner reads the sentence the rebuild door will answer.
- `src/components/NamesTermsSettings.tsx` -- export `NAMES_TERMS_READ_ONLY_COPY` (mirrors `namesTerms`); accept optional `readOnly`/`describedBy` props; early-return from `save()` and from `remove()` BEFORE its `window.confirm`; mark the text inputs `readOnly`, the selects/buttons `aria-disabled`, and point them at a `useId()` note composed with the page's -- the DW-264/DW-265 shape.
- `src/components/EmailIngestSettings.tsx` -- same treatment with `EMAIL_INGEST_READ_ONLY_COPY` (mirrors `emailSettings`); leave **Copy address** live -- it writes nothing.
- `src/app/api/research/route.ts` -- add `readOnly: isReadOnly()` to the `GET` body -- the Studio's only read of that door becomes its source of truth for the flag.
- `src/components/KnowledgeStudio.tsx` -- export `RESEARCH_CREATE_READ_ONLY_COPY`, `RESEARCH_MUTATE_READ_ONLY_COPY` and `RESEARCH_COLLECT_READ_ONLY_COPY` (mirroring `researchCreate`, `researchMutate`, `ingest`); adopt `readOnly` from the `/api/research` body; pass it to `InsightsPanel` and `ResearchPanel`; refuse `research`, `createProject`, `runAutomated`, `cancel`, `collect` and `remove` (before its `window.confirm`) and render one identified note per distinct sentence -- three doors, three sentences, no per-row duplication. Document in a comment that the other Studio panels are NOT covered by this change.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- add the five client/server pairs, pin `settings/route.ts` and `settings/rebuild-embeddings/route.ts` as constant-served doors by NAME, and pin `SETTINGS_READ_ONLY_COPY` against `settingsSave` -- the drift this file exists for.
- `src/components/__tests__/names-terms-read-only.test.tsx`, `src/components/__tests__/email-ingest-read-only.test.tsx`, `src/components/__tests__/studio-research-read-only.test.tsx` -- new mounted suites covering the I/O matrix rows: refusal announced, control still focusable, no request sent, no `window.confirm` opened, and nothing rendered when writable.

**Acceptance Criteria:**
- Given a read-only deployment, when the owner opens `/settings`, then the banner, the Names & Terms note and the Email ingestion note each state the sentence the door BEHIND their controls answers, and the Rebuild button describes the embeddings sentence rather than the form's.
- Given a read-only deployment, when the owner activates any refused control on those surfaces, then no request is issued and no destructive confirm opens, while the control keeps its place in the tab order.
- Given a writable deployment, when the same surfaces mount, then no read-only note is rendered and no control is `aria-disabled` for that reason.
- Given `pnpm exec vitest run --project node src/lib/__tests__/read-only-copy-parity.test.ts`, when it runs, then every new client constant is pinned against its server sentence and both `/settings` doors are pinned as constant-served.

## Spec Change Log

## Review Triage Log

### 2026-08-28 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 8, low 2)
- defer: 3: (high 0, medium 2, low 1)
- reject: 6: (high 0, medium 1, low 5)
- addressed_findings:
  - `[medium]` `[patch]` The Studio's transport rationale was FALSE — it claimed `/studio` is `"use client"` from the page down, but `src/app/studio/page.tsx` is an `async` server component. Transport kept; the rationale in `KnowledgeStudio.tsx`, `api/research/route.ts` and the studio suite now states the true reason (the desk re-reads that door on every Refresh, so the flag and the projects it gates arrive in one answer).
  - `[medium]` `[patch]` `refresh()` put all eight mount GETs in one `Promise.all`, so an unrelated failure left `readOnly` false and every Research control live in front of four 403s. The `/api/research` read now settles on its own and the flag is adopted whenever its door answered.
  - `[medium]` `[patch]` Controls marked `aria-disabled` still mutated state: Names & Terms' Type select rewrote the draft (wiping role/organization/email), and Email's two destination selects and the accept checkbox still changed. Each `onChange` now early-returns.
  - `[medium]` `[patch]` Two policies for what a refused control names on one page. Now one: every refused control names ITS OWN door's sentence. `describedBy` dropped from both components and both call sites; the banner comment narrowed to the form's controls.
  - `[medium]` `[patch]` `InsightsPanel` rendered its refusal note on `readOnly` alone, describing no control when the insight list is empty; guarded on `insights.length > 0`, matching `ResearchPanel`.
  - `[medium]` `[patch]` Nothing pinned `GET /api/research` to serving `readOnly` — deleting that line shipped a desk that never refuses, all green. Two cases added to `research-route.test.ts`.
  - `[medium]` `[patch]` Nothing pinned the `/settings` page wiring or the banner's sentence — reverting either passed everything. The page suite's stubs now record props and the banner is asserted against `SETTINGS_READ_ONLY_COPY`.
  - `[medium]` `[patch]` The Insights panel's **Research this →** button was gated but never rendered by any suite. The insight stub is now non-empty and the button is asserted refused, named, and silent.
  - `[low]` `[patch]` `REBUILD_READ_ONLY_NOTE_ID` was a hardcoded module id where every other note uses `useId()`; two mounts collided. Now `useId()`.
  - `[low]` `[patch]` Email's save kept `disabled={saving || loading}` without yielding to `readOnly`, so a never-resolving mount GET took the one control carrying the sentence out of the tab order. The transient disable now yields to the standing refusal.

## Design Notes

The banner keeps its `Read-only mode` label and gains the pinned sentence after it, because three existing suites assert that label and the label is the visual heading, not the refusal:

```tsx
<strong>Read-only mode</strong> — {SETTINGS_READ_ONLY_COPY}
```

Five sentences will be visible on a read-only `/settings` (save, Workspace Purpose, Names & Terms, Email ingestion, Rebuild). That is the design, not the DW-387 defect: DW-387 is about one CONTROL reading one sentence before pressing and a different one after, and each of these notes states exactly what its own door answers.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-copy-parity.test.ts` -- expected: all pass, including the new pairs.
- `pnpm exec vitest run --project dom src/components/__tests__/names-terms-read-only.test.tsx src/components/__tests__/email-ingest-read-only.test.tsx src/components/__tests__/studio-research-read-only.test.tsx src/app/settings/__tests__` -- expected: all pass; the three `/settings` suites that assert `"Read-only mode"` stay green.
- `pnpm exec vitest run --project node` -- expected: no new failures against the baseline revision.
- `pnpm exec vitest run --project dom` -- expected: no new failures against the baseline revision (compare, do not assume green — a prior spec recorded a red dom baseline).
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm exec eslint src` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Every surface that composes a write in front of a read-only door on `/settings` and the Studio's Research desk now refuses BEFORE the request, names the sentence its own door answers, and keeps the refused control in the tab order. Two `/settings` server sentences moved under `READ_ONLY_REFUSAL` (`settingsSave`, `embeddingRebuild`), so the page banner, the Workbench save bar and both routes state one wording per door instead of three.

**Files changed.**
- `src/lib/read-only.ts` -- added `settingsSave` and `embeddingRebuild`; module note lists the six new client mirrors and why `SETTINGS_READ_ONLY_COPY` lives in `workbench-settings.ts`.
- `src/app/api/settings/route.ts`, `src/app/api/settings/rebuild-embeddings/route.ts` -- both inline 403 literals replaced by the constants.
- `src/app/api/research/route.ts` -- `GET` serves `readOnly: isReadOnly()`, the Studio's only source for the flag.
- `src/lib/workbench-settings.ts` -- `SETTINGS_READ_ONLY_COPY` reworded character-identical to `settingsSave`.
- `src/app/settings/page.tsx` -- banner renders that constant after its `Read-only mode` label; `readOnly` passed to the two sections.
- `src/components/EmbeddingSettings.tsx` -- `EMBEDDING_REBUILD_READ_ONLY_COPY` and its own `useId()` note; Rebuild names the embeddings sentence.
- `src/components/NamesTermsSettings.tsx`, `src/components/EmailIngestSettings.tsx` -- exported mirrors, `readOnly` prop, early-returning handlers (Remove refuses before its `window.confirm`), guarded `onChange`s, `aria-disabled` controls.
- `src/components/KnowledgeStudio.tsx` -- three research mirrors; the Research desk and the graph-insight create path refuse; other Studio panels documented as out of scope.
- `src/components/ProviderForm.tsx` -- stale cross-reference line number corrected.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- seven new pairs, both `/settings` doors pinned as constant-served.
- `src/lib/__tests__/research-route.test.ts` -- the `readOnly` field pinned on both flag states.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` -- Rebuild re-pinned to its own sentence; page wiring and banner copy pinned.
- `src/components/__tests__/names-terms-read-only.test.tsx`, `email-ingest-read-only.test.tsx`, `studio-research-read-only.test.tsx` -- new mounted suites (29 cases) covering every I/O matrix row.

**Review findings breakdown.** 10 patches applied, 3 deferred, 6 rejected, 0 intent gaps, 0 spec repairs.

**Follow-up review recommendation:** true. Patched severities: high 0, medium 8, low 2. Score = 3x8 + 1x2 = 26, which is at or above 5.

**Verification.**
- `pnpm exec vitest run --project node` -- 277 files, 6855 passed, 1 skipped, 0 failed.
- `pnpm exec vitest run --project dom` -- 229 failed / 659 passed, against a measured baseline of 229 failed / 627 passed at `2b5d20f8`: the identical 13-file pre-existing failure set (`window.localStorage` undefined in `src/components/workbench/__tests__`), +32 passing. No new failure.
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/research-route.test.ts` -- 45 passed.
- `pnpm exec vitest run --project dom` on the three new suites plus `src/app/settings/__tests__` -- 64 passed.
- `pnpm exec tsc --noEmit` -- clean. `pnpm exec eslint src` -- clean apart from three pre-existing `jsx-ast-utils` notices also present at baseline.
- Matrix audit: all six I/O rows are covered by cases that ran and passed. Each patch was reverted individually and re-run to confirm the new assertions are not vacuous.

**Residual risks.**
- The `dom` project is red at baseline on this machine, so the 13 Workbench suites protect nothing here; the comparison above is what stands in for them.
- The Studio learns the flag from a response body rather than the server page's props. It is refreshed with the data it gates, but a deployment that flips `YOPEDIA_READONLY` between a mount and a click still meets the 403 — which every door still answers with the sentence the surface displayed.
- Three deferred findings are recorded in frontmatter: a fourth research sentence in `ResearchCanvas.tsx`, the ungated Studio panels outside the Research desk, and three Workbench canvases still using plain `disabled=` for this flag.
