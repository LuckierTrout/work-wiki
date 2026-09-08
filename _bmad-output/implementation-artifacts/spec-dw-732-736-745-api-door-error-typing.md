---
title: 'DW-732/736/745 — typed refusals at three API doors'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
baseline_revision: '6dab3357e5916ecb72d988ab5bb8d8995b55d7d5'
deferred:
  - summary: >-
      `writeWikiArtifact`'s `purpose.md` authority-marker branch still rethrows a raw
      storage error, so the owner's save banner can show an errno and the server's
      absolute filesystem path by the same door DW-736 was meant to clean.
    evidence: |-
      `purpose.md` is in `EDITABLE_ARTIFACT_FILES`, so `PUT /api/workbench/artifact`
      reaches it. On a Wiki whose record has no `artifactAuthority` marker yet, the
      save takes the legacy branch: the bytes land, `writeRegistry(owner, registryToMark)`
      is attempted, and on failure the artifact is restored and the storage error is
      rethrown unchanged (`src/lib/wikis.ts`, the marker-write catch below the new
      `putWikiArtifact` wrap). That raw error passes every arm of the route's ladder --
      it is neither read-only, write-conflict, unreadable nor unwritable -- and leaves by
      the fallthrough `json({ error: getErrorMessage(error) }, 500)`, which `savePreviewBody`
      renders verbatim. `readRegistry` a few lines above the same branch is unguarded too.
      Two independent review layers reached this by tracing the branch; no test covers it
      (`grep artifactAuthority` finds only `wikis.test.ts` and
      `workspace-purpose-canonicalization.test.ts`, and the one registry-write-failure row
      there drives `canonicalizeWikiPurpose` and asserts the raw message propagates).
      Left out on purpose: this bundle's intent names the write half at `src/lib/wikis.ts:1179`,
      and the marker write is a third store write with a different truth to tell -- after a
      successful restore the stored version is unchanged, but after a failed restore it is not,
      so it needs its own sentence rather than `ARTIFACT_UNWRITABLE_COPY`.
    location: >-
      src/lib/wikis.ts (writeWikiArtifact, the purpose.md authority-marker branch)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three API doors still answer with an untyped fault where their siblings answer with a typed one: `PATCH /api/v1/projects/[wikiId]/reviews/[reviewId]` returns 500 for the contended registry write that four `/api/research` doors already return 503 for; `PUT /api/workbench/artifact` relays a raw storage errno (and the server's absolute path) into the owner's save banner when the WRITE half of the save fails, having typed only the read half; and `parseArchive`'s collision probe rethrows a raw `ENOTDIR` when an archive path's ANCESTOR segment is a file, leaking the host filesystem path through `/api/archive/import`'s 500 body.

**Approach:** Insert the missing rung at each door using the idiom its own siblings already use — a `ResearchProjectBusyError` → 503 rung in the review handler's catch ladder, a write-half mirror of `ArtifactUnreadableError` thrown from `writeWikiArtifact`'s `putWikiArtifact` call and answered with owner-facing copy, and an `ENOTDIR` arm beside the `isDirectory` check that raises an archive-relative message. Pin each with a test, and tighten the one existing test that asserted only "the body's error is a string".

## Boundaries & Constraints

**Always:**
- Classify by TYPE (`instanceof` / `name`), never by string-matching a message — the established idiom at every door touched here.
- Keep every existing rung's order and status: read-only 403 stays first, `ClientInputError` 400 stays ahead of the new rungs, and the bare 500 stays the fallthrough.
- The owner-facing copy is served from a module constant, never read off the caught error's message; the original error rides as `cause` and reaches the log only.
- New error types extend `Error` directly and are recognised by a `name`-matching guard, so a duplicated module graph cannot silently downgrade the typed answer (the `isArtifactUnreadableError` rationale).
- Every new message names only archive- or artifact-relative paths — never a tenant, a storage key, or a host filesystem path.

**Block If:**
- Adding the 503 rung to the review handler cannot be done without the `@/lib/research-projects` mock in `epic8-v1-routes.test.ts` exporting the real `ResearchProjectBusyError` class (the route's `instanceof` would otherwise throw against `undefined`) AND spreading the original module breaks unrelated rows in that suite.

**Never:**
- Do not change the status of any fault that is correctly classified today; DW-736 is a wording fix, not a status fix — the write-half failure stays 500.
- Do not re-type the registry read (`getWikiRegistry`) in `PUT /api/workbench/artifact`'s `handle`: this bundle's intent names the write half at `src/lib/wikis.ts:1179`, and an "artifact could not be saved" sentence would misdescribe a registry-resolution fault.
- Do not wrap the fault inside `putWikiArtifact` itself — it has other callers (seed, re-template) whose contracts are not in scope; wrap at `writeWikiArtifact`'s call site, as the read half is wrapped at its call site.
- Do not touch the deferred-work ledger.
- Do not widen `/api/archive/import`'s 400/500 selector regex; DW-745 is about the message, not the status.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Review deep_research, contended store | `PATCH .../reviews/r-deep` `{action:"deep_research"}`, `createResearchProject` rejects `ResearchProjectBusyError` | 503, body `{ error: <the error's own "retry the request." sentence> }` | Typed rung, ordered after the 400 |
| Review deep_research, caller fault | same, `createResearchProject` rejects `ClientInputError` | 400, `{ error: V1_INVALID_INPUT_ERROR, detail }` — unchanged | Existing rung, must not regress |
| Review deep_research, storage fault | same, rejects `Error("EINVAL: … open '/data/…json'")` | 500, `{ error: <message> }` — unchanged | Existing fallthrough |
| Artifact save, write half fails | `PUT /api/workbench/artifact?path=schema.md` with valid If-Match; `putWikiArtifact` rejects `Error("EACCES: … open '/srv/…'")` | 500, `{ error: ARTIFACT_UNWRITABLE_COPY }`; stored bytes, log and `dataVersion` unchanged | Wrapped as `ArtifactUnwritableError` with the storage error as `cause`; route logs it |
| Artifact save, read-only flips mid-request | same; `assertWritable` throws `ReadOnlyError` | 403, refusal message — unchanged | `ReadOnlyError` passes through the wrap untouched |
| Artifact save, unparseable owner/wiki id | same; storage layer throws `ClientInputError` | 400, message unchanged | `ClientInputError` passes through the wrap untouched |
| Archive probe, ancestor segment is a file | `tenants/alice/raw/atlas` is a regular file; manifest entry `raw/atlas/source.bin` | Inspect and import both reject with a message naming `raw/atlas/source.bin` and no host path | `ENOTDIR` arm, beside the `isDirectory` refusal |
| Archive probe, path absent | entry has no tenant counterpart | listed in `newFiles` — unchanged | `ENOENT` arm, first |
| Archive probe, path is a directory | tenant path is a directory | rejects naming the path — unchanged | `isDirectory` refusal |

</intent-contract>

## Code Map

- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:160-183` -- the catch ladder to amend. Read-only 403 at `:163`, `isClientInputError` 400 at `:177`, bare 500 at `:182`. Its comment at `:167` cites "the `src/app/api/research/route.ts` idiom (DW-478)" — the ladder DW-684 changed underneath it; the comment must name DW-684. `createResearchProject` is called at `:141`.
- `src/app/api/research/route.ts:164-170` -- the reference ladder: `isClientInputError ? 400 : error instanceof ResearchProjectBusyError ? 503 : 500`. Mirror it verbatim in shape. Siblings: `src/app/api/research/[id]/route.ts:108-113` and `:146-151`, `run/route.ts:130-135`, `repair/route.ts:69`.
- `src/lib/research-projects.ts:119` -- `ResearchProjectBusyError` (extends `Error`, sets `name`); thrown at `:679` and `:765` from the exhausted registry CAS.
- `src/lib/__tests__/epic8-v1-routes.test.ts:75-77` -- **the blocker to clear first.** `vi.mock("@/lib/research-projects", () => ({ createResearchProject: vi.fn() }))` is a TOTAL mock, so `ResearchProjectBusyError` would be `undefined` in the route and `error instanceof undefined` throws. Convert to the `importOriginal` spread the three sibling suites already use (`research-route.test.ts:14-21`, `research-run-route.test.ts:27-34`, `research-repair-route.test.ts:20-23`). `research-projects.ts` imports only `config`, `errors`, `lock`, `logger`, `read-only`, `storage`, `wiki`, `research-concurrency`, `research-contract` — `@/lib/wiki` and `@/lib/config` are PARTIAL mocks in this suite, so the spread is safe. New row goes in the `deep_research classifies what the store throws` describe at `:573-647`.
- `src/lib/wikis.ts:897-939` -- `ARTIFACT_UNREADABLE_COPY`, `ArtifactUnreadableError`, `isArtifactUnreadableError`. The write-half mirror goes beside these, same shape and same docblock register.
- `src/lib/wikis.ts:1083-1099` -- the read-half wrap inside `writeWikiArtifact`: `ClientInputError` passes through, everything else becomes `ArtifactUnreadableError(…, { cause })`. Copy the pass-through logic.
- `src/lib/wikis.ts:1179` -- `await putWikiArtifact(owner, wikiId, file, content);`, unguarded. This is the write half. `putWikiArtifact` (`:368-376`) calls `assertWritable` then `getStorage().writeFile`, so a `ReadOnlyError` reaches here too and MUST pass through unwrapped (the route's 403 arm is first and reads it by type).
- `src/app/api/workbench/artifact/route.ts:105-121` -- the route ladder: `isArtifactUnreadableError` → `ARTIFACT_UNREADABLE_COPY` 500 with a log line, then the `isClientInputError ? 400 : 500` fallthrough. The new arm sits directly beneath the unreadable arm, same shape.
- `src/lib/__tests__/wiki-schema-edit.test.ts:1127-1142` -- `"answers a failed storage write with 500, and moves nothing"`: `writeFile` is mocked rejected, and `:1135` asserts only `typeof error === "string"`. Tighten to the exact constant. Imports at `:60-65` already pull the unreadable trio; add the unwritable ones. `:1438-1471` is the structural-guard describe to mirror for the new guard.
- `src/lib/portable-archive.ts:231-259` -- the collision probe. `stat` at `:247`, `isDirectory` refusal at `:248-254`, `collisions.push` at `:255`, catch at `:256-259` where `isEnoent` → `newFiles` and everything else rethrows RAW.
- `src/lib/errors.ts:121-128` -- `isEnoent`, the shape the new `isEnotdir` mirrors (`err instanceof Error` proven before `code` is read).
- `src/lib/storage/filesystem.ts:529-530` -- `stat` is `fs.stat(this.resolve(filePath))`, so the raw Node error carries `code: "ENOTDIR"` and an ABSOLUTE host path in its message. This is the leak.
- `src/lib/__tests__/portable-archive.test.ts:385-441` -- the DW-701 directory case; the new ENOTDIR case is its sibling and uses the same real-tmpdir fixture (`fs.rm` / `fs.mkdir` under `tmpDir`).
- `src/app/api/archive/import/route.ts:19-22` -- read-only evidence: the catch echoes `getErrorMessage(error)` and picks 400 only for `/invalid|unsafe|checksum|missing|limit/i`. Unchanged by this work; the new message stays a 500, as the directory refusal already is.

## Tasks & Acceptance

**Execution:**
- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts` -- import `ResearchProjectBusyError` from `@/lib/research-projects`; replace the `isClientInputError(error) ? 400 : 500` decision at the end of the catch with the three-rung ladder (`400` / `503` / `500`), keeping the 400's token+detail body and the 500's bare-message body, and giving the 503 the bare-message body; rewrite the stale `(DW-478)` comment so it names DW-684 and says why a contended registry write is a retryable 503 here as at the four `/api/research` doors -- the door that shares `createResearchProject` must not tell an agent a provably-never-landed write is permanent.
- `src/lib/__tests__/epic8-v1-routes.test.ts` -- convert the `@/lib/research-projects` mock factory to spread `importOriginal`, keeping `createResearchProject: vi.fn()`; import `ResearchProjectBusyError`; add a row to the `deep_research classifies what the store throws` describe asserting 503 with the error's own message -- the suite that would have caught this had no row for the class.
- `src/lib/wikis.ts` -- add `ARTIFACT_UNWRITABLE_COPY`, `ArtifactUnwritableError` and `isArtifactUnwritableError` beside the unreadable trio, documented as the write-half mirror; wrap the `putWikiArtifact` call at `:1179` in a try/catch that rethrows `ReadOnlyError` and `ClientInputError` unchanged and otherwise throws `ArtifactUnwritableError(ARTIFACT_UNWRITABLE_COPY, { cause: error })` -- the owner's save banner renders this message verbatim.
- `src/app/api/workbench/artifact/route.ts` -- import the new guard and constant; add an arm directly beneath the `isArtifactUnreadableError` arm that logs the error and answers `{ error: ARTIFACT_UNWRITABLE_COPY }` with 500 -- status unchanged, sentence replaced.
- `src/lib/__tests__/wiki-schema-edit.test.ts` -- tighten `"answers a failed storage write with 500, and moves nothing"` from `typeof … === "string"` to the exact `ARTIFACT_UNWRITABLE_COPY`, and assert the body carries no `EACCES`/absolute-path residue; add a describe mirroring the DW-689 structural-guard block for `isArtifactUnwritableError` (accepts a foreign-realm error by `name`, rejects `ClientInputError`, `StoreFaultError`, plain `Error`, `null`, a string and a bare object) -- the guard is what stands between the owner-worded 500 and an errno-leaking one.
- `src/lib/errors.ts` -- add `isEnotdir` beside `isEnoent`, same shape and same "proven `instanceof Error` before reading `code`" rationale -- a second raw spelling of the errno check would drift.
- `src/lib/portable-archive.ts` -- add an `ENOTDIR` arm to the probe's catch, between the `isEnoent` arm and the rethrow, that throws a plain `Error` naming only `entry.path` -- a path whose ancestor is a file can never be written, so it is the same loud refusal the directory case gets, without the host path.
- `src/lib/__tests__/portable-archive.test.ts` -- add a DW-745 case beside the DW-701 one: replace `tenants/alice/raw/atlas` with a regular file, then assert both `inspectPortableArchive` and `importPortableArchive` (under both collision policies) reject with a message naming `raw/atlas/source.bin` and containing neither `ENOTDIR` nor the absolute `tmpDir` path.

**Acceptance Criteria:**
- Given the review handler's `createResearchProject` throws a `ResearchProjectBusyError`, when an agent PATCHes with `action: "deep_research"`, then the response is 503 carrying the error's own message, matching what `POST /api/research` answers for the identical class.
- Given the `@/lib/research-projects` mock spread change, when `epic8-v1-routes.test.ts` runs, then every pre-existing row in it still passes.
- Given `putWikiArtifact` rejects with a raw storage errno, when the owner saves the Schema, then the response is 500 whose `error` is exactly `ARTIFACT_UNWRITABLE_COPY`, the stored artifact, activity log and `dataVersion` are unchanged, and the errno appears only in the server log.
- Given a mid-request read-only flip or an unparseable owner id during the same save, when the write is attempted, then the answer is still 403 / 400 respectively — the wrap does not reclassify them.
- Given a tenant path whose ancestor segment is a regular file, when an archive carrying a deeper entry under it is inspected or imported, then the operation is refused with a message naming the archive-relative entry path only, and no write scope is opened.

## Design Notes

The three doors are independent; only the review handler has an ordering
constraint, and it is the sibling ladder's:

```ts
const status = isClientInputError(error)
  ? 400
  : error instanceof ResearchProjectBusyError
    ? 503
    : 500;
```

The v1 façade splits its bodies (token + `detail` for a caller fault, bare
message for a server fault), so the 503 keeps the bare-message shape: an agent
has nothing to switch-case on for contention, and the store's own sentence
already says "retry the request."

The write-half wrap mirrors the read half at `wikis.ts:1083-1099` exactly,
including which types pass through:

```ts
try {
  await putWikiArtifact(owner, wikiId, file, content);
} catch (error) {
  if (isReadOnlyError(error) || isClientInputError(error)) throw error;
  throw new ArtifactUnwritableError(ARTIFACT_UNWRITABLE_COPY, { cause: error });
}
```

`ReadOnlyError` is the one addition over the read half's pass-through list, and
it is load-bearing: `putWikiArtifact` calls `assertWritable`, and the route's
403 arm reads that by type.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/epic8-v1-routes.test.ts src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/portable-archive.test.ts src/lib/__tests__/research-route.test.ts src/lib/__tests__/research-run-route.test.ts src/lib/__tests__/research-repair-route.test.ts` -- expected: all pass, including the three new rows
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm lint` -- expected: no new errors
- `pnpm test` -- expected: the full two-project run is green

## Auto Run Result

Status: done
Blocking condition: none

### Summary

Three API doors gained the typed refusal their siblings already had. `PATCH /api/v1/projects/{wikiId}/reviews/{reviewId}` with `action: "deep_research"` now answers 503 for a `ResearchProjectBusyError` instead of 500, rung for rung with the five `/api/research` doors that share the store. `PUT /api/workbench/artifact` no longer relays a raw storage errno into the owner's save banner when the overwrite itself fails: `writeWikiArtifact` wraps the `putWikiArtifact` call in an `ArtifactUnwritableError` — the write-half mirror of DW-689's read-half type — and the route answers the owner-facing constant at the same 500, with the errno surviving only as `cause` in the server log. `parseArchive`'s collision probe no longer rethrows a raw `ENOTDIR` when an archive path's ancestor segment is a regular file, so `/api/archive/import` stops echoing the server's absolute filesystem path.

### Files changed

- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts` -- 503 rung between the 400 and the 500, bare-message body; the pre-existing ladder comment now names DW-684.
- `src/lib/research-projects.ts` -- `ResearchProjectBusyError`'s docblock records the closed set of six request/response doors and names `POST /api/tasks/run` as the reasoned exception (its status is the queue consumer's 4xx-poison / 5xx-retry instruction, not a caller's).
- `src/lib/__tests__/epic8-v1-routes.test.ts` -- `@/lib/research-projects` mock converted from total to the `importOriginal` spread the sibling suites use (a total mock left `ResearchProjectBusyError` undefined, and `instanceof undefined` throws); new 503 row.
- `src/lib/wikis.ts` -- `ARTIFACT_UNWRITABLE_COPY`, `ArtifactUnwritableError`, `isArtifactUnwritableError`; the `putWikiArtifact` call wrapped, with `ReadOnlyError` and `ClientInputError` passing through unchanged.
- `src/app/api/workbench/artifact/route.ts` -- unwritable arm directly beneath the unreadable one: logs the error, answers the constant, status unchanged at 500.
- `src/lib/__tests__/wiki-schema-edit.test.ts` -- the storage-write row tightened from "is a string" to the exact constant plus no-`EACCES`/no-tmpdir/no-`/tenants/` residue, its stand-in fault made a real errno with a real absolute path; 403/400 pass-through rows; `isArtifactUnwritableError` structural-guard describe.
- `src/lib/errors.ts` -- `isEnotdir` beside `isEnoent`.
- `src/lib/__tests__/errors.test.ts` -- five `isEnotdir` rows mirroring `isEnoent`'s, including a throwing-getter row.
- `src/lib/portable-archive.ts` -- ENOTDIR arm between the ENOENT arm and the rethrow; archive-relative message, errno as `cause`.
- `src/lib/__tests__/portable-archive.test.ts` -- DW-745 case beside the DW-701 one; asserts the entry path is named, that `ENOTDIR`/tmpdir/tenant key are absent, that the errno survives as `cause`, and that no write scope opened.
- `skills/work-wiki/api-reference.md` -- documents the new 503 and says it carries no token and is not the `busy` concurrency shed.

### Review findings

- Patches applied: 5 (high 0, medium 0, low 5). Score: 0 high -> `followup_review_recommended: false`.
- Deferred: 1 (low) -- the `purpose.md` authority-marker rethrow, recorded in frontmatter `deferred`.
- Rejected: 5 -- answering the new 503 with the `V1_BUSY_ERROR` token (that token is documented as the 64-in-flight concurrency shed, a different refusal); switching the 503 rung from `instanceof` to a `name` guard (the five sibling doors use `instanceof` and the intent said "the same rung"); widening the archive probe's catch to EACCES/ELOOP/ENAMETOOLONG and to the import phase's own EEXIST (a real but distinct class the intent named ENOTDIR against); adding an `isArtifactUnwritableError` arm to the revert door (which is strictly better off than before the change, since it now echoes the constant rather than an errno); and enumerating the artifact door's throw sites as a property test.

### Verification

- `pnpm exec vitest run --project node` over the six spec-named suites plus `errors.test.ts` and `workbench-epic8.test.ts`: 8 files, 319 passed.
- `pnpm exec tsc --noEmit`: clean.
- `pnpm lint`: no errors.
- `pnpm test`: 386 files, 9686 passed, 1 skipped (the skip is pre-existing).
- Matrix test audit: all nine I/O rows have a covering test that ran and passed -- the three `deep_research` classification rows in `epic8-v1-routes.test.ts`, the write-half 500 row and the two pass-through rows in `wiki-schema-edit.test.ts`, and the ENOTDIR, ENOENT and directory rows in `portable-archive.test.ts`.
- Each new row was mutation-checked by reverting its fix: the 503 row failed with `expected 500 to be 503`, the artifact row returned the raw `EACCES` with an absolute path, and the archive row returned `ENOTDIR: not a directory, stat '/var/folders/...'`.

### Residual risks

- The 403/400 pass-through rows reject from `getStorage().writeFile` rather than from `assertWritable` a frame earlier, because the route's own read-only gate answers before `writeWikiArtifact` is reached and a genuine mid-request flip is not producible through the test's `put()` helper by env var alone. What the catch sees is identical either way, but it is a stand-in for the real throw site.
- `epic8-v1-routes.test.ts` now loads the real `research-projects` module under the whole suite rather than a total stub. All 37 pre-existing rows still pass, but the suite's mock surface is wider than it was.
- The DW-745 fix and its test are pinned at the library (`parseArchive`), one layer below the surface the ledger names (`/api/archive/import`'s response body). The route echoes `getErrorMessage(error)` verbatim, so the library assertion implies the body, but nothing in the repo asserts on that route's body directly.
