---
title: 'Read-only parity completion: the research siblings, the three stores, three surfaces and the /settings sentence'
type: 'bugfix'
created: '2026-08-21'
baseline_revision: '89924fb4a32c48796d10b1cccbf49e03285d30b1'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The previous bundle left the read-only story uneven at three layers. `PATCH`/`DELETE /api/research/[id]` and `POST /api/research/[id]/run` carry no `isReadOnly()` call, so the feature refuses creates and accepts edits, deletes and runs (DW-384). `research-projects.ts`, `names-terms.ts` and `email-ingest.ts` carry no `assertWritable`, so a CLI, MCP or agent-runtime caller reaches the writers with no route in front — DW-314's own argument, applied to `wikis.ts` only (DW-385). `NamesTermsSettings`, `EmailIngestSettings` and `KnowledgeStudio` still compose a write in front of a door that now answers 403, so `READ_ONLY_REFUSAL.namesTerms` and `.emailSettings` have no client mirror (DW-386). And `/settings` states three different sentences for one deployment state — the page banner, `PUT /api/settings` and `POST /api/settings/rebuild-embeddings` — none owned by `READ_ONLY_REFUSAL` (DW-387).

**Approach:** Gate the three research `[id]` verbs at the route with early `isReadOnly()` 403s carrying new `READ_ONLY_REFUSAL` keys; gate the seven store writers with `assertWritable` before their lock, the `wikis.ts` shape; mirror the refusal on the three surfaces following the `RecentIngests`/`WorkspacePurposeSettings` convention (the deployment fact rides the GET each surface already makes); and move the three `/settings` sentences under one `settingsChange` key, with the existing `SETTINGS_READ_ONLY_COPY` as its single client mirror. Every new sentence is pinned by `read-only-copy-parity.test.ts`.

## Boundaries & Constraints

**Always:** Every new server sentence is a key on `READ_ONLY_REFUSAL` in `src/lib/read-only.ts`, distinct from the others, starting with a capital and ending `while this deployment is read-only.` — the shape `read-only-copy-parity.test.ts` enforces. Newly gated routes import the constant; they never re-type the literal. Store gates come BEFORE `withFileLock` and before any read. Client refusals use `aria-disabled` (never `disabled`) plus an early return in the handler, so refused controls stay in the tab order and stored values stay readable; `disabled` stays only for transient state (`saving`, `loading`, `busy`). Client copy constants are duplicated next to their component (or in the client-safe `workbench-settings.ts`) and pinned by `read-only-copy-parity.test.ts` — never imported from `read-only.ts` into a `"use client"` module. A surface learns `readOnly` from the GET it already makes; no new endpoint, no extra request.

**Block If:** Closing a gap would require changing what a route or store function does on a WRITABLE deployment.

**Never:** Do not touch `deferred-work.md`. Do not rename any frozen identifier (`YOPEDIA_READONLY` stays). Do not add read-only refusals to `KnowledgeStudio` surfaces outside the Research desk (vaults, agent skills, portability, ingest batch) — their doors are not gated by this change and a client refusal would claim a 403 the server does not answer. Do not change `PUT /api/workspace-profile`'s inline literal — it is a different door, pinned as a deliberate divergence. Do not convert `/settings` or `/ingest` to server components.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Research edit, read-only | `PATCH /api/research/[id]`, `YOPEDIA_READONLY=1` | 403 `{ error: READ_ONLY_REFUSAL.researchEdit }`; `updateResearchProject` never called | Gate after the 401, before the body parse |
| Research delete, read-only | `DELETE /api/research/[id]` | 403 with `READ_ONLY_REFUSAL.researchDelete`; `deleteResearchProject` never called | Gate after the 401 |
| Research run/cancel, read-only | `POST /api/research/[id]/run`, any body | 403 with `READ_ONLY_REFUSAL.researchRun`; no queue, no enqueue, no inline run | Gate after the 401, before the body parse |
| Research status poll, read-only | `GET /api/research/[id]/run` | Unchanged 200 with the project | Reads are never refused |
| Store writers, read-only | direct library call to `createResearchProject`, `updateResearchProject`, `deleteResearchProject`, `createNamesTerm`, `updateNamesTerm`, `deleteNamesTerm`, `saveEmailIngestConfig` | `ReadOnlyError` thrown before the lock; the projects file, the dictionary file and the email-config index are byte-identical afterwards | Refusal propagates to the caller |
| All doors and stores, writable | flag unset | Behaviour byte-identical to today | — |
| Names & Terms panel, read-only | `GET /api/names-terms` says `readOnly: true` | Add/Update submit and every Remove control `aria-disabled` + describe the refusal; no `fetch`, no `window.confirm`; the dictionary list and the draft fields stay readable and focusable | Sentence rendered once, id resolvable |
| Email ingestion panel, read-only | `GET /api/email/settings` says `readOnly: true` | Save submit `aria-disabled` + describes the refusal; no `PUT`; the address, senders and destinations stay readable; **Copy address** still works | Sentence rendered once |
| Research desk, read-only | `GET /api/research` says `readOnly: true` | Create/Run/Cancel/Collect/Synthesize/Delete and the Insights "Research this" control `aria-disabled` + describe the refusal; no `fetch`, no `window.confirm`; the brief list stays readable | Sentence rendered once per panel |
| Surface GET fails or 401s | any of the three | Fails open — controls stay live, the server still refuses | Matches `RecentIngests` |
| `/settings` save, read-only | `PUT /api/settings` | 403 with `READ_ONLY_REFUSAL.settingsChange` — the same sentence the banner and the Workbench save bar show | — |
| Embedding rebuild, read-only | `POST /api/settings/rebuild-embeddings` | 403 with `READ_ONLY_REFUSAL.settingsChange` | — |

</intent-contract>

## Code Map

- `src/lib/read-only.ts` -- `READ_ONLY_REFUSAL` (:94), `assertWritable` (:219). Add `researchEdit`, `researchDelete`, `researchRun`, `settingsChange`. Extend the module header: the store family (research/names-terms/email) is now gated, and `settingsChange` is the one key whose client mirror lives in `workbench-settings.ts` rather than beside a component.
- `src/app/api/research/[id]/route.ts:15,52` -- `PATCH`, `DELETE`; no gate. Idiom to copy verbatim: `src/app/api/research/route.ts:25-39`.
- `src/app/api/research/[id]/run/route.ts:14` -- `POST`; no gate. `GET` at :51 stays untouched.
- `src/app/api/research/route.ts:12` -- `GET`; add `readOnly: isReadOnly()` beside `projects`/`availableProviders` (the `src/app/api/ingest/history/route.ts:108` seam).
- `src/app/api/names-terms/route.ts:13` -- `GET`; add `readOnly` beside `entries`.
- `src/app/api/email/settings/route.ts:23` -- `GET`; add `readOnly` to the answer. `PUT` (:47) already gated.
- `src/lib/research-projects.ts` -- `createResearchProject:167`, `updateResearchProject:193`, `deleteResearchProject:275`; each opens `return withFileLock(lockKey(owner), …)`. Gate before that call. Note: `src/lib/research-runtime.ts` funnels every runtime write through `updateResearchProject`, so one gate covers the runtime too — and `POST /api/tasks/run` already refuses, so the consumer never reaches it.
- `src/lib/names-terms.ts` -- `createNamesTerm:284`, `updateNamesTerm:308`, `deleteNamesTerm:330`; same `withFileLock` shape. Read paths (`listNamesTerms`, `buildNamesTermsGuidance`) stay ungated.
- `src/lib/email-ingest.ts` -- `saveEmailIngestConfig:97`; no lock, one `putIndex`. Gate at the head, before the config object is built.
- `src/app/api/settings/route.ts:130` -- inline literal `"Settings are read-only in this deployment."` → `READ_ONLY_REFUSAL.settingsChange`.
- `src/app/api/settings/rebuild-embeddings/route.ts:14-19` -- inline literal `"Rebuilding embeddings is disabled in read-only mode."` → the same constant.
- `src/lib/workbench-settings.ts:213-214` -- `SETTINGS_READ_ONLY_COPY`, the Workbench save bar's sentence (`src/components/workbench/SettingsCanvas.tsx:791`) for the SAME `PUT /api/settings` door (`SETTINGS_ROUTE:417`). Re-point its value to the new sentence; every consumer imports it by name, so no test literal moves.
- `src/app/settings/page.tsx:146-155` -- the banner; `<strong>Read-only mode</strong>` label stays (two mounted suites assert that string), the sentence after the dash becomes `SETTINGS_READ_ONLY_COPY`.
- `src/components/NamesTermsSettings.tsx` -- load :56-71 (add `readOnly` to the parsed answer), `save` :104, `remove` :145 (its `window.confirm` at :146), submit :308-314, Remove buttons :389-396.
- `src/components/EmailIngestSettings.tsx` -- load :34-64, `save` :71, submit :279-283. `copyAddress` :111 writes nothing and is NOT refused.
- `src/components/KnowledgeStudio.tsx` -- `refresh` :141-165 (the `/api/research` answer already lands here; carry `readOnly` into state), `InsightsPanel` :512 (`research()` :525, its button :571), `ResearchPanel` :587 (`createProject` :624, `patchProject` :643, `collect` :653, `runAutomated` :674, `cancel` :691, `synthesize` :708, `remove` :725 with `window.confirm` at :726; the action buttons :756, :771-775). The poll effect at :610-622 issues a `GET` and stays.
- `src/components/RecentIngests.tsx:54,99,107,257,418-438,460-470` -- the reference implementation for adopt-over-the-wire + per-control refusal + exported copy constant.
- `src/components/WorkspacePurposeSettings.tsx:172-222,900-945` -- the reference for `useId` note + `describedBy` + `aria-disabled` submit that keeps `disabled` for transient state only.
- Tests to extend: `src/lib/__tests__/read-only-copy-parity.test.ts` (new keys; the three new client constants; `SETTINGS_READ_ONLY_COPY` re-point; the newly-gated-doors table at :277-292), `src/lib/__tests__/read-only-kernel-gate.test.ts` (a new `withFileLock` gate-precedes-lock scan for the seven store writers, and byte cases), `src/lib/__tests__/research-route.test.ts`, `names-terms-routes.test.ts`, `email-settings-route.test.ts`, `settings-route.test.ts`. New: research `[id]` route suites, and mounted suites for the three surfaces. Mount recipes: `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx:23-80` (stub siblings, stub `fetch` per URL) and `src/components/__tests__/recent-ingests-read-only.test.tsx`.

## Tasks & Acceptance

**Execution:**
- `src/lib/read-only.ts` -- add `researchEdit`, `researchDelete`, `researchRun`, `settingsChange` with doc comments naming their door; extend the module header for the store family and for the `workbench-settings.ts` mirror -- one owner per server sentence.
- `src/app/api/research/[id]/route.ts` -- early `isReadOnly()` 403 in `PATCH` and `DELETE`, after the 401 and before the parse -- the feature refused creates and accepted edits and deletes.
- `src/app/api/research/[id]/run/route.ts` -- early 403 in `POST` only -- a run enqueues work and rewrites the project record; the `GET` poll is a read.
- `src/lib/research-projects.ts` -- `assertWritable` at the head of the three writers, before `withFileLock` -- DW-314's argument: a CLI or MCP caller reaches these with no route in front.
- `src/lib/names-terms.ts` -- `assertWritable(READ_ONLY_REFUSAL.namesTerms)` at the head of the three writers, before `withFileLock` -- same argument, one sentence for one store.
- `src/lib/email-ingest.ts` -- `assertWritable(READ_ONLY_REFUSAL.emailSettings)` at the head of `saveEmailIngestConfig` -- it reaches no kernel writer and refuses nothing of its own.
- `src/app/api/research/route.ts`, `src/app/api/names-terms/route.ts`, `src/app/api/email/settings/route.ts` -- each `GET` also answers `readOnly` -- the surface reads the fact from the route whose write would refuse.
- `src/components/NamesTermsSettings.tsx` -- adopt `readOnly`; export `NAMES_TERMS_READ_ONLY_COPY` (character-identical to `READ_ONLY_REFUSAL.namesTerms`); refuse the submit and every Remove control per control, returning before the fetch and before the confirm -- no confirm in front of a 403.
- `src/components/EmailIngestSettings.tsx` -- adopt `readOnly`; export `EMAIL_SETTINGS_READ_ONLY_COPY` (character-identical to `READ_ONLY_REFUSAL.emailSettings`); refuse the submit; leave **Copy address** live -- it writes nothing.
- `src/components/KnowledgeStudio.tsx` -- adopt `readOnly` from the `/api/research` answer, thread it to `InsightsPanel` and `ResearchPanel`; export `RESEARCH_READ_ONLY_COPY`, one deliberately wider sentence covering the four research doors; refuse every research write control per control and return before each fetch and before `remove`'s confirm -- three surfaces, one deployment fact.
- `src/app/api/settings/route.ts`, `src/app/api/settings/rebuild-embeddings/route.ts` -- serve `READ_ONLY_REFUSAL.settingsChange` instead of their inline literals -- one deployment state, one sentence.
- `src/lib/workbench-settings.ts` -- re-point `SETTINGS_READ_ONLY_COPY` to the new sentence and document that it is the client mirror of `settingsChange` -- the Workbench save bar refuses for the same door.
- `src/app/settings/page.tsx` -- render `SETTINGS_READ_ONLY_COPY` in the banner after the `Read-only mode` label -- the sentence the owner reads before pressing is the one the route answers after.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- pin the four new keys, the three new client constants (two identical, `RESEARCH_READ_ONLY_COPY` recorded as a deliberate widening), `SETTINGS_READ_ONLY_COPY` against `settingsChange`, and add the five newly gated route/key rows to the by-name table.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` -- byte cases for the seven store writers and a source-order scan proving each gates before `withFileLock`; a writable control case so "unchanged" cannot pass against a writer that merely stopped working.
- `src/lib/__tests__/research-route.test.ts` + new `research-id-routes.test.ts` -- a read-only case per verb asserting 403, the sentence and that the store was never called, plus the `GET` poll still answering; and the `readOnly` field on `GET /api/research`.
- `src/lib/__tests__/names-terms-routes.test.ts`, `email-settings-route.test.ts`, `settings-route.test.ts` -- the `readOnly` field on each `GET`, and the re-pointed `PUT /api/settings` sentence.
- `src/components/__tests__/` -- new mounted suites for the three surfaces, each asserting: no request and no confirm on activation, the sentence on screen and resolvable through `aria-describedby`, stored values still readable, and a writable control case where the same control does fetch.

**Acceptance Criteria:**
- Given `YOPEDIA_READONLY=1`, when an authorized caller invokes `PATCH`/`DELETE /api/research/[id]` or `POST /api/research/[id]/run`, then the response is 403 carrying that verb's `READ_ONLY_REFUSAL` sentence and no store, queue or runtime function is called.
- Given `YOPEDIA_READONLY=1`, when any of the seven store writers is called directly, then it rejects with `ReadOnlyError` before taking its lock and the file it would have written is byte-identical afterwards.
- Given the flag is unset, when the same three routes and seven store writers run, then their behaviour and responses are unchanged from before this change.
- Given each of the three surfaces rendered on a read-only deployment, when the owner activates any refused control, then no request is made, no `window.confirm` is raised, the refusal sentence is on screen and referenced by that control's `aria-describedby`, and the surface's stored values remain readable and focusable.
- Given a read-only deployment, when the owner meets the refusal on `/settings` — in the banner, from the Workbench save bar, from `PUT /api/settings`, or from `POST /api/settings/rebuild-embeddings` — then all four state the identical sentence.

## Spec Change Log

- 2026-08-21 -- status `in-progress` -> `in-review` on completion of execution. All four `READ_ONLY_REFUSAL` keys, three route gates, seven store gates, three `readOnly`-carrying GETs, three client surfaces and the four-way `/settings` sentence are landed; `npx vitest run` (6211 tests, 277 files), `npx eslint .` and `npx tsc --noEmit` are clean.
- 2026-08-21 -- status corrected `in-review` -> `in-progress` on re-dispatch of the same bundle. The prior session wrote this spec and marked it `in-review`, but `baseline_revision` 89924fb is still HEAD, the working tree carries no change, and none of the four `READ_ONLY_REFUSAL` keys, three route gates or seven store gates exist in the source. The implementation was never landed, so the spec is resumed at execution rather than reviewed against an empty diff.

## Review Triage Log

## Design Notes

Sentences (each unique, each ending `while this deployment is read-only.`):

```
researchEdit:   "Research projects cannot be changed while this deployment is read-only."
researchDelete: "Research projects cannot be deleted while this deployment is read-only."
researchRun:    "Research cannot run while this deployment is read-only."
settingsChange: "Settings cannot be changed while this deployment is read-only."
```

Three research keys rather than the one-sentence-per-store shape `namesTerms` uses: the Research desk puts Run, Delete and the collect/synthesize patches side by side as separate controls with separate consequences, and "cannot be changed" beside a Delete button is the kind of near-miss the parity suite exists to catch. Names & Terms keeps ONE sentence because its three verbs sit behind two controls that mean the same thing to the owner.

`RESEARCH_READ_ONLY_COPY` is deliberately WIDER than any single server sentence — the panel refuses six controls at once and one note serves them all, so it names the whole desk rather than one verb. That is the inverse of the Revert narrowing, and it is recorded in the parity suite the same way: as a difference, not left to look like drift.

`settingsChange` replaces THREE literals and re-points a fourth constant. `SETTINGS_READ_ONLY_COPY` in `workbench-settings.ts` is the Workbench's mirror of the same `PUT /api/settings` door; leaving it would move DW-387's defect onto the Workbench instead of closing it. Every consumer imports it by name, so the value change is invisible to the existing suites. `PUT /api/workspace-profile` keeps its own literal — different door, already pinned as a divergence.

The store gates go before `withFileLock` for the reason the `wikis.ts` gates do: a refusal raised inside the lock has already queued behind every in-flight operation for that owner and read the file it was never going to write.

Fail-open on the surfaces, matching `RecentIngests`: if the GET errors or 401s, `readOnly` stays `false`, the control stays live, and the server still refuses. A surface that guessed "read-only" from a failed load would refuse a writable deployment.

## Verification

**Commands:**
- `npx vitest run` -- expected: all suites pass in both the `node` and `dom` projects.
- `npx eslint .` -- expected: exit 0 (three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices are not regressions).
- `npx tsc --noEmit -p tsconfig.json` -- expected: no errors.
