---
title: 'Read-only enforcement moves into the kernel writers (DW-187, DW-188, DW-190)'
type: 'bugfix'
created: '2026-08-19'
status: 'done'
baseline_revision: 'ee9278f631ecb6a6cb83f500130e84d8c25ff8d3'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `/wiki/new` still lets the owner compose an entire page before
      `POST /api/wiki` refuses it, now that the route answers 403.
    evidence: |-
      This change is what makes `POST /api/wiki` refuse on a read-only
      deployment (src/app/api/wiki/route.ts, catch maps ReadOnlyError to 403).
      `src/app/wiki/new/page.tsx:45` is a client page that fetches that route on
      submit with no read-only signal, so the owner types a title and a full
      body and meets the refusal only afterwards — the DW-149 confirm-then-403
      harm, on a door this bundle opened. It was left alone because it is not a
      surface the bundle intent names (DW-190 names only ArticleActions) and it
      sits on no existing `readOnly` seam: the page is `"use client"`, so the
      fact would have to arrive through a new server wrapper rather than the
      ArticleView thread the Re-ingest and Revert mirrors reuse.
    location: src/app/wiki/new/page.tsx:45
    severity: medium
  - summary: >-
      The `/ingest` page's bulk-delete control confirms an irreversible delete
      in front of a `DELETE /api/ingest/history` that now answers 403.
    evidence: |-
      `src/components/RecentIngests.tsx:229` raises a `window.confirm` naming
      permanent removal, then calls the route this change gated at
      `src/app/api/ingest/history/route.ts:121`. Same confirm-then-403 shape as
      the Re-ingest and Revert controls that WERE mirrored here. Left alone for
      the same two reasons: not named by the bundle intent, and `/ingest`
      (src/app/ingest/page.tsx:414) carries no `readOnly` prop today — though it
      is a server component, so the thread is one attribute plus a prop, cheaper
      than `/wiki/new`.
    location: src/components/RecentIngests.tsx:229
    severity: medium
  - summary: >-
      `putWikiArtifact` writes `schema.md` and `purpose.md` without the gate
      `writeWikiArtifact` now carries, so wiki seeding still writes.
    evidence: |-
      `assertWritable` was added to `writeWikiArtifact` (src/lib/wikis.ts), but
      the unlocked seeder `putWikiArtifact` — used by `createWiki` inside the
      registry lock — takes the wider `ArtifactFile` type and has no gate. The
      residual hole is narrow because `POST /api/wikis` has consulted
      `isReadOnly()` since before this change, so only a direct library caller
      (CLI, a future MCP tool) can reach it; it is nonetheless a caller that
      does not inherit the refusal the module docstring claims every caller
      inherits.
    location: src/lib/wikis.ts (putWikiArtifact)
    severity: low
  - summary: >-
      `POST /api/tasks/run` answering 403 changes Cloudflare Queue semantics
      from retry-then-DLQ to ack-and-drop, and the trade-off deserves a human call.
    evidence: |-
      The route's own status contract maps 4xx to "ack and drop" and 5xx to
      "retry, DLQ after max_retries". Before this change an ungated write simply
      succeeded; the new uniform 403 means work queued against a deployment that
      is read-only for a maintenance window is discarded rather than parked in
      the DLQ for replay. 403 is what the intent asks for ("the refusal shape
      the existing gated routes answer") and retrying cannot succeed while the
      flag is set, so it was implemented and documented in the route comment
      with the operational note "drain or pause the queue before setting
      YOPEDIA_READONLY". Whether the queue consumer should instead answer 503
      and preserve the work is an operational decision, not a code defect.
    location: src/app/api/tasks/run/route.ts:78
    severity: medium
  - summary: >-
      `YOPEDIA_READONLY` has no operator-facing documentation, and this change
      materially redefines what it refuses.
    evidence: |-
      The flag appears only in code docstrings and spec artifacts — not in
      README.md and not under docs/. It now means "no page or artifact write
      through any caller, including MCP and the CLI", while settings, the wikis
      registry, vaults, agent profiles, tasks, monitors, structured knowledge,
      `raw/`, the ingest ledger and the revision store all still mutate. An
      operator setting the flag has nowhere to read that boundary; the new
      `isReadOnly()` docstring in src/lib/config.ts states it, but only to a
      reader already in the code.
    location: src/lib/config.ts:139
    severity: low
---

<intent-contract>

## Intent

**Problem:** `isReadOnly()` is enforced door by door at the HTTP layer, so every door DW-37 did not name still writes on a read-only deployment: `POST /api/wiki` creates pages, `POST /api/wiki/[slug]/revisions {action:"revert"}` rewrites a body, `DELETE /api/ingest/history` deletes pages in bulk, `POST /api/ingest/reingest` replaces a whole body, and `src/mcp.ts` calls the kernel writers directly so no HTTP gate can ever reach it.

**Approach:** Follow DW-188's recorded 2026-08-19 decision — enforce `isReadOnly()` inside the four kernel writers (`writeWikiPageWithSideEffects`, `deleteWikiPage`, `patchMetadata`, `writeWikiArtifact`) so every caller inherits the refusal, map that refusal to 403 at the HTTP layer, and keep an explicit route-level check only where a late refusal would produce an observably wrong response.

## Boundaries & Constraints

**Always:**
- The kernel writers are the enforcement point: a read-only deployment refuses a page write no matter which caller reaches them (REST, stdio MCP, CLI, agents, ingest, lint-fix, merge).
- A route adds its own `isReadOnly()` check ONLY where the kernel refusal arrives too late to shape the response correctly — irreversible side effects already committed, or expensive/failable work whose own error would mask the refusal.
- Every refusal a route answers is JSON `{ error }` whose sentence names read-only, with status 403 — the shape `/api/wiki/[slug]` already answers.
- One owner per refusal sentence: the server-side wording lives in a single module, and the routes that already spell it reference it rather than restating it.
- A refusal the server answers is mirrored by the surface that offers it: `aria-disabled` plus a handler that returns BEFORE any `window.confirm`, never `disabled`, and the reason said out loud beside the control.
- Runtime identifiers stay `yopedia` (`YOPEDIA_READONLY`); copy says work-wiki.

**Block If:**
- The kernel gate cannot be added without changing an observable outcome for a writable (`YOPEDIA_READONLY` unset) deployment.

**Never:**
- Do not extend this to the `If-Match` write-precondition guard — DW-196 is a separate, deliberately-open decision ("Decide with the Epic 2 ingest writer").
- Do not gate the read-only mirror onto `/wiki/new` (the create form) or `RecentIngests` bulk delete on the `/ingest` page — neither sits on an existing `readOnly` seam. Record, do not widen.
- Do not change any status code, ACL outcome or body for a writable deployment.
- Do not touch the deferred-work ledger. No new dependency, no i18n, no restyle beyond the `aria-disabled` faces already established.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Page create, read-only | `YOPEDIA_READONLY=1`, `POST /api/wiki` with a fresh slug | 403, no page written, no `dataVersion` bump | JSON `{ error }` naming read-only |
| Revision revert, read-only | `YOPEDIA_READONLY=1`, `POST /api/wiki/[slug]/revisions {action:"revert"}` on a page with a revision | 403, stored bytes unchanged, no `dataVersion` bump | JSON `{ error }` naming read-only |
| Bulk ingest delete, read-only | `YOPEDIA_READONLY=1`, `DELETE /api/ingest/history` with valid ids | 403 answered before any mutation; pages AND ingest jobs all still present | JSON `{ error }` naming read-only |
| Re-ingest, read-only | `YOPEDIA_READONLY=1`, `POST /api/ingest/reingest` for a page with a `source_url` | 403 answered before the source fetch and the LLM calls; body unchanged | JSON `{ error }` naming read-only |
| MCP write, read-only | `YOPEDIA_READONLY=1`, `handleCreatePage` / `handleUpdatePage` / `handleUpdateMetadata` / `handleDeletePage` | Each rejects; storage unchanged | Throws `ReadOnlyError` whose message names read-only |
| Artifact write, read-only | `YOPEDIA_READONLY=1`, `writeWikiArtifact` called directly | Rejects before the lock; artifact and its history unchanged | Throws `ReadOnlyError` |
| Writable deployment | `YOPEDIA_READONLY` unset, every request above | Unchanged behaviour — existing status codes, ACL outcomes, cloaks and bodies all exactly as before | Unchanged |
| Conflicting create, read-only | `YOPEDIA_READONLY=1`, `POST /api/wiki` for a slug that already exists | 409 (the conflict is true regardless of the flag, and the read costs nothing) | JSON `{ error }` naming the conflict |
| Missing revision, read-only | `YOPEDIA_READONLY=1`, revert to a timestamp with no stored revision | 404 (same reasoning — a read the flag does not change) | JSON `{ error }` |
| Re-ingest control, read-only | Article page rendered with `readOnly` | Re-ingest button focusable, `aria-disabled`, reason announced; no request issued on click | No request, no error |
| Revert control, read-only | Article page history expanded with `readOnly` | Each Revert button focusable, `aria-disabled`, reason announced; no `window.confirm`, no request | No dialog, no request |

</intent-contract>

## Code Map

- `src/lib/config.ts:139` -- `isReadOnly()`, reading `process.env.YOPEDIA_READONLY` at CALL time (so tests flip it per case). Its docstring at `:128-132` lists the doors that "still write on a read-only deployment" — that list is exactly what this change closes and must be rewritten, not left standing.
- `src/lib/lifecycle.ts:687` (`deleteWikiPage`) and `:731` (`writeWikiPageWithSideEffects`) -- two of the four kernel writers. Both are thin wrappers over `runPageLifecycleOp`; the gate goes at the top of each wrapper, before `validateSlug`/the read, so the answer is identical for every slug and leaks nothing. `lifecycle.ts` already imports from `./wiki`, which imports `./config` — no new cycle.
- `src/lib/patch-metadata.ts:55` (`patchMetadata`) -- gate at the very top, before the lifecycle-key rejection and the ACL, so the refusal is deployment-wide rather than ordered behind a permission answer. It calls `writeWikiPageWithSideEffects` at `:161`, so it would be doubly refused; the early gate is what makes the MESSAGE right.
- `src/lib/wikis.ts:612` (`writeWikiArtifact`) -- gate before `withFileLock`. `wikis.ts` imports no config today; nothing in `config.ts`'s transitive imports reaches `wikis.ts`, so the new import introduces no cycle. Only two callers exist (both already-gated routes), so this is a pure backstop.
- `src/app/api/wiki/route.ts:51` -- `POST` (create). Catch at `:154` maps only "invalid slug" → 400, everything else → 500. Needs the read-only → 403 branch. `writeWikiPageWithSideEffects` is called at `:142`, after the 409 existence check at `:97`.
- `src/app/api/wiki/[slug]/revisions/route.ts:98` -- `POST` revert. Writes at `:194`; catch is at the bottom of the handler. Needs the same 403 branch.
- `src/app/api/ingest/history/route.ts:107` -- `DELETE`. **Needs an explicit early gate**: `deleteWikiPage` failures are swallowed per-slug into `failed` at `:210-215` and the handler still returns 200, and `deleteIngestJob` at `:243` is NOT a kernel writer, so a kernel-only refusal would delete ingest jobs and answer 200.
- `src/app/api/ingest/reingest/route.ts:9` -- `POST`. **Needs an explicit early gate**: `reingest()` re-fetches the source URL and runs two LLM calls before writing, so a kernel-only refusal costs those calls and a fetch failure would answer 500 instead of the refusal.
- `src/app/api/wiki/[slug]/route.ts:33,108,275` -- the three DW-37 gates. They stay: each answers BEFORE the existence read, which is what keeps "unknown slug on a read-only deployment → 403, no existence oracle" true (a pinned DW-37 acceptance criterion). Their three literal sentences become references to the new single owner.
- `src/app/api/workbench/artifact/route.ts:90` and `src/app/api/workbench/artifact/revisions/route.ts:122` -- already gated; their literal sentence is the same one `writeWikiArtifact` now needs, so both become references to the single owner. Behaviour unchanged.
- `src/mcp.ts:258, :333, :364, :398, :1385` -- the exported handlers (`handleCreatePage`, `handleUpdatePage`, `handleUpdateMetadata`, `handleDeletePage`, plus the answer-save at `:1385`) that call the kernel writers directly. Nothing changes here — they inherit the refusal. Their "mirrors the REST ACL" comments at `:283`/`:381` are what DW-188 called out as a comment standing in for a gate.
- `src/components/ReingestButton.tsx` -- no `readOnly` today; `reingest()` fires straight at the route. Gains the prop, `aria-disabled`, an early return, and an owned copy constant beside the existing `DELETE_PAGE_READ_ONLY_COPY` pattern.
- `src/components/ArticleActions.tsx:127` -- renders `<ReingestButton slug={slug} />`; already receives `readOnly` and hands it to `<DeletePageButton>` at `:145`. Its prop docstring at `:27-33` claims Reingest writes "through routes this change did not touch" — false after this change, so it must be rewritten. Graphify (`POST /api/knowledge` → `structured-knowledge.ts`) and Save to vault write NO wiki page and stay undimmed.
- `src/components/RevisionHistory.tsx:87` (`handleRevert`) -- `window.confirm` first, then `POST .../revisions`. Gains `readOnly`, passes it to `RevisionItem`, and returns before the confirm.
- `src/components/RevisionItem.tsx:70-80` -- the Revert button (`disabled={reverting}` stays for the transient state; the standing refusal is `aria-disabled`).
- `src/components/ArticleView.tsx:126,153,480,490` -- the single seam: `readOnly` prop already threaded from `src/app/u/[handle]/[slug]/page.tsx:125`. Add `readOnly={readOnly}` to `<RevisionHistory>` at `:480`. Only one render site of `<ArticleView>` exists.
- `src/components/DeletePageButton.tsx` -- the established convention to copy verbatim: owned copy constant, `aria-disabled` (never `disabled`), guard BEFORE `window.confirm`, `aria-describedby` wiring the sentence to the control.
- Tests: `src/lib/__tests__/wiki-routes.test.ts:1064+` (the DW-37 read-only describe, with its `seed()`/`dataVersion()` helpers and per-test env clearing — extend it), `src/lib/__tests__/ingest-routes.test.ts:686+` (reingest), `src/lib/__tests__/ingest-history-delete-route.test.ts` (bulk delete), `src/lib/__tests__/mcp.test.ts` (MCP handlers), `src/lib/__tests__/article-actions-gate.test.ts:70-85` (the "dims nothing this change did not gate" scan — its Reingest claim is now false), `src/components/__tests__/page-write-read-only.test.tsx` (mounted, `dom` project).
- `vitest.config.ts` -- two projects: `node` collects `src/**/__tests__/**/*.test.ts`, `dom` collects `*.test.tsx`. New mounted assertions must live in a `__tests__/*.test.tsx` file.

## Tasks & Acceptance

**Execution:**
- `src/lib/read-only.ts` (new) -- export `ReadOnlyError` (an `Error` subclass with `name = "ReadOnlyError"`), a `READ_ONLY_REFUSAL` record owning every server-side refusal sentence (page edit, page write, page delete, metadata patch, artifact/Schema edit, bulk page delete, re-ingest), `assertWritable(refusal)` which throws when `isReadOnly()`, and `isReadOnlyError(err)` matching on `name` so it survives module-graph duplication -- one enforcement helper and one owner per sentence, so the kernel and the routes cannot state the refusal differently.
- `src/lib/lifecycle.ts` -- call `assertWritable` at the top of `writeWikiPageWithSideEffects` and `deleteWikiPage` -- these two carry every page create, edit, revert, re-ingest and bulk delete in the codebase, so gating them is what makes MCP, CLI and agent callers inherit the refusal.
- `src/lib/patch-metadata.ts` -- call `assertWritable` at the top of `patchMetadata` -- the shared REST+MCP metadata path; gating it before the ACL keeps the refusal deployment-wide rather than ordered behind a permission answer.
- `src/lib/wikis.ts` -- call `assertWritable` at the top of `writeWikiArtifact`, before `withFileLock` -- the Schema is executable at runtime, so a read-only deployment must not rewrite it through any future caller.
- `src/lib/config.ts` -- rewrite the `isReadOnly()` docstring paragraph that lists the still-ungated doors -- it is now the inverse of the truth, and it is the first thing a new caller reads.
- `src/app/api/wiki/route.ts` -- map a read-only error to 403 in the `POST` catch -- create is DW-187's first named door and its catch would otherwise answer 500.
- `src/app/api/wiki/[slug]/revisions/route.ts` -- map a read-only error to 403 in the `POST` catch -- revert is a full body rewrite behind a confirm.
- `src/app/api/ingest/history/route.ts` -- add an explicit `isReadOnly()` 403 before any mutation, and map a read-only error to 403 in the outer catch -- the handler swallows per-page failures into `failed` and still deletes ingest jobs, so only an early refusal keeps the batch atomic.
- `src/app/api/ingest/reingest/route.ts` -- add an explicit `isReadOnly()` 403 first, and map a read-only error to 403 in the catch -- the write happens after a network fetch and two LLM calls, and a fetch failure would answer 500 in place of the refusal.
- `src/app/api/wiki/[slug]/route.ts`, `src/app/api/workbench/artifact/route.ts`, `src/app/api/workbench/artifact/revisions/route.ts` -- replace the literal refusal sentences with `READ_ONLY_REFUSAL` references, changing no wording, status or ordering -- the kernel now states the same sentences, and two owners for one sentence is how they drift.
- `src/components/ReingestButton.tsx` -- add `readOnly`, an owned copy constant, `aria-disabled`, a handler that returns before the fetch, and `aria-describedby` wiring the sentence -- `POST /api/ingest/reingest` now answers 403, so an interactive-looking control is a refusal the surface fails to mirror.
- `src/components/ArticleActions.tsx` -- pass `readOnly` to `<ReingestButton>` and rewrite the prop docstring -- the fact is already on this component; the docstring's claim that Reingest is behind an ungated route is now false.
- `src/components/RevisionItem.tsx` -- add `readOnly`, `aria-disabled` on Revert (keeping `disabled={reverting}` for the transient state), and `aria-describedby` -- the Revert control is the one that opens the irreversible-sounding confirm.
- `src/components/RevisionHistory.tsx` -- add `readOnly`, return from `handleRevert` BEFORE `window.confirm`, pass the flag and the sentence id down to each `RevisionItem` -- answering a dialog that changes nothing is the DW-149 harm.
- `src/components/ArticleView.tsx` -- pass `readOnly={readOnly}` to `<RevisionHistory>` -- the seam already carries the fact; this is the one hop that was missing.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` (new) -- assert each of the four kernel writers rejects with a read-only error and leaves storage byte-identical, and that with the flag unset each still succeeds -- the enforcement point deserves a test that does not go through any route.
- `src/lib/__tests__/wiki-routes.test.ts` -- extend the DW-37 read-only describe with `POST /api/wiki` (403, no page, no `dataVersion` bump), the revert route (403, bytes unchanged), the two writable control cases, and the 409/404 orderings the matrix records -- the I/O matrix's server half for DW-187's first two doors.
- `src/lib/__tests__/ingest-routes.test.ts` -- add a read-only case for `POST /api/ingest/reingest` asserting 403, a body naming read-only, an unchanged page, and that neither the source fetch nor the LLM was called -- "before the expensive work" is the reason this door keeps a route-level check.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` -- add a read-only case asserting 403 with every selected page AND every selected ingest job still present -- atomicity is the reason this door keeps a route-level check.
- `src/lib/__tests__/mcp.test.ts` -- add read-only cases for `handleCreatePage`, `handleUpdatePage`, `handleUpdateMetadata` and `handleDeletePage` -- DW-188 is precisely the claim that no HTTP test can make.
- `src/lib/__tests__/article-actions-gate.test.ts` -- update the "dims nothing this change did not gate" case: Reingest now mirrors a refusal and is threaded, Graphify and Save to vault still must not be -- the existing assertion encodes a justification this change makes false.
- `src/components/__tests__/page-write-read-only.test.tsx` -- add mounted cases for `ReingestButton` and the revision Revert control: focusable, `aria-disabled`, reason resolvable through `aria-describedby`, no `window.confirm` raised and no request issued -- the outermost surface the intent references.

**Acceptance Criteria:**
- Given `YOPEDIA_READONLY=1`, when any caller reaches `writeWikiPageWithSideEffects`, `deleteWikiPage`, `patchMetadata` or `writeWikiArtifact` — through REST, the stdio MCP handlers, or a direct library call — then the write is rejected before any byte is stored and the error message names read-only.
- Given `YOPEDIA_READONLY` is unset, when the full suite runs, then every pre-existing status code, ACL outcome, cloak and response body is unchanged.
- Given a read-only deployment, when the article page renders, then Re-ingest and every Revert control are focusable, report `aria-disabled`, and announce a sentence naming read-only, while Graphify and Save to vault stay fully interactive.
- Given a read-only deployment, when the owner activates Re-ingest or Revert, then no `window.confirm` is raised and no request is issued.

## Spec Change Log

## Review Triage Log

### 2026-08-19 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 1, medium 3, low 4)
- defer: 5: (high 0, medium 3, low 2)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[high]` `[patch]` `deleteTenant` half-destroyed a tenant silo on a read-only deployment: the per-page `deleteWikiPage` calls now threw and were swallowed into `errors`, and `getStorage().deleteDirectory("tenants/<t>")` — not a kernel writer — then ran unconditionally, so the page mirrors and the tenant's query history were destroyed while the flat pages survived and the route answered 207. Reproduced before fixing. `assertWritable` is now the first statement of `deleteTenant`, before the listing and any storage call, and `DELETE /api/admin/tenant/[handle]` maps the refusal to 403; the new cases assert no mutation of any of the three artifacts, plus the unknown-tenant case, a writable control and the route status.
  - `[medium]` `[patch]` The kernel refusal answered 500 at every door outside the four the spec's Tasks enumerated, contradicting the spec's own Always clause that a route refusal is 403. Added the `isReadOnlyError` → 403 branch to 14 routes (the ingest family, email/agent ingest, tasks/run, query/save, lint/fix, review/proposals, admin/tenant) plus the three catches in `/api/wiki/[slug]` (DELETE's was classifying it as 400) and both Workbench artifact routes.
  - `[medium]` `[patch]` The ingest doors committed irreversible side effects and paid for the source fetch and both model calls before the kernel refusal — the same argument this change used to keep an early gate on `/api/ingest/reingest`. Applied the spec's rule per door: early `isReadOnly()` gates on `/api/ingest` and its five siblings, email ingest, agent ingest, `tasks/run`, `query/save` and `lint/fix`, each comment naming which half of the rule the door meets; catch-mapping only where the write is the first side effect.
  - `[medium]` `[patch]` None of those doors had a test. Added behavioural read-only cases with writable controls for `POST /api/ingest`, `/api/ingest/batch`, `POST /api/query/save`, `POST /api/lint/fix` and `DELETE /api/admin/tenant/[handle]`, plus `read-only-door-coverage.test.ts` — a symbol-level scan that resolves which route modules reach a kernel writer and requires one of the two treatments, re-derives the writer map from `src/lib` so it cannot go stale, and pins that the four writers still open with `assertWritable`. Negative-controlled by neutering one door's treatment. 22 doors reach a writer; 22 are treated.
  - `[low]` `[patch]` The rewritten `isReadOnly()` docstring claimed routes map the refusal to 403 (true only after the patch above) and had dropped the old "check before assuming a new caller is covered" warning. Rewritten with an explicit "what it does NOT refuse" paragraph and the warning restored as its point.
  - `[low]` `[patch]` "ONE OWNER PER SENTENCE" was false: the client Re-ingest copy and the server sentence differed, and the Revert copy had no server counterpart. The Re-ingest constants are now character-identical, the module docstring scopes the claim to server-side copy and explains the client bundle boundary, and `read-only-copy-parity.test.ts` compares each client constant to its server sentence and records the Revert divergence explicitly.
  - `[low]` `[patch]` `isReadOnlyError`'s stated rationale — name matching rather than `instanceof`, so a duplicated module graph cannot turn a 403 into a 500 — was untested; switching the implementation to `instanceof` would have left every assertion green. Added four cases including a foreign class carrying `name = "ReadOnlyError"`.
  - `[low]` `[patch]` Two nits: the `RevisionItem` seam assertion used the unanchored `[\s\S]*?` form its own comment forbids two lines above (now element-anchored), and the reingest read-only gate answered before the 401 while its sibling ingest-history door answered after (now consistent, with a test that an unauthenticated caller still gets 401 and the before-the-LLM-calls property retained).

## Design Notes

The refusal travels as a thrown error, not a return value, because the kernel writers all return success-shaped results that ~30 callers destructure — a nullable return would be silently ignored at most of them. `isReadOnlyError` matches on `err.name` rather than `instanceof` so a duplicated module graph (vitest projects, bundler chunking) cannot turn the 403 back into a 500.

```ts
// src/lib/read-only.ts
export function assertWritable(refusal: string): void {
  if (isReadOnly()) throw new ReadOnlyError(refusal);
}
// route catch
if (isReadOnlyError(err)) {
  return NextResponse.json({ error: getErrorMessage(err) }, { status: 403 });
}
```

Two doors keep a route-level check for a stated reason, and the reason is the test: `DELETE /api/ingest/history` because it swallows per-page failures and still deletes ingest jobs (atomicity), and `POST /api/ingest/reingest` because the write follows a network fetch and two LLM calls (a fetch failure would answer 500 in place of the refusal). Every other newly-gated door relies on the kernel plus the catch mapping.

## Verification

**Commands:**
- `pnpm test` -- expected: both projects green; the `dom` project collects the mounted suites.
- `pnpm lint` -- expected: no new errors.
- `npx tsc --noEmit -p tsconfig.json` -- expected: no new type errors.
- `grep -rn "isReadOnly" src/app/api` -- expected: gates only where the spec says a route keeps one; no door added a check the kernel already covers.

## Auto Run Result

Status: done

### Summary

Read-only enforcement moved from door-by-door HTTP checks into the four kernel writers, closing DW-187, DW-188 and DW-190. `writeWikiPageWithSideEffects`, `deleteWikiPage`, `patchMetadata` and `writeWikiArtifact` now refuse on a read-only deployment, so every caller — REST, the stdio MCP server, the CLI, agents, ingest, lint-fix, merge, tenant admin — inherits the refusal rather than needing its own gate. Routes classify that refusal as the 403 `/api/wiki/[slug]` already answered; a route keeps or adds its own `isReadOnly()` check only where the kernel refusal would arrive too late to shape the response correctly (irreversible side effects already committed, or a fetch plus model calls whose own failure would mask the refusal). The two article-page controls the change newly refuses — Re-ingest and Revert — mirror the refusal with `aria-disabled`, a handler that returns before the request or the confirm, and the reason said out loud. `src/mcp.ts` needed no edit: it inherits.

### Files changed

**Enforcement**
- `src/lib/read-only.ts` (new) -- `ReadOnlyError`, `READ_ONLY_REFUSAL` (one owner for every server-side sentence), `assertWritable`, `isReadOnlyError` (matches on `name`, not `instanceof`).
- `src/lib/lifecycle.ts` -- gates `writeWikiPageWithSideEffects` and `deleteWikiPage` ahead of `validateSlug` and any read.
- `src/lib/patch-metadata.ts` -- gates `patchMetadata` ahead of the lifecycle-key rejection and the ACL.
- `src/lib/wikis.ts` -- gates `writeWikiArtifact` before `withFileLock`.
- `src/lib/tenant-admin.ts` -- gates `deleteTenant` before the listing and any storage call (atomicity: it swallows per-page failures and then deletes the silo directory outright).
- `src/lib/config.ts` -- `isReadOnly()` docstring rewritten: what the flag now refuses, and the explicit list of writes it still does not.

**Routes** -- `wiki/route.ts`, `wiki/[slug]/route.ts`, `wiki/[slug]/revisions/route.ts`, `ingest/route.ts`, `ingest/batch`, `ingest/document`, `ingest/pdf`, `ingest/image`, `ingest/x-mention`, `ingest/reingest`, `ingest/history`, `email/ingest`, `agents/[id]/ingest`, `agents/[id]`, `agents/seed`, `tasks/run`, `query/save`, `lint/fix`, `review/proposals/[id]`, `admin/tenant/[handle]`, `workbench/artifact`, `workbench/artifact/revisions` -- each either gates early (with the reason recorded) or maps `isReadOnlyError` to 403; already-gated routes swapped their literal sentences for `READ_ONLY_REFUSAL` references with no wording or ordering change.

**Surfaces** -- `ReingestButton.tsx` (new `readOnly`, owned copy, `aria-disabled`, early return), `RevisionHistory.tsx` (returns before `window.confirm`), `RevisionItem.tsx` (`aria-disabled` on Revert, `disabled` kept for the transient state), `ArticleActions.tsx` (threads `readOnly` to Re-ingest; docstring corrected), `ArticleView.tsx` (the missing `<RevisionHistory readOnly>` hop).

**Tests** -- new `read-only-kernel-gate.test.ts`, `read-only-door-coverage.test.ts`, `read-only-copy-parity.test.ts`; extended `wiki-routes.test.ts`, `ingest-routes.test.ts`, `ingest-history-delete-route.test.ts`, `lint-fix-route.test.ts`, `query-save-route.test.ts`, `tenant-admin.test.ts`, `mcp.test.ts`, `article-actions-gate.test.ts`, `page-write-read-only.test.tsx`.

### Review findings

- Patches applied: 8 -- high 1, medium 3, low 4.
- Items deferred: 5 -- medium 3, low 2 (see frontmatter `deferred`).
- Items rejected: 10 -- all low.
- Follow-up review recommended: **true** -- one patched finding was high severity (`deleteTenant` partial silo destruction). Score for the medium/low rule: 3x3 + 4 = 13.

### Verification

- `npx vitest run` -- 244 files, 5022 tests passed (baseline before this change: 4994).
- `npx tsc --noEmit -p tsconfig.json` -- exit 0, no output.
- `npx eslint` -- exit 0; the same three pre-existing `jsx-ast-utils` library warnings as the baseline.
- `npx next build` -- exit 0, compiled successfully. Run deliberately (not in the spec's command list) to close the import-cycle question the new `read-only.ts` -> `config.ts` edge raised.
- `grep -rn "isReadOnly" src/app/api` -- every route-level check is either pre-existing or one the spec's rule sanctions, each with its reason recorded in a comment.
- Matrix test audit: all 11 I/O rows are covered by tests that ran and passed.

### Residual risks

- **Widest blast radius in this change:** background writers on a read-only deployment (async ingest tasks, email ingest, agent runs, silo reconcile) now refuse instead of writing. That is the point of DW-188's decision, but it is a behaviour change no HTTP gate previously produced.
- **`POST /api/tasks/run` queue semantics:** the uniform 403 makes the consumer ack and drop where the un-gated path would have retried into the DLQ. Documented in the route comment with the operational note; deferred for a human call.
- **Read-only is now precisely "no page or artifact write":** settings, the wikis registry, vaults, agent profiles, tasks, monitors, structured knowledge, `raw/`, the ingest ledger and the revision store all still mutate. Stated in the `isReadOnly()` docstring; no operator-facing doc exists yet (deferred).
- The seam tests in `article-actions-gate.test.ts` and `read-only-door-coverage.test.ts` are source scans, so they are coupled to spelling: threading the flag through an intermediate variable or a spread would fail them without any behaviour change.
