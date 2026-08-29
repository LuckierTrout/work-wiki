---
title: 'DW-393 — per-entry outcomes for the bulk ingest-history delete'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Thirteen dom suites under src/components/workbench/__tests__/ fail at
      window.localStorage.clear() on Node 26, unrelated to any code change.
    evidence: |-
      233 tests across 13 files die with "TypeError: Cannot read properties of
      undefined (reading 'clear')". Reproduced on a stashed tree at 34f1863d,
      so it is not a branch regression. Root cause confirmed by probe: Node
      26.8.1's built-in `localStorage` global shadows jsdom's own and is
      `undefined` unless the process is started with `--localstorage-file`
      ("ExperimentalWarning: localStorage is not available because
      --localstorage-file was not provided"). Every other dom suite passes.
      Needs a repo-wide decision (pin Node, pass the flag, or shim the global
      in vitest.setup.dom.ts), so it was not fixed inside this bundle.
    location: >-
      src/components/workbench/__tests__/ (13 files); vitest.setup.dom.ts
    severity: medium
baseline_revision: '34f1863dfa91cd112c15f85fda4aae2ff59c3d00'
---

<intent-contract>

## Intent

**Problem:** `DELETE /api/ingest/history` answers one all-or-nothing 404 (`SELECTION_NOT_FOUND`) whenever any single selection is missing, not the caller's, or names a page absent from the page index. An orphan page — on disk but absent from the index, the drift `checkOrphanPages` exists because of — therefore makes its ledger row and its done job permanently undeletable AND vetoes every other item selected alongside it, clearing nothing.

**Approach:** Turn the three not-found refusals into PER-ENTRY outcomes recorded in the response's existing `failed[]` array, so the rest of the batch still deletes; apply the identical shape to the `ingestIds` preflight, the `jobIds` preflight and the DW-270 read gate in the ACL loop so all three stay in parity; and surface the partial result in `RecentIngests`.

## Boundaries & Constraints

**Always:**
- One sentence — `SELECTION_NOT_FOUND` — for all three not-found reasons (entry absent from ledger, entry with no `primary_slug`, slug outside `listReadableWikiPages`, job absent, job not the caller's). The reason must stay indistinguishable; naming the caller's OWN submitted id back to them is not a leak, distinguishing WHY it failed is.
- A refused entry mutates nothing: no `deleteWikiPage` for its slug, no `deleteIngestJob` for its job, and its slug never enters `deletedPageSlugs` or `deletedIngestIds`.
- The DW-270 read gate stays INSIDE the ACL loop, after `if (!page) continue`, so a done job whose page is already gone still clears (200, job deleted, no page delete).
- The DW-187 read-only refusal stays a whole-batch 403 answered before any ledger read.
- `failed[]` keeps its shape `{ id, kind: "ingest" | "job", error }`, ordered by submission order (all `ingestIds`, then all `jobIds`).

**Block If:** the change would require distinguishing "does not exist" from "you may not read it" in any caller-visible way.

**Never:**
- Do not add a disk fallback for orphan slugs (the explicitly rejected option 2 — the ledger/index contract stays as-is).
- Do not change the whole-batch 403 (delete ACL denial, incl. the realm sentence) or the whole-batch 409 (queued/processing job) — both are stable, actionable refusals about items the caller can see and deselect, and both already fire before any mutation. Only the not-found family becomes per-entry.
- Do not touch `_bmad-output/implementation-artifacts/deferred-work.md`.
- Do not change `GET /api/ingest/history`, `WRITE_DENIAL*`, or `READ_ONLY_REFUSAL`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mixed ingest batch | `ingestIds: ["ing-ok","ing-orphan"]`; `page-ok` readable, `page-orphan` absent from index | 200; `page-ok` deleted, `deletedIngestIds` contains `ing-ok`, `failed` = `[{id:"ing-orphan",kind:"ingest",error:SELECTION_NOT_FOUND}]` | Per-entry |
| Unknown ingest id | `ingestIds: ["ing-nope"]` (absent from ledger) | 200; nothing deleted; `failed` = one `ingest` entry with `SELECTION_NOT_FOUND` | Per-entry |
| Job not the caller's | `jobIds: ["job-bob"]`, `job.owner !== principal.handle` | 200; `deleteIngestJob` NOT called; `failed` = one `job` entry with `SELECTION_NOT_FOUND` | Per-entry |
| DW-270 unreadable job page | `jobIds:["job-a"]` owned by caller, page `bob-secret` exists but unreadable | 200; no page delete, no job delete; `failed` = one `job` entry whose error is exactly `SELECTION_NOT_FOUND` — no realm sentence, no slug, no "permission" | Per-entry |
| Already-gone job page | `jobIds:["job-gone"]`, `readWikiPageWithFrontmatter` → null | 200; job cleared, no page delete, `failed` empty | No error |
| Realm page in batch | readable page, `canWriteFrontmatter` false | 403 for the WHOLE batch with the resolver's sentence; nothing deleted | Unchanged |
| Active job in batch | job `status: "processing"` | 409 for the WHOLE batch; nothing deleted | Unchanged |
| Read-only deployment | `YOPEDIA_READONLY=1` | 403 before any ledger read; nothing deleted | Unchanged |
| Client partial result | response 200 with some `deletedIngestIds` and some `failed` | Deleted rows drop; failed ids stay SELECTED (keyed by `kind`); error names the failure count and reason; notice reports the cleared count | — |
| Client total failure | response 200, `deletedIngestIds`/`deletedJobIds` empty, `failed` non-empty | Error shown; NO "0 ingest records cleared" notice | — |

</intent-contract>

## Code Map

- `src/app/api/ingest/history/route.ts` -- the whole change. `SELECTION_NOT_FOUND` (~L34) is the shared sentence; its doc comment claims vagueness about WHICH selection failed and must be rewritten. `DELETE` handler: `ingestIds` preflight `selectedEntries.some(...)` → 404 (~L188-200); `jobIds` preflight `!job || job.owner !== principal.handle` → 404 (~L205-210); non-terminal job → 409 (keep); ACL loop's `if (!readable.has(slug))` → 404 (~L253-258, the DW-270 gate, keep its long comment's substance and update the answer it describes); `canWriteFrontmatter` → 403 (keep); delete loop + `failedSlugs`/`removedSlugs`/`deletedIngestIds` attribution (~L268-332) is the existing per-entry machinery to extend.
- `src/components/RecentIngests.tsx` -- `deleteSelected()` (~L250-345): response type at ~L296-303 (`failed?: {id,error}[]` — add `kind?`), selection retention via `ingestIds.includes(id)` (~L321-328 — prefer `kind`), and the error/notice block (~L329-341 — notice currently fires even when nothing was cleared).
- `src/lib/__tests__/ingest-history-delete-route.test.ts` -- the pins. `"cloaks ledger entries the caller cannot read"` and `"404s a jobIds selection whose page the caller cannot read (DW-270)"` both assert 404 and must become per-entry assertions WITHOUT losing their leak assertions. `"still clears a done job whose page is already gone"`, `"preflights page delete permission"`, `"rejects active jobs"`, `"refuses the whole batch on a read-only deployment"` must stay green unchanged.
- `src/lib/write-denial.ts` -- ~L43-51 narrates DW-270 as answering "the same 404 selection sentence"; update the wording only. ~L106 (`"one refusal for a whole selection"` for `bulkDelete`) stays TRUE and must not change — the 403 is still whole-batch.
- Read-only evidence: `src/lib/config.ts:286` and `src/lib/__tests__/read-only-copy-parity.test.ts:207` describe read-only behaviour this change does not touch — leave both alone.
- Test project routing: route + client-logic suites are `.test.ts` (node project). See AGENTS.md "Test environments".

## Tasks & Acceptance

**Execution:**
- `src/app/api/ingest/history/route.ts` -- Replace the two preflight 404 returns and the ACL-loop read-gate 404 with per-entry refusals: collect refused `ingestIds`/`jobIds` into sets rather than returning, exclude them from `selectedEntries`/`selectedJobs` (so their slugs never enter `slugs`), and in the ACL loop seed the existing `failedSlugs` map with `SELECTION_NOT_FOUND` for an unreadable existing slug instead of returning. Move `failedSlugs` above the ACL loop. Build `failed[]` by walking `ingestIds` then `jobIds` in submission order, emitting `SELECTION_NOT_FOUND` for a refused id and the slug's failure message otherwise; skip `deleteIngestJob` for any refused or slug-failed job. -- Restores the rest of the batch while keeping the three refusals indistinguishable.
- `src/app/api/ingest/history/route.ts` -- Rewrite the `SELECTION_NOT_FOUND` doc comment and the DW-270 gate comment to describe the per-entry contract: one sentence for all three reasons, the id echoed back is the caller's own, and the 403/409 remain whole-batch (and why). -- The comments currently assert the opposite of the new behaviour.
- `src/components/RecentIngests.tsx` -- Add `kind?: "ingest" | "job"` to the `failed` response type and key the retained selection off it (falling back to the current `ingestIds.includes(id)` test when absent); suppress the "cleared" notice when nothing was cleared; report the distinct failure reasons rather than blindly the first. -- Surfaces the partial result honestly.
- `src/lib/write-denial.ts` -- Update the DW-270 narration so it no longer says the route answers a 404 for an unreadable page. -- Prose parity with the shipped contract.
- `src/components/__tests__/recent-ingests-partial-delete.test.tsx` -- New mounted suite covering the two client matrix rows: a partly-refused batch (deleted row drops, refused row stays selected keyed off `kind`, both halves reported) and a wholly-refused one (no "cleared" notice), plus the happy-path bound on the suppressed notice. -- The client half of the matrix needs an executable pin.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` -- Convert the two 404 cases to per-entry assertions (200 + `failed` + no mutation, keeping every leak assertion), and add the I/O matrix's mixed-batch case (one readable + one orphan ingest id) and the not-my-job case. -- The matrix's edge cases become executable.

**Acceptance Criteria:**
- Given a selection mixing deletable and not-found items, when DELETE runs, then every deletable item is deleted and only the not-found items appear in `failed`.
- Given any not-found refusal, when the response is read, then its `error` is character-identical to the sentence used by the other two not-found refusals.
- Given the batch contains a realm-restricted readable page or a queued/processing job, when DELETE runs, then the whole batch is still refused (403 / 409) with nothing deleted.
- Given the repository at HEAD, when `pnpm test` runs, then the full suite passes with no pre-existing suite turned red.

## Design Notes

Seeding `failedSlugs` (already the map that drives `removedSlugs` → `deletedIngestIds`, the delete-loop skip, and per-entry attribution) is why the ACL-loop gate needs no new machinery:

```ts
const failedSlugs = new Map<string, string>();   // hoisted above the ACL loop
for (const slug of slugs) {
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) continue;                            // already-gone cleanup, untouched
  if (!readable.has(slug)) {                      // DW-270 gate, now per-entry
    failedSlugs.set(slug, SELECTION_NOT_FOUND);
    continue;
  }
  if (!canWriteFrontmatter(...)) return NextResponse.json(..., { status: 403 });
  existingSlugs.add(slug);
}
```

Why 200 even when EVERY item is refused: the transport status describes the batch evaluation, which succeeded; the route already answers 200 with a populated `failed[]` when `deleteWikiPage` throws, so the not-found family folds into a shape the client already handles rather than inventing a second one.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/ingest-history-delete-route.test.ts` -- expected: all cases pass, including the converted DW-270 case.
- `pnpm exec vitest run --project dom src/components/__tests__/recent-ingests-partial-delete.test.tsx` -- expected: the mounted partial-result cases pass.
- `pnpm test` -- expected: no suite turned red by this change. KNOWN PRE-EXISTING EXCLUSION, verified by re-running on a stashed tree at `34f1863d`: the 13 suites under `src/components/workbench/__tests__/` fail at `window.localStorage.clear()` because Node 26's built-in `localStorage` global shadows jsdom's and is `undefined` without `--localstorage-file` (`ExperimentalWarning: localStorage is not available because --localstorage-file was not provided`). That is a Node-version condition on this machine, not a repo change, and is out of scope here.
- `pnpm exec tsc --noEmit` -- expected: no type errors.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** `DELETE /api/ingest/history` no longer answers one all-or-nothing 404 when a selection cannot be made. The three not-found refusals — a ledger entry that is absent or slugless or whose page is outside `listReadableWikiPages`, a job that is absent or not the caller's, and the DW-270 read gate on a job's existing-but-unreadable page — are now recorded per entry in the response's existing `failed[]` array while the rest of the batch deletes. The handler answers 200 because the batch evaluation succeeded, the same shape the route already used when `deleteWikiPage` threw. The cloak is unchanged: one sentence (`SELECTION_NOT_FOUND`) for every reason, so an unreadable page still looks like an unselectable one. The delete-ACL 403 (which may name a readable page's realm) and the queued/processing 409 stay whole-batch, and the DW-187 read-only 403 still answers before any ledger read.

**Files changed.**
- `src/app/api/ingest/history/route.ts` — the three 404 returns became per-entry refusals; `failedSlugs` hoisted above the ACL loop so the read gate records rather than returns; `failed[]` rebuilt by walking the submitted ids in order; refused ids subtracted from `deletedIngestIds`; doc comments rewritten to the per-entry contract.
- `src/components/RecentIngests.tsx` — `failed[]` carries `kind`; retained selection keyed off it; both the failure sentence and the cleared-count notice now render together in one live region; reasons deduped, filtered and capped; the notice composed from non-zero halves only.
- `src/lib/write-denial.ts` — DW-270 narration updated so it no longer claims the route answers a 404.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` — the two 404 cases converted to per-entry assertions with every leak assertion kept; seven new cases (unknown id, mixed readable+orphan batch, not-my-job, slugless entry, mixed `jobIds` batch, `deleteWikiPage` throw, refused-id-not-reported-deleted); the 403/409 cases given a second deletable item. 17 → 21 cases.
- `src/components/__tests__/recent-ingests-partial-delete.test.tsx` — new mounted suite (5 cases) covering the client matrix rows.

**Review findings.** 10 patches applied (2 high, 3 medium, 5 low), 1 deferred (medium — the pre-existing Node 26 `localStorage` breakage recorded in frontmatter `deferred`), 7 rejected as noise (the `SELECTION_NOT_FOUND` name vs. the retired status code, adding operator logging for refusals, retro-editing the frozen `spec-dw-121-230-269-270` artifact, a dead-end selection state that the high-severity fix already removes, an unreset mock nothing asserts on, missing DELETE-body assertions the route suite already owns, and the absence of a route→client contract test). No intent gaps and no spec defects: the human's decision explicitly rejected the disk-fallback option, and "instead of an all-or-nothing 404" settles the wholly-refused case at 200.

**Follow-up review recommendation.** true. Patched counts: high 2, medium 3, low 5 → score `3 × 3 + 1 × 5 = 14` (≥ 5), and a high-severity patch was applied.

**Verification.**
- `pnpm exec vitest run src/lib/__tests__/ingest-history-delete-route.test.ts` — 21/21 pass.
- `pnpm exec vitest run --project dom src/components/__tests__/recent-ingests-partial-delete.test.tsx src/components/__tests__/recent-ingests-read-only.test.tsx` — 10/10 pass.
- `pnpm exec tsc --noEmit` — exit 0.
- `pnpm lint` — exit 0.
- `pnpm test` — 233 failures across 13 files, the byte-identical set that fails on a stashed tree at `34f1863d`; passing tests rose 7734 → 7743. No suite was turned red by this change.
- Mutation checks: deleting the ingest-attribution lines, reverting the notice guard, and dropping the `refusedIngestIds` filter each now turn a test red.
- Matrix test audit: all ten I/O rows are covered by a test that ran and passed.

**Residual risks.**
- An orphan page's ledger row and its done job remain undeletable — by design, since the human rejected the disk-fallback option. They no longer veto the batch, but they stay selected and re-error on every retry.
- The DW-270 residue is unchanged: a caller who owns a job can still distinguish "page exists but is unreadable" (lands in `failed[]`) from "page already gone" (cleared), because the gate must sit after the already-gone cleanup branch.
- The not-found family is now resolvable per item in one request rather than by submitting ids one at a time — a change in resolution and cost, not a new oracle class, since the sentence is identical for every reason.
- The 13 pre-existing workbench dom suites remain red on Node 26 (deferred above).
