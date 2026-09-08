---
title: 'DW-420: stop GET /api/workbench/preview?kind=file reporting an unreadable wiki leaf as absent'
type: 'bugfix'
created: '2026-08-31'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
baseline_revision: 'e5dc6724d36cd57af3f28ebc816b065fe980c30c'
---

<intent-contract>

## Intent

**Problem:** `GET /api/workbench/preview?kind=file` degrades a non-ENOENT storage failure on `wiki/<slug>.md` to the route's shared 404. `readSafely` (`src/lib/workbench-files.ts:916-925`) logs the failure and returns `null`; `readWorkbenchFile` (`:1035-1036`) passes that `null` through and `preview/route.ts:266-267` answers `notFound()` — telling the owner their page is gone when it is only unreadable, at a door whose payload seeds the `PUT /api/wiki/[slug]` precondition. `readWorkbenchFile`'s artifact branch (`:1027-1033`) swallows the same failure, so `schema.md` 404s while `purpose.md` — which the route reads through `readEffectiveWikiArtifact`, whose throw is uncaught — already answers 500 at the very same door.

**Approach:** Add a `strict` flag to `WorkbenchFileOptions` that makes `readSafely` and `readWorkbenchFile` rethrow a non-ENOENT failure instead of degrading it to `null`, and pass it from the preview route for the two leaves whose payload seeds a write precondition: the `wiki/` leaf and the seeded artifact. The route's existing GET catch then answers 500 with `{ error }`, which is exactly what the repo settled on for this fault (`DELETE /api/wiki/[slug]`, `src/app/api/wiki/[slug]/route.ts:57-66`) and what the same route's `purpose.md` branch already does.

## Boundaries & Constraints

**Always:**
- ENOENT stays `null` under `strict`, and every existing refusal (gated out, traversal-shaped, absent, unresolved root) keeps answering the one undifferentiated 404. `strict` changes the answer for a FAILED read only.
- Default `strict: false`: `readWorkbenchFile`'s two other callers (`src/app/api/v1/projects/[wikiId]/files/content/route.ts:58`, `src/lib/source-rescan.ts:124`) pass no flag and keep their current fail-soft behaviour byte-for-byte.
- The route decides WHICH leaves refuse, using the `wikiLeafName` it already imports and the `isEditableArtifactFile`/`WIKI_ARTIFACT_FILES` predicate the artifact branch already resolves through — no second expression of either rule.
- Keep `readSafely`'s non-ENOENT `logger.error` on both paths: a refused read is still a fault worth logging.
- Comment each change with DW-420 and the reason, in the style of `src/app/api/wiki/[slug]/route.ts:51-66`.

**Block If:**
- `readWorkbenchFile` no longer routes both branches through one resolver, or `isEnoent` no longer distinguishes ENOENT from other failures.

**Never:**
- Do not reintroduce `src/lib/page-read-failure.ts`, `PAGE_UNREADABLE_COPY`, `PAGE_UNREADABLE_STATUS` or `isPageUnreadableError`, and do not answer 503. That module was deleted by `f2458e1` and the repo settled on the read option plus a 500 — the same Never `spec-dw-496-wiki-door-unreadable-contract.md` records.
- Do not change `readWorkbenchFileBytes`, `workbenchFileExists`, `listSafely`, `resolveRoot` or the listing walk. The media/unsupported existence branch seeds no precondition and is not this bundle's entry.
- Do not make the `raw/` branch strict: a raw source is not editable, so its preview seeds no precondition, and the intent scopes this to the wiki leaf.
- Do not touch `readEffectiveWikiArtifact` or `src/lib/wikis.ts` — the `purpose.md` path is the parity TARGET here, not the work.
- Do not change the shared 404 body, the `NO_STORE` header, or any payload field.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Readable wiki leaf | `kind=file&path=wiki/alpha.md`, gate admits `alpha` | 200 with body, `slug`, `version` | No error expected |
| Unreadable wiki leaf | same path, `readFile` throws `EIO` | 500 `{ error }`, never 404 | Failure rethrown by `readSafely`, logged, caught by the route's GET catch |
| Absent wiki leaf | same path, `readFile` throws `ENOENT` | 404 `{ error: "Not found." }` | Degraded to `null` under `strict`, unchanged |
| Gated-out wiki leaf | `wiki/hidden.md`, gate excludes `hidden` | 404, storage never read | Unchanged |
| Unreadable seeded artifact | `kind=file&path=schema.md`, artifact read throws `EIO` | 500 `{ error }` — matches `purpose.md` today | Rethrown from the artifact branch |
| Absent seeded artifact | `schema.md` absent | 404 | `readWikiArtifact` returns `null`, unchanged |
| Unreadable raw source | `kind=file&path=raw/note.md`, `readFile` throws `EIO` | 404, unchanged | Still degraded — non-strict by decision |
| Non-preview caller | `readWorkbenchFile(...)` with no `strict` and an `EIO` | `null`, unchanged | v1 files/content and source-rescan keep fail-soft |

</intent-contract>

## Code Map

- `src/lib/workbench-files.ts:106-110` -- `WorkbenchFileOptions extends WorkbenchSlugGate` with `limit`/`maxDepth`; the new `strict?: boolean` lands here (read paths only, like `limit`/`maxDepth` are listing-only).
- `src/lib/workbench-files.ts:916-925` -- `readSafely(key)`: one `getStorage().readFile`, `isEnoent`-checked `logger.error`, returns `null`. The swallow to fix.
- `src/lib/workbench-files.ts:1018-1039` -- `readWorkbenchFile`: `resolveWorkbenchFile` → artifact branch (`:1027-1033`, its own catch around `readWikiArtifact`) or key branch (`:1035-1036`, `readSafely`). Both swallow.
- `src/lib/workbench-files.ts:965-1013` -- `resolveWorkbenchFile`: every refusal is one `null`; `wiki/` is gated by `wikiLeafName` + `readableWikiLeaf`, `raw/` by `rawPathAllowed`. Untouched.
- `src/lib/workbench-files.ts:392-413` -- `resolveRoot`: a FAILED `wiki/` silo listing keeps the silo prefix (`:408`), so a failed listing cannot silently redirect the key to the flat tree. This is why fixing `readSafely` alone is sufficient for the wiki leaf.
- `src/lib/workbench-files.ts:155-159` -- `wikiLeafName`, already imported by the route; the one spelling of "direct child of `wiki/`" (DW-204).
- `src/app/api/workbench/preview/route.ts:255-269` -- the `kind=file` read: `purpose.md` → `readEffectiveWikiArtifact` (throw uncaught → 500 today), else `readWorkbenchFile` → `notFound()` on `null`. The call site to make strict.
- `src/app/api/workbench/preview/route.ts:131-144` -- the GET catch: logs and answers `json({ error: getErrorMessage(error) }, 500)`. Already the landing pad; no new branch needed.
- `src/app/api/workbench/preview/route.ts:35-54` -- the route docblock's "NO EXISTENCE ORACLE" paragraph, which currently lists `unreadable` among the 404s. Must be amended.
- `src/app/api/wiki/[slug]/route.ts:51-66` -- the settled precedent: `{ fresh: true, strict: true }`, rethrow, catch answers 500. Comment style to match.
- `src/lib/wiki.ts:370-391` -- `ReadWikiPageOptions.strict`, the option this mirrors, including how it documents the reach it does NOT cover.
- `src/lib/errors.ts:69-75` -- `isEnoent`.
- `src/lib/__tests__/workbench-preview.test.ts:1229-1478` -- the `readWorkbenchFile` block: real filesystem under a temp `DATA_DIR`, `gate(...)` helper, `writeSilo`.
- `src/lib/__tests__/workbench-preview.test.ts:1480-1600` -- the route block: `get(query)` lazily imports the handler, `writePage` seeds file + index.
- `src/lib/__tests__/names-terms.test.ts:388-404` -- the in-repo idiom for a non-ENOENT fault: `vi.spyOn(getStorage(), "readFile")` delegating to the real bind except for one key.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-files.ts` -- add `strict?: boolean` to `WorkbenchFileOptions` with a docblock naming DW-420, what it covers (the Page/artifact bytes) and what it does not (`resolveRoot`'s listing, `readWorkbenchFileBytes`, `workbenchFileExists`); give `readSafely` an options argument that rethrows when `strict` and `!isEnoent(error)` after the existing log; rethrow instead of returning `null` in `readWorkbenchFile`'s artifact catch when `strict`; forward `options.strict` at the `readSafely` call. -- One flag, applied by the two branches that produce a preview body.
- `src/app/api/workbench/preview/route.ts` -- pass `{ ...gate, strict: <seeds a precondition> }` at the `readWorkbenchFile` call, where the predicate is `wikiLeafName(displayPath) !== null || isEditableArtifactFile(displayPath)`; amend the "NO EXISTENCE ORACLE" docblock so a storage failure is named as the exception (500, matching `purpose.md` and `DELETE /api/wiki/[slug]`) and the residuals still on 404 (`raw/`, the media/unsupported existence check) are named. -- The route owns which leaves refuse.
- `src/lib/__tests__/workbench-preview.test.ts` -- extend the `readWorkbenchFile` block with strict/non-strict cases and the route block with the 500-vs-404 cases, driving faults through `vi.spyOn(getStorage(), "readFile")`; cover every I/O matrix row. -- The matrix is the contract.

**Acceptance Criteria:**
- Given a stored, gated `wiki/alpha.md` whose `readFile` throws a non-ENOENT error, when `GET /api/workbench/preview?kind=file&path=wiki%2Falpha.md` is called, then the response is 500 with an `{ error }` body and is not the shared 404.
- Given the same page and the same request, when the fault is ENOENT instead, then the response is still 404 with `{ error: "Not found." }`.
- Given a seeded `schema.md` whose read throws a non-ENOENT error, when it is previewed as `kind=file`, then the response is 500 — the same status `purpose.md` already answers for that fault.
- Given `raw/note.md` whose read throws a non-ENOENT error, when it is previewed, then the response is still 404, and `readWorkbenchFile` called without `strict` still resolves to `null` for the same fault.
- Given the whole suite, when `pnpm test` runs, then it passes with no change to any existing preview assertion other than the docblock-driven ones this spec names.

## Spec Change Log

## Review Triage Log

## Design Notes

The intent was written against a repo state that no longer exists: it asks for a `PageUnreadableError` classified to 503 by the route's GET catch. `src/lib/page-read-failure.ts` and its `PAGE_UNREADABLE_*` constants were deleted by `f2458e1` and never returned; `spec-dw-496-wiki-door-unreadable-contract.md` (done 2026-08-31) records that the repo settled on a `strict` read option whose rethrow the route answers as a 500. This spec is that translation, not a narrowing: the observable defect the intent names — an unreadable page reported as absent at a precondition-seeding door — is closed either way, and 500 is the status every sibling door gives this fault today.

The intent also asks for an explicit decision on the artifact branch. **Included**, on evidence the intent could not have had: at this same door `purpose.md` already answers 500 for an unreadable artifact, because the route reads it through `readEffectiveWikiArtifact` and lets the throw reach the GET catch. Leaving `readWorkbenchFile`'s artifact catch in place would keep `schema.md` 404ing for the fault its sibling reports as a fault, and its payload seeds the scoped `PUT /api/workbench/artifact` precondition (DW-200).

Two limits are deliberate and belong in the code comments. `strict` reaches the BYTES only: `resolveRoot`'s listing still degrades a failed silo listing, which for `wiki/` keeps the silo prefix selected (`:408`) and so cannot redirect the read — the reason the byte-level fix is sufficient here. And `raw/` stays fail-soft: it is not editable, so no write precondition is seeded from it.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-preview.test.ts` -- expected: all pass, including the new strict rows.
- `pnpm test` -- expected: the full two-project run passes.
- `pnpm exec tsc --noEmit` -- expected: no type errors from the new option.
- `pnpm lint` -- expected: clean.
