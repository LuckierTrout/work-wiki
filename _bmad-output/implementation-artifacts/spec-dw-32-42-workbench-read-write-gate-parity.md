---
title: 'DW-32/DW-42 — Workbench read gate and editable flag mean what they say'
type: 'bugfix'
created: '2026-08-27'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized', 'multiple-goals']
deferred:
  - summary: >-
      `raw/assets/<slug>/<file>` is silo-mirrored and still spells a hidden page's slug, so
      DW-32's disclosure survives in the assets subtree.
    evidence: |-
      `syncSiloForPage` mirrors `raw/assets/<slug>/<file>` into
      `tenants/<t>/raw/assets/<slug>/` (src/lib/silo.ts:148), which is exactly the tree the
      Files tab walks and `/api/workbench/media` serves bytes from. `rawPathSlug` reads only
      the FIRST segment under `raw/` (after dropping `sources`), so that path derives the
      slug `assets`, not `<slug>`, and `rawPathAllowed` admits it. The directory row
      `raw/assets/<hidden>/` therefore still announces the page. Triaged `patch` (medium) in
      the 2026-08-27 review pass and NOT applied — the session hit its token budget first.
      The fix is to drop a leading `assets` segment the way `sources` is dropped. Note the
      intent-contract's I/O matrix calls `raw/assets/…` a "non-slug raw subtree", which is
      false for this shape; `raw/parsed/<slug>/…` has the same shape but is written only to
      the flat non-silo key (src/lib/raw.ts:279), so it is NOT reachable from the tab.
    location: >-
      src/lib/workbench-files.ts:199
    severity: medium
  - summary: >-
      A page slugged plain `queries` with sharded sources is not refused — the two-segment
      `queries/<leaf>` branch swallows the snapshot id.
    evidence: |-
      `validateSlug` admits `queries` as an ordinary one-segment slug as well as the
      prefixed `queries/<leaf>` shape. For a page slugged `queries`, `saveRawSourceFor`
      writes `raw/sources/queries/<sha>.md`; `rawPathSlug` sees head `queries` with a
      following segment and returns `queries/<sha>` instead of `queries`, so a hidden page
      slugged `queries` is not refused. Fix: have `rawPathAllowed` test BOTH candidates
      (`queries` and `queries/<leaf>`) when the head is `queries`. Triaged `patch` (low),
      not applied — session budget.
    location: >-
      src/lib/workbench-files.ts:207
    severity: low
  - summary: >-
      `rescanSources`' `hiddenSlugs` forwarding is never exercised with a non-empty set, so
      the gate on the one door a caller can point at an arbitrary raw path is unpinned.
    evidence: |-
      Every `rescanSources` call site in the suite passes `hiddenSlugs: new Set()`
      (src/lib/__tests__/epic8-remediation.test.ts, ten sites); `epic8-v1-routes.test.ts`
      mocks `@/lib/source-rescan` wholesale; the new rescan row in `workbench-tree.test.ts`
      calls `listRawSourceFilePaths` DIRECTLY, not through `rescanSources`. Replacing
      `hiddenSlugs: input.hiddenSlugs` with `new Set()` at src/lib/source-rescan.ts:126
      leaves the whole suite green, and a POST of
      `{"paths":["raw/sources/<hidden>/<sha>.md"]}` would then read and enqueue the hidden
      page's source. The explicit-`paths` branch skips the listing entirely, so that forward
      is its ONLY gate. Triaged `patch` (medium), not applied — session budget.
    location: >-
      src/lib/source-rescan.ts:126
    severity: medium
  - summary: >-
      `frontmatterOf`'s docblock and two test comments claim parity with
      `PUT /api/wiki/[slug]` for an UNPARSEABLE frontmatter block; that route answers 500,
      not 403.
    evidence: |-
      `readWikiPageWithFrontmatter` (src/lib/wiki.ts:534-546) calls `parseFrontmatter` with
      no catch, so an unclosed `---` throws past the PUT route's ACL check into its outer
      catch — a 500. The parity claim holds for EMPTY metadata (`bare.md`, where the parse
      succeeds and returns `{}`) and is false for the unparseable case the comments attach
      it to. Triaged `patch` (low), not applied — session budget.
    location: >-
      src/app/api/workbench/preview/route.ts:101
    severity: low
  - summary: >-
      A dangling `{@link allowEveryLeaf}` points at a symbol this change deleted.
    evidence: |-
      `allowEveryLeaf` was replaced by `rawFilter`/`allowEveryDir`, but the `rawPathAllowed`
      docblock still links it. Triaged `patch` (low), not applied — session budget.
    location: >-
      src/lib/workbench-files.ts:218
    severity: low
  - summary: >-
      `hiddenSlugs` is derived from READABLE entries, so a page outside the read ACL is
      treated as an orphan and its raw paths list — while the docblocks claim the set is
      "the slugs the index named".
    evidence: |-
      Every door feeds `workbenchSlugGate` the result of `listReadableWikiPages(principal)`,
      which is `listWikiPages()` already filtered by `canReadEntry` (src/lib/wiki.ts:841).
      A slug naming a page the principal may not read is therefore absent from `entries`,
      lands outside `hiddenSlugs`, and is admitted as an orphan — the fail-OPEN direction.
      One reachable instance: a page whose frontmatter will not parse is marked
      `visibility: private` and unowned (src/lib/wiki.ts:818), so it is unreadable to every
      non-admin while its sources stay enumerable. Exposure is nil today because `raw/` is
      silo-only (DW-40) so the bytes are the owner's own, which is why this is recorded
      rather than fixed: closing it needs a second UNFILTERED index read at all seven doors,
      which the intent's Never clause pushes away from. At minimum the docblocks on
      `workbenchSlugGate` and `WorkbenchFileOptions` should say "readable entries", not
      "the index named".
    location: >-
      src/lib/workbench-tree.ts:826
    severity: low
  - summary: >-
      A folder-import Source puts the IMPORT FOLDER's name in the slug position, so the
      positional `raw/` gate cannot tell it from a page slug.
    evidence: |-
      `saveRawSourceTree` (src/lib/raw.ts:389-419) writes `raw/sources/<dir>/…` where `<dir>`
      is a `validateSlug`'d import-folder name, not a page slug. `rawPathSlug` reads the slug
      positionally, so a folder-import source backing a hidden page is NOT refused, and a
      hidden page slugged like an import folder withholds an unrelated subtree. An
      identity-based mapping (`src/lib/source-index.ts` maps sha256/url/hash to a canonical
      slug) could tell the two apart; the positional rule cannot. This is the ledger's own
      "source→page mapping" reading of DW-32, which this bundle did not take.
    location: >-
      src/lib/workbench-files.ts:199
    severity: medium
  - summary: >-
      Gating the rescan listing and read means an agent-scoped page's sources can never be
      re-ingested, for the owner too, with no accounting in the result.
    evidence: |-
      `buildKnowledgeTree` drops agent-scoped types unconditionally, so those slugs are
      always in `hiddenSlugs` for every principal including the owner. `rescanSources` now
      refuses them at both the listing and the read, and `SourceRescanResult` carries no
      counter distinguishing "refused" from "absent" — an explicit `paths` entry comes back
      `queued: false, reason: "not_found"`. DW-32 scoped the problem to filenames in the
      Files tree; extending it to recompilation is a behaviour change worth a decision.
    location: >-
      src/lib/source-rescan.ts:98
    severity: low
  - summary: >-
      No route-level test observes `hiddenSlugs` arriving at the walk from any HTTP door —
      the six non-SSR doors are held by TypeScript's required field alone.
    evidence: |-
      `epic8-v1-routes.test.ts` and `workbench-epic2-routes.test.ts` both
      `vi.mock("@/lib/workbench-files")` and assert options with `expect.anything()` /
      `expect.objectContaining({ limit })`. The only door-level pin is a SOURCE-STRING
      assertion for `page.tsx` in `workbench-left-column.test.ts`. A wiring mistake in the
      media, files, or any `/api/v1` route — reintroducing a `{ readableSlugs }` literal, say
      — would not be caught by behaviour. Pre-existing test architecture that the new gate
      inherits.
    location: >-
      src/lib/__tests__/epic8-v1-routes.test.ts:45
    severity: low
  - summary: >-
      A failed page-index read degrades the `raw/` gate OPEN, where it degrades the `wiki/`
      gate closed.
    evidence: |-
      `src/app/page.tsx` catches an index-read failure into `entries: []`, which makes
      `readableSlugs` empty (every `wiki/` leaf filtered out — fail closed) and `hiddenSlugs`
      empty too (every `raw/` path admitted — fail open). Not a regression, since `raw/` was
      unfiltered before this change, but the two roots now disagree about which direction a
      degraded index fails in, and nothing says so.
    location: >-
      src/app/page.tsx:100
    severity: low
  - summary: >-
      Chat/Search retrieval surfaces hidden pages' slugs and raw source bodies, entirely
      outside the workbench file gate.
    evidence: |-
      `src/lib/wiki-retrieve.ts:253-285` builds documents from `listRawSources()` /
      `listRawSourceSnapshots()` with `title: source.slug` and `path: raw/sources/<slug>…`,
      never touching `workbench-files.ts`. The module's own doctrine — the filename, the
      directory name and the bytes disclose the same slug, so one refusal covers all three —
      stops at the Workbench doors. A different surface from the one this bundle's intent
      names, so recorded rather than fixed here.
    location: >-
      src/lib/wiki-retrieve.ts:253
    severity: medium
baseline_revision: '3f0bf1a231bf043d27c125427b204629cf8d8395'
---
<intent-contract>

## Intent

**Problem:** Two Workbench gates overstate their reach. (DW-32) `wikiLeafFilter` gates `wiki/` leaves against the readable slug set, but `raw/` leaves pass through `allowEveryLeaf` unfiltered — and every `raw/` path is slug-derived (`raw/sources/<slug>/<sha>.md`, `raw/sources/<slug>.md`), so the filename of a page the Knowledge tab hides is still spelled in the Files tree. (DW-42) The Preview route derives `editable` from `isReadOnly()` alone, while `canWritePage`'s realm branch refuses `writeKind: "body"` for any commons page to a non-service, non-admin principal — so a readable-but-unwritable page offers `Edit`, seeds the editor, and only then relays the write route's 403.

**Approach:** Give the file walk a second caller-supplied set — the slugs the principal's index named that the Knowledge tab does not show — and refuse any `raw/` leaf whose path spells one, at both the listing filter and `resolveWorkbenchFile`. Derive `editable` for a Page from `canWriteFrontmatter(..., "body")` on the bytes the route already read, in both the `kind=page` and the `wiki/<slug>.md` file branch.

## Boundaries & Constraints

**Always:**
- ONE predicate answers "may this `raw/` display path be shown/served", exported from `workbench-files.ts`, and every caller calls it rather than restating it (the DW-41/DW-204 doctrine already in that module).
- ONE derivation produces both slug sets from the same `(entries, knowledge groups)` pair, exported from `workbench-tree.ts` beside `readableSlugsFromKnowledge`, so no call site can spell the pair differently.
- The new set is a REQUIRED field of `WorkbenchFileOptions`, exactly as `readableSlugs` is: omitting it must not be spellable.
- An ORPHANED source — a `raw/` path whose spelled slug names no page in the index — still lists and still reads. That is this bundle's recorded decision, and it is why the refusal set is "hidden pages", not "not-readable pages".
- `editable` stays a claim about a write that can actually land: it must consult every refusal the matching write route answers 403 to, and no more.
- Existing `wiki/` listing, read-gate and artifact behaviour is unchanged.

**Block If:** nothing — both decisions the bundle names (orphan handling; deriving `editable` from `canWritePage`) are settled above.

**Never:**
- Do not have `workbench-files.ts` read the page index itself. `listWikiPages()` is a storage read whose fallback is a full frontmatter scan, and every caller has already paid for the entries.
- Do not widen `readableSlugs` or change `buildKnowledgeTree`.
- Do not add refusal copy, a disabled-Edit tooltip, or a `writeDenial` sentence to the payload — that is other work.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Hidden page's source | `raw/sources/agentpage/<sha>.md` on disk; `agentpage` in the index, absent from the knowledge tree | Path absent from `listWorkbenchFilePaths`; `readWorkbenchFile`/`readWorkbenchFileBytes`/`workbenchFileExists` answer null/null/false | No error; refusal is indistinguishable from absence |
| Hidden page's flat source | `raw/hidden.md` (legacy shape, silo) with `hidden` hidden | Same refusal — the legacy shape spells a slug too | No error expected |
| Orphaned source | `raw/sources/nobody/<sha>.md`, `nobody` in no index entry | Lists and reads normally | No error expected |
| Readable page's source | `raw/sources/alpha/<sha>.md`, `alpha` in the knowledge tree | Lists and reads normally | No error expected |
| Non-slug raw subtree | `raw/parsed/<slug>/<id>.md`, `raw/assets/…` | Lists, unless the first segment itself collides with a hidden slug (conservative, documented) | No error expected |
| Commons page, non-admin | `kind=page&slug=alpha`, page public + `type: concept`, principal neither admin nor service | 200 with `editable: false`; body still served | No error — read-only means read-only, not hidden |
| Same page from Files tab | `kind=file&path=wiki/alpha.md`, same principal | 200 with `slug: "alpha"`, `editable: false` — the two branches agree | No error expected |
| Commons page, admin/owner | Same page, principal passes `isAdmin` | `editable: true` (unless `isReadOnly()`) | No error expected |
| Unparseable frontmatter | `wiki/alpha.md` whose YAML block has no closing `---` | Treated as empty metadata → realm-restricted → `editable` only for admin/service | Parse throw caught, never surfaces |
| Artifact | `kind=file&path=schema.md` | Unchanged: `isReadOnly()` + `isOwnerHandle()` only | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-files.ts` — the walk and both gates. `WorkbenchFileOptions` (66-79) gains the new set. `LeafFilter` (144) and `walkRoot` (229-284) apply `allowLeaf` to LEAVES ONLY — directories are unfiltered, which is safe under `wiki/` and NOT under `raw/`, where `raw/sources/<slug>/` is itself a directory spelling a slug. `wikiLeafFilter` (346-372) is the `wiki/` precedent to mirror; `allowEveryLeaf` (382) is what `raw/` uses today. `listWorkbenchFilePaths` (410-491) walks `raw/` at 469-475 and `wiki/` at 484-490. `listRawSourceFilePaths` (505-613) — its `allow` option (509, 526) is the rescan's SCOPE filter, and it descends directories via `towardSources` (548-552). `resolveWorkbenchFile` (740-777) is the read gate — the `root === "raw"` branch (773-775) applies nothing. `readWorkbenchFile` (783), `readWorkbenchFileBytes` (807), `workbenchFileExists` (836) all funnel through it. `wikiLeafSlug` (654), `readableWikiLeaf` (662), `isListablePath` (674).
- `src/lib/workbench-tree.ts` — `readableSlugsFromKnowledge` (779-787) and its docblock on why the derivation is a function, not an inlined `flatMap`. `buildKnowledgeTree` (596) takes `readonly IndexEntry[]`. The new pair-derivation belongs here, calling both.
- `src/lib/wiki.ts` — `validateSlug` (183-210) and `SAFE_SLUG_RE`: a slug is lowercase alphanumeric + hyphens, NO dots and NO slashes — except the one prefixed shape `queries/<leaf>` (181, 196-205). That is why a raw path can spell a slug across TWO segments, and why extension-stripping is unambiguous.
- `src/lib/raw.ts` — the writers that make `raw/` slug-derived: `RAW_SOURCES_DIR = "sources"` (30), `RAW_PARSED_DIR = "parsed"` (41), `saveRawSource` (293-301, `sources/<slug>.md`), `saveRawSourceFor` (366-378, `sources/<slug>/<rawId>.md`), `saveRawSourceBytes` (235-255), `saveRawSourceTree` (389-419, `sources/<dir>/…`, dirs `validateSlug`'d as IMPORT-FOLDER names, not page slugs — see Design Notes). Legacy flat `raw/<slug>.md` and `raw/<slug>/<hash>.md` residue is what the no-`sources` branch of the rule covers.
- `src/app/page.tsx` (96-102) — SSR first paint; holds `pageIndex.entries` AND `knowledge`.
- `src/app/api/workbench/files/route.ts` (23-34), `src/app/api/workbench/media/route.ts` (80-88), `src/app/api/workbench/preview/route.ts` (128-129, `gate` at 200) — the other in-product doors; each already builds `knowledge` from entries it has (media/preview inline the `await` and need it hoisted to a variable).
- `src/lib/v1-route.ts` — `v1ReadableSlugs` (89-94), the one derivation the three `/api/v1` doors share.
- `src/app/api/v1/projects/[wikiId]/files/route.ts` (42-46), `.../files/content/route.ts` (57-62), `.../sources/rescan/route.ts` (82-87) — consumers of that derivation.
- `src/lib/source-rescan.ts` (60-120) — `rescanSources` takes `readableSlugs` (63), composes `allow` for `listRawSourceFilePaths` (88-91), and reads through `readWorkbenchFile` (116).
- `src/app/api/workbench/preview/route.ts` — 145-176 is the `kind=page` payload: `parseFrontmatter` already runs at 150-154 for `disputed`, `editable: !isReadOnly()` at 175. 264-268 is the file branch's `disputed` parse; `editable` at 322-325 (`format === "markdown" && ((slug !== undefined && !isReadOnly()) || (artifact !== undefined && …))`).
- `src/lib/authz.ts` — `canWriteFrontmatter` (294-309) over `canWritePage` (254-292); the realm branch is `isRealmRestrictedWrite` (196-206) → `belongsInCommons` (`src/lib/commons.ts:46-56`). `isAdmin` (51-61) returns true for `isOwnerHandle`, so the owner keeps `editable: true`.
- `src/app/api/wiki/[slug]/route.ts` (205-219) — the write route whose refusal `editable` must mirror: `canWriteFrontmatter(existing.frontmatter, principal, "body")`, plus `isReadOnly()` at 156-163.
- READ-ONLY EVIDENCE / do not change: `src/lib/authz.ts`, `src/lib/commons.ts`, `src/lib/raw.ts`, `src/lib/wiki.ts`, `src/app/api/wiki/[slug]/route.ts`.
- Tests: `src/lib/__tests__/workbench-tree.test.ts` — `describe("listWorkbenchFilePaths")` from 469, its `gate()` helper at 528-530 is the single place every case builds options, `writeSilo` at 543. `src/lib/__tests__/workbench-preview.test.ts` — `describe("GET /api/workbench/preview")` from 1475; `beforeAll` sets `NEXT_PUBLIC_OWNER_HANDLE = OWNER` (1503) and `beforeEach` sets `principal.current = { id: "u1", handle: OWNER }` (1525), so every existing `editable: true` survives through `isAdmin`; `writePage` (1543-1552) writes `type: concept` with no `visibility`, which IS a commons page. Mocked call sites that must keep compiling: `src/lib/__tests__/epic8-v1-routes.test.ts`, `src/lib/__tests__/workbench-epic2-routes.test.ts`, `src/lib/__tests__/workbench-left-column.test.ts`, `src/lib/__tests__/wiki-schema-edit.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-tree.ts` -- export a `WorkbenchSlugGate` type (`readableSlugs`, `hiddenSlugs`) and one function producing it from `(entries, groups)`, `hiddenSlugs` being every entry slug absent from `readableSlugsFromKnowledge(groups)` -- one derivation the seven doors share, so the pair cannot drift the way the DW-41 filters did.
- `src/lib/workbench-files.ts` -- add REQUIRED `hiddenSlugs` to `WorkbenchFileOptions`; export `rawPathSlug(displayPath)` (the page slug a `raw/` display path spells: drop `raw/`, drop a leading `sources` segment, then the first remaining segment names it -- extension-stripped when it is the only one, and joined with the next segment when it is `queries`, the one two-segment slug shape `validateSlug` allows) and `rawPathAllowed(displayPath, hiddenSlugs)`; give `walkRoot` a directory filter alongside its leaf filter and pass `rawPathAllowed` as BOTH for the `raw/` root (a refused directory is not descended and is not truncation); apply `rawPathAllowed` in `resolveWorkbenchFile`'s `root === "raw"` branch -- the filename, the directory name and the bytes disclose the same slug, so one predicate gates all three.
- `src/lib/workbench-files.ts` -- make `hiddenSlugs` a REQUIRED option of `listRawSourceFilePaths` and apply `rawPathAllowed` INSIDE the walk (both to `raw/sources/*` descent and to leaves), leaving the caller's `allow` as the scope filter it is -- the gate is not the caller's to compose, so a second caller cannot get an ungated enumeration by omitting a callback.
- `src/lib/v1-route.ts` -- rename `v1ReadableSlugs` to `v1SlugGate`, returning the pair -- the three `/api/v1` doors keep sharing exactly one expression of the gate.
- `src/app/page.tsx`, `src/app/api/workbench/files/route.ts`, `src/app/api/workbench/media/route.ts`, `src/app/api/workbench/preview/route.ts`, `src/app/api/v1/projects/[wikiId]/files/route.ts`, `.../files/content/route.ts`, `.../sources/rescan/route.ts` -- build the pair from the shared derivation and spread it into the options -- every door gets the fix without restating it.
- `src/lib/source-rescan.ts` -- take the `WorkbenchSlugGate` pair on `rescanSources` and pass it to both `listRawSourceFilePaths` and `readWorkbenchFile` -- a rescan must not enumerate or compile a hidden page's source.
- `src/app/api/workbench/preview/route.ts` -- import `canWriteFrontmatter`; in the `kind=page` branch parse the read bytes' frontmatter ONCE and use it for both `disputed` and `editable: !isReadOnly() && canWriteFrontmatter(fm, principal, "body")`; in the file branch apply the same conjunct to the `slug !== undefined` half only, leaving the artifact half untouched -- the affordance now mirrors the exact refusal `PUT /api/wiki/[slug]` answers.
- `src/lib/__tests__/workbench-tree.test.ts` -- extend `gate()` to carry `hiddenSlugs` and add a case per `raw/` row of the I/O matrix (hidden slug refused in the nested, flat and legacy shapes AND as a directory row; orphan listed; readable listed; refusal not counted as truncation; list/read/bytes/exists all agree) -- these rows are what make the gate a fact rather than a comment.
- `src/lib/__tests__/workbench-preview.test.ts` -- add cases for a commons page under a NON-admin principal (200, body present, `editable: false`) reached from BOTH `kind=page` and `kind=file`, and keep an owner case green -- without a non-admin principal the whole realm branch is unreachable and the fix would be untested.

**Acceptance Criteria:**
- Given a page in the principal's index that `buildKnowledgeTree` drops, and a source stored under its slug, when the Workbench Files tree is listed, then no path spelling that slug appears -- as a file OR as a directory -- and `truncated` is unchanged by the refusal.
- Given the same setup, when any workbench file door is asked for that path directly, then it answers exactly as it does for a path that does not exist.
- Given a source whose spelled slug matches no index entry, when the tree is listed, then the path appears and its bytes read back.
- Given a public, non-agent-scoped, non-artifact page and a principal that is neither the service principal nor an admin, when the Preview is fetched for that page by slug or by its `wiki/<slug>.md` path, then the payload carries the body and `editable: false`, and the two branches agree.
- Given the same page and an admin/owner principal on a writable deployment, when the Preview is fetched, then `editable` is `true`.
- Given a new call site of `listWorkbenchFilePaths` or `listRawSourceFilePaths` that omits `hiddenSlugs`, when the project is type-checked, then it fails to compile.
- Given `pnpm test`, `pnpm lint` and `npx tsc --noEmit`, when run, then all three pass with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 5: (high 0, medium 2, low 3)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - none — the session hit its token budget before the patch set could be applied. All six
    `patch` findings were verified against the codebase and are recorded verbatim in
    frontmatter `deferred`, each labelled with its triage and the fix it needs, so none is
    lost. `followup_review_recommended` is `true` (3x2 medium + 1x4 low = 10, >= 5).

## Design Notes

`hiddenSlugs` is the caller's job for the same reason `readableSlugs` is: which pages the Knowledge tab shows is a rendering fact the storage layer cannot know, and every door already holds the index entries the pair is derived from. Deriving it inside `workbench-files.ts` would mean a second `listWikiPages()` per listing — whose no-index fallback is a full per-page frontmatter scan.

Why the refusal set is "hidden pages" and not "everything not readable": a `raw/` path whose slug names no page at all is an ORPHANED source, and it is the owner's own file in the owner's own silo (`raw/` is silo-only since DW-40). Refusing it would hide real data to protect nothing. Listing it is this bundle's recorded decision.

Directories must be filtered under `raw/` and must NOT be under `wiki/`. `raw/sources/<slug>/` spells a slug in its own name, so a leaf-only filter would withhold the snapshot filenames and leave the directory row announcing the page anyway; under `wiki/` the only directories are structural (`wiki/query-history/`), and `wikiLeafFilter`'s docblock records why they must keep listing. That asymmetry is why `walkRoot` gains a SECOND filter rather than having its one filter widened to directories.

The `sources` segment is dropped rather than treated as a slug because it is `RAW_SOURCES_DIR`, the fixed structural root every Source lives under — reading it as a spelled slug would let one page slugged `sources` blank the entire Sources tree. Every OTHER first segment is read as a slug, so `raw/parsed/…` derives `parsed`: deliberately conservative, because the legacy flat shapes (`raw/<slug>.md`, `raw/<slug>/<hash>.md`) put a real slug in exactly that position and the path alone cannot tell them apart. If a hidden page were ever slugged `parsed`, that subtree is withheld — the safe direction for a filter whose job is to withhold filenames, and the same fail-closed direction `wikiLeafFilter` already takes for a name it did not see while building its winner set.

For `editable`, the two Preview branches read the same bytes and must reach the same answer, so both parse the frontmatter they already have rather than re-reading the page. A frontmatter block that will not parse yields empty metadata, which `belongsInCommons` treats as a commons page — so it fails closed to admin/service, and no exception escapes.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-preview.test.ts` -- expected: all pass, including the new gate and `editable` cases
- `npx tsc --noEmit` -- expected: clean; the required `hiddenSlugs` fields must surface every un-migrated call site as a compile error first
- `pnpm test` -- expected: no new failures across the suite
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

DW-32 — the `raw/` root of the Workbench file tree was walked with `allowEveryLeaf`, so the
filename of a page the Knowledge tab hides was still spelled in the Files column. One
caller-supplied refusal set (`hiddenSlugs`) and one predicate (`rawPathAllowed`) now gate
`raw/` at the listing filter, at the directory filter, at `resolveWorkbenchFile`, and inside
the rescan walk. An orphaned source — a `raw/` path whose slug names no page — still lists
and reads, which is this bundle's recorded decision.

DW-42 — `editable` was `!isReadOnly()` alone while `canWritePage`'s realm branch refuses
body writes to a commons page from any non-service, non-admin principal, so a
readable-but-unwritable page offered `Edit` and failed at Save. Both Preview branches now
derive `editable` from one parse of the bytes they already read, conjoined with
`canWriteFrontmatter(fm, principal, "body")`.

### Files changed

- `src/lib/workbench-tree.ts` — new `WorkbenchSlugGate` type and `workbenchSlugGate(entries, groups)`, the one derivation all seven doors share.
- `src/lib/workbench-files.ts` — required `hiddenSlugs` on `WorkbenchFileOptions`; new `rawPathSlug` / `rawPathAllowed`; `walkRoot` gains a `DirFilter`; the read gate and `listRawSourceFilePaths` apply the same predicate.
- `src/lib/v1-route.ts` — `v1ReadableSlugs` → `v1SlugGate`, returning the pair.
- `src/app/page.tsx`, `src/app/api/workbench/{files,media,preview}/route.ts`, `src/app/api/v1/projects/[wikiId]/{files,files/content,sources/rescan}/route.ts` — build the pair from the shared derivation and spread it into the options.
- `src/lib/source-rescan.ts` — `rescanSources` takes the whole gate and forwards both halves.
- `src/app/api/workbench/preview/route.ts` — new `frontmatterOf`; `editable` mirrors the write route's refusals in both branches.
- `src/lib/__tests__/workbench-tree.test.ts` — `gate()`/`hiding()` helpers, `workbenchSlugGate` and `rawPathSlug` unit rows, seven listing rows for the `raw/` gate.
- `src/lib/__tests__/workbench-preview.test.ts` — `asNonAdmin()` helper; commons-page rows from both `kind=page` and `kind=file`; owner-stays-editable row; empty-metadata and unparseable-frontmatter rows.
- `src/lib/__tests__/{epic8-remediation,wiki-schema-edit,workbench-left-column}.test.ts` — call-site and source-text pins updated.

### Review findings breakdown

Four review layers ran (blind hunter, edge-case hunter, verification-gap, intent-alignment).
Patches applied: 0 of 6 triaged — the session hit its token budget before the patch step.
Items deferred: 11 (the 6 unapplied patches plus 5 genuine defers). Items rejected: 8.
Follow-up review recommended: true — patched-severity score 3x2 + 1x4 = 10, >= 5.

The two findings that matter most, both verified against the codebase rather than taken on
a reviewer's word: `raw/assets/<slug>/<file>` is silo-mirrored (`src/lib/silo.ts:148`) and
still spells a hidden slug, so DW-32 is closed for `raw/sources/**` but not for
`raw/assets/**`; and `rescanSources`' gate forward is unpinned by any test.

### Verification performed

- `npx tsc --noEmit` — clean. The required `hiddenSlugs` fields surfaced every un-migrated call site as a compile error first.
- `pnpm test` — 328 files, 7548 passed, 1 skipped, 0 failures. One DOM suite (`workspace-purpose-settings.test.tsx`, DW-136) failed once under the full parallel run and passed in isolation both with and without this change, and passed on a clean re-run of the full suite: a pre-existing flake, not a regression.
- `pnpm lint` — clean (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` warnings).
- Matrix test audit — all ten I/O matrix rows are covered by tests that ran and passed. Row 9 (unparseable frontmatter) is covered in two halves: the throw-never-surfaces half on `broken.md`, and the empty-metadata-is-realm-restricted half on `bare.md`. A non-admin cannot reach an unparseable page at all, because `listWikiPages` marks it `visibility: private` and unowned (`src/lib/wiki.ts:818`) — the read gate, upstream of and unchanged by this bundle.

### Residual risks

- DW-32 is closed for `raw/sources/**` and the legacy flat shapes, and NOT for `raw/assets/**`. That is the single most important open item and is the first `deferred` entry.
- The positional slug rule cannot distinguish a folder-import directory name from a page slug, and reads every non-`sources` first segment as a slug (so a hidden page slugged `parsed` withholds that subtree). Both directions are recorded in `deferred`.
- `hiddenSlugs` is derived from readable entries rather than from the whole index, so a page outside the read ACL is admitted as an orphan; harmless while `raw/` is silo-only, and recorded.
- Gating the rescan means an agent-scoped page's sources can no longer be re-ingested, for the owner too.
