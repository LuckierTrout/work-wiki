---
title: 'Write precondition: hold it inside the lock, bind it to the Wiki, read it fresh (DW-193, DW-194, DW-195, DW-200)'
type: 'bugfix'
created: '2026-08-21'
baseline_revision: '680ad39b2b060760731cd34837344c0c1950958c'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `readWikiPage` answers `null` for a page that is UNREADABLE as well as one
      that is absent, so a storage blip on the page write's merge-base read is
      reported as `404 page not found`.
    evidence: |-
      `src/lib/wiki.ts:409-419` warns and returns `null` for every non-ENOENT
      read failure, and `PUT /api/wiki/[slug]` turns that `null` into
      `page not found: <slug>` before the precondition is ever consulted. This
      bundle made exactly the opposite call one layer over: when
      `writeWikiArtifact` is given an `expectedVersion`, a failed pre-write read
      rethrows rather than being read as "absent", because "absent" is answered
      as a conflict and a blip is not one. The page path keeps the older
      behaviour, so the same transient failure is a 404 on one surface and a 500
      on the other. Pre-existing — the swallow predates the precondition and
      this change only added the `fresh` option beside it — and closing it means
      changing `readWikiPage`'s null contract, which ~40 callers depend on.
    location: src/lib/wiki.ts:409, src/app/api/wiki/[slug]/route.ts:161
    severity: medium
  - summary: >-
      The other read-modify-write merge bases still read through `pageCache`, so
      the staleness DW-195 closed for the precondition-bearing reads is open on
      every path that merges into cached bytes and writes the result back.
    evidence: |-
      `src/lib/patch-metadata.ts` (the `PATCH` frontmatter merge), the page
      revert in `src/app/api/wiki/[slug]/revisions/route.ts`, `src/lib/merge.ts`
      and several sites in `src/lib/lint-fix.ts` all call `readWikiPage` /
      `readWikiPageWithFrontmatter` without `{ fresh: true }` and then write the
      merged result. A bulk scan (`lint.ts`, `search.ts`, `query.ts`,
      `dataview.ts`) holding a superseded entry open across one of those
      requests makes the merge base a file that is no longer stored, and the
      write lands it back. Pre-existing and unrelated to the precondition — none
      of these routes is gated, and the spec's Never clause forbids gating them
      — but "do not gate it" is a different decision from "let it merge into
      cached bytes". Closing it is a sweep over those call sites, not a change
      to this guard.
    location: src/lib/patch-metadata.ts, src/lib/merge.ts, src/lib/lint-fix.ts
    severity: medium
  - summary: >-
      A fresh read still falls back from a FAILED silo read to the flat copy, so
      a version can describe bytes at a path the write will not target.
    evidence: |-
      `src/lib/wiki.ts:389-401` warns on a non-ENOENT silo failure and falls
      through to `wikiRelPath(...)`, which is the legacy flat file. `fresh`
      bypasses `pageCache` but not that fallback, so a transient silo failure on
      a precondition-bearing read hands the editor the version of the flat copy
      while `writeWikiPageWithSideEffects` resolves the tenant path — a
      precondition computed over one file and compared against another.
      Pre-existing: the fallback predates the version entirely and exists so a
      not-yet-migrated page still reads. Closing it means letting a
      precondition-bearing read refuse rather than widen, which needs the same
      null-contract change the entry above names.
    location: src/lib/wiki.ts:389
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The `If-Match` guard does not hold across the window it claims to guard. `PUT /api/workbench/artifact` reads current bytes at `route.ts:157`, OUTSIDE the `wikis:<tenant>` lock its own writer takes at `wikis.ts:734`, so the one route already holding a lock still leaves a check-to-write gap (DW-193). Its version hashes content alone, so a Schema draft held across an active-Wiki switch lands on the OTHER Wiki's `schema.md` whenever both hold the identical seeded bytes (DW-200). `readWikiPage`'s module-global `pageCache` (`wiki.ts:335-337`) can serve the Preview — and now the page write route's own merge base — a stale body and a stale version, producing a 412 against a write the reader never saw, or a match against bytes that are no longer stored (DW-195). And requiring `If-Match` is an undocumented wire-contract change for the service-token REST path that `middleware.ts:30` still describes as an unconditional write, with no test covering that caller (DW-194).

**Approach:** Thread the expected version into `writeWikiArtifact` and re-check it inside the lock it already takes, against the bytes it already reads for the revision snapshot — one read, one critical section, no new lock and no new ordering. Bind the resolved Wiki id into the artifact's version through a scoped variant of the same pure hash, so a token read from one Wiki matches no other, while the browser still names no Wiki. Give every precondition-bearing page read a cache-bypassing option so the version and the bytes it describes come from storage. Document the header on the service-token surface and cover it with executed tests.

## Boundaries & Constraints

**Always:**
- The artifact precondition is compared INSIDE `withWikiLock`, above the revision snapshot and above `putWikiArtifact`, against the bytes read in that same critical section. A refused save writes nothing: no snapshot, no bytes, no log line, no `dataVersion` bump.
- ONE comparison, in `write-precondition.ts`, shared by the header-level check and the writer-level check. Neither re-types the conflict sentence.
- The 428 (no usable `If-Match`) is answered at the route, before the lock is taken. Only the 412 half moves inward.
- `expectedVersion` is OPTIONAL on `writeWikiArtifact`: a caller that supplies none writes exactly as it does today. When one IS supplied, the pre-write read stops being fail-soft — a read that throws refuses the save with its own error rather than being read as "absent".
- The artifact version is `scopedContentVersion(wikiId, bytes)` on EVERY side that computes it — the Preview read, the artifact `PUT`'s check and answer, and the artifact revert's answer — so no two sides can hash different strings.
- The scope is always the server-resolved `currentId` (or the gated `wikiId` for revert). The browser addresses no tenant, no Wiki and no storage key; the version stays an opaque token it only relays.
- Page reads that SEED or CHECK a precondition bypass `pageCache`. A bypassing read neither consults nor mutates the cache, so a bulk scan holding it open is unaffected.
- `readWikiPage` / `readWikiPageWithFrontmatter` keep their current signatures and cached behaviour for every existing caller; freshness is an added option.
- The wire contract for `PUT /api/wiki/[slug]` — `If-Match` required, 428 absent, 412 mismatched — is stated where a non-browser caller reads it: the middleware's in-route-auth note and the route's own docblock.

**Block If:** the artifact writer cannot take the precondition without a second lock acquisition or a new lock key (it can: `readWikiArtifact` is an unlocked raw read already called from inside `withWikiLock`).

**Never:**
- No new lock, no new lock key, no new lock ordering, no reentrant acquisition.
- Do not gate `PATCH /api/wiki/[slug]`, `POST /api/wiki`, the page revisions/revert routes, the artifact revert route, `POST /api/ingest/reingest`, or `src/mcp.ts`. None is named here.
- Do not change the settings precondition scheme (`readConfig`/`saveConfig` own it since DW-192), and do not widen the 412/428 vocabulary or the two sentences.
- Do not make `pageCache` fresh by default, do not remove it, and do not change its ref-counting.
- Do not let a caller name the Wiki a save lands on, and do not add a Wiki id to any payload or header.
- No merge/diff UI, no reload affordance, no new dependency, no i18n, no restyle.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Concurrent artifact saves, same seed | Two `PUT /api/workbench/artifact` with the SAME valid `If-Match` | Exactly one 200 and one 412; the stored bytes are the 200's content | The loser's draft is kept; conflict sentence |
| Artifact save, matching version | `If-Match` equals `scopedContentVersion(currentId, stored)` | 200, bytes land, answer carries the new scoped version | No error expected |
| Draft across a Wiki switch | Two Wikis seeded from one template, identical `schema.md`; version read from A, active Wiki now B | 412; B's `schema.md` unchanged | Conflict sentence; draft kept |
| Artifact gone | `schema.md` deleted between read and save | 412 — a missing file matches no version | Conflict sentence |
| Pre-write read throws | Storage error inside the lock while `expectedVersion` is supplied | 500 with the storage error; nothing is written | Never reported as a conflict, never treated as absent |
| Revert, no precondition | `POST /api/workbench/artifact/revisions {action:"revert"}` | 200 as today (ungated); answer carries the scoped version | No error expected |
| Stale page cache, Preview | `pageCache` active and holding superseded bytes for `slug` | `GET /api/workbench/preview?kind=page` serves the STORED body and its version; the cache entry is left as it was | No error expected |
| Stale page cache, page write | `pageCache` active and stale; `PUT /api/wiki/[slug]` with the version of the STORED bytes | 200 — the merge base is the stored file, not the cached one | A version of the cached bytes is 412 |
| Service token, no header | `PUT /api/wiki/<slug>` with a valid bearer token and no `If-Match` | 428, `WRITE_PRECONDITION_REQUIRED_COPY`, page unchanged | Same body shape every other caller gets |
| Service token, stale header | Valid bearer token, `If-Match` from before another actor's save | 412, `WRITE_CONFLICT_COPY`, page unchanged | — |
| Service token, matching header | Valid bearer token, current version | 200, write and side effects run, answer carries the new version | — |
| Scope/content boundary | `scopedContentVersion("ab", "c")` vs `scopedContentVersion("a", "bc")` | Different versions | — |

</intent-contract>

## Code Map

**The primitive.**
- `src/lib/write-precondition.ts:131-153` -- `contentVersion` and its `hex32`/`fnv1a32` helpers; factor the body into a private `versionOf(scheme, input)` and add `scopedContentVersion(scope, content)` under its OWN scheme prefix (`w1s:`), length-prefixing the scope so the scope/content boundary is unambiguous.
- `src/lib/write-precondition.ts:418-464` -- `PreconditionOutcome` and `checkWritePrecondition(header, current)`. Split the comparison out as `checkVersionPrecondition(supplied, current)`; `checkWritePrecondition` becomes `checkVersionPrecondition(parseIfMatch(header), current)`. Add `WriteConflictError` + `isWriteConflictError` beside `WRITE_CONFLICT_COPY` (`:390`), modelled on `src/lib/read-only.ts`'s `isReadOnlyError`.

**Artifact — the lock (DW-193) and the scope (DW-200).**
- `src/lib/wikis.ts:716-820` -- `writeWikiArtifact`. Replace the trailing `reason?: string` with an options object (`{ reason?, expectedVersion? }`); the in-lock read at `:759` (already `readWikiArtifact`, unlocked and raw) becomes the precondition's read too. Its `catch` currently warns and continues with `existing = null` — keep that ONLY when no `expectedVersion` was supplied; otherwise rethrow. Compare above the `saveWikiArtifactRevision` block at `:770` and above `putWikiArtifact` at `:786`.
- `src/lib/wikis.ts:1401-1411` -- `readWikiArtifact`, the unlocked getter this reuses. Unchanged.
- `src/lib/wiki-lock.ts:95-110` -- `withWikiLock`, non-reentrant; the check runs inside the ONE acquisition `writeWikiArtifact` already makes.
- `src/app/api/workbench/artifact/route.ts:147-174` -- drop the pre-lock `readWikiArtifact` + `checkWritePrecondition` pair; `parseIfMatch` at the route (null → 428 with `WRITE_PRECONDITION_REQUIRED_COPY`), pass the parsed version to `writeWikiArtifact`, answer `scopedContentVersion(currentId, content)`. The outer `catch` at `:63-80` maps `isWriteConflictError` → 412 beside the existing `isReadOnlyError` → 403.
- `src/app/api/workbench/artifact/revisions/route.ts:269-278` -- revert stays UNGATED (passes no `expectedVersion`) but its answered `version` becomes scoped by the gated `wikiId`.
- `src/app/api/workbench/preview/route.ts:206-228` -- the file branch's `version`. `artifact !== undefined` implies `currentId !== null` (`resolveWorkbenchFile` returns an artifact only with a `wikiId`, `workbench-files.ts:493-497`), so the artifact case uses `scopedContentVersion(currentId, content)` and everything else keeps `contentVersion(content)`.

**Page reads (DW-195).**
- `src/lib/wiki.ts:231-274` -- `pageCache`, `pageCacheRefCount`, `beginPageCache`/`withPageCache`; ref-counted around bulk scans (`lint.ts:71`, `search.ts:209,276`, `query.ts:282`, `dataview.ts:218`), so a concurrent scan can hold it open across any request.
- `src/lib/wiki.ts:324-391` -- `readWikiPage`. Add `options?: { fresh?: boolean }`: skip the lookup at `:334-337`, the negative set at `:374-376` and the positive set at `:386-388`.
- `src/lib/wiki.ts:405-415` -- `readWikiPageWithFrontmatter`, forwards the option.
- `src/app/api/workbench/preview/route.ts:127` -- the Preview's page read → fresh.
- `src/app/api/wiki/[slug]/route.ts:153-197` -- the PUT's `existing` read (the merge base the precondition hashes at `:195`) → fresh.
- `src/app/u/[handle]/[slug]/edit/page.tsx:21,138` -- the edit screen's seed read, which becomes `initialVersion` → fresh.

**Wire contract (DW-194).**
- `src/middleware.ts:29-31` -- the `/api/wiki` and `/api/wiki/<slug>` in-route-auth lines; add the `If-Match` requirement for the mutating verbs.
- `src/app/api/wiki/[slug]/route.ts:92-115` -- the PUT docblock lists body and merge steps but says nothing about the header. State it.
- `src/lib/authz.ts:237` -- `canWriteFrontmatter` returns true for any `service:`-prefixed principal, so the service path reaches the precondition with no ACL detour.
- `src/lib/auth.ts:172-181` -- `getServicePrincipal` reads `YOPEDIA_SERVICE_TOKEN` / `YOPEDIA_SERVICE_PRINCIPAL` and the `Authorization` bearer.

**Tests to extend (all existing).**
- `src/lib/__tests__/write-precondition.test.ts` -- `scopedContentVersion` and `checkVersionPrecondition`.
- `src/lib/__tests__/wiki-schema-edit.test.ts:353-383` -- the `put` helper derives `contentVersion(stored)`; it must derive the SCOPED version. `:620-714` is the precondition block.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts:681` and `src/lib/__tests__/workbench-preview.test.ts:1634` -- pin the artifact version; both become scoped.
- `src/lib/__tests__/wiki-routes.test.ts:1-43` (the `getServicePrincipal: vi.fn(() => null)` mock and `currentIfMatch`), `:1380-1545` (the precondition block) -- add the service-principal cases.
- `src/lib/__tests__/wiki.test.ts:1840-1950` -- the existing `beginPageCache` cases, beside which the `fresh` cases belong.

**Read-only evidence.**
- `src/lib/__tests__/wiki-schema-edit.test.ts:220` -- a source scan pins `writeWikiArtifact`'s first three parameters only, so the tail may change.
- `src/lib/config.ts` / `src/app/api/settings/route.ts` -- the settings precondition is the opaque-token scheme (DW-192); untouched here.

## Tasks & Acceptance

**Execution:**
- `src/lib/write-precondition.ts` -- add `scopedContentVersion` (own `w1s:` scheme, length-prefixed scope), `checkVersionPrecondition`, `WriteConflictError`/`isWriteConflictError`; re-express `checkWritePrecondition` over the new comparison. Document the scope as a server-derived binding, never a caller-supplied one.
- `src/lib/wikis.ts` -- `writeWikiArtifact` takes `{ reason?, expectedVersion? }`; the in-lock read serves both the revision snapshot and the precondition; a supplied `expectedVersion` makes that read non-fail-soft and a mismatch (or an absent file) throws `WriteConflictError` above the snapshot and the put.
- `src/app/api/workbench/artifact/route.ts` -- 428 at the route from `parseIfMatch`; the 412 comes from the writer; answer the scoped version; map the conflict in the outer catch.
- `src/app/api/workbench/artifact/revisions/route.ts` -- pass `{ reason }` in the new shape; answer the scoped version.
- `src/app/api/workbench/preview/route.ts` -- scoped version for the artifact branch; fresh page read.
- `src/lib/wiki.ts` -- `fresh` option on `readWikiPage` and `readWikiPageWithFrontmatter`, documented as "neither consults nor mutates the cache".
- `src/app/api/wiki/[slug]/route.ts` -- fresh merge-base read; document the `If-Match` wire contract in the PUT docblock.
- `src/app/u/[handle]/[slug]/edit/page.tsx` -- fresh seed read.
- `src/middleware.ts` -- note the `If-Match` requirement on the `/api/wiki/<slug>` in-route-auth line.
- `src/lib/__tests__/write-precondition.test.ts` -- cover the scope rows of the I/O Matrix: identical content under two scopes differs, the scope/content boundary is unambiguous, the scheme prefix differs from `contentVersion`, and `checkVersionPrecondition`'s three outcomes.
- `src/lib/__tests__/wiki-schema-edit.test.ts` -- move the helper onto the scoped version; add the two concurrent-save rows (one 200, one 412, stored bytes are the winner's — this fails before the change, where both land) and the Wiki-switch row (two Wikis, identical seeded bytes, A's version refused against B, B unchanged).
- `src/lib/__tests__/wiki.test.ts` -- cover the two page-cache rows: a fresh read returns the stored bytes while a stale entry is cached, and leaves that entry untouched.
- `src/lib/__tests__/workbench-preview.test.ts` -- the Preview serves stored bytes and their version while a stale cache entry is active; the artifact version is scoped.
- `src/lib/__tests__/wiki-routes.test.ts` -- a service-principal block: 428 without a header, 412 with a stale one, 200 with a matching one, each asserting what the stored page is afterwards; and a scan that `src/middleware.ts` states the requirement.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` -- the revert answer is the scoped version and revert stays ungated.

**Acceptance Criteria:**
- Given a Schema draft seeded from Wiki A and an active-Wiki switch to Wiki B whose `schema.md` holds byte-identical seeded content, when the owner saves, then the response is 412 and B's `schema.md` is unchanged.
- Given two saves of the same artifact carrying the same valid `If-Match`, when both are in flight, then exactly one lands and the other is refused 412, and the stored bytes are the landed one's.
- Given a precondition-checked artifact save whose pre-write read fails, when the writer runs, then nothing is written and the failure is reported as a server error rather than as a conflict.
- Given `pageCache` is active and holds superseded bytes for a slug, when the Preview reads that page and the owner then saves with the version it served, then the save lands.
- Given a caller authenticated by the service token, when it issues `PUT /api/wiki/<slug>` without `If-Match`, then it receives 428 with the shared sentence and the page is unchanged — and the requirement is stated in `src/middleware.ts`.
- Given the full suite, `npx tsc --noEmit -p tsconfig.json` and `npx eslint .`, when run after the change, then there are no new failures and no new errors.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 16: (high 0, medium 8, low 8)
- defer: 3: (high 0, medium 3, low 0)
- reject: 6
- addressed_findings:
  - `[medium]` `[patch]` `src/middleware.ts`'s new note was headed "THE IN-ROUTE-AUTH PATHS ARE NOT EXEMPT" (plural) while only `PUT /api/wiki/<slug>` is gated — the exact over-read a non-browser integrator would make from the list DW-194 says they read first. Rewritten to name one verb on one path, plus an explicit paragraph listing the siblings that stay unconditional (`PATCH`, `POST /api/wiki`, the page revisions route, `/api/ingest/*`, `/api/mcp`).
  - `[medium]` `[patch]` The PUT docblock's "there is deliberately no unconditional path" read as a guarantee about the CALLER; the same bearer can still rewrite frontmatter through `PATCH` and the body through MCP. Scoped to this handler and verb, naming what stays unconditional.
  - `[medium]` `[patch]` `PreviewPayload.version` still documented the token as `contentVersion` of the whole stored file — false for the artifact branch since DW-200, on the one client-facing type that explains what the string means. Both branches and both schemes are now documented.
  - `[medium]` `[patch]` The Preview's version expression fell back to `contentVersion` when `artifact !== undefined && currentId === null` — the "impossible" branch emitted exactly the unscoped token DW-200 exists to eliminate, and one no writer could ever match. The flag and its scope are now derived together in one narrowing block, so an unscoped artifact token is not expressible.
  - `[medium]` `[patch]` The stale-cache row in `wiki-routes.test.ts` attempted the cached-version save AFTER the landing write, whose `writeWikiPage` deletes the entry — so its 412 was an ordinary mismatch, not a stale-cache one. Reordered: the cached version is refused while the entry is genuinely stale (mutation-checked: without `fresh` that assertion answers 200 and clobbers), then the landing save runs with the entry still open.
  - `[medium]` `[patch]` The edit screen was the one of three `fresh` sites with no test — removing `{ fresh: true }` from `edit/page.tsx` left the whole suite green. `edit-denial-copy.test.tsx` now asserts the seed read is called with `{ fresh: true }`; mutation-checked.
  - `[medium]` `[patch]` The "reached only through this module" scan was loosened to `checkWritePrecondition(` OR `parseIfMatch(` for ALL FOUR routes, so any of them could satisfy it by parsing a header and never comparing. Pinned per-route instead: three routes keep the comparison call, the artifact route must parse AND pass `expectedVersion` into the writer, and `wikis.ts` must hold the comparison and re-type neither sentence.
  - `[medium]` `[patch]` The Wiki-switch case hand-computed the token in the test body, so producer and consumer were pinned separately by one helper and a change moving both stayed green. It is now a round trip at the outermost surfaces: read the version from `GET /api/workbench/preview` under Wiki A, switch to B, `PUT` → 412 with B unchanged, then switch back and land the same token — so the refusal is pinned as being about WHICH Wiki.
  - `[low]` `[patch]` `IF_MATCH_HEADER`'s docblock still claimed every route checks "after the read whose bytes it compares against" — no longer true for the artifact route, which parses with zero bytes in hand. Updated beside the module header that already was.
  - `[low]` `[patch]` `writeWikiArtifact`'s older "BOTH ARE FAIL-SOFT … the save proceeds either way" sat six lines above the new conditional rethrow and contradicted it. Qualified in place and folded into one paragraph.
  - `[low]` `[patch]` The writer collapsed ANY non-ok outcome into `WriteConflictError`, so the 428 outcome would have been answered 412 carrying the 428 sentence. Unreachable today; now asserted rather than collapsed.
  - `[low]` `[patch]` `ReadWikiPageOptions.fresh` claimed the read "goes to storage" without qualification, but the silo path is still chosen through `getPageIndex()`'s own cache. The docblock now says what `fresh` bypasses is `pageCache` and only that.
  - `[low]` `[patch]` `scopedContentVersion`'s length field is over the composed input, not the content, while `contentVersion`'s docblock sells that number as the content's length — and the two tokens appear side by side. Documented.
  - `[low]` `[patch]` Nothing said what happens to an editor open across the deploy: it relays a pre-DW-200 `w1:` token and gets one 412 blaming somebody else for a file nothing changed. Recorded as a comment on the artifact route, with the recovery (the reload the sentence already asks for) and the rejected alternative (scheme-sniffing at the route).
  - `[low]` `[patch]` The case named "refuses a STALE save with 412 and never reaches the writer" was wrong about the mechanism — the writer IS entered and throws from inside its lock. Renamed, comment corrected, and the missing revision-snapshot assertion added so the "commits nothing" clause is pinned rather than claimed.
  - `[low]` `[patch]` The ungated-revert case pinned behaviour by slicing route source to the first `});`, which a reformat or a comment could flip without changing behaviour. Dropped in favour of the behavioural 200 that already pins it, plus an import-level fact no reformat can move.

## Design Notes

**Why the 412 moves in but the 428 does not.** A missing header is a fact about the REQUEST — it needs no bytes to decide, and answering it at the route keeps a malformed caller from taking the tenant lock. A mismatched version is a fact about the STORE, and the only moment that fact is stable is inside the critical section that is about to overwrite it. Splitting them that way is what lets the writer keep one read: the bytes it already pulls for the revision snapshot become the bytes the check compares.

**Why an options object.** `writeWikiArtifact`'s fifth parameter is `reason`, a free string. A sixth free string beside it invites the two to be swapped at a call site, silently turning a precondition into a log line. Two named fields cannot be transposed.

**Shape of the scoped version.**

```ts
// Length-prefixed so the scope/content boundary is unambiguous for ANY content.
export function scopedContentVersion(scope: string, content: string): string {
  return versionOf("w1s", `${scope.length.toString(36)}:${scope}${content}`);
}
```

The scope is a Wiki id the SERVER resolved; it never appears in a payload, a header or a query. The token stays opaque — the id is not recoverable from the hash, and confirming a guessed id needs the id itself, which the owner already holds.

**What is still not closed.** The page and settings routes check their preconditions outside any lock, because neither has one to reuse: the page write's lock is per-slug and does not exist, and the settings write is guarded by the stored token instead. This bundle closes the artifact window because that route's writer already holds exactly the right lock. The residual for the other two is unchanged and still recorded upstream.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/write-precondition.test.ts src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/wiki.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/wiki-artifact-revisions.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts` -- expected: all pass
- `npx vitest run` -- expected: no new failures against the pre-change baseline
- `npx tsc --noEmit -p tsconfig.json` -- expected: clean
- `npx eslint .` -- expected: clean
## Auto Run Result

Status: done

**Implemented change.** The write precondition now holds across the window it
claims to guard. The artifact save's mismatch check moved INSIDE the one
`wikis:<tenant>` acquisition `writeWikiArtifact` already makes, comparing
against the bytes it already reads for the revision snapshot — one read, one
critical section, no new lock key and no new ordering — while the "no usable
header" half stays at the route, where it needs no bytes and takes no lock. The
artifact's version is bound to the Wiki the server resolved through a scoped
variant of the same pure hash under its own scheme, so a token read from one
Wiki matches no other and the browser still names no Wiki. Every page read that
seeds or checks a precondition now bypasses the module-global `pageCache`, which
neither consults nor mutates it. And the `If-Match` requirement is stated where
a non-browser caller reads it, with executed service-principal coverage of the
428, the 412 and the 200. Closes DW-193, DW-194, DW-195 and DW-200.

**Files changed.**
- `src/lib/write-precondition.ts` -- `versionOf` factored out; new `scopedContentVersion` (`w1s:`, length-prefixed scope); `checkVersionPrecondition` split out as the ONE comparison both halves run; `WriteConflictError` / `isWriteConflictError`.
- `src/lib/wikis.ts` -- `writeWikiArtifact` takes `{ reason?, expectedVersion? }`; the in-lock read serves both the snapshot and the guard, stops being fail-soft when a version was supplied, and refuses above both the snapshot and the put.
- `src/app/api/workbench/artifact/route.ts` -- 428 from `parseIfMatch` at the route, 412 mapped from the writer's throw, scoped version answered.
- `src/app/api/workbench/artifact/revisions/route.ts` -- revert stays ungated; its answered version is scoped by the gated Wiki id.
- `src/app/api/workbench/preview/route.ts` -- artifact flag and scope derived together so an unscoped artifact token is not expressible; the page read is fresh.
- `src/lib/wiki.ts` -- `ReadWikiPageOptions.fresh` on `readWikiPage` / `readWikiPageWithFrontmatter`; default behaviour unchanged for every existing caller.
- `src/app/api/wiki/[slug]/route.ts` -- fresh merge-base read; the PUT docblock states the wire contract and its limits.
- `src/app/u/[handle]/[slug]/edit/page.tsx` -- fresh seed read behind `initialVersion`.
- `src/middleware.ts` -- the in-route-auth list now says authenticating is not sufficient to write `PUT /api/wiki/<slug>`, and which siblings stay unconditional.
- `src/lib/workbench-preview.ts` -- `PreviewPayload.version` documents both schemes.
- `src/lib/knowledge-compilation.ts` -- point-free `map(readWikiPageWithFrontmatter)` wrapped, which the new optional parameter would otherwise have fed the array index.
- Tests: extended `write-precondition`, `wiki-schema-edit`, `wiki-routes`, `wiki`, `workbench-preview`, `wiki-artifact-revisions`, `edit-denial-copy`.

**Review findings, this pass.** 16 patched (high 0, medium 8, low 8), 3 deferred
(medium 3 -- see frontmatter `deferred`), 6 rejected, 0 intent gaps, 0 bad-spec
loopbacks. The rejections were the refusal-ordering claim that read-only now
precedes the conflict (it already did -- `isReadOnly()` has always been the
route's first gate), a request to gate the artifact revert (named by no entry in
this bundle and forbidden by the source spec's Never clause), the observation
that the revert's scoped answer has no client yet (forward-looking consistency,
not a defect), a heavier union type for `expectedVersion`, a client-side
Wiki-switch test for a component that only relays an opaque string, and three
proposed matrix rows for behaviour the intent excludes.

**Follow-up review recommended: true.** This pass's patched counts: high 0,
medium 8, low 8. No high patched finding, so the score decides:
`3 x 8 + 1 x 8 = 32`, at or above 5.

**Verification.** `npx vitest run` -- 263 files / 5758 tests, all passing; the same
suite on the stashed baseline is 5727, so the 31 new cases are this bundle's. `npx tsc --noEmit -p
tsconfig.json` -- clean. `npx eslint .` -- clean (only the pre-existing
`jsx-ast-utils` `TSNonNullExpression` warnings). Every I/O Matrix row has a named
test that ran and passed. Five of the new cases were mutation-checked by
reverting the fix they cover: the concurrent-save row answers `[200, 200]` with
the check back outside the lock; the two stale-cache rows answer 412 and serve
the cached body without `fresh`; the edit-screen row fails without
`{ fresh: true }`; the Wiki-switch round trip fails with an unscoped Preview
token. The spec named `pnpm`, which fails in this repo with "packages field
missing or empty"; the `npx` equivalents were used. One unrelated pre-existing
flake was observed and confirmed on the untouched baseline
(`workspace-purpose-settings.test.tsx > adopts a recheck that answers no wiki at
all`, roughly one failure in six full runs); it is not introduced here.

**Residual risks.** The page and settings preconditions still sit outside any
lock, because neither has one to reuse -- the page write's would be per-slug and
does not exist, and the settings write is guarded by its stored token. Only the
artifact route had the right lock already, which is why only it closed. Changing
the artifact version's scheme is a wire-contract change with a deploy window: a
Schema editor open across the deploy relays a `w1:` token, is refused once with
the "changed somewhere else" sentence though nothing changed, and recovers by
reloading -- documented at the route, with scheme-sniffing deliberately
rejected. `fresh` bypasses `pageCache` and nothing else: the silo path is still
chosen through `getPageIndex()`'s own cache, and a failed silo read still widens
to the flat copy (both deferred). The page write's merge-base read still reports
an unreadable page as absent, the opposite of the call this bundle made one
layer over (deferred). The wire contract is documented in source comments and in
the middleware list; the published `public/agent-api.md` does not describe these
page-write routes at all and was not widened to.
