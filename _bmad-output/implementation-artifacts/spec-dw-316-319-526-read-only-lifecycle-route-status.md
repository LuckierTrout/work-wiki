---
title: 'DW-316/319/526 — write doors answer refusal vs fault with the right status'
type: 'bugfix'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      DELETE /api/research/[id] still answers a mid-request read-only refusal as
      500, the exact defect class this bundle fixed at nine sibling doors.
    evidence: |-
      `retireResearchProject` opens with `assertWritable(READ_ONLY_REFUSAL.researchMutate)`
      (src/lib/research-runtime.ts:463), and the DELETE handler's catch is the
      unchanged `error instanceof ClientInputError ? 400 : 500` shape, so a flag
      that flips between the route's `isReadOnly()` gate and the writer is
      reported as a server fault. Not named by DW-316, DW-319 or DW-526, whose
      intent enumerates the doors to fix, so it was left out of this bundle
      rather than swept in. Its suite (`research-run-route.test.ts:305`) pins the
      400-vs-500 classification with a plain Error and a ClientInputError only,
      so nothing there would surface it. PATCH on the same file is NOT affected:
      `updateResearchProjectIf` reaches no `assertWritable`; the only two in
      `research-projects.ts` are at :442 and :656.
    location: >-
      src/app/api/research/[id]/route.ts:103
    severity: low
  - summary: >-
      No source scan enforces the read-only treatment on the wiki-lifecycle,
      workspace-profile, Names & Terms, email-settings or research writers, so
      the next door added repeats the defect with the suite green.
    evidence: |-
      `read-only-door-coverage.test.ts` exists precisely to catch "the door added
      TOMORROW", but its `KERNEL_WRITERS`/`WRITER_EXPORTS` cover only
      `writeWikiPageWithSideEffects`, `deleteWikiPage`, `patchMetadata` and
      `writeWikiArtifact`. `createWiki`, `renameWiki`, `deleteWiki`,
      `setCurrentWiki`, `applyScenarioTemplate`, `saveWorkspaceProfile`,
      `createNamesTerm`/`updateNamesTerm`/`deleteNamesTerm`,
      `saveEmailIngestConfig`, `createResearchProject` and
      `retireResearchProject` are all gated in the kernel (DW-266, DW-314,
      DW-385) yet invisible to it. Every one of the eleven handlers fixed in this
      pass is pinned only by a hand-written per-door case. Widening the map is a
      change of its own: it would also demand a treatment on the doors listed in
      the entry above and on `PUT /api/settings`, `POST /api/tasks/scan` and the
      rebuild-embeddings doors, none of which this bundle's intent reaches.
    location: >-
      src/lib/__tests__/read-only-door-coverage.test.ts:34
    severity: low
  - summary: >-
      POST /api/names-terms and PUT /api/names-terms/[id] still answer a storage
      fault 400, telling the owner their input was wrong — DW-319's complaint at
      a different door.
    evidence: |-
      Both catches end `{ status: error instanceof NamesTermConflictError ? 409 : 400 }`,
      so an EACCES, a full disk or a lock timeout inside `createNamesTerm` /
      `updateNamesTerm` is reported as the caller's bad input, the exact reasoning
      DW-319 used against `PUT /api/workspace-profile`. Sibling `DELETE
      /api/names-terms/[id]` already answers 500 for the same class, so the one
      store states two verdicts about itself. Pre-existing and untouched by this
      pass, which only prepended the 403 branch; no DW entry names it.
    location: >-
      src/app/api/names-terms/route.ts:57
    severity: low
baseline_revision: '061589f5c63986d7c4408705b889443500b54f34'
---

<intent-contract>

## Intent

**Problem:** Eight write doors misclassify what their `catch` receives. A `ReadOnlyError` thrown by a kernel writer after the route's own `isReadOnly()` gate passed (the flag flips mid-request) is answered 500 by the wiki-lifecycle routes, 400/409 by the Names & Terms writers, and 500 by `DELETE /api/names-terms/[id]`, `PUT /api/email/settings` and `POST /api/research` — a refusal reported as the caller's bad input or as a server fault. Separately, `PUT /api/workspace-profile` answers 400 when `saveWorkspaceProfile` fails for a STORAGE reason, telling the owner their edit was rejected when the write merely could not reach the store.

**Approach:** Add the repo's existing backstop shape — `if (isReadOnlyError(error)) return 403` as the FIRST branch of the handler's catch, the `src/app/api/workbench/artifact/route.ts:68` and `src/app/api/ingest/reingest/route.ts:90` idiom — to every write catch that lacks it, and give the `PUT /api/workspace-profile` write its own try/catch that answers 403 for a refusal, 400 for a `ClientInputError`, and 500 for anything else.

## Boundaries & Constraints

**Always:**
- The 403 branch is FIRST in each catch, before any `ClientInputError` / `NamesTermConflictError` classification, so a refusal can never be reclassified.
- The 403 body is `getErrorMessage(error)` — the KERNEL's own sentence, carried verbatim. Do not substitute a route literal; the sentence is already right and only the status is wrong.
- Every existing early `isReadOnly()` gate stays exactly where it is. These catches are backstops for a mid-request flip only.
- Each route's existing status mapping for non-read-only errors is unchanged, except the one `PUT /api/workspace-profile` change DW-319 names.
- A refusal is not a server fault: do not emit `logger.error` for the 403 path in `PUT /api/email/settings`.
- Behavioural coverage goes in the node suite that already owns each door (`wikis-routes.test.ts`, `workspace-profile-routes.test.ts`, `names-terms-routes.test.ts`, `email-settings-route.test.ts`, `research-route.test.ts`).

**Block If:**
- Adding the 403 backstop to `PUT /api/workspace-profile` requires re-asserting, not just re-wording, `read-only-copy-parity.test.ts` — i.e. an existing assertion there goes red rather than only a prose comment becoming stale.

**Never:**
- Do not touch `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts`. It already carries the 403 backstop; DW-526's closing note about it stating two sentences (`reviewQueue` at the gate, `researchCreate` from the kernel) is a COPY observation, not a status defect, and is out of this bundle.
- Do not change any sentence in `READ_ONLY_REFUSAL`, nor any route's inline 403 literal.
- Do not add or remove kernel `assertWritable` calls.
- Do not add a 403 branch to any GET handler — reads are not refused.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Flag flips mid-request on a wiki-lifecycle write | `isReadOnly()` false at the gate; `createWiki` / `renameWiki` / `deleteWiki` / `applyScenarioTemplate` / `setCurrentWiki` throws `ReadOnlyError` | 403, body `{ error: <kernel sentence> }` | Was 500 |
| Flag flips mid-request on a Names & Terms write | `createNamesTerm` / `updateNamesTerm` throws `ReadOnlyError` | 403, body `{ error: <kernel sentence> }` | Was 400 |
| Flag flips mid-request on a Names & Terms delete | `deleteNamesTerm` throws `ReadOnlyError` | 403 | Was 500 |
| Flag flips mid-request on email settings / research create | `saveEmailIngestConfig` / `createResearchProject` throws `ReadOnlyError` | 403; no `logger.error` on the email path | Was 500 |
| Storage failure on the workspace-profile write | `saveWorkspaceProfile` rejects with a plain `Error` (EACCES, full disk, lock timeout) | 500, body `{ error: <message> }` | Was 400 |
| Flag flips mid-request on the workspace-profile write | `saveWorkspaceProfile` throws `ReadOnlyError` | 403 | Was 400 |
| Caller's input is bad on the workspace-profile write | no active Wiki, drifted `wikiId`, or a field `parseWorkspaceProfileInput` rejects | 400, unchanged | `ClientInputError` |
| Name conflict on a Names & Terms write | `NamesTermConflictError` | 409, unchanged | Classified after the 403 branch |
| Deployment already read-only at request time | early `isReadOnly()` gate | 403 with each route's existing inline/`READ_ONLY_REFUSAL` sentence, unchanged | No catch involved |

</intent-contract>

## Code Map

- `src/app/api/workbench/artifact/route.ts:68-73` -- the canonical fix shape: `isReadOnlyError(error)` first in the catch, body `getErrorMessage(error)`, status 403, with a comment naming the mid-request flip. Copy this shape.
- `src/app/api/ingest/reingest/route.ts:90-98` -- the second worked example ("Backstop for a flag that flipped mid-request").
- `src/lib/read-only.ts:317` -- `isReadOnlyError(err)`, structural on `err.name === "ReadOnlyError"`; `READ_ONLY_REFUSAL` (l.120) holds the sentences the kernel throws. Import `isReadOnlyError` only.
- `src/app/api/wikis/route.ts:88-91` -- POST catch, `ClientInputError ? 400 : 500`. `createWiki` is gated (`wikiCreate`). GET's catch at l.25 is a READ — leave it.
- `src/app/api/wikis/[id]/route.ts:43-46` (PATCH/`renameWiki`) and `:75-78` (DELETE/`deleteWiki`) -- same catch shape, twice.
- `src/app/api/wikis/[id]/template/route.ts:46-49` -- same catch shape (`applyScenarioTemplate`).
- `src/app/api/wikis/current/route.ts:43-46` -- the SAME gap in the same door family (`setCurrentWiki`, gated as `wikiSwitch`). Not named in DW-316's location list, which stopped at three files; included here because it is one line of the identical change and leaving it out mints an immediate leftover.
- `src/app/api/workspace-profile/route.ts:184` -- `saveWorkspaceProfile` call, currently inside the big try whose catch (l.194-196) answers a flat 400. l.96-108 (registry read) and l.158-173 (precondition read) are the two 500 branches whose reasoning this change extends to the write; their comments state the rule.
- `src/app/api/names-terms/route.ts:49-54` -- POST catch, `NamesTermConflictError ? 409 : 400`.
- `src/app/api/names-terms/[id]/route.ts:40-45` (PUT, 409/400) and `:67-68` (DELETE, 500).
- `src/app/api/email/settings/route.ts:185-191` -- PUT catch: `logger.error` then 500. The 403 must return before the log.
- `src/app/api/research/route.ts:140-151` -- POST catch, `ClientInputError ? 400 : 500`. GET's catch (l.62) is a read — leave it.
- `src/lib/__tests__/wikis-routes.test.ts` -- mocks `@/lib/auth`, `@/lib/config`, `@/lib/owner`, `@/lib/wikis`; already imports all four wiki handlers and `ClientInputError`. Add cases here.
- `src/lib/__tests__/workspace-profile-routes.test.ts` -- mocks `getCurrentWiki`, `getWorkspaceProfile`, `saveWorkspaceProfile`; has `putRequest(body, headers)` and `formatIfMatch`/`objectVersion` helpers. A passing precondition needs `If-Match` for `objectVersion(PROFILE)`.
- `src/lib/__tests__/names-terms-routes.test.ts`, `email-settings-route.test.ts`, `research-route.test.ts` -- each saves/clears `process.env.YOPEDIA_READONLY` in `beforeEach` and restores in `afterEach`; each already imports `READ_ONLY_REFUSAL`. Mocked writers can `mockRejectedValue(new ReadOnlyError(...))`.
- `src/lib/__tests__/read-only-copy-parity.test.ts:147-162` and `:185-206` -- two cases whose PROSE says the Settings sentence is "the only one an HTTP caller ever reads" from `PUT /api/workspace-profile`. Their assertions are unaffected by this change; the comment on the second becomes inaccurate once the 403 backstop exists and must be corrected.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- source-scan requiring one of two sanctioned treatments per writer-reaching door. Adding a treatment never fails it.
- `AGENTS.md` "Test environments" -- node-project suites are `*.test.ts` under `__tests__`; run with `pnpm exec vitest run --project node <path>`.

## Tasks & Acceptance

**Execution:**
- `src/app/api/wikis/route.ts` -- add `isReadOnlyError` to the `@/lib/read-only` import and a 403 branch at the head of the POST catch -- a refused create is not a server fault.
- `src/app/api/wikis/[id]/route.ts` -- same branch at the head of both the PATCH and DELETE catches -- rename and delete are gated kernel writes.
- `src/app/api/wikis/[id]/template/route.ts` -- same branch at the head of the POST catch -- re-templating is a gated kernel write.
- `src/app/api/wikis/current/route.ts` -- same branch at the head of the PUT catch -- `setCurrentWiki` is gated as `wikiSwitch`.
- `src/app/api/workspace-profile/route.ts` -- wrap the `saveWorkspaceProfile` call in its own try/catch returning 403 for a read-only refusal, 400 for a `ClientInputError`, and 500 otherwise; leave the outer catch's 400 for the input guards above it -- a store that cannot be WRITTEN is not the owner's edit being wrong, the rule the route's own l.99-102 comment already states for the READ.
- `src/app/api/names-terms/route.ts` -- same 403 branch before the conflict/400 classification in the POST catch -- a refusal must not be answered as bad input.
- `src/app/api/names-terms/[id]/route.ts` -- same branch at the head of the PUT and DELETE catches.
- `src/app/api/email/settings/route.ts` -- same branch at the head of the PUT catch, returning BEFORE `logger.error` -- a refusal is not an error to log as a fault.
- `src/app/api/research/route.ts` -- same branch at the head of the POST catch, before the `ClientInputError` classification.
- `src/lib/__tests__/wikis-routes.test.ts` -- add a mid-request-flip case per handler (POST /api/wikis, PATCH, DELETE, template POST, current PUT): mocked writer rejects with `new ReadOnlyError(READ_ONLY_REFUSAL.<key>)` while `isReadOnly()` is mocked false; expect 403 and the kernel sentence in the body.
- `src/lib/__tests__/workspace-profile-routes.test.ts` -- add three cases: a `saveWorkspaceProfile` rejection with a plain `Error` is 500; with a `ReadOnlyError` is 403; a `ClientInputError` from the input guards is still 400. Each supplies a matching `If-Match` so the precondition passes and the write is actually reached.
- `src/lib/__tests__/names-terms-routes.test.ts` -- add mid-request-flip cases for POST, PUT and DELETE: expect 403, not 400/409/500.
- `src/lib/__tests__/email-settings-route.test.ts` -- add a mid-request-flip case for PUT: expect 403.
- `src/lib/__tests__/research-route.test.ts` -- add a mid-request-flip case for POST: expect 403, sitting beside the existing 400-vs-500 classification rows.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- correct the stale prose in "the Settings route and the kernel behind it answer DIFFERENT sentences": an HTTP caller CAN now read the kernel's `wikiFileWrite` sentence, on the mid-request-flip 403. Assertions unchanged.

**Acceptance Criteria:**
- Given a deployment writable at request time and `YOPEDIA_READONLY` set before the kernel call, when any of the nine write handlers listed in Execution runs, then the HTTP response is 403 and its `error` is the kernel's own refusal sentence.
- Given the same flip, when `PUT /api/email/settings` answers 403, then `logger.error` was not called for that request.
- Given a writable deployment and a valid body with a matching `If-Match`, when `saveWorkspaceProfile` rejects with a non-`ClientInputError`, non-`ReadOnlyError` error, then `PUT /api/workspace-profile` answers 500.
- Given a writable deployment, when a caller sends no active Wiki, a drifted `wikiId`, or a field the parser rejects, then `PUT /api/workspace-profile` still answers 400.
- Given a read-only deployment at request time, when any of these doors is called, then the response is the same 403 and the same sentence it answered before this change.
- Given a writable deployment and a `NamesTermConflictError`, when `POST /api/names-terms` or `PUT /api/names-terms/[id]` runs, then the response is still 409.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures.

## Spec Change Log

No bad_spec loopback occurred. Empty by design.

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 3: (high 0, medium 0, low 3)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[low]` `[patch]` `src/lib/read-only.ts` module header described these door families as gate-and-literal only, which this change made stale; added a paragraph recording the nine new backstops and corrected the `wikiFileWrite` JSDoc clause claiming `PUT /api/workspace-profile` never reaches that sentence. Comment-only — no `READ_ONLY_REFUSAL` value changed.
  - `[low]` `[patch]` `read-only-copy-parity.test.ts` line ~147 still said the workspace-profile door "refuses with a sentence about SETTINGS" unqualified; qualified it as the at-arrival gate and cross-referenced the mid-request-flip note below. Assertions untouched.
  - `[low]` `[patch]` `wikis-routes.test.ts` "leaves the OTHER classifications alone" never drove `mockedRename` or `mockedDelete`, the two handlers in `wikis/[id]/route.ts` that each gained a branch; added a plain-`Error` → 500 control for both.
  - `[low]` `[patch]` `workspace-profile-routes.test.ts` DW-319 rows mixed persistent `mockRejectedValue` with `mockRejectedValueOnce`, leaving a rejecting `saveWorkspaceProfile` for any case appended after them; switched to `mockRejectedValueOnce` throughout and dropped a redundant `mockedReadOnly.mockReturnValue(false)`.

Rejected as noise (not recorded in `deferred`): extracting the repeated 403 branch into a shared helper (the repo's two existing exemplars each carry their own copy, by convention); walking `error.cause` in `isReadOnlyError` (would change a repo-wide contract; nothing wraps these errors); relaying a human sentence instead of the raw store message at 500 (the route's two sibling READ branches already relay raw text at 500 — matching them is the point); adding a `logger.warn` on the 403 paths (neither existing exemplar logs a refusal); the outer `PUT /api/workspace-profile` catch's 400 on a post-write throw (`objectVersion` of a returned profile cannot realistically throw); the spec's own eight-vs-nine-vs-eleven handler counts (the Intent that says "eight" is inside the read-only `<intent-contract>`); a duplicate `VALID` fixture in a separate describe scope; `pnpm lint` absent from Verification (eslint was run over every touched file); and the observation that the new tests inject a `ReadOnlyError` rather than flipping the env flag mid-request (the defect surface DW names is the catch's status mapping, and the kernel's own throw is pinned in `read-only-kernel-gate.test.ts`).

## Design Notes

The shape, copied from `src/app/api/workbench/artifact/route.ts`:

```ts
} catch (error) {
  // Backstop for a flag that flipped mid-request: the gate above already
  // answered for a deployment read-only on arrival, so reaching here means the
  // kernel writer refused. That is a refusal, not a fault or bad input.
  if (isReadOnlyError(error)) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
  }
  const status = error instanceof ClientInputError ? 400 : 500;
  ...
```

`src/app/api/workspace-profile/route.ts` is the one door that needs more than a
prepended branch: its single catch currently flattens every failure to 400, so
the write gets its own try/catch and the outer catch keeps the 400 that belongs
to the input guards (`NO_WIKI`, `WIKI_DRIFTED`, `parseWorkspaceProfileInput`).
Classify by TYPE, not message — the `research/route.ts` idiom recorded at its
l.141-147.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/wikis-routes.test.ts src/lib/__tests__/workspace-profile-routes.test.ts src/lib/__tests__/names-terms-routes.test.ts src/lib/__tests__/email-settings-route.test.ts src/lib/__tests__/research-route.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/read-only-door-coverage.test.ts` -- expected: all pass, including the new mid-request-flip rows.
- `pnpm exec tsc --noEmit` -- expected: no type errors.
- `pnpm test` -- expected: full suite green, no new failures.

## Auto Run Result

Status: done

**Implemented change.** Eleven write handlers across ten route files now classify a
`ReadOnlyError` as a refusal (403) instead of a server fault (500) or the caller's bad
input (400/409). The branch is the repo's existing shape — `isReadOnlyError(error)` FIRST
in the catch, body `getErrorMessage(error)` — copied from `src/app/api/workbench/artifact/route.ts:68`
and `src/app/api/ingest/reingest/route.ts:90`. It is reachable only when `YOPEDIA_READONLY`
flips between a route's own `isReadOnly()` gate and the kernel call; every early gate is
untouched. Separately (DW-319), the `saveWorkspaceProfile` call in `PUT /api/workspace-profile`
got its own try/catch classifying by TYPE — 403 refusal, 400 `ClientInputError`, 500
otherwise — so a storage fault no longer tells the owner their edit was rejected.

`src/app/api/wikis/current/route.ts` was included beyond DW-316's three-file location list:
`setCurrentWiki` is gated as `wikiSwitch`, the catch was byte-identical, and leaving the
fourth door of one family out would have minted an immediate leftover. Disclosed in the
Code Map before implementation.

**Files changed.**
- `src/app/api/wikis/route.ts` — 403 backstop on POST (`createWiki`).
- `src/app/api/wikis/[id]/route.ts` — 403 backstop on PATCH (`renameWiki`) and DELETE (`deleteWiki`).
- `src/app/api/wikis/[id]/template/route.ts` — 403 backstop on POST (`applyScenarioTemplate`).
- `src/app/api/wikis/current/route.ts` — 403 backstop on PUT (`setCurrentWiki`).
- `src/app/api/workspace-profile/route.ts` — the write gets its own 403/400/500 try/catch; the outer catch keeps its 400 for the input guards.
- `src/app/api/names-terms/route.ts` — 403 backstop on POST, ahead of the 409/400 mapping.
- `src/app/api/names-terms/[id]/route.ts` — 403 backstop on PUT and DELETE.
- `src/app/api/email/settings/route.ts` — 403 backstop on PUT, returning BEFORE `logger.error`.
- `src/app/api/research/route.ts` — 403 backstop on POST, ahead of the `ClientInputError` classification.
- `src/lib/read-only.ts` — module header records the new backstop layer; `wikiFileWrite` JSDoc corrected. Comment-only; no sentence changed.
- `src/lib/__tests__/{wikis-routes,workspace-profile-routes,names-terms-routes,email-settings-route,research-route}.test.ts` — mid-request-flip rows per door plus controls pinning that the 403 branch did not swallow the mapping beneath it (400 for input, 409 for a name clash, 500 for a fault).
- `src/lib/__tests__/read-only-copy-parity.test.ts` — comment-only; the workspace-profile door is now two-sentenced and both notes say so. Assertions unchanged, so the spec's Block If never triggered.

**Review findings breakdown.** 4 patches applied (all low), 3 items deferred (all low), 10
rejected. 0 intent_gap, 0 bad_spec — no loopback. Details in the Review Triage Log above.

**Follow-up review recommendation:** false. Patched findings this pass: 0 high, 0 medium,
4 low. Score = 3 × 0 + 1 × 4 = 4, below the threshold of 5, and no patched finding was high.

**Verification.**
- `pnpm exec vitest run --project node` over the seven suites named in Verification — 7 files, **128 passed**. Re-run after the review patches: same result.
- `pnpm exec tsc --noEmit` — clean (exit 0), before and after the patches.
- `pnpm test` — **353 files, 8247 passed, 1 skipped**, before and after the patches. No new failures.
- `pnpm exec eslint` over every touched file — clean.
- Negative control (run by the implementer): reverting only `src/app` while keeping the new
  tests turned exactly the 12 new rows red, so each pins real behaviour rather than passing
  vacuously. Independently reproduced by the verification-gap reviewer, which also confirmed
  the `read-only-copy-parity.test.ts` edit is comment-only. Working tree restored both times.
- Matrix audit: all nine I/O rows are covered by tests that ran and passed — the five
  mid-request-flip rows, the two workspace-profile write rows, the at-arrival gate rows that
  pre-dated this change, and the 409 conflict row.

**Residual risks.**
- The nine 403 bodies carry the KERNEL's sentence rather than each route's inline literal, so
  a mid-request-flip refusal and an at-arrival refusal can read differently at the same door.
  That is deliberate — which sentence a caller meets records WHEN the deployment turned
  read-only — and both `read-only-copy-parity.test.ts` and `src/lib/read-only.ts` now say so.
  No client string-matches on refusal copy; both parity and door-coverage scans stay green.
- The new tests inject a `ReadOnlyError` into a mocked writer rather than flipping the env
  flag mid-flight, so what is pinned is the catch's status mapping — the surface all three DW
  entries name. The kernel's own throw is pinned separately in `read-only-kernel-gate.test.ts`.
- Three sibling doors of the same shape remain un-backstopped and are recorded in frontmatter
  `deferred`; the intent enumerates the doors to fix, so they were left out rather than swept in.
