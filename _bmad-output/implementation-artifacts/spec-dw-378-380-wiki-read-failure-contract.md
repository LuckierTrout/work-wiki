---
title: 'A precondition-bearing page read refuses instead of lying (DW-378, DW-380)'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `wikiPageExists` is the untouched near-twin of the read this bundle fixed and now
      contradicts it: it widens from a non-ENOENT silo failure to the flat file, and
      rethrows a non-ENOENT flat failure raw instead of as a named refusal.
    evidence: |-
      `src/lib/wiki.ts` `wikiPageExists` warns on a non-ENOENT silo failure and falls through
      to `wikiRelPath(...)` — the same widening DW-380 closed for the fresh read, 100 lines
      above it — and its flat catch does `throw err`, so a caller sees an unclassified errno
      whose message carries an absolute server path rather than `PAGE_UNREADABLE_COPY`.
      Pre-existing and out of this bundle's `fresh`-scoped reach: `wikiPageExists` has no
      `fresh` option and returns a boolean, so it has no "precondition-bearing" mode to gate on.
    location: >-
      src/lib/wiki.ts:289
    severity: low
  - summary: >-
      `GET /api/workbench/preview?kind=file` still degrades an unreadable `wiki/<slug>.md`
      to the shared 404, and that door seeds the same `PUT /api/wiki/[slug]` precondition
      the `kind=page` door now refuses for.
    evidence: |-
      The Files tab reaches the same bytes through `readWorkbenchFile` -> `readSafely`
      (`src/lib/workbench-files.ts`), which swallows every non-ENOENT error into `null`, so the
      route answers `notFound()`. The payload it would otherwise serve carries a `version` for
      the same page `PUT`, so this is DW-378's lie surviving on a second read door of the same
      route. Closing it means giving `readSafely` a refusing mode, which is outside the
      `fresh`-scoped contract this bundle established; the route comment names the residual.
    location: >-
      src/lib/workbench-files.ts (readSafely) via src/app/api/workbench/preview/route.ts
    severity: medium
  - summary: >-
      `PATCH` and `DELETE /api/wiki/[slug]` still answer `page not found` for a page whose
      bytes could not be read, and `DELETE`'s catch maps an unknown error to 400.
    evidence: |-
      `patchMetadata` reads unqualified, so a non-ENOENT storage failure becomes `null` ->
      `code = "NOT_FOUND"` -> 404 at the `PATCH` door; `DELETE` reads unqualified at
      `src/app/api/wiki/[slug]/route.ts:47` and answers the same 404 on `!existing`. Both verbs
      MUTATE the page, so both make the existence claim DW-378 names — the intent scoped this
      bundle to the `fresh` path and neither verb takes one. `DELETE`'s catch additionally
      classifies anything that is not "page not found" as 400, so it would mis-answer
      `PageUnreadableError` as a client error if it ever gained a fresh read.
    location: >-
      src/app/api/wiki/[slug]/route.ts:47, src/lib/patch-metadata.ts
    severity: medium
  - summary: >-
      A failed PAGE-INDEX read re-opens both lies for a silo-resident page, because
      `getPageIndex` is fail-soft and a fresh read skips the silo branch entirely when it
      answers `null`.
    evidence: |-
      `getPageIndex` logs and returns `null` on its own storage failure (`src/lib/page-index.ts`).
      `readWikiPage` then never computes a silo path: a silo-only page meets ENOENT on the flat
      path and resolves `null` (DW-378's 404, unfixed), and a page with a stale flat copy yields
      a version over a file the write will not target (DW-380, unfixed). The intent enumerates
      "a non-ENOENT silo or page failure"; an index failure is neither, so closing it needs its
      own decision about whether a precondition-bearing read may proceed without the index.
    location: >-
      src/lib/wiki.ts:416 via src/lib/page-index.ts
    severity: medium
  - summary: >-
      `PUT /api/workbench/artifact` relays the raw errno message as owner-facing copy when its
      precondition-bearing read fails.
    evidence: |-
      `writeWikiArtifact` rethrows the read failure raw when `expectedVersion` was supplied
      (`src/lib/wikis.ts:920`), and the route maps anything that is not read-only / write-conflict /
      `ClientInputError` to 500 with `getErrorMessage(error)`. `savePreviewBody` relays a served
      `{ error }` verbatim for any non-502/504 status, so in the same Preview editor a page save
      now shows `PAGE_UNREADABLE_COPY` while an artifact save shows
      `EIO: i/o error, read '/abs/server/path/...'`. Pre-existing; the sibling half of the
      divergence DW-378 named.
    location: >-
      src/app/api/workbench/artifact/route.ts:86
    severity: medium
baseline_revision: '2da21a56ed4cda2b853682ad5dd8ca28bd769f3f'
---

<intent-contract>

## Intent

**Problem:** `readWikiPage` answers `null` for a page that is UNREADABLE as well as one that is absent (`src/lib/wiki.ts:413-431`), so `PUT /api/wiki/[slug]` turns a storage blip into `page not found: <slug>` (404) before the write precondition is ever consulted — while `writeWikiArtifact` one layer over already rethrows for exactly this reason (DW-378). The same read also falls through a FAILED silo read to the legacy flat file (`src/lib/wiki.ts:388-411`), so `fresh` bypasses `pageCache` but not that widening: the editor gets a version computed over one file while the write targets another (DW-380).

**Approach:** Scope the change to the `fresh` path only. When a caller asks for a fresh read, a non-ENOENT silo failure rethrows instead of widening to flat, and a non-ENOENT flat/page failure rethrows instead of answering `null`. Both throw one named, name-matched error owned by a new zero-dependency leaf, which the two doors that consume a fresh read map to 503 with one sentence — the same shape `PUT /api/settings` already answers when its store cannot be read.

## Boundaries & Constraints

**Always:**
- The UNQUALIFIED read (`fresh` absent or `false`) keeps its exact current behaviour, byte for byte: warn, fall back to flat, cache the negative entry, return `null`. ~40 callers depend on that null contract.
- ENOENT stays "absent" on BOTH paths and in BOTH modes — a missing page is still `null`, still a 404.
- The refusal travels as a thrown error with an explicitly set `name`, classified by a `name`-matching predicate (never `instanceof`), exactly as `ReadOnlyError` and `WriteConflictError` are — a duplicated module graph must not turn the 503 back into a 500.
- One sentence, one owner: the copy is a single exported constant, never re-typed at a route.
- The 503 branch sits ABOVE the generic status ladder in each route's existing `catch`, and BELOW the read-only branch already there.

**Block If:** the correct status for an unreadable page at the `PUT` door is contested by an existing route contract that already answers something other than 503 for an unreadable store.

**Never:**
- Do not change `readWikiPage`'s signature, its return type, or any non-`fresh` call site.
- Do not add a retry, a backoff, or a second read anywhere.
- Do not touch `writeWikiArtifact`, `checkWritePrecondition`, or the 412/428 statuses.
- Do not add a client component or new UI copy; the existing `savePreviewBody` relays the server's `{ error }` verbatim (503 is deliberately NOT in `UNCONFIRMED_STATUSES`).
- Do not catch the throw in `src/app/u/[handle]/[slug]/edit/page.tsx` — see Design Notes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh read, silo read fails non-ENOENT | page index names a tenant; silo `readFile` throws EIO | `readWikiPage(slug, { fresh: true })` REJECTS with `PageUnreadableError`; the flat file is never read | throws; cause preserved |
| Fresh read, silo ENOENT, flat readable | silo absent, flat present | resolves with the flat page, `path` = flat | No error expected |
| Fresh read, flat read fails non-ENOENT | no page index; flat `readFile` throws EIO | REJECTS with `PageUnreadableError`; nothing cached | throws; cause preserved |
| Fresh read, page genuinely absent | both paths ENOENT | resolves `null`; no negative cache entry written | No error expected |
| Unqualified read, silo fails non-ENOENT | same EIO, `fresh` omitted | resolves with the FLAT page (unchanged widening), warn logged | swallowed, as today |
| Unqualified read, flat fails non-ENOENT | same EIO, `fresh` omitted | resolves `null`, warn logged, negative entry cached when a cache is open | swallowed, as today |
| `PUT /api/wiki/[slug]`, page unreadable | valid `If-Match`, storage read throws EIO | 503 with `{ error: PAGE_UNREADABLE_COPY }`; no write, no log line, no `dataVersion` bump | classified in the existing catch |
| `PUT /api/wiki/[slug]`, page absent | slug with no file | 404 `page not found: <slug>` — unchanged | No error expected |
| `GET /api/workbench/preview?kind=page`, page unreadable | gated-in slug, storage read throws EIO | 503 with `{ error: PAGE_UNREADABLE_COPY }` — no longer a 404 | classified in the existing catch |

</intent-contract>

## Code Map

- `src/lib/wiki.ts:369-442` -- `readWikiPage`. `const fresh = options?.fresh === true` at :380. Silo branch :388-411 (`catch` at :404-410 warns on non-ENOENT and falls through). Flat fallback :413-431 (`catch` at :418-430 warns, seeds the negative cache when `!fresh`, returns `null`). BOTH catches are the change. `ReadWikiPageOptions` at :328-360 -- the `fresh` docblock states the current guarantee and must gain the new one.
- `src/lib/wiki.ts:460` -- `readWikiPageWithFrontmatter` forwards `options` verbatim; the throw propagates with no change here.
- `src/lib/errors.ts:29-35` -- `isEnoent(err)`: the ENOENT test both catches already use. Reuse it; do not re-spell it.
- `src/lib/read-only.ts` -- the pattern to copy for the new leaf: explicit `this.name`, a `name`-matching predicate, and a module docblock saying why `instanceof` is wrong here.
- `src/lib/write-precondition.ts:WriteConflictError / isWriteConflictError / WRITE_CONFLICT_STATUS` -- the second instance of the same pattern, plus the status-constant convention.
- `src/lib/config.ts:420` -- `CONFIG_UNREADABLE_COPY`, and `src/app/api/settings/route.ts:52-62` `configUnreadable()`: the PRECEDENT for 503-not-500 on an unreadable store, including the "copy anything unsaved, reload, try again" recovery half. Mirror the shape and the tone; do not import it (that copy names the settings store).
- `src/app/api/wiki/[slug]/route.ts:195-201` -- the fresh read and the `!existing` → 404 that DW-378 names. `:300-313` -- the PUT `catch`: read-only branch, then `invalid slug` → 400, else 500. Insert the new branch between them.
- `src/app/api/workbench/preview/route.ts:137-138` -- the fresh read and its `notFound()`. `:93-104` -- the GET `catch`, which logs `logger.error` and answers 500.
- `src/lib/workbench-preview.ts:1283-1290` -- documents that 503 is deliberately excluded from `UNCONFIRMED_STATUSES` because this app's routes emit it as a verdict, so `savePreviewBody` relays the served sentence verbatim. No client change is needed.
- `src/lib/__tests__/wiki.test.ts:1936-2050` (the `fresh` block) and `:2194-2260` (`silo-primary reads`, which shows the `getStorage()` + `putIndex("pages", …)` fixture) -- where the unit tests go.
- `src/lib/__tests__/wiki-routes.test.ts:30-45` -- `currentIfMatch(slug)` helper; the PUT describe blocks are the model for the route test.
- `src/lib/__tests__/workbench-preview.test.ts:1450-1500` -- the preview-route fixture (`writePage`, `get(query)`).

## Tasks & Acceptance

**Execution:**
- `src/lib/page-read-failure.ts` -- NEW zero-dependency leaf exporting `PAGE_UNREADABLE_COPY`, `PAGE_UNREADABLE_STATUS = 503`, `class PageUnreadableError extends Error` (explicit `this.name`, accepts a `cause`), and `isPageUnreadableError(err)` matching on `err.name` -- one owner for the sentence, the status and the classifier, importable by both routes without pulling the wiki graph.
- `src/lib/wiki.ts` -- in `readWikiPage`, make BOTH catches conditional on `fresh`: the silo catch rethrows a non-ENOENT failure as `PageUnreadableError` (never reaching the flat fallback) and the flat catch rethrows a non-ENOENT failure instead of returning `null`; every non-`fresh` line stays exactly as it is. Update the `fresh` docblock and `readWikiPage`'s own docblock to state the new contract -- this is the whole of DW-378 and DW-380.
- `src/app/api/wiki/[slug]/route.ts` -- in the PUT `catch`, classify `isPageUnreadableError` → `PAGE_UNREADABLE_STATUS` with `PAGE_UNREADABLE_COPY`, above the `invalid slug` ladder -- so a storage blip stops being answered as `page not found`.
- `src/app/api/workbench/preview/route.ts` -- in the GET `catch`, classify the same error → 503 with the same sentence, before the `logger.error`/500 fall-through -- the other fresh-read door, so one failure does not answer two different ways.
- `src/lib/__tests__/wiki.test.ts` -- add a `fresh` read-failure describe covering every Matrix row for the library, spying on `getStorage().readFile` to throw a non-ENOENT error for one path -- pin that `fresh` refuses AND that the unqualified read still widens and still answers `null`.
- `src/lib/__tests__/wiki-routes.test.ts` -- add PUT cases for the unreadable page (503 + sentence, nothing written) and re-assert the absent page still answers 404 -- pin the two apart at the door.
- `src/lib/__tests__/workbench-preview.test.ts` -- add a preview-route case for the unreadable page (503 + sentence, no longer 404).

**Acceptance Criteria:**
- Given a page whose fresh read fails with a non-ENOENT storage error, when `PUT /api/wiki/[slug]` is called with a well-formed `If-Match`, then the response is 503 carrying `PAGE_UNREADABLE_COPY`, the page file is unchanged, and no activity-log line is written.
- Given the page index names a tenant and the silo read fails with a non-ENOENT error, when `readWikiPage(slug, { fresh: true })` runs, then it rejects with `PageUnreadableError` and the flat file at `wiki/<slug>.md` is never read.
- Given the same silo failure, when `readWikiPage(slug)` runs with no options, then it resolves with the flat file's content exactly as it does today.
- Given a page that does not exist at all, when either read mode runs, then the result is `null` and the `PUT` door still answers 404 `page not found: <slug>`.
- Given a gated-in slug whose fresh read fails with a non-ENOENT error, when `GET /api/workbench/preview?kind=page&slug=…` runs, then the response is 503 carrying `PAGE_UNREADABLE_COPY` rather than the shared 404 body.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 4, low 4)
- defer: 5: (high 0, medium 4, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` Both fresh-throw branches skipped the `logger.warn` below them and neither consuming route logs, so a storage incident on a precondition-bearing read left no server-side trace — added a `logger.error` naming the slug and the exact path before each throw.
  - `[medium]` `[patch]` The `PUT` docblock still enumerated three outcomes and claimed 404 for a slug that does not exist, with no mention of the new wire status — added the 503 outcome and extended the existing docblock-parity test (which already required "428"/"412") to require "503".
  - `[medium]` `[patch]` Test hardening: the `isPageUnreadableError`/`cause` assertions sat inside a `.catch(cb)` that never runs if the promise resolves (now `try`/`expect.unreachable()`); both route spies matched `endsWith("<slug>.md")` and so did not prove WHICH read failed (now exact storage-relative keys); no door-level test exercised DW-380 at all, since both route tests failed silo and flat together (added a preview case where only the silo read fails and a DIFFERENT readable flat copy exists); and the matrix's "no `dataVersion` bump" claim was unasserted (now a `putIndex` spy asserted uncalled across the refused save).
  - `[medium]` `[patch]` The edit server component's new behaviour was unpinned — wrapping its read in a `try/catch` that sets `page = null` would silently restore the DW-378 lie with every test green. Added a case to `edit-denial-copy.test.tsx` rejecting the mocked read with `PageUnreadableError` and asserting no "Page not found" markup is produced.
  - `[low]` `[patch]` `PAGE_UNREADABLE_COPY` says "so nothing was changed", a write-shaped sentence now also served by a `GET` — documented the asymmetry the way `CONFIG_UNREADABLE_COPY` documents its own: the sentence reaches the owner on the SAVE door, and the preview `GET`'s 503 buys the status class (`unreachable`, stale bytes kept) rather than the copy.
  - `[low]` `[patch]` "No caller can induce a storage failure for a chosen slug" was stated absolutely in three places and is overstated (EMFILE/ENFILE/ENOMEM and an R2 5xx are request-driven) — softened to "not reliably or selectively", resting the argument on the accepted residual instead.
  - `[low]` `[patch]` The preview route's "one failure must not answer two ways" overstated the result while the same route's `kind=file` branch answers a third way — narrowed the claim to the two PAGE doors and named the residual.
  - `[low]` `[patch]` The new leaf's central design claim (name-matching, not `instanceof`) was exercised by nothing — added `src/lib/__tests__/page-read-failure.test.ts`, including the hand-copied recovery-clause parity against `CONFIG_UNREADABLE_COPY`.

## Design Notes

**Why 503 and not 500.** `PUT /api/settings` already answers 503 with `CONFIG_UNREADABLE_COPY` for exactly this condition — a store that is temporarily unavailable — and `workbench-preview.ts` documents that 503 is excluded from `UNCONFIRMED_STATUSES` precisely because this app's own routes emit it as a definite verdict. So `savePreviewBody` relays the sentence verbatim and keeps the owner's draft, with no client change. A 500 would be read as a server fault, and a 404 is the lie this bundle removes.

**Why the 503 lands before the ACL cloak.** The cloak needs `existing.frontmatter`, which is precisely what the failed read did not produce — there is nothing to cloak with. The residual difference is real: an existing-but-unreadable page answers 503 where an absent one answers 404.

What carries the argument is the CONCLUSION, not an impossibility claim. Reaching the difference requires an actual storage failure, and some failure classes are request-driven rather than ambient — resource exhaustion (EMFILE / ENFILE / ENOMEM) and an R2 5xx surfaced as a non-ENOENT error can both be provoked by load. So the honest statement is that no caller can induce the failure RELIABLY or SELECTIVELY for a slug of their choosing, which is what a usable existence oracle would require; a caller who can only make reads fail broadly learns nothing about any particular slug. Weighed against the alternative — telling the owner their page does not exist every time storage hiccups — that residual is accepted deliberately for this single-owner private deployment.

**Why the edit server component is left throwing.** `src/app/u/[handle]/[slug]/edit/page.tsx` also reads fresh; the throw now reaches Next's error boundary instead of rendering "Page not found". That is the correct direction — a hard failure rather than a false claim about what exists — and it needs no new copy, because at page load there is no draft to protect.

Shape for both catches (silo shown; the flat one is the same test returning a throw instead of `null`):

```ts
} catch (e) {
  if (fresh && !isEnoent(e)) {
    // A precondition-bearing read must not widen to a DIFFERENT file (DW-380).
    throw new PageUnreadableError(PAGE_UNREADABLE_COPY, { cause: e });
  }
  if (!isEnoent(e)) logger.warn("wiki", `silo read failed for "${slug}", falling back to flat:`, e);
}
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wiki.test.ts src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/workbench-preview.test.ts` -- expected: all pass, including the new read-failure cases.
- `pnpm test` -- expected: no new failures anywhere in the suite (the ~40 unqualified `readWikiPage` callers are the regression surface).
- `pnpm lint` -- expected: clean.

**Environment note:** the local `pnpm` binary is broken on this machine (`pnpm -v` itself exits with `ERROR packages field missing or empty`), so every `pnpm <script>` above was run through its underlying command instead: `npx vitest run …`, `npx vitest run`, `npx eslint`. Not caused by this change — no package manifest was touched.
- `npx tsc --noEmit` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** A `fresh` `readWikiPage` now REFUSES a failed read instead of answering
`null`. On the silo path a non-ENOENT failure throws rather than widening to the legacy flat file
(DW-380, which otherwise derives a version over a file the write will not target); on the flat path
a non-ENOENT failure throws rather than returning `null` (DW-378, which the `PUT` door answered as
`page not found` before the precondition was ever consulted). ENOENT still means "absent" on both
paths in both modes, and the unqualified read — the null contract ~40 callers depend on — is
byte-for-byte unchanged, warn, widening, negative cache and all. The refusal is a named,
`name`-matched error that the two doors consuming a fresh read map to 503 with one owned sentence,
the same shape `PUT /api/settings` already answers for an unreadable store.

**Files changed.**
- `src/lib/page-read-failure.ts` (new) — zero-dependency leaf owning `PAGE_UNREADABLE_COPY`,
  `PAGE_UNREADABLE_STATUS = 503`, `PageUnreadableError` and `isPageUnreadableError`.
- `src/lib/wiki.ts` — both catches in `readWikiPage` gate on `fresh`; each logs before throwing;
  three docblocks state the new contract.
- `src/app/api/wiki/[slug]/route.ts` — PUT catch classifies the refusal as 503 above the
  `invalid slug` ladder; the PUT docblock gains the fourth outcome.
- `src/app/api/workbench/preview/route.ts` — GET catch classifies the same refusal as 503; the
  `NO EXISTENCE ORACLE` docblock gains the storage-failure carve-out.
- `src/lib/__tests__/wiki.test.ts` — library-level read-failure suite (fresh refuses on both paths,
  unqualified still widens and still answers `null`, ENOENT unchanged, refusal propagates through
  `readWikiPageWithFrontmatter`).
- `src/lib/__tests__/wiki-routes.test.ts` — PUT 503 cases, absent-page 404 re-assert, `putIndex`
  asserted uncalled, docblock parity extended to 503.
- `src/lib/__tests__/workbench-preview.test.ts` — preview 503-not-404 case, absent stays the shared
  404, and the DW-380 door case (only the silo read fails, a different flat copy is readable).
- `src/lib/__tests__/page-read-failure.test.ts` (new) — the leaf's own contract, including
  cross-module-copy classification and recovery-clause parity with `CONFIG_UNREADABLE_COPY`.
- `src/app/u/[handle]/[slug]/edit/__tests__/edit-denial-copy.test.tsx` — pins that a failed fresh
  read on the edit screen does not render "Page not found".

**Review findings breakdown.** 8 patches applied (4 medium, 4 low), 5 items deferred (4 medium,
1 low — recorded in frontmatter `deferred`), 8 rejected. No intent gaps and no spec repairs; the
review loop ran once.

**Follow-up review recommendation:** true. Patched findings this pass: high 0, medium 4, low 4;
score = 3x4 + 1x4 = 16, which is at or above the threshold of 5.

**Verification performed.**
- `npx vitest run` (full suite) — 273 files, 6134 tests, all passed.
- `npx tsc --noEmit` — clean.
- `npx eslint` — exit 0.
- The `pnpm` binary is broken on this machine (`pnpm -v` itself exits with
  `ERROR packages field missing or empty`), so every `pnpm <script>` in `## Verification` was run
  through its underlying command. No package manifest was touched by this change.
- Every I/O matrix row is covered by a named test that ran and passed.

**Residual risks.**
- `PUT`'s 503 is decided in the handler's catch, so it lands before the ACL cloak — an
  existing-but-unreadable page answers 503 where an absent one answers 404. The cloak needs the
  frontmatter the failed read did not produce, so there is nothing to cloak with; the difference is
  reachable only during an actual storage failure, and only resource-exhaustion classes make that
  request-driven at all.
- The owned sentence reaches the owner at the SAVE door only. On the preview `GET`, `fetchPreview`
  maps every non-ok response to `unreachable` and drops the body, so the 503 there buys the status
  class (stale bytes kept, Retry offered) rather than the copy. Documented, not changed.
- `src/app/u/[handle]/[slug]/edit/page.tsx` now throws into the segment's error boundary instead of
  rendering "Page not found". Correct in direction and pinned by test, but the owner sees the generic
  boundary copy rather than the sentence.
- Four read/write doors still answer the pre-existing 404 (or a raw errno) for the same condition —
  `kind=file` preview, `PATCH`, `DELETE`, and the artifact save — all recorded in `deferred`.
