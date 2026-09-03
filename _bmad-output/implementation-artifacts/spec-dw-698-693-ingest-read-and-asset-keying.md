---
title: 'Ingest realm-fork guard reads strict, and image assets are keyed by content digest'
type: 'bugfix'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['multiple-goals', 'oversized']
baseline_revision: '98d63784ae9ecb27719a5915db39976a814c551e'
deferred:
  - summary: >-
      A forked page's image stays in the OTHER page's asset directory, so
      `/api/assets/[...path]` gates it on the wrong page's visibility.
    evidence: |-
      `ingestImage` mints `assets/<slugify(title)>/…` before `ingest()`
      uniquifies, so when the realm guard forks (Alice's private `photo`, Bob's
      page `photo-2`) Bob's image is still stored under `assets/photo/`.
      `src/app/api/assets/[...path]/route.ts:69-76` reads `segments[0]` as the
      page slug and gates on THAT page: Bob's own image 404s for Bob and for
      every reader of his public page, while Alice — who owns neither the page
      nor the image — can fetch it. The mirror case (first page public, forked
      page private) serves a private page's image ungated. `syncSiloForPage`
      (`src/lib/silo.ts:281-295`) likewise mirrors Bob's bytes into Alice's
      tenant silo and never into his own. Pre-existing — the directory was
      always the pre-uniquified slug — and unchanged in kind by DW-693's digest
      keying, which the intent sanctioned as an alternative to keying off the
      final page slug. Keying off the final page slug (a post-ingest re-key plus
      body rewrite, or deferring the store) is the fix that would close it.
      `src/lib/__tests__/assets-route.test.ts:126-176` covers private gating but
      has no row where the asset's directory slug names a different page than
      the embedding one.
    location: >-
      src/lib/ingest.ts:425
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Two `src/lib/ingest.ts` defects let one ingest damage another owner's or another page's content. (a) DW-698 — the realm-fork guard (`src/lib/ingest.ts:2075`) and the `findFreeSlug` probe it calls (`src/lib/ingest.ts:1516`) read without `strict`/`fresh`, so a non-ENOENT provider failure or a stale `pageCache` entry answers `null`; the fork to a free slug is then skipped (or forks onto an occupied slug), and the merge base at `:2191` — which DOES find the private page — preserves its `owner`/`visibility` and writes the actor's body over it, with no downstream authorization to re-decide. (b) DW-693 — `ingestImage` stores the asset under `assets/<slugify(title)>/<filename>`, a slug computed before `ingest()` uniquifies the page slug, so two ingests sharing a title and a sanitized filename address one key and one of the two pages shows the wrong bytes.

**Approach:** Make the fork guard's read and every `findFreeSlug` probe `{ fresh: true, strict: true }`, so a blip fails the ingest closed instead of authorizing a cross-owner overwrite. Separately, make the image asset key content-addressed by folding a SHA-256 digest of the bytes into the stored filename inside `storeImageBytes`, so two different uploads can never share a key, and pin the collision with a test at the `ingestImage` boundary that runs the REAL `storeImageBytes` against real storage.

## Boundaries & Constraints

**Always:**
- Keep the page slug as the FIRST segment of the asset key (`assets/<slug>/…`). `src/app/api/assets/[...path]/route.ts` reads that segment as the page slug and gates private-page assets on it; moving the digest into that position would serve private images ungated.
- The digest goes in the stored FILENAME, ahead of the sanitized name, so the extension (and therefore `contentTypeFor`) is preserved.
- `storeImageBytes` keeps its `(bytes, slug, suggestedName)` signature and keeps returning `{ localPath, filename }` describing the key it actually wrote.
- The strict/fresh change applies ONLY to the realm-fork guard read and `findFreeSlug`. Every other existence probe in `ingest.ts` stays exactly as it is.
- New tests must fail against the pre-fix code, not merely pass after it.

**Block If:**
- Making the fork guard strict would require changing `readWikiPageWithFrontmatter`'s contract or `ReadWikiPageOptions`.
- Digest-keying the asset cannot be done without changing how `/api/assets/[...path]` resolves or gates a request.

**Never:**
- Do not re-key the asset after `ingest()` returns (no post-hoc asset move plus body rewrite) — the digest is the sanctioned alternative to the final page slug.
- Do not change `writeAsset` to a create-only door, and do not touch `src/lib/storage/*`.
- Do not widen `strict`/`fresh` to the other existence probes in `ingest.ts` (`resolveConceptSlug`'s reads at `:1135`/`:1143`/`:1160`/`:1178`, the dedup probe at `:1915`, the prebuilt-H1 probes at `:2048`/`:2057`).
- Do not change `src/lib/illustration.ts` or `src/lib/document-sources.ts`, which mint asset keys of their own.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fork guard, healthy | Alice owns PRIVATE page `transformer`; Bob ingests a source titling to `transformer` | Bob's page forks to `transformer-2`; Alice's page byte-for-byte untouched | No error expected |
| Fork guard, provider blip on the guard read | Same, but the guard's read of `transformer.md` throws a non-ENOENT error | `ingest()` rejects with that storage error; Alice's page byte-for-byte untouched; no page written | Storage error propagates out of `ingest()` |
| `findFreeSlug` probe blips | Same, guard read succeeds and forks, but the free-slug probe of `transformer.md` throws non-ENOENT | `ingest()` rejects with that storage error; nothing written | Storage error propagates |
| Genuinely absent page | Guard read of a free slug returns ENOENT | Guard does not fork; ingest proceeds on that slug | `null` (ENOENT stays `null` under strict) |
| Two image ingests, same title + filename, DIFFERENT bytes | Both call `ingestImage` with filename `photo.png`, title "Photo" | Two distinct asset keys; each page's embed resolves to its OWN bytes | No error expected |
| Two image ingests, same title + filename, IDENTICAL bytes | Same bytes both times | One shared key (content-addressed); both pages render the same, correct bytes | No error expected |

</intent-contract>

## Code Map

- `src/lib/ingest.ts:2069-2082` -- the realm-fork guard. `const resolvedExisting = await readWikiPageWithFrontmatter(slug);` is the ONLY gate that forks off another owner's PRIVATE page. Needs `{ fresh: true, strict: true }`.
- `src/lib/ingest.ts:1513-1521` -- `findFreeSlug(base)`; its `while (await readWikiPageWithFrontmatter(candidate))` probe needs the same options. Sole caller is the fork at `:2081` (verified by grep), so the change is contained to the fork path. A flattened first probe returns `base` itself — i.e. the very private slug being forked away from.
- `src/lib/ingest.ts:2191-2195` -- the merge base, already `{ fresh: true, strict: true, owner }`. It is what writes over the private page when the guard is skipped; do not change it. Note it passes `owner`; the guard must NOT — the owner hint only reaches the ACTOR's own silo, which can never be the other-owner private page the guard forks from.
- `src/lib/wiki.ts:342-402` -- `ReadWikiPageOptions`: `fresh` (bypass `pageCache`), `strict` (rethrow non-ENOENT, incl. from `getPageIndex`; ENOENT and invalid slugs still answer `null`), `owner`.
- `src/lib/ingest.ts:425-427` -- `const slug = slugify(title); const { localPath } = await storeImageBytes(bytes, slug, filename);` — the pre-uniquified slug. `localPath` is embedded into the prebuilt body on the next line, before `ingest()` runs, so the FINAL page slug is not knowable here.
- `src/lib/fetch.ts:613-631` -- `storeImageBytes`. Today: `const localPath = \`assets/${slug}/${filename}\`; await getStorage().writeAsset(rawRelPath(localPath), bytes);`. NOTE: the door is `writeAsset` (OVERWRITE), not the create-only `writeAssetIfAbsent` the DW-693 reason describes — so in this tree the SECOND upload silently replaces the FIRST page's image. The fix is unchanged either way. `storeImageAsset` (`src/lib/fetch.ts:603-609`) is the other caller and inherits the fix.
- `src/lib/source-sha256.ts` -- `bytesSha256(bytes: BufferSource): Promise<string>` — the house digest over raw bytes. Reuse it; do not add a new hash helper. `src/lib/fetch.ts` does not import it yet.
- `src/app/api/assets/[...path]/route.ts:68-83` -- `const slug = segments[0]` is the AUTHORIZATION key: a private page there means owner-only. This is why the slug segment must survive.
- `src/app/api/wiki/export/route.ts:60-70` -- lists `assets/<slug>/` per page and copies each file by name; digest-in-filename keeps working (names are just longer).
- `src/components/MarkdownRenderer.tsx:106-113` -- maps `assets/<...>` refs to `/api/assets/<...>`; opaque to the filename shape.
- `src/lib/__tests__/ingest.test.ts:3681-3720` -- `describe("ingest — write bases read fresh + strict (DW-427)")`: the fault-injection pattern to copy (spy on `storage.readFile`, one-shot non-ENOENT throw, count page reads to ANCHOR the shot on the intended read).
- `src/lib/__tests__/ingest.test.ts:2829-2868` -- `describe("ingest — private-page convergence guard")` and its `seedPrivate(slug, owner, body, extra)` helper — the seeding pattern for the fork rows.
- `src/lib/__tests__/ingest-image.test.ts:11-14,50-55` -- the file mocks `storeImageBytes` away (`vi.mock("../fetch", …)` plus a `mockImplementation` in `beforeEach`), which is exactly why no test exercises the collision. The suite already roots `DATA_DIR`/`RAW_DIR` at a per-test tmpdir, so restoring the REAL implementation via `vi.importActual` inside one row gives a real-storage collision test.

## Tasks & Acceptance

**Execution:**
- `src/lib/ingest.ts` -- pass `{ fresh: true, strict: true }` to the realm-fork guard read at `:2075` and to the `findFreeSlug` probe at `:1516`; extend the comment at each site to say why this one is not a "pure existence probe" (it authorizes, or declines, a write onto another owner's page) -- so a provider blip or a stale cache entry can never skip the fork or fork onto an occupied slug.
- `src/lib/fetch.ts` -- in `storeImageBytes`, import `bytesSha256` from `./source-sha256` and build the key as `assets/${slug}/${digest}-${filename}` using a short (12-hex-char) prefix of the digest; update the JSDoc to state that the key is content-addressed and why (the caller's slug is pre-uniquified) -- so two different uploads sharing a title and filename can never address one key.
- `src/lib/__tests__/ingest.test.ts` -- add a `describe("ingest — realm fork guard reads fresh + strict (DW-698)")` block covering the fork-guard matrix rows: healthy fork, blip on the guard read, blip on the `findFreeSlug` probe, and a stale-`pageCache` row proving the guard sees the STORED private page. Anchor each fault the way the DW-427 rows do (count reads of the target `.md` and assert the count) so a shot consumed by an earlier read fails loudly -- so each row fails against the pre-fix code.
- `src/lib/__tests__/ingest-image.test.ts` -- add a `describe("ingestImage — asset keys are content-addressed (DW-693)")` block that restores the REAL `storeImageBytes` (via `vi.importActual<typeof import("../fetch")>("../fetch")`) and ingests two images with the same title and the same filename but DIFFERENT bytes, asserting each page's embedded path resolves to its own bytes on disk; add an identical-bytes row asserting the shared key is correct for both -- so the collision is pinned at the `ingestImage` boundary rather than mocked away.

**Acceptance Criteria:**
- Given Alice owns a PRIVATE page and Bob's ingest resolves onto its slug, when the guard's read of that page fails with a non-ENOENT storage error, then `ingest()` rejects with that error and Alice's stored page is unchanged byte for byte.
- Given the same setup, when the guard forks and the `findFreeSlug` probe fails with a non-ENOENT storage error, then `ingest()` rejects with that error and no page is written.
- Given a genuinely absent page (ENOENT), when the guard reads it, then the read still answers `null` and the ingest proceeds without forking — strict does not turn absence into an error.
- Given two `ingestImage` calls with the same title and the same filename but different bytes, when both complete against real storage, then they occupy two different asset keys and each page's embed reads back its own bytes.
- Given `pnpm test` and `pnpm lint`, when run on the repository, then both succeed with no new failures.

## Spec Change Log

No bad_spec loopback occurred; this section is empty.

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 1: (high 0, medium 1, low 0)
- reject: 13: (high 0, medium 3, low 10)
- addressed_findings:
  - `[low]` `[patch]` `src/lib/fetch.ts` -- `storeImageAsset` returned the pre-digest `filename` alongside a digest-bearing `localPath`, so the two no longer composed into a real key. Now returns the name `storeImageBytes` actually wrote.
  - `[low]` `[patch]` `src/lib/__tests__/ingest.test.ts` -- `expect(FREE_SLUG_PROBE_READ).toBeGreaterThan(CONCEPT_RESOLVER_READ)` compared two literals and could never fail. Removed, with the read ordering folded into the constants' comment.
  - `[low]` `[patch]` `src/lib/__tests__/ingest-image.test.ts` -- the DW-693 rows were unlabelled while the sibling DW-698 block labels every row. Marked the different-bytes row ABLATION and the identical-bytes row INVARIANT, and corrected the block header.

## Design Notes

Why a digest and not the final page slug: the asset must be written BEFORE the body is built, because the body embeds `localPath`, and the body is what `ingest()` uniquifies a slug for. Learning the final slug would mean re-keying the asset and rewriting the page after the fact — a second write racing the very concurrent ingest the collision describes. The DW entry sanctions "the final page slug OR a digest"; the digest is the option reachable at this boundary.

The digest goes in the filename, not the directory, because the directory segment is load-bearing for authorization:

```ts
// src/lib/fetch.ts — storeImageBytes
const filename = sanitizeImageFilename(suggestedName);
// Content-addressed: `slug` is the caller's PRE-uniquified slug, so two
// ingests sharing a title and filename would otherwise address one key.
const digest = (await bytesSha256(bytes)).slice(0, 12);
const localPath = `assets/${slug}/${digest}-${filename}`;
```

`assets/<digest>/<filename>` would look tidier and is WRONG: `/api/assets/[...path]` reads `segments[0]` as a page slug to gate private images, and a digest resolves to no page — every such asset would be served ungated.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/ingest.test.ts src/lib/__tests__/ingest-image.test.ts` -- expected: all rows pass, including the four new DW-698 rows and the new DW-693 rows.
- `git stash && pnpm vitest run …` is NOT the check — instead, before wiring each fix, run the new row against the unfixed source and confirm it FAILS for the stated reason, then apply the fix.
- `pnpm test` -- expected: full suite green, no new failures versus the pre-change baseline.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** Two independent `src/lib/ingest.ts` defects from the `ingest-read-and-asset-keying` bundle.

DW-698 — the realm-fork guard (`src/lib/ingest.ts:2097`) and the `findFreeSlug` probe it calls (`src/lib/ingest.ts:1527`) now read `{ fresh: true, strict: true }`. A non-ENOENT provider failure or a stale `pageCache` entry can no longer flatten to `null` and either skip the fork (letting the merge base write the actor's body onto another owner's private page, `owner`/`visibility` preserved) or fork onto the very slug the fork exists to leave. ENOENT still answers `null`, so genuine absence is unchanged. The guard deliberately passes no `owner` hint: that hint only reaches the actor's own silo, which can never be the other-owner private page being forked from.

DW-693 — `storeImageBytes` (`src/lib/fetch.ts`) now keys the asset as `assets/<slug>/<digest>-<filename>`, folding a 12-hex-char `bytesSha256` prefix into the stored filename. Two uploads sharing a title and a sanitized filename can no longer address one key; identical bytes harmlessly share one. The page slug stays the FIRST segment because `/api/assets/[...path]` reads it as the page slug to gate private-page assets; the digest sits ahead of the sanitized name so the extension (and `contentTypeFor`) survives.

**Files changed.**
- `src/lib/ingest.ts` -- fork-guard read and `findFreeSlug` probe read fresh + strict, with comments explaining why neither is a pure existence probe.
- `src/lib/fetch.ts` -- content-addressed asset key in `storeImageBytes`; `storeImageAsset` now returns the filename actually written so its `localPath`/`filename` pair composes.
- `src/lib/__tests__/ingest.test.ts` -- new `describe("ingest — realm fork guard reads fresh + strict (DW-698)")`: healthy fork, blip on the guard read, blip on the `findFreeSlug` probe, stale-`pageCache` fork, and an ENOENT invariant. Faults are anchored by counting flat reads of the target page, the DW-427 way.
- `src/lib/__tests__/ingest-image.test.ts` -- new `describe("ingestImage — asset keys are content-addressed (DW-693)")` running the REAL `storeImageBytes` against the suite's tmpdir: different bytes → two keys each reading back its own bytes; identical bytes → one shared key.

**Review findings breakdown.** 3 patches applied (all low: the `storeImageAsset` return pair, a tautological test assertion, missing INVARIANT/ABLATION row labels). 1 item deferred (medium: a forked page's image stays under the other page's asset directory, so `/api/assets` gates it on the wrong page's visibility — pre-existing, and the alternative the intent sanctioned). 13 findings rejected as noise or pre-existing-by-design (orphaned superseded asset keys, which match the repo's established content-addressed no-rewrite pattern; tests exercising only the flat-read branch while the flags are individually ablated; the prebuilt-H1 retarget probe, which the intent's scope excludes; unbounded `findFreeSlug` loop; concurrent fork race; index-corruption fail-closed semantics, already established by the strict merge base; unindexed silo-only private pages; `crypto.subtle` availability; 48-bit prefix collisions; 255-byte filename limits; `downloadImages` key-shape drift with no production callers; 12-vs-16 hex digest convention; absence of a dedicated `fetch.ts` unit row for a behavior the `ingestImage` rows already pin).

**Follow-up review recommendation.** Patched findings by severity: high 0, medium 0, low 3. Score: no high-severity patch → `followup_review_recommended: false`.

**Verification.**
- `pnpm vitest run src/lib/__tests__/ingest.test.ts src/lib/__tests__/ingest-image.test.ts` -- 278 passed (269 + 9), 0 failures.
- `pnpm test` -- 372 files, 9218 passed, 1 skipped; no new failures versus the baseline.
- `pnpm lint` -- exit 0 (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- `npx tsc --noEmit` -- exit 0.
- Test-first: each new row was run against the unfixed source first. Pre-fix, all three DW-698 ablation rows failed with `ingest()` resolving onto `transformer` (Alice's private slug) instead of rejecting or forking; the DW-693 different-bytes row failed on the two refs being equal. Per-flag ablations confirm each of the four flags and the digest is individually pinned by exactly one row.
- Matrix audit: all six I/O matrix rows are covered by a test that ran and passed.

**Residual risks.**
- The key-shape change is forward-only. Assets already stored as `assets/<slug>/<filename>` keep resolving (their keys live in the page bodies referencing them, and `/api/assets` and the export route are opaque to filename shape). No migration is performed, so both key shapes coexist.
- Re-ingesting a page with changed image bytes now mints a new key instead of overwriting, so superseded bytes accumulate. This matches the repo's existing content-addressed `rawId` behavior, but there is no asset GC anywhere.
- The DW-698 read ordinals in the test are measured, not derived. If `resolveConceptSlug` ever adds or drops a read of the resolved slug, the count assertions fail loudly rather than silently re-aiming the one-shot — intended, but a maintenance edge.
- The deferred item above (asset directory naming the wrong page after a fork) is unaddressed by design; it is pre-existing and the intent sanctioned the digest route.
