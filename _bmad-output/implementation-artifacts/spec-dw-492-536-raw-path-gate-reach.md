---
title: 'DW-492/536 — The raw-path gate covers a page slugged `queries`, and `/api/assets/` runs it'
type: 'bugfix'
created: '2026-09-03'
baseline_revision: '03696dc57c686058874277c91b2a67fb984a16ad'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `/api/raw/[slug]` serves the raw SOURCE text of a page the Knowledge tab hides
      to anyone, unauthenticated — the sources-half twin of the hole DW-536 just closed
      on the assets half.
    evidence: |-
      DW-536 aligned `/api/assets/[...path]` on `hiddenSlugs`/`rawPathAllowed`.
      `/api/raw/[slug]` (`src/app/api/raw/[slug]/route.ts:24-30`) reads the same silo
      tree — `readRawSource` / `readRawSourceById` over `raw/sources/<slug>.md` and
      `raw/sources/<slug>/<rawId>.<ext>` — and its ONLY gate is
      `canReadSlug(slug, principal)` (`src/lib/authz.ts:144-162`), which reads
      frontmatter visibility/owner and nothing else. Those are exactly the paths
      `rawPathAllowed` refuses for a hidden slug at `listWorkbenchFilePaths`,
      `resolveWorkbenchFile` and the `/api/v1` file doors. An `agent-*` typed page with
      `visibility: public` is kept by `listReadableWikiPages` but dropped by
      `buildKnowledgeTree` (`src/lib/workbench-tree.ts:656`), so its slug is in
      `hiddenSlugs` and the Files tab withholds its source — while
      `GET /api/raw/<that-slug>` returns the source text with no session.
      Verified by reading both routes; no test in the suite exercises that route's GET
      at all (only citation-href string assertions in `raw-source-search.test.ts`).
      Pre-existing: that route's gate predates DW-491/DW-536 and was not touched here.
    location: >-
      src/app/api/raw/[slug]/route.ts:24
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Two holes in the raw-path gate's reach. (1) DW-492 — `validateSlug` admits `queries` as an ordinary one-segment slug as well as the prefixed `queries/<leaf>` shape, so for a page slugged plain `queries` the sharded source `raw/sources/queries/<sha>.md` makes `rawPathSlug` answer `queries/<sha>`; `rawPathAllowed` then tests a slug nobody hid and a hidden page slugged `queries` is never refused. (2) DW-536 — `/api/assets/[...path]` reads the same `raw/assets/<slug>/<file>` bytes the Workbench doors read, but its only gate is `visibility: private`, while those doors gate on the broader `hiddenSlugs`; so the Files tab withholds an agent-scoped page's asset while a plain unauthenticated `GET /api/assets/agentpage/pic.png` still returns it.

**Approach:** Have `rawPathAllowed` test BOTH candidates (`queries` and `queries/<leaf>`) when the head is `queries`, leaving `rawPathSlug`'s answer untouched. And give `/api/assets/[...path]` the same gate the Workbench doors use — `listReadableWikiPages(principal)` → `buildKnowledgeTree` → `workbenchSlugGate` → `rawPathAllowed` over the display path `raw/assets/<…>` — derived for the request's principal, keeping the route no-auth for slugs that gate admits (the 2026-08-29 decision on DW-536).

## Boundaries & Constraints

**Always:** `rawPathAllowed` stays THE one predicate — the second candidate lives inside it, so leaf, directory row and bytes are refused together at every door that already calls it. `rawPathSlug`'s answer is unchanged for every path: no new slug spelling enters the module. `/api/assets/` derives the gate the one way every other door does (`listReadableWikiPages` → `buildKnowledgeTree` → `workbenchSlugGate`), never hand-rolling a `hiddenSlugs` set. It keeps its EXISTING `visibility: private` + `canReadFrontmatter` check as well: `hiddenSlugs` is a refusal set derived from entries the principal can READ, so a private page absent from an anonymous index is not in it and only the visibility check refuses that. Its refusal stays a bodyless 404, indistinguishable from absent — no existence oracle. The gate is applied to the WORKBENCH DISPLAY path (`raw/assets/<segments>`), not to `storageKey`, which `rawRelPath` may rewrite under a `RAW_DIR` override.

**Block If:** Nothing here requires a human decision; the ledger's DW-492 fix and the recorded 2026-08-29 DW-536 decision each name the change.

**Never:** Do not edit `_bmad-output/implementation-artifacts/deferred-work.md` or the source specs `spec-dw-32-42-workbench-read-write-gate-parity.md` and `spec-dw-491-493-494-workbench-raw-path-gate-parity.md`. Do not change `rawPathSlug`'s return value for any path — the existing `workbench-tree.test.ts` table rows must all keep passing verbatim. Do not add a 401 to `/api/assets/`: it stays no-auth, and an anonymous request for an admitted slug still gets the bytes. Do not change the asset storage key shape or move the page-slug segment. Do not add gating to doors that already have it (`/api/workbench/*`, `/api/v1/*`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Hidden page slugged `queries`, sharded source | `rawPathAllowed("raw/sources/queries/ab12.md", {"queries"})` | `false` — DW-492 | No error expected |
| Hidden page slugged `queries`, mirrored asset | `rawPathAllowed("raw/assets/queries/pic.png", {"queries"})` | `false` | No error expected |
| Hidden `queries/<leaf>` page | `rawPathAllowed("raw/sources/queries/leaf.md", {"queries/leaf"})` | `false` — unchanged | No error expected |
| Readable sibling under the same head | `rawPathAllowed("raw/sources/queries/ab12.md", {"queries/leaf"})` | `true` — neither candidate is hidden | No error expected |
| Ordinary slug, no `queries` head | `rawPathAllowed("raw/sources/alpha/ab12.md", {"alpha-2"})` | `true` — unchanged | No error expected |
| Agent-scoped page's asset, unauthenticated | `GET /api/assets/agentpage/pic.png`; index names `agentpage` with `type: agent-knowledge` | 404, empty body; storage never read | Same 404 as absent — no oracle |
| Ordinary public page's asset, no session | `GET /api/assets/alice/img.png`; `alice` is in the knowledge tree | 200 + bytes, `immutable` cache header as today | No error expected |
| Private page's asset, owner authenticated | `GET /api/assets/alice/secret.png`, `visibility: private`, owner principal | 200 — visibility check unchanged | No error expected |
| Orphan asset (slug names no index entry) | `GET /api/assets/orphan/x.png` | 200 — the refusal set is entries-derived, so an orphan is not hidden | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-files.ts:298-305` -- `rawPathAllowed`, the one predicate. Today: `hiddenSlugs.size === 0` short-circuit, then `rawPathSlug`, then a single `hiddenSlugs.has(slug)`. This is the whole DW-492 change surface.
- `src/lib/workbench-files.ts:262-283` -- `rawPathSlug`. Line 272 (`if (first === "queries" && rest.length > 1)`) is the branch that swallows the shard id; it is the only `"queries"` literal in the module. UNCHANGED by this work — the docblock paragraph at :215-217 explaining the join should gain a sentence pointing at the predicate that now covers the ambiguity.
- `src/lib/workbench-files.ts:590-591, 693, 763, 1037` -- the four call sites (listing leaf/dir filter, rescan listing, `resolveWorkbenchFile`), all routing through `rawPathAllowed`, so one edit covers every door.
- `src/lib/wiki.ts:186-215` -- `QUERIES_SLUG_PREFIX = "queries/"` and `validateSlug`: the read-only evidence that plain `queries` and `queries/<leaf>` are BOTH admissible slugs, which is what makes the path ambiguous.
- `src/app/api/assets/[...path]/route.ts:53-95` -- the route. Its docblock (`:17-20`) still claims "Public-page assets skip principal resolution entirely for performance" — that sentence is what DW-536 falsifies and must be rewritten. `:69` `const slug = segments[0]`; `:70-79` the visibility check (KEEP); `:82` `rawRelPath(\`assets/${segments.join("/")}\`)`, the storage key — the gate must use the display spelling instead.
- `src/app/api/workbench/media/route.ts:82-89` -- the template for the derivation: entries hoisted, `workbenchSlugGate(entries, buildKnowledgeTree(entries))`, gate passed down. Copy the shape, not the 401.
- `src/lib/v1-route.ts:82-99` -- `v1SlugGate`, the same derivation for `/api/v1`; it takes a NON-null `Principal`, so the assets route (whose principal may be `null`) inlines the two lines rather than reusing it.
- `src/lib/wiki.ts:1016-1022` -- `listReadableWikiPages(principal: Principal | null)` — accepts `null`, filtering by `canReadEntry`, which is why an anonymous request can derive a gate at all.
- `src/lib/workbench-tree.ts:653-661, 888-897` -- `buildKnowledgeTree` drops `isAgentScopedType(entry.type)` pages; `workbenchSlugGate` turns "named by the index, dropped by the tree" into `hiddenSlugs`. Read-only evidence that an agent-scoped PUBLIC page lands in the refusal set.
- `src/lib/raw.ts:43-69` -- `RAW_ASSETS_DIR` docblock; it states explicitly that the `/api/assets` route spells `assets/` as the MARKDOWN-FACING namespace rather than importing the constant, so the route keeps its literal.
- `src/lib/__tests__/workbench-tree.test.ts:497-550` -- the `rawPathSlug` table and the DW-491 assets case. The comment at :528-531 declares DW-492 OPEN and "NOT coverage of it"; it is now stale. `hiding()` (~:602) and `writeSilo()` (~:615) are the door-level fixtures; the DW-32 door cases sit ~:1260-1300.
- `src/lib/__tests__/assets-route.test.ts:1-46` -- the route suite. It mocks `@/lib/wiki`, `@/lib/auth`, `@/lib/authz` and `@/lib/storage`; the `@/lib/wiki` mock must gain `listReadableWikiPages`. `:108-122` "serves a public-page asset without resolving the principal" asserts `getPrincipal` is NOT called — the one existing assertion this change invalidates.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-files.ts` -- in `rawPathAllowed`, refuse when EITHER candidate is hidden: the slug `rawPathSlug` returns, and — when that slug carries the `queries/` head — the bare `queries` a plain-slugged page would spell. Give it the docblock paragraph naming DW-492, the ambiguity (`raw/sources/queries/<sha>.md` is either page `queries`' shard or page `queries/<sha>`' flat source) and the deliberate fail-closed direction. Introduce one module-local constant for the `"queries"` head so the predicate and `rawPathSlug` cannot drift to two spellings.
- `src/app/api/assets/[...path]/route.ts` -- resolve the principal once, keep the `visibility: private` check as-is, then derive `workbenchSlugGate(entries, buildKnowledgeTree(entries))` from `listReadableWikiPages(principal)` and 404 before touching storage when `rawPathAllowed("raw/assets/" + segments.join("/"), hiddenSlugs)` is false. Rewrite the route docblock: the gate now equals the Workbench doors' gate, the route is still no-auth, and principal resolution is no longer skipped — with the reason (an agent-scoped page needs no `visibility: private` to be hidden).
- `src/lib/__tests__/workbench-tree.test.ts` -- add the five `rawPathAllowed` rows from the matrix (both `queries` shapes refused, the readable sibling and the ordinary slug admitted) plus one door-level case: a hidden page slugged `queries` with a sharded source in the silo is absent from `listWorkbenchFilePaths` and reads back `null`. Replace the stale "DW-492 (OPEN — this row is NOT coverage of it)" comment with what the row now means.
- `src/lib/__tests__/assets-route.test.ts` -- add `listReadableWikiPages` to the `@/lib/wiki` mock (real `workbench-tree`, so the derivation itself is exercised) and add the DW-536 cases: an agent-scoped page's asset 404s unauthenticated and never reaches `readAsset`; an ordinary public page's asset still 200s with no session. Rewrite the "without resolving the principal" case to pin what is actually true now — the public-page asset still serves with no session, and the principal is resolved to derive the gate.

**Acceptance Criteria:**
- Given the `queries` second-candidate test is deleted from `rawPathAllowed`, when the suite runs, then exactly the new DW-492 rows and the new door case fail and nothing else does.
- Given the `rawPathAllowed` call is deleted from `/api/assets/[...path]`, when the suite runs, then the agent-scoped refusal case fails.
- Given an ordinary public page with no session, when its asset is requested, then the bytes are served with the same status, `Content-Type` and cache headers as before this change.
- Given the whole change, when `pnpm exec tsc --noEmit` and `pnpm lint` run, then both exit clean.

## Spec Change Log

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 1: (high 0, medium 1, low 0)
- reject: 12: (high 0, medium 2, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The gate derivation (`listReadableWikiPages` / `buildKnowledgeTree` / `workbenchSlugGate`) sat outside any try/catch, so a page-index read failure escaped `/api/assets/[...path]` as an unlogged framework 500 — contradicting the route's own contract (ENOENT 404, real failure logged 500). Wrapped it: logged, answered 500, and documented as fail-CLOSED so a underivable gate can never fall through to the bytes.
  - `[low]` `[patch]` `workbenchSlugGate`'s docblock still said "Seven doors build this gate (SSR first paint, three `/api/workbench/*`, three `/api/v1`)". Corrected to eight, naming `/api/assets/[...path]` as the one that is neither.
  - `[low]` `[patch]` The new route docblock claimed it reads "the very same bytes" the Workbench doors read. It reads the shared flat `raw/assets/…` keys; those doors resolve the per-tenant copy `syncSiloForPage` mirrors. Rewritten to say two roots, one content.
  - `[low]` `[patch]` `QUERIES_SLUG_HEAD`'s docblock claimed two places in the module must agree on the string, but the predicate keyed on `slug.indexOf("/")` and never used it. `rawPathAllowed` now tests `startsWith(\`${QUERIES_SLUG_HEAD}/\`)` and `has(QUERIES_SLUG_HEAD)` — the rule keyed on the head, as the intent words it, rather than on "the first slash". Behavior identical.
  - `[low]` `[patch]` No test pinned the chosen reading for an AUTHENTICATED principal: the gate matches the Workbench doors for everyone, so an agent-scoped page's asset is refused to its own owner too. Added that case.
  - `[low]` `[patch]` Nothing pinned that the shared, non-page `assets/illustrations/<key>.jpg` prefix — the URL `illustration.ts` bakes into saved answers and slides — still serves while `hiddenSlugs` is non-empty, nor the cross-item case `GET /api/assets/queries/pic.png` refused when a page slugged plain `queries` is hidden. Added both.

## Design Notes

The predicate, in full:

```ts
if (hiddenSlugs.size === 0) return true;
const slug = rawPathSlug(displayPath);
if (slug === null) return true;
if (hiddenSlugs.has(slug)) return false;
// `queries/<leaf>` is the ONE two-segment slug shape, so a `queries/…` answer
// is ambiguous: the same path is also how a page slugged plain `queries`
// spells its sharded source. Refuse if EITHER page is hidden (DW-492).
const sep = slug.indexOf("/");
return sep < 0 || !hiddenSlugs.has(slug.slice(0, sep));
```

Deliberately shape-blind rather than depth-sensitive: `raw/sources/queries/leaf/ab12.md` can only belong to `queries/leaf`, so testing `queries` there over-refuses when a *different*, hidden page is slugged `queries`. That is the fail-closed direction the module already takes for `raw/parsed/…`, and it costs one rule instead of a depth comparison — the exact kind of subtlety that produced DW-492.

The assets route keeps BOTH gates because they cover disjoint holes: `hiddenSlugs` is derived from entries the principal can read, so a private page an anonymous caller cannot read is absent from that set entirely, and only `canReadFrontmatter` refuses it; conversely an agent-scoped page is readable-but-dropped, so only `hiddenSlugs` refuses it. Dropping either would reopen one of the two.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/assets-route.test.ts src/lib/__tests__/epic8-remediation.test.ts src/lib/__tests__/workbench-files-unresolved-tenant.test.ts` -- expected: all pass.
- `pnpm exec vitest run` -- expected: no NEW failures (the `|dom|` `window.localStorage.clear()` failures are pre-existing; confirm against the baseline commit if any appear).
- `pnpm exec tsc --noEmit` -- expected: exit 0.
- `pnpm lint` -- expected: exit 0.
- Mutation checks, restored afterwards: delete the second-candidate test in `rawPathAllowed` (expect exactly the new DW-492 rows + door case to fail); delete the `rawPathAllowed` call in the assets route (expect exactly the agent-scoped refusal case to fail).

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Closed both holes in the raw-path gate's reach. `rawPathAllowed` now tests TWO candidates
instead of one: because `validateSlug` admits plain `queries` as an ordinary slug as well as
the `queries/<leaf>` prefix shape, `raw/sources/queries/<sha>.md` is either page
`queries/<sha>`'s flat source or page `queries`' sharded one, and testing only the joined
answer `rawPathSlug` returns asked about a page nobody hid — so a hidden page slugged
`queries` had its source filenames listed and its bytes served (DW-492). `rawPathSlug` is
unchanged; the second candidate lives in the predicate, which is what makes the refusal reach
leaf, directory row and bytes together. And `/api/assets/[...path]` now derives the same
`hiddenSlugs`/`rawPathAllowed` gate the Workbench doors derive — `listReadableWikiPages` →
`buildKnowledgeTree` → `workbenchSlugGate`, for the request's principal — so an agent-scoped
page's asset is refused where the Files tab already withheld it (DW-536). The route stays
no-auth: an ordinary public page's asset still serves with no session. It keeps its existing
`visibility: private` check too, because the two gates cover disjoint holes — `hiddenSlugs` is
derived from entries the principal can READ, so a private page an anonymous caller cannot read
is absent from that set entirely.

### Files changed

- `src/lib/workbench-files.ts` -- `rawPathAllowed` tests both candidates when the derived slug carries the `queries/` head; new `QUERIES_SLUG_HEAD` constant, the module's one spelling of that head; docblocks on the predicate and on `rawPathSlug` record the ambiguity and the deliberate fail-closed direction.
- `src/app/api/assets/[...path]/route.ts` -- second gate added (derived per-principal, applied to the display path, failing closed with a logged 500 when the derivation throws); docblock rewritten to state both gates, why neither subsumes the other, and that the route is still no-auth.
- `src/lib/workbench-tree.ts` -- `workbenchSlugGate` docblock: eight doors now build this gate, the eighth being neither a workbench nor a v1 route.
- `src/lib/__tests__/workbench-tree.test.ts` -- a `rawPathAllowed` unit block (both `queries` raw shapes refused, `queries/<leaf>` still refused, a sibling admitted, an ordinary slug untouched) plus a door-level case; the stale "DW-492 (OPEN)" comment replaced.
- `src/lib/__tests__/assets-route.test.ts` -- `listReadableWikiPages` added to the `@/lib/wiki` mock while `workbench-tree`/`workbench-files` run for real; agent-scoped refusal unauthenticated AND to its own owner; ordinary public page still served with no session; orphan slug served; shared `illustrations/` prefix still served; the cross-item `queries` case at the door.

### Review findings

- Patches applied: 6 (medium 1, low 5) — see the Review Triage Log for each.
- Deferred: 1 (medium) — `/api/raw/[slug]` serves a hidden page's raw source text unauthenticated, the sources-half twin of DW-536.
- Rejected: 12 (medium 2, low 10) — the images of an agent-scoped page now 404 for its owner too (that IS the recorded 2026-08-29 decision: the same gate the Workbench doors use; now pinned by a test and recorded as a residual risk below); gate 1's `const slug = segments[0]` mis-addresses the two-segment `queries/<leaf>` shape (pre-existing, and the deferred slot went to the larger hole); the publicly-cacheable `immutable` 200 with no `Vary` (pre-existing — the principal-dependent 200 predates this change); the per-request page-index read (explicitly authorised by the decision; recorded as a residual risk); `listWikiPages` swallowing a non-ENOENT index failure into `[]` (pre-existing and shared with every sibling door — changing it is a cross-cutting decision); an uppercase-slug bypass on a case-insensitive filesystem (`validateSlug` admits no uppercase, and production keys are case-sensitive); the single-segment `/api/assets/<file>.ext` deriving `assets` (exotic, and fail-closed); an empty/trailing-segment guard (`isUnsafeSegment` already refuses empty segments); the ledger reason's "artifacts included" example (`buildKnowledgeTree` drops only agent-scoped types — the diff implements the true behavior, and the ledger is not this session's to edit); missing `readWorkbenchFileBytes`/`listRawSourceFilePaths` door cases (all route through the one predicate, which is unit-pinned plus one door case — the coverage shape DW-491 established); the door case using the file's `writeSilo` fixture rather than `saveRawSourceFor` (the adjacent DW-32/DW-491 cases do the same); and `deferred-work.md` still listing both entries open (orchestrator-owned).

### Follow-up review recommendation

`false`. Patched counts: high 0, medium 1, low 5. The rule counts only high-severity patches; none was high.

### Verification performed

- `pnpm exec vitest run` on `workbench-tree`, `assets-route`, `epic8-remediation`, `workbench-files-unresolved-tenant`: 191 passed, 0 failed.
- Full suite `pnpm exec vitest run`: 372 files, 9253 passed, 1 skipped, 0 failed. (The `|dom|` `localStorage` failures earlier runs saw did not appear.)
- `pnpm exec tsc --noEmit`: exit 0. `pnpm lint`: exit 0.
- Mutation checks, run rather than assumed, both restored and re-verified green:
  - Deleting the second-candidate test in `rawPathAllowed` fails exactly three cases — the `rawPathAllowed` DW-492 row, the `listWorkbenchFilePaths` door case, and the route's cross-item `queries` case. Nothing else.
  - Deleting the `rawPathAllowed` call in `/api/assets/[...path]` fails exactly three — the agent-scoped refusal unauthenticated, the same refusal to its owner, and the cross-item `queries` case.
- I/O matrix audit: all nine rows are covered by assertions that ran and passed — five `rawPathAllowed` rows in `workbench-tree.test.ts`, and the agent-scoped, public-page, private-page-owner and orphan rows in `assets-route.test.ts`.

### Residual risks

- **An agent-scoped page's embedded images now 404 for every viewer, its owner included.** That is the recorded decision applied faithfully — the same gate the Workbench doors use, which drops `agent-*` types for every principal — but those pages stay reachable at `/u/[handle]/[slug]`, which gates only on `canReadFrontmatter`. So a public `agent-knowledge` page (email/agent ingest produces them, and `ingestImage` bakes `![](assets/<slug>/<file>)` into the body) renders with broken images. Whether the page-view surface should stop rendering such pages, or the asset door should exempt a principal who may read the page, is a product question this change does not settle; a test now pins the current answer so it cannot drift silently.
- Every asset GET now resolves the principal and reads the page index (`listReadableWikiPages` plus a full knowledge-tree build) before the storage read, on an unauthenticated route with no memoisation. The decision authorised the gate; the cost is real on a page with many images, and worse when the metadata index is unseeded and `listWikiPages` falls back to a full scan.
- The predicate's second candidate is deliberately shape-blind, so `raw/…/queries/<leaf>/<file>` — which only page `queries/<leaf>` can own — is also refused when a DIFFERENT page slugged plain `queries` is hidden. Fail-closed, and now visible at a public rendering door rather than only in the Files tree.
- Gate 1 still reads `segments[0]` as the page slug, so for the two-segment `queries/<leaf>` shape it checks the visibility of the unrelated page `queries`. Pre-existing, untouched, and the one shape where the two ledger items intersect.
