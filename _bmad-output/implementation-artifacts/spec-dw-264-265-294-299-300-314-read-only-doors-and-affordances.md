---
title: 'Read-only parity for the last ungated doors and two write-inviting affordances'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
baseline_revision: 'da674e50b6fd7ac5861bcc9de601d47c436ab960'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The sibling research routes (PATCH/DELETE `/api/research/[id]`, POST `/api/research/[id]/run`)
      still write and delete research-project records with no read-only gate.
    evidence: |-
      DW-294 named only `POST /api/research`, which this change gated. The `[id]` handlers reach
      `updateResearchProject`/`deleteResearchProject`, reach no kernel writer, and contain no
      `isReadOnly` reference — so the feature refuses creates and accepts edits, deletes and runs.
    location: >-
      src/app/api/research/[id]/route.ts; src/app/api/research/[id]/run/route.ts
    severity: medium
  - summary: >-
      The research, Names & Terms and email-ingest stores carry no `assertWritable`, so a CLI, MCP
      or agent-runtime caller still writes them on a read-only deployment.
    evidence: |-
      DW-314's whole argument is that a route gate is not enough because a direct library caller
      reaches the kernel with no route in front. This change applied that argument to `wikis.ts`
      only; `createResearchProject`, `createNamesTerm`/`updateNamesTerm`/`deleteNamesTerm` and
      `saveEmailIngestConfig` got HTTP gates alone.
    location: >-
      src/lib/research-projects.ts; src/lib/names-terms.ts; src/lib/email-ingest.ts
    severity: medium
  - summary: >-
      Three surfaces now compose a write in front of a door this change taught to answer 403, with
      no read-only mirror — the DW-264/DW-265 shape, one bundle later.
    evidence: |-
      `NamesTermsSettings` and `EmailIngestSettings` render immediately below the `/settings` form
      that now refuses per control, and `KnowledgeStudio` posts to `/api/research`; all three submit
      and meet the new 403 afterwards. `READ_ONLY_REFUSAL.namesTerms` and `.emailSettings`
      consequently have no client counterpart and no parity-test entry.
    location: >-
      src/components/NamesTermsSettings.tsx; src/components/EmailIngestSettings.tsx; src/components/KnowledgeStudio.tsx
    severity: medium
  - summary: >-
      `/settings` now states three different sentences for one deployment state, none of them owned
      by `READ_ONLY_REFUSAL` and none pinned by the parity suite.
    evidence: |-
      The banner every refused control now points at reads "Read-only mode — This deployment has
      explicitly disabled settings changes."; `PUT /api/settings` answers "Settings are read-only in
      this deployment."; `POST /api/settings/rebuild-embeddings` answers a third wording. Only the
      banner is on screen, so the owner reads one sentence before pressing and another if anything
      reaches the route.
    location: >-
      src/app/settings/page.tsx:147; src/app/api/settings/route.ts:130; src/app/api/settings/rebuild-embeddings/route.ts
    severity: medium
  - summary: >-
      Nothing outside code comments records that `POST /api/tasks/scan` now answers 403 on every
      cron pass of a read-only deployment.
    evidence: |-
      The scan is the only trigger for the DW-137 workspace-profile backfill and the only scheduled
      trigger for the orphan-directory sweep, and a monitor that treats non-2xx as failure will now
      alert once per tick while `YOPEDIA_READONLY` is set. DEPLOY.md's read-only section documents
      the Workbench settings affordances and says nothing about the scan.
    location: >-
      DEPLOY.md; src/app/api/tasks/scan/route.ts:62
    severity: low
---

<intent-contract>

## Intent

**Problem:** Six read-only gaps survive the earlier sweeps. Four writers refuse nothing on `YOPEDIA_READONLY=1` — `POST /api/research`, the three names-terms writers, `PUT /api/email/settings`, and `deleteWiki`/`setCurrentWiki`/`sweepOrphanWikiDirectories` in `src/lib/wikis.ts` (the last reachable on a timer through `POST /api/tasks/scan`, which carries no gate either) — so those forms silently succeed and a cron can delete Wiki directories. Two client affordances still invite a write the server now refuses: `/wiki/new` lets the owner compose a whole page before a 403, and RecentIngests confirms an irreversible bulk delete in front of one. And `/settings` still refuses by disabling its whole fieldset — the identical DW-191 defect — making stored provider/model/base-URL/embedding values unreadable and disabling the non-writing **Test Connection** button.

**Approach:** Gate each ungated door at the layer its siblings use — an early `isReadOnly()` 403 at the four routes, `assertWritable` before the lock in the three `wikis.ts` functions — with every sentence owned by `READ_ONLY_REFUSAL`. Then mirror the refusal on the two client affordances following the `ReingestButton`/`WorkspacePurposeSettings` convention (`aria-disabled`, handler returns before the fetch/confirm, a sentence wired through `aria-describedby`), and replace the `/settings` fieldset gate with the same per-control refusal so stored values stay readable and Test Connection stays live.

## Boundaries & Constraints

**Always:** Every new server sentence is a key on `READ_ONLY_REFUSAL` in `src/lib/read-only.ts`, distinct from the others, starting with a capital and ending `while this deployment is read-only.` — the shape `read-only-copy-parity.test.ts` enforces. Where a route already serves that sentence inline (`Wikis cannot be deleted…`, `The active wiki cannot be changed…`) the new constant is character-identical to the literal, and the parity suite pins it. Kernel gates come BEFORE `withWikiLock` and before any read. Client refusals use `aria-disabled` (never `disabled`) plus an early return in the handler, so refused controls stay in the tab order and stored values stay readable. Client copy constants are duplicated next to their component and pinned by `read-only-copy-parity.test.ts` — never imported from `read-only.ts` into a `"use client"` module.

**Block If:** Closing a gap would require changing what a route does on a WRITABLE deployment.

**Never:** Do not touch `deferred-work.md`. Do not rename any frozen identifier (`YOPEDIA_READONLY` stays). Do not add read-only surfaces to `NamesTermsSettings` or `EmailIngestSettings` — DW-300 is the doors only. Do not widen `POST /api/tasks/scan` beyond a refusal (its `?dry=1` and `AUTONOMOUS_MAINTENANCE` semantics stay exactly as documented). Do not convert `/settings` or `/ingest` to server components; both stay `"use client"`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Research create, read-only | `POST /api/research`, `YOPEDIA_READONLY=1` | 403, `{ error: READ_ONLY_REFUSAL.researchCreate }`; `createResearchProject` never called | Gate precedes body parse |
| Names & Terms writers, read-only | `POST /api/names-terms`, `PUT`/`DELETE /api/names-terms/[id]` | 403 with `READ_ONLY_REFUSAL.namesTerms`; no store call | Gate after auth, before parse |
| Email settings save, read-only | `PUT /api/email/settings` | 403 with `READ_ONLY_REFUSAL.emailSettings`; `saveEmailIngestConfig` never called | Gate after the owner check, so a non-owner still 404s |
| Maintenance scan, read-only | `POST /api/tasks/scan` (service token) | 403 with `READ_ONLY_REFUSAL.maintenanceScan`; no sweep, no backfill, no enqueue | Gate after the service-principal check |
| Wiki delete / switch / sweep, read-only | direct library call to `deleteWiki`, `setCurrentWiki`, `sweepOrphanWikiDirectories` | `ReadOnlyError` thrown before the lock; `wikis.json` and every wiki directory byte-identical | Refusal propagates; `deleteWiki` never reaches its fail-soft catches |
| All five doors, writable | flag unset | Behaviour byte-identical to today | — |
| `/wiki/new`, read-only | page rendered with `readOnly` | Fields still readable and focusable; submit `aria-disabled` and describes the refusal; submit performs no `fetch` | Sentence rendered once, id resolvable |
| Bulk delete, read-only | `/ingest` recent list, history GET says `readOnly` | Bulk-delete entry control `aria-disabled` + refusal sentence; no `window.confirm`, no DELETE | Refusal stated before selection mode |
| `/settings`, read-only | `GET /api/settings` says `readOnly: true` | Stored provider/model/base URL/embedding values readable and in the tab order; write controls refuse per control; **Test Connection** enabled | One refusal sentence, pointed at by each refused control |

</intent-contract>

## Code Map

- `src/lib/read-only.ts` -- `READ_ONLY_REFUSAL` (:81) + `assertWritable` (:153). Add keys: `researchCreate`, `namesTerms`, `emailSettings`, `maintenanceScan`, `wikiDelete`, `wikiSwitch`, `wikiDirectorySweep`. Module header documents the ownership rule; extend the "WIKI-LIFECYCLE ROUTES KEEP THEIR INLINE LITERALS" note to cover the two new mirrored literals.
- `src/app/api/research/route.ts:23` -- `POST`; no gate. Idiom to copy: `src/app/api/ingest/route.ts:12-13,46-49` (`isReadOnly` from `@/lib/config`, `READ_ONLY_REFUSAL` from `@/lib/read-only`, early 403).
- `src/app/api/names-terms/route.ts:23` (POST), `src/app/api/names-terms/[id]/route.ts:15,39` (PUT, DELETE) -- gate right after the `getPrincipal` 401.
- `src/app/api/email/settings/route.ts:45` -- `PUT`; gate after `requireOwner()`'s 404 so the not-found cloak still wins.
- `src/app/api/tasks/scan/route.ts:54` -- `POST`; gate after `getServicePrincipal` 401, before `scanForMaintenance`. Sibling: `src/app/api/tasks/run/route.ts:78-81`.
- `src/lib/wikis.ts` -- `setCurrentWiki:1214`, `sweepOrphanWikiDirectories:1634`, `deleteWiki:1668`; each opens with `return withWikiLock(...)` today. Gate before that call, in the style of `createWiki:1043-1054`. Module header :46-53 records these three as a KNOWN GAP — rewrite that paragraph, it is now false.
- `src/app/api/wikis/[id]/route.ts:65` / `src/app/api/wikis/current/route.ts:21` -- the two inline literals the new `wikiDelete` / `wikiSwitch` constants must match character for character.
- `src/app/wiki/new/page.tsx` -- `"use client"` whole-page form, fetches `POST /api/wiki` at :45. Split: page becomes a server component reading `isReadOnly()` (pattern: `src/app/u/[handle]/[slug]/edit/page.tsx:150`), form moves to a client component.
- `src/components/RecentIngests.tsx` -- history fetch :84-90, bulk-delete entry button :366-385, `deleteSelected` :210 (its `window.confirm` at :229). `/ingest` (`src/app/ingest/page.tsx:1`) is `"use client"`, so the fact must arrive over the wire, not as a prop.
- `src/app/api/ingest/history/route.ts:60-91` -- `GET` returns `{ entries }`; add `readOnly` there (the same seam `/api/workspace-profile` gives `WorkspacePurposeSettings`). `DELETE` :121 already refuses with `READ_ONLY_REFUSAL.bulkPageDelete`.
- `src/app/settings/page.tsx:119` -- `<fieldset disabled={readOnly}>` wrapping `ProviderForm`, `StructuredKnowledgeSettings`, `EmbeddingSettings`, Save (:170) and Test Connection (:178). `readOnly` already arrives from `useSettings` (`src/hooks/useSettings.ts:459`).
- `src/components/ProviderForm.tsx`, `src/components/StructuredKnowledgeSettings.tsx`, `src/components/EmbeddingSettings.tsx` -- no `readOnly` prop today; selects at ProviderForm:100 / StructuredKnowledge:84, text inputs at ProviderForm:140,175, StructuredKnowledge:109, Embedding:127, and the Rebuild Vector Index button at Embedding:186 (its route, `/api/settings/rebuild-embeddings`, already 403s).
- `src/components/WorkspacePurposeSettings.tsx:172-222,745-830,900-945` -- the reference implementation for per-control refusal (note id, `describedBy`, `aria-disabled` select, `readOnly` textarea, submit that keeps `disabled` only for transient state).
- `src/components/ReingestButton.tsx` -- the reference for a refusing button + its exported copy constant.
- Tests to extend: `src/lib/__tests__/read-only-copy-parity.test.ts` (new constants + the two mirrored literals + client copy), `src/lib/__tests__/read-only-kernel-gate.test.ts:288-305,428-478` (family note is now false; add the three functions to both the byte cases and the gate-precedes-lock list), `src/lib/__tests__/research-route.test.ts`, `names-terms-routes.test.ts`, `email-settings-route.test.ts`, `scan-route.test.ts`. Mounted-suite recipes: `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx:35-46` (stub the sibling panels, keep the hook real) and `src/components/__tests__/workspace-purpose-settings.test.tsx:58-70` (fetch stub helper).

## Tasks & Acceptance

**Execution:**
- `src/lib/read-only.ts` -- add the seven refusal keys with doc comments naming their door; update the module header's inline-literal note -- one owner per server sentence.
- `src/app/api/research/route.ts` -- early `isReadOnly()` 403 in `POST` -- the create writes to storage and reaches no kernel writer.
- `src/app/api/names-terms/route.ts` and `src/app/api/names-terms/[id]/route.ts` -- early 403 in `POST`, `PUT`, `DELETE` -- three writers, one sentence.
- `src/app/api/email/settings/route.ts` -- early 403 in `PUT`, after `requireOwner()` -- keeps the 404 cloak ahead of the refusal.
- `src/app/api/tasks/scan/route.ts` -- early 403 in `POST` -- the scan's sweep and backfill delete and write bytes on a timer.
- `src/lib/wikis.ts` -- `assertWritable` at the head of `deleteWiki`, `setCurrentWiki` and `sweepOrphanWikiDirectories`, before `withWikiLock`; rewrite the header's "WHAT IS NOT GATED" paragraph -- the gap it records is closed.
- `src/app/api/ingest/history/route.ts` -- `GET` also returns `readOnly` -- the surface reads the fact from the route it will call.
- `src/components/RecentIngests.tsx` -- adopt `readOnly` from the history answer; export `BULK_DELETE_READ_ONLY_COPY` (character-identical to `READ_ONLY_REFUSAL.bulkPageDelete`); refuse the bulk-delete entry control per control and return from `deleteSelected` before the confirm -- no confirm in front of a 403.
- `src/app/wiki/new/page.tsx` + new client component beside it -- page becomes a server component passing `readOnly={isReadOnly()}`; the form exports its own copy constant and refuses at the submit -- the owner learns before composing, not after.
- `src/app/settings/page.tsx` -- drop the `disabled` fieldset; render one refusal sentence with an id; pass `readOnly` down; Save keeps `disabled` only for `saving` and takes `aria-disabled` + `aria-describedby`; Test Connection is no longer refused -- it writes nothing.
- `src/components/ProviderForm.tsx`, `src/components/StructuredKnowledgeSettings.tsx`, `src/components/EmbeddingSettings.tsx` -- accept optional `readOnly` and `describedBy` props (default off, so every existing caller renders unchanged); selects take `aria-disabled` + a returning `onChange`, text inputs take `readOnly`, Rebuild Vector Index refuses like the Save button -- values stay readable.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- pin the new constants, the two mirrored route literals, and the two new client copy constants.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` -- byte cases for the three `wikis.ts` functions, add them to the gate-precedes-lock scan, correct the "NOT A CLAIM ABOUT THE FAMILY" note.
- `src/lib/__tests__/research-route.test.ts`, `names-terms-routes.test.ts`, `email-settings-route.test.ts`, `scan-route.test.ts` -- a read-only case per writer verb, each asserting 403, the sentence, and that the store/scan function was never called; and a writable control case where one is not already implied.
- `src/components/__tests__/` and `src/app/settings/__tests__/` -- new mounted suites for the three affordances: `/wiki/new` form, RecentIngests bulk delete, and `/settings` read-only per-control refusal (this last one also asserting the stored values are still rendered and Test Connection is enabled).

**Acceptance Criteria:**
- Given `YOPEDIA_READONLY=1`, when any of `POST /api/research`, `POST /api/names-terms`, `PUT`/`DELETE /api/names-terms/[id]`, `PUT /api/email/settings` or `POST /api/tasks/scan` is called by an otherwise authorized caller, then the response is 403 carrying that door's `READ_ONLY_REFUSAL` sentence and no store, sweep, backfill or enqueue function is called.
- Given `YOPEDIA_READONLY=1`, when `deleteWiki`, `setCurrentWiki` or `sweepOrphanWikiDirectories` is called directly, then it rejects with `ReadOnlyError` and the tenant's `wikis.json` and every `wikis/<id>/` directory are byte-identical afterwards.
- Given the flag is unset, when the same six doors and three functions run, then their behaviour and responses are unchanged from before this change.
- Given `/wiki/new` rendered on a read-only deployment, when the owner submits the form, then no request is made, the refusal sentence is on screen and referenced by the submit control's `aria-describedby`, and the title, slug and content fields remain focusable.
- Given the recent-ingests list on a read-only deployment, when the owner activates the bulk-delete control, then no `window.confirm` is raised and no `DELETE /api/ingest/history` is sent, and the refusal sentence is on screen.
- Given `/settings` on a read-only deployment, when the page renders, then the stored provider, model, base URL and embedding model remain readable and reachable by keyboard, every write control states the refusal through `aria-describedby`, and **Test Connection** is not disabled.

## Design Notes

Sentences (each unique, each ending `while this deployment is read-only.`):

```
researchCreate:      "Research projects cannot be created while this deployment is read-only."
namesTerms:          "Names & Terms entries cannot be changed while this deployment is read-only."
emailSettings:       "Email ingestion settings cannot be changed while this deployment is read-only."
maintenanceScan:     "Maintenance scans cannot run while this deployment is read-only."
wikiDelete:          "Wikis cannot be deleted while this deployment is read-only."          // = the /api/wikis/[id] literal
wikiSwitch:          "The active wiki cannot be changed while this deployment is read-only." // = the /api/wikis/current literal
wikiDirectorySweep:  "Orphaned wiki directories cannot be reclaimed while this deployment is read-only."
```

`POST /api/tasks/scan` refuses WHOLE rather than forcing `dry=1`: `?dry=1` is documented as the inspection switch, and a read-only deployment answering a dry-looking 200 would report a scan that never ran. `POST /api/tasks/run` already refuses the same way, and the consumer treats a 403 as a terminal refusal.

The three `wikis.ts` gates go before `withWikiLock` for the reason `createWiki` states: `deleteWiki` swallows both byte-removal failures, so a refusal raised inside the lock would land after `wikis.json` was rewritten and be logged rather than surfaced.

Per-control refusal on `/settings` follows `WorkspacePurposeSettings` exactly — including its rule that `disabled` stays only for transient state (`saving`, `rebuilding`) so a refused control keeps its place in the tab order and its pointer to the sentence.

## Verification

**Commands:**
- `pnpm test` -- expected: all suites pass, including the new read-only cases in both the `node` and `dom` projects.
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit -p tsconfig.json` -- expected: no type errors from the new props and the split page.

## Auto Run Result

Status: done

**Implemented:** Read-only parity for the six gaps in the bundle. Four doors and three library
functions now refuse on `YOPEDIA_READONLY=1`, and three client affordances state the refusal
before they invite a write.

**Files changed**
- `src/lib/read-only.ts` — seven new `READ_ONLY_REFUSAL` keys plus the module note that owns them.
- `src/app/api/research/route.ts`, `src/app/api/names-terms/route.ts`, `src/app/api/names-terms/[id]/route.ts`, `src/app/api/email/settings/route.ts`, `src/app/api/tasks/scan/route.ts` — early `isReadOnly()` 403 serving the constant.
- `src/lib/wikis.ts` — `assertWritable` before the lock in `deleteWiki`, `setCurrentWiki`, `sweepOrphanWikiDirectories`; the header's "what is not gated" paragraph rewritten.
- `src/app/api/ingest/history/route.ts` — `GET` also answers `readOnly`.
- `src/components/RecentIngests.tsx` — adopts that fact, exports `BULK_DELETE_READ_ONLY_COPY`, refuses the bulk-delete entry control before any confirm.
- `src/app/wiki/new/page.tsx` + `src/app/wiki/new/NewWikiForm.tsx` — page split into a `force-dynamic` server component that reads the flag and a client form that refuses at the submit.
- `src/app/settings/page.tsx`, `src/components/ProviderForm.tsx`, `src/components/StructuredKnowledgeSettings.tsx`, `src/components/EmbeddingSettings.tsx` — the disabled fieldset replaced by per-control refusal; stored values stay readable and Test Connection stays live.
- Tests: `read-only-copy-parity`, `read-only-kernel-gate`, `research-route`, `names-terms-routes`, `email-settings-route`, `scan-route`, `ingest-history-delete-route` extended; new suites `settings-page-read-only-controls.test.tsx`, `new-wiki-form-read-only.test.tsx`, `recent-ingests-read-only.test.tsx`, `wiki/new/__tests__/new-wiki-page-seam.test.ts`.

**Review findings:** 6 patches applied (1 high, 2 medium, 3 low), 5 items deferred (4 medium, 1 low),
7 rejected. No intent gaps and no spec repairs.

**Follow-up review recommended:** true — one patched finding was high severity (patched counts:
high 1, medium 2, low 3; score 3×2 + 1×3 = 9).

**Verification:** `npx vitest run` — 268 files, 5892 tests, all pass. `npx eslint` — exit 0 (the
three `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing). `npx tsc --noEmit -p tsconfig.json`
— no errors.

**Residual risks:** `POST /api/tasks/scan` now refuses whole rather than degrading to a dry run, so a
cron pointed at a read-only deployment gets a terminal 403 and the DW-137 workspace-profile backfill
does not progress while the flag is set. `RecentIngests` fails open when the history GET errors or
401s — the control stays live and the server still refuses. The remaining ungated research `[id]`
routes, the missing library-level gates, and the three unmirrored surfaces are recorded in
`deferred` above.
