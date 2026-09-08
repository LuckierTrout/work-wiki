---
title: 'DW-726/738/742 — page-scoped read gates'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
baseline_revision: '9f565c5ac4a923ec7ebdd4990532d2564d00fb34'
deferred:
  - summary: >-
      The `/u/<handle>/raw/<slug>` page component still serves the same raw source
      text behind `canReadSlug` alone, so the disclosure DW-742 closed on the API
      door stays open on the human one.
    evidence: |-
      `src/app/u/[handle]/raw/[slug]/page.tsx:29` gates on `canReadSlug(slug, principal)`
      and nothing else, then reads the very bytes this bundle just gated —
      `readRawSource` / `readRawSourceById` — and hands them to `RawSourceBrowser`
      as `initialContent`. Middleware admits anonymous GETs on `/u/**`. A review
      subagent demonstrated it on a tmpdir deployment: for a `visibility: public`,
      `type: agent-knowledge` page with `getPrincipal -> null`,
      `GET /api/raw/agent-notes` now answers 404 while `RawSourcePage` passes every
      gate and reaches its render with the raw text loaded. Pre-existing and not
      named by the bundle intent, which pointed at `src/app/api/raw/[slug]/route.ts:24`.
      The same door carries the mirror-image mismatch: `RawSourceBrowser.tsx:62-63`
      builds its Download link as `/api/raw/<slug>`, and because `hiddenSlugs` is
      derived from the principal's OWN readable entries, that button now 404s even
      for the owner of their own agent-scoped page — the intended parity with
      `/api/assets/[...path]` and the `/api/v1` file doors, surfaced on a page that
      was never taught about it. The only suite touching the component,
      `src/lib/__tests__/edit-raw-alias-forwarding.test.ts:193-294`, seeds no
      agent-scoped page and asserts neither half.
    location: >-
      src/app/u/[handle]/raw/[slug]/page.tsx:29
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Three doors serve bytes a page gate is meant to withhold. `GET /api/raw/[slug]` gates only on `canReadSlug`, never on the `workbenchSlugGate`/`rawPathAllowed` second gate DW-536 added to the assets door, so the raw SOURCE text of a page the Knowledge tab hides is served unauthenticated. `ingestImage` mints `assets/<slugify(title)>/…` before `ingest()` uniquifies, so a realm-forked page's image sits in the OTHER page's asset directory and `/api/assets/[...path]` gates it on the wrong page. The streaming query route applies the `isArtifactType` exclusion only inside `if (!scopeSlugs)`, while `query()` applies it regardless of scope, so an owner/`mine`-scoped stream can answer from saved artifact markup.

**Approach:** Add the second gate to the raw door, mirroring `assets/[...path]/route.ts:113-139` including its fail-closed derivation. Re-key a forked page's assets onto the final post-uniquification slug inside `ingest()` (body rewrite included), plus a one-shot maintenance migration for directories already mis-keyed. Hoist the artifact filter above the scope branch in the stream route.

## Boundaries & Constraints

**Always:**
- The raw door's second gate is DERIVED, never restated: `listReadableWikiPages(principal)` → `buildKnowledgeTree` → `workbenchSlugGate` → `rawPathAllowed`, exactly as the assets door derives it. A derivation failure logs and answers **500** (fail closed), not 404 and not a fall-through to bytes.
- Every raw-door refusal keeps the route's existing 404 shape (JSON `{ error, ...canonicalSlugHintForMissing(...) }`), so the door stays a non-oracle and the merged-away-slug hint behaviour of DW-233 is unchanged.
- The raw door stays NO-AUTH: an anonymous request for a slug the gate admits still gets the bytes.
- Asset re-keying deletes the pre-fork key ONLY when this ingest created it. `writeAssetIfAbsent` answering `false` means the key already held identical bytes belonging to the other page — deleting then is data loss.
- `assets/illustrations/<key>.jpg` is a SHARED cache whose first segment names no page. It is never re-keyed and never migrated.
- The migration re-keys only the uniquifier's own shape: a page slugged `<base>-<n>` whose body references `assets/<base>/…` while a page slugged `<base>` exists. It is idempotent and fail-soft.

**Block If:**
- The `workbenchSlugGate`/`rawPathAllowed` pair cannot be derived on the raw door without a new export or a widened signature (it can today — the assets door imports both).

**Never:**
- Do not change `canReadSlug`, `rawPathAllowed`, `rawPathSlug`, `workbenchSlugGate` or `buildKnowledgeTree` semantics — this bundle only adds a CALLER of the existing gate.
- Do not change `syncSiloForPage`'s keying: it already mirrors `raw/assets/<slug>/` into the tenant of the page named `<slug>`, which is correct once the directory is keyed off the final slug. Prove it with a test rather than editing it.
- Do not rewrite the stored RAW SOURCE snapshot when re-keying — it is the verbatim arriving document, and `contentHash(content)` addresses it.
- Do not turn the streaming route's artifact exclusion into a new predicate; move the existing `isArtifactType` term only.
- Do not add authentication to `/api/raw/[slug]`, and do not convert its 404s to 403s.
- No new storage-provider methods; `readAsset` / `writeAssetIfAbsent` / `deleteFile` / `listFiles` are sufficient.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Raw source of an admitted public page | `GET /api/raw/concept-a`, page public, empty hidden set | 200 `text/plain` with the source body | No error expected |
| Raw source of an agent-scoped page | `GET /api/raw/agent-notes`, `visibility: public`, `type: agent-knowledge`, no session | 404 JSON `{ error: "not found" }` — the knowledge tree drops it, so its slug is in `hiddenSlugs` | Refusal, not an error |
| Raw source of a private page | `GET /api/raw/secret`, not the owner | 404 JSON, unchanged from today (`canReadSlug` arm fires first) | Refusal, not an error |
| Per-source snapshot of a hidden page | `GET /api/raw/agent-notes?source=<rawId>` | 404 — both raw shapes derive the same slug through `rawPathSlug` | Refusal, not an error |
| Slug-gate derivation fails | `listReadableWikiPages` throws (storage outage) | 500, logged via `logger.error("raw", …)` | Fail closed — never falls through to bytes |
| Forked image ingest | Alice's private `photo`; Bob ingests same title | Bob's body embeds `assets/<bob-slug>/<digest>-photo.png`; bytes readable there; the pre-fork key is removed when Bob created it | Re-key failure fails the ingest rather than leaving a dangling ref |
| Forked image, identical bytes | Alice and Bob upload byte-identical images | Bob's page points at his own directory; Alice's key survives (this ingest did not create it) | No delete |
| Silo mirror after a fork | `syncSiloForPage(bobSlug, tenant(bob))` | Bob's image lands in Bob's tenant; `syncSiloForPage("photo", tenant(alice))` carries none of Bob's bytes | Fail-soft as today |
| Scoped stream query over an artifact | `POST /api/query/stream` with `scope: "mine"`, readable set contains `type: "html"` / `"slides"` | Artifact entries are absent from `selectPagesForQuery`'s entries; agent-scoped entries still pass on a scoped query | No error expected |

</intent-contract>

## Code Map

- `src/app/api/raw/[slug]/route.ts:24-56` — the door to fix. `principal` is already resolved at line ~43; add gate 2 immediately after the `canReadSlug` arm, INSIDE the existing `try` but with its own `try/catch` returning 500 (the outer catch collapses everything to 404).
- `src/app/api/assets/[...path]/route.ts:113-139` — the reference implementation to mirror: hoisted `listReadableWikiPages`, `workbenchSlugGate(entries, buildKnowledgeTree(entries))`, `logger.error` + 500 on derivation failure, `rawPathAllowed(displayPath, hiddenSlugs)`.
- `src/lib/workbench-files.ts:281-352` — `rawPathSlug` / `rawPathAllowed`. Both raw shapes (`raw/sources/<slug>.md` and `raw/sources/<slug>/<rawId>.<ext>`) derive the SAME slug, and `queries/<leaf>` joins identically, so gating on `raw/sources/${slug}.md` decides both without feeding an unvalidated `?source` value into the gate.
- `src/lib/authz.ts:144-162` — `canReadSlug`; frontmatter-only, which is why it is not the whole gate.
- `src/lib/__tests__/assets-route.test.ts:1-70` — the mocking template for the new raw-route test (mock `@/lib/wiki`, `@/lib/auth`, `@/lib/authz`; leave `workbench-tree`/`workbench-files` REAL so the derivation runs).
- `src/lib/ingest.ts:425-427` — `ingestImage` calls `storeImageBytes(bytes, slug, filename)` with the pre-uniquified slug and embeds `localPath` in the prebuilt body.
- `src/lib/ingest.ts:2182-2193` — the realm-fork guard: `slug = await findFreeSlug(slug)`. `wikiContent` (built at ~2068) is still in memory here and the write path starts at ~2196 — this is where the re-key belongs.
- `src/lib/ingest.ts:1945-1950, 1976` — `ingest()`'s `internal` parameter (`prebuiltContent`); the channel for the asset hand-off.
- `src/lib/fetch.ts:887-905` — `storeImageBytes`; discards `writeAssetIfAbsent`'s boolean. That boolean is the "we created it" fact the delete needs.
- `src/lib/fetch.ts:851-857` — `storeImageAsset` destructures `{ localPath, filename }`; widening the return is additive.
- `src/lib/silo.ts:280-295` — `syncSiloForPage`'s asset arm, keyed `raw/assets/<slug>/` → `tenants/<tenant>/raw/assets/<slug>/`. Correct once keying is; the only live callers are `migrate-to-tenants.ts:81` and tests.
- `src/lib/maintenance.ts:447-464` — `backfillWorkspaceProfiles`: the exact shape for the migration wrapper (owner guard, `await import`, try/catch → 0, NOT inside `scanForMaintenance`).
- `src/app/api/tasks/scan/route.ts:210-260` — where byte-touching steps are called under `if (!forceDry)` and reported in the JSON body + the `logger.info` line.
- `src/lib/lint-fix.ts:83-100` — `readWikiPage(slug, { fresh: true, strict: true })` + `writeWikiPageWithSideEffects({ slug, title, content, summary, logOp, crossRefSource: null, author })`: the page-rewrite pattern the migration should reuse.
- `src/app/api/query/stream/route.ts:118-134` — the `if (!scopeSlugs)` block holding both filters.
- `src/lib/query.ts:334-342` — the invariant being mirrored, with the comment that states it.
- `src/lib/__tests__/query-stream-route.test.ts:198-227` — the existing unscoped-artifact row; the scoped row goes beside it and must set `mockedScope.mockResolvedValue({ scopeSlugs: [...] })`.
- `src/lib/__tests__/ingest-image.test.ts:233-355` — the DW-693 fork fixture (`makePrivate`, `embeddedRef`, `readAssetBytes`). Its two rows ASSERT the bug (`bobRef.startsWith("assets/photo/")`, `expect(bobRef).toBe(aliceRef)`) and must be updated to the re-keyed expectations.

## Tasks & Acceptance

**Execution:**
- `src/app/api/query/stream/route.ts` -- hoist `!isArtifactType(e.type)` out of the `if (!scopeSlugs)` block into an unconditional `entries = entries.filter(...)` immediately above it, leaving `isAgentScopedType` inside; carry over `query.ts`'s "regardless of scope" rationale in a short comment -- the two paths must state one invariant.
- `src/lib/__tests__/query-stream-route.test.ts` -- add a row: `mine`-scoped query whose readable set holds `html` + `slides` entries; assert neither type reaches `selectPagesForQuery` while an agent-scoped entry still does (so the hoist did not swallow the scope branch) -- pins DW-726 in the direction that was uncovered.
- `src/app/api/raw/[slug]/route.ts` -- after the `canReadSlug` arm, derive `hiddenSlugs` via `listReadableWikiPages(principal)` + `workbenchSlugGate(entries, buildKnowledgeTree(entries))` in its own try/catch (log + 500 on failure), then refuse with the route's existing 404 shape when `!rawPathAllowed(\`raw/sources/${slug}.md\`, hiddenSlugs)`; document why one display path decides both raw shapes -- closes DW-742.
- `src/lib/__tests__/raw-route.test.ts` -- NEW. First GET coverage this route has ever had: admitted public source (200 + `text/plain` + `Content-Disposition`), agent-scoped hidden slug refused 404 unauthenticated, private page still 404 via `canReadSlug`, `?source=<rawId>` refused for the same hidden slug, derivation failure 500 -- the assets-route test is the mocking template.
- `src/lib/fetch.ts` -- widen `storeImageBytes`' return with `created: boolean` (the `writeAssetIfAbsent` result, no longer discarded) and add `rekeyImageAsset(fromSlug, toSlug, filename, { removeSource })` returning the new `assets/<toSlug>/<filename>` display path -- the delete guard and the one place that owns the `assets/` literal.
- `src/lib/ingest.ts` -- have `ingestImage` pass `{ assetSlug, assetFile, assetCreated }` through `internal`; in `ingest()`, capture the pre-fork slug, and when `findFreeSlug` moved it, `rekeyImageAsset` and string-replace the old ref in `wikiContent` before the write path. Leave `content` (the raw snapshot) untouched -- closes DW-738 at the source.
- `src/lib/asset-slug-rekey.ts` -- NEW. `rekeyForkedPageAssets(): Promise<number>`: walk `listWikiPages()`, build a ref map of `assets/<dir>/<file>` per page, and for each page slugged `<base>-<n>` referencing `assets/<base>/…` where a page `<base>` exists, copy the bytes to `assets/<slug>/…`, rewrite the page via `writeWikiPageWithSideEffects`, and delete the old key only when no other page references it. Skip `assets/illustrations/`. Return the number of assets re-keyed -- the migration the DW-738 decision requires for already-forked directories.
- `src/lib/maintenance.ts` -- add `rekeyForkedAssets(): Promise<number>`, a fail-soft `await import("./asset-slug-rekey")` wrapper modelled verbatim on `backfillWorkspaceProfiles`, outside `scanForMaintenance` -- it writes bytes.
- `src/app/api/tasks/scan/route.ts` -- call it under `if (!forceDry)` beside the other migrations, add `forkedAssetsRekeyed` to the JSON response and the `logger.info` line, and extend the route docblock's list of self-healing steps -- the migration's only trigger.
- `src/lib/__tests__/ingest-image.test.ts` -- update the two DW-693 rows to the re-keyed expectations (`bobRef` under `assets/<bob.primarySlug>/`, distinct from `aliceRef` even for identical bytes) and add: bytes readable at the new key, the pre-fork key gone for the different-bytes case and PRESERVED for the identical-bytes case, and a mirror row asserting `syncSiloForPage` lands Bob's bytes in Bob's tenant and none in Alice's -- the fork and mirror cases the decision asks to pin.
- `src/lib/__tests__/asset-slug-rekey.test.ts` -- NEW. Seed a mis-keyed pair on real tmpdir storage; assert one run re-keys and rewrites, a second run is a no-op (idempotent), `assets/illustrations/…` is untouched, and a key still referenced by the base page is copied but not deleted.

**Acceptance Criteria:**
- Given an `agent-*`-typed page with `visibility: public`, when an unauthenticated caller requests `GET /api/raw/<slug>` (with or without `?source`), then the response is 404 with no source bytes, matching what the Files tab already withholds.
- Given `listReadableWikiPages` throws, when `GET /api/raw/<slug>` runs, then the response is 500 and the failure is logged — never 404 and never the bytes.
- Given a public page no gate hides, when `GET /api/raw/<slug>` runs with no session, then the source is served 200 as `text/plain` exactly as today.
- Given Alice owns a private page `photo` and Bob ingests an image with the same title, when the ingest completes, then Bob's page body references `assets/<bob-slug>/…`, those bytes read back as Bob's, and `/api/assets/[...path]` gates them on Bob's page.
- Given that same forked pair, when `syncSiloForPage` runs for each page, then each tenant silo holds only its own page's asset bytes.
- Given a deployment whose storage already holds a mis-keyed forked directory, when `POST /api/tasks/scan` runs without `?dry=1`, then the asset is re-keyed, the page body is rewritten, and a second scan re-keys nothing.
- Given a `mine`-scoped streaming query whose readable set contains `html` and `slides` pages, when the route selects pages, then no artifact entry is passed to `selectPagesForQuery`, matching `query()`.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 3, low 6)
- defer: 1: (high 0, medium 1, low 0)
- reject: 15: (high 0, medium 4, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The migration moved only the flat `raw/assets/<base>/<file>` key and left the tenant mirror `syncSiloForPage` had already produced, so on a migrated deployment the base owner kept listing and downloading the forked page's image through the Workbench / `/api/v1` file doors while the forked owner's silo never gained it — the migration now mirrors the new key into the forked page's tenant and removes the base owner's tenant copy whenever the flat key is reclaimed, pinned by a row that syncs both silos before the run.
  - `[medium]` `[patch]` The delete guard's `refsByPage` was built only from pages whose body read succeeded, so a page skipped by the fail-soft catch could let a key it still embeds be deleted — a failed body read now disarms the whole reclamation phase, the docblock states the weaker real guarantee, and a row seeds an unreadable page.
  - `[medium]` `[patch]` `assetRefsIn` matched `assets/<dir>/<file>` as an unanchored substring (absolute URLs, `raw/assets/…` in prose, and nested paths truncated into a false file), and a single bad match abandoned the entire page on every future scan — the pattern gained delimiter/boundary guards and the copy failure was narrowed to the offending ref.
  - `[low]` `[patch]` Every scan read every page body before it could discover there was nothing to repair; candidates are now derived from index rows first and a migrated deployment returns 0 with zero page reads.
  - `[low]` `[patch]` `FORK_SUFFIX`'s comment called the base group "non-greedy-safe" when the regex is greedy and greediness is exactly what makes `gpt-4-2` resolve to `gpt-4`.
  - `[low]` `[patch]` `rekeyImageAsset` re-read the bytes `ingestImage` still held, adding a storage read and a race in which a concurrent identical-bytes ingest reclaimed the source key and failed the other ingest; the bytes are threaded through `internal` and the read is now only the migration's fallback.
  - `[low]` `[patch]` `assetRefPath`'s docblock claimed to be the only spelling of the `assets/` literal, which the same diff contradicted; the migration's target now goes through it and the claim is narrowed to the construct side.
  - `[low]` `[patch]` `?source=<rawId>` was covered only in the 404 direction, so `readRawSourceById` never ran to completion; a success row was added.
  - `[low]` `[patch]` The new `rekeyForkedAssets` maintenance wrapper appeared only as a stand-in mock, so neither its dynamic import nor its catch-and-return-0 path was exercised; a suite modelled on `backfillWorkspaceProfiles` was added.

## Design Notes

One display path decides both raw shapes. `rawPathSlug("raw/sources/a.md")` and `rawPathSlug("raw/sources/a/<rawId>.ext")` both answer `a`, and the `queries/<leaf>` join behaves identically for both, so the route gates on `raw/sources/${slug}.md` and never has to interpolate an unvalidated `?source` value into a gate path.

The re-key, sketched:

```ts
const preForkSlug = slug;
if (resolvedExisting && … ) slug = await findFreeSlug(slug);
if (slug !== preForkSlug && internal?.assetFile) {
  const next = await rekeyImageAsset(preForkSlug, slug, internal.assetFile, {
    removeSource: internal.assetCreated === true,
  });
  wikiContent = wikiContent.split(`assets/${preForkSlug}/${internal.assetFile}`).join(next);
}
```

`removeSource` is gated on `assetCreated` because `writeAssetIfAbsent` returning `false` means the key already held the OTHER page's identical bytes.

## Verification

**Commands:**
- `pnpm test -- src/lib/__tests__/raw-route.test.ts src/lib/__tests__/query-stream-route.test.ts src/lib/__tests__/ingest-image.test.ts src/lib/__tests__/asset-slug-rekey.test.ts src/lib/__tests__/assets-route.test.ts` -- expected: all pass
- `pnpm test` -- expected: no new failures against the baseline revision
- `pnpm lint` -- expected: clean
- `npx tsc --noEmit` -- expected: no type errors

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Three page-scoped read gates closed.

**DW-742** — `GET /api/raw/[slug]` now derives the Workbench slug gate the same way `/api/assets/[...path]` does (`listReadableWikiPages` -> `buildKnowledgeTree` -> `workbenchSlugGate` -> `rawPathAllowed`) and refuses a slug the knowledge tree drops. The derivation sits in its own try/catch so a failure logs and answers 500 rather than being collapsed into the route's catch-all 404; refusals keep the route's existing JSON 404 shape including the DW-233 `canonicalSlug` hint. Gating on the flat display path `raw/sources/<slug>.md` decides the `?source=<rawId>` shape too, because `rawPathSlug` answers the same slug for both.

**DW-738** — a page's image is now keyed off the slug `ingest()` finally resolves. `storeImageBytes` reports whether it created the key; `ingestImage` hands the pre-move slug, filename, bytes and that flag to `ingest()`, which re-keys and rewrites the body reference once the slug is final. The condition is written against the final slug rather than against the fork, so the alias resolver, the concept/H1 re-derivation and `pinSlug` are closed alongside the realm fork. The pre-move key is deleted only when this ingest created it — a content-addressed key that was already occupied holds the other page's bytes. `src/lib/asset-slug-rekey.ts` repairs directories a deployment already holds, in both the flat root and the tenant silos, triggered by `POST /api/tasks/scan`. `syncSiloForPage` was not edited: it keys off the page's own slug and is correct once the directory is, which a test now proves.

**DW-726** — the streaming query route's `isArtifactType` exclusion moved above the scope branch, so a `mine`/`owner:` scoped stream can no longer answer from saved artifact markup that `query()` withholds.

### Files changed

- `src/app/api/query/stream/route.ts` -- artifact exclusion hoisted above the scope branch.
- `src/app/api/raw/[slug]/route.ts` -- second (Workbench slug) gate added, fail-closed to 500.
- `src/lib/fetch.ts` -- `storeImageBytes` reports `created`; new `assetRefPath` and `rekeyImageAsset`.
- `src/lib/ingest.ts` -- `ingestImage` hands the asset over; `ingest()` re-keys onto the final slug and rewrites the body.
- `src/lib/asset-slug-rekey.ts` (new) -- the migration for already mis-keyed forked directories, flat root and tenant silos.
- `src/lib/maintenance.ts` -- fail-soft `rekeyForkedAssets` wrapper.
- `src/app/api/tasks/scan/route.ts` -- runs the migration on a non-dry scan and reports `forkedAssetsRekeyed`.
- `src/lib/__tests__/raw-route.test.ts` (new) -- the first GET coverage this route has ever had.
- `src/lib/__tests__/asset-slug-rekey.test.ts` (new) -- the migration against real tmpdir storage.
- `src/lib/__tests__/ingest-image.test.ts` -- fork, identical-bytes, silo-mirror and non-fork (`pinSlug`) re-key rows.
- `src/lib/__tests__/query-stream-route.test.ts` -- scoped-artifact exclusion row.
- `src/lib/__tests__/scan-route.test.ts`, `src/lib/__tests__/maintenance.test.ts` -- coverage for the new scan step and its wrapper.

### Review findings breakdown

- Patches applied: 9 (medium 3, low 6).
- Items deferred: 1 (medium) -- the `/u/<handle>/raw/<slug>` page component, recorded in frontmatter `deferred`.
- Items rejected: 15.

### Follow-up review recommendation

`false`. Patched findings by severity: high 0, medium 3, low 6. Only a high-severity patch recommends another pass.

### Verification performed

- `pnpm test` -- 388 files, 9741 passed, 1 skipped, 0 failures.
- `npx tsc --noEmit` -- clean.
- `pnpm lint` -- clean (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- Ablation on the ingest re-key branch: disabling it fails all four `ingest-image` re-key rows, so they pin the fix rather than passing vacuously. The patch pass ran further ablations on the tenant mirror, the reclamation guard, the ref pattern and the maintenance wrapper.
- Matrix audit: every I/O row has a covering test that ran and passed.

### Residual risks

- The forked page's stored RAW SOURCE snapshot still spells the pre-move `assets/<base>/<file>` ref, which this ingest deletes when it created the key. Rewriting it is forbidden by the spec (`contentHash(content)` addresses the snapshot), so the raw-source view of a forked image page shows a broken image. Cosmetic; the page itself renders correctly.
- Per-page asset directories mean two byte-identical uploads under one title now occupy two keys rather than sharing one. That is inherent to gating an image on the page that owns it; there is no reclamation path for the duplicate.
- The raw door's second gate is derived from the caller's own readable entries, so it refuses an agent-scoped page's source to its OWNER as well -- the parity with `/api/assets/[...path]` and the `/api/v1` file doors that the intent asked for. The `RawSourceBrowser` Download button therefore 404s on those pages; see the deferred entry.
- `rekeyForkedPageAssets` is fail-soft at every step it owns, so the maintenance wrapper's catch is exercised by mocking the library function rather than by starving storage.
