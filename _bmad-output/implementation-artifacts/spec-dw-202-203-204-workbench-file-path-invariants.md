---
title: 'DW-202/203/204: one canonical Files row per wiki slug, one spelling of "direct child of the wiki root"'
type: 'bugfix'
created: '2026-08-27'
baseline_revision: '6a5c1d03f0cba429062af3cdf73c031f85592525'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A `wiki/` display path asked for directly still previews one object and saves
      another: the read gate and the preview route's slug derivation were left at
      their old reach, so only the LISTING door was closed.
    evidence: |-
      DW-202/203 was fixed at the listing on the authority of the recorded
      2026-08-19 decision ("list only the canonical `<slug>.md` row and drop the
      variant-cased sibling from the Files tab"), and the ledger itself records the
      defect as "pre-existing at the read and edit layers". So the harm is narrowed
      but not closed: `readWorkbenchFile`/`workbenchFileExists` still serve
      `wiki/cased.MD`, and `src/app/api/workbench/preview/route.ts` still hands it
      slug `cased` with `editable: true`. A deep link, a restored selection from
      `workbench-state`, or any API caller that names the display path directly
      reproduces the original defect — preview `cased.MD`, save `cased.md`.
      Deliberately not closed here: the route's page/file disambiguation is what
      DW-41's intent put out of bounds, and reverting the slug for an odd-cased name
      would re-break the case-INSENSITIVE store, where that name IS the Page and a
      case-sensitive test there once made it read-only from the Files tab. Closing
      it properly needs a rule that can tell the two stores apart at the edit
      surface, which is a decision, not a patch.
    location: >-
      src/app/api/workbench/preview/route.ts (slug derivation);
      src/lib/workbench-files.ts (resolveWorkbenchFile)
    severity: medium
  - summary: >-
      The row that CREATES a collision is still editable: a lone `wiki/cased.MD` on
      a case-sensitive store lists, is handed slug `cased`, and the first save from
      it writes `wiki/cased.md` — orphaning the previewed bytes and making the row
      vanish from the next listing.
    evidence: |-
      The elected-winner rule keys on the candidate names present AT LISTING TIME,
      which is what lets a lone variant keep listing (it must: on a
      case-INSENSITIVE store that name is the only real Page). But the wiki write
      path targets `<slug>.md` unconditionally
      (`writeWikiPage`/`writeWikiPageIfContentMatches`, `src/lib/wiki.ts`), so on a
      case-sensitive store the first save from that row creates a SECOND object.
      From then on the collision exists, the election correctly drops the `.MD`
      row, and its bytes are orphaned with no surface that mentions them. So the
      decision's mechanism ("drop the sibling") is implemented while its stated
      purpose ("every visible row reads and writes the same object") holds only
      after a collision already exists — never for the row that creates one. Same
      root cause as the entry above: the fix has to reach the save half, which the
      recorded decision scoped out.
    location: >-
      src/lib/wiki.ts (writeWikiPage / writeWikiPageIfContentMatches);
      src/app/api/workbench/preview/route.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Two invariants of the Workbench `wiki/` root are each spelled more than once. (a) `wikiLeafSlug` (`src/lib/workbench-files.ts:540-547`) is case-insensitive on the extension, so on a case-SENSITIVE store `wiki/cased.md` and `wiki/cased.MD` are two different objects that both list as rows for the single slug `cased`; the preview route hands both the same slug, so an edit reached from either row writes `wiki/cased.md` and the bytes previewed from the `.MD` row go stale (DW-202 and DW-203 are the same defect recorded twice). (b) "a direct child of the wiki root" is spelled three independent ways — `depth === 1` (`workbench-files.ts:269`), `rest.length !== 1` (`:646`), and `segments.length === 2 && segments[0] === "wiki"` (`src/app/api/workbench/preview/route.ts:224`) — held together only by one test and three doc comments (DW-204).

**Approach:** Apply DW-202's recorded 2026-08-19 decision at the LISTING: when two `wiki/` leaves collide on one `wikiLeafSlug`, list only the canonical `<slug>.md` row and drop the variant-cased sibling, so every visible row reads and writes the same object. Extract one exported predicate for "a direct child of the `wiki/` display root" and route all three sites through it, changing `LeafFilter` to take the display path the walk already computes.

## Boundaries & Constraints

**Always:**
- The collision rule is CONDITIONAL on a canonical sibling actually being present in the same listing. A lone `wiki/cased.MD` with no `wiki/cased.md` beside it still lists, because a case-INSENSITIVE store returns that name for the real Page and dropping it would hide a page the Knowledge tab edits (`workbench-tree.test.ts:840-851` pins this).
- The collision decision is made from the depth-1 entries `resolveRoot("wiki", …)` already returned. No `stat()`, no existence probe, no extra storage round trip — the names already decide it.
- The listing's admissible set stays a SUBSET of what `resolveWorkbenchFile` will serve, so "never lists a wiki path the read gate would refuse" (`workbench-tree.test.ts:926`) still holds.
- `readableWikiLeaf` / `wikiLeafSlug` stay the single definition of "may these bytes be read"; the listing keeps deriving from that predicate rather than restating it (DW-41).
- `wikiLeafFilter` stays a separate named function with its own doc comment stating the LISTING's reason (a filename is a disclosure).
- `raw/` behaviour is untouched: `allowEveryLeaf` still admits every visible leaf at every depth.
- Directories are still never leaf-filtered.

**Block If:**
- Making the three depth spellings share one predicate turns out to require merging `wikiLeafFilter` and `readableWikiLeaf` into one function — DW-41 froze that split on security grounds.

**Never:**
- Do not change the READ gate's reach: `readWorkbenchFile`/`workbenchFileExists` on `wiki/cased.MD` must still serve its bytes when its slug is readable. The fix is at the LISTING.
- Do not revoke the preview route's slug for an odd-cased name. `wiki/alpha.MD` carrying slug `alpha` is a deliberate DW-41-era fix (`preview/route.ts:216-221`): on a case-insensitive store that name IS the Page, and a case-sensitive test there once made it read-only from the Files tab.
- Do not touch `PREVIEW_FAILED_COPY`, the Knowledge tab, the per-root budget split, the depth cap, or the truncation reporting.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Case-sensitive collision | `wiki/cased.md` + `wiki/cased.MD` both on disk, slug `cased` readable | Files tab lists `wiki/cased.md` only; `wiki/cased.MD` absent | No error expected |
| Lone variant | only `wiki/cased.MD` on disk, slug `cased` readable | still listed once, still readable | No error expected |
| Variant, slug not readable | `wiki/cased.md` + `wiki/cased.MD`, slug `cased` NOT readable | neither lists | No error expected |
| Read reach unchanged | `wiki/cased.MD` on disk (collided or not), slug readable | `readWorkbenchFile` returns its bytes | No error expected |
| Depth still bound | `wiki/archive/mine.md`, slug `mine` readable | `wiki/archive/` lists, the leaf does not | No error expected |
| `raw/` unaffected | `raw/sources/a/b.txt` | still lists at its depth | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-files.ts:108` -- `type LeafFilter = (name: string, depth: number) => boolean`, with the depth-numbering doc comment at `:93-107`. Becomes display-path-shaped so the walk can route through the shared predicate.
- `src/lib/workbench-files.ts:194-243` -- `walkRoot`. Calls `allowLeaf` twice: the depth-cap probe at `:221` (`entries.some((e) => e.isDirectory || allowLeaf(e.name, node.depth))`) and the emit loop at `:227`. Both test CHILDREN of `node`, so both build `` `${node.display}/${entry.name}` ``. The emit loop already computes exactly that at `:230`.
- `src/lib/workbench-files.ts:245-269` -- `wikiLeafFilter(readableSlugs)`, currently `depth === 1 && readableWikiLeaf(name, readableSlugs)`. Gains the canonical-collision test and takes the root's depth-1 entries.
- `src/lib/workbench-files.ts:271-279` -- `allowEveryLeaf`, the `raw/` filter. Signature-only change.
- `src/lib/workbench-files.ts:378-384` -- the `wiki/` `walkRoot` call in `listWorkbenchFilePaths`. `resolveRoot("wiki", siloWiki, wikiRelPath(""))` is inlined into the call; hoist it to a local so its `entries` can seed the filter. (The `raw/` call at `:368-375` is the shape to mirror.)
- `src/lib/workbench-files.ts:514-551` -- the frozen READ-GATE doc comment, `wikiLeafSlug` (exported; lowercases before testing `.md`) and `readableWikiLeaf`. Read-only except for doc-comment updates.
- `src/lib/workbench-files.ts:600-660` -- `resolveWorkbenchFile`; the wiki branch at `:645-647` spells the depth rule as `rest.length !== 1`. Third site.
- `src/app/api/workbench/preview/route.ts:215-226` -- the editable-Page disambiguation, `segments.length === 2 && segments[0] === "wiki"`. Second site. `wikiLeafSlug` is already imported at `:16`.
- `src/lib/__tests__/workbench-tree.test.ts:840-864` -- the two existing odd-case listing tests. `:840-851` (lone `cased.MD` lists and reads) MUST stay green — it is the reason the collision rule is conditional.
- `src/lib/__tests__/workbench-tree.test.ts:926-951` -- the "never lists a wiki path the read gate would refuse" invariant test. Its fixture seeds `cased.MD` with NO `cased.md`, and asserts `["wiki/cased.MD", "wiki/mine.md"]`; that stays correct (no collision), so do not weaken it.
- `src/lib/__tests__/workbench-preview.test.ts:1305-1325, 1940-1955` -- read-gate and preview-route `.MD` coverage. Read-only evidence that the read half and the slug half must not change.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-files.ts` -- Add an exported `wikiLeafName(displayPath: string): string | null` returning the leaf name when `displayPath` is exactly `wiki/<name>` and `null` otherwise, with a doc comment naming it the one spelling of "a direct child of the wiki root" and listing its three callers. -- DW-204: one predicate instead of three restatements.
- `src/lib/workbench-files.ts` -- Change `LeafFilter` to `(displayPath: string) => boolean`, update its doc comment (the depth-numbering prose is replaced by the predicate), update `allowEveryLeaf`, and make both `walkRoot` call sites pass `` `${node.display}/${entry.name}` ``. -- Gives the walk the shape the shared predicate needs.
- `src/lib/workbench-files.ts` -- Make `wikiLeafFilter(readableSlugs, rootEntries)` ELECT exactly one listable name per slug from `rootEntries` — the literal `<slug>.md` when the root holds one, otherwise the lexicographically first name carrying that slug — and precompute those winners into a `Set`. The returned filter tests `wikiLeafName(...)` then `readableWikiLeaf` then membership in that set; `readableWikiLeaf` keeps its current name and signature, and the set is built from `wikiLeafSlug(entry.name)` rather than from a second expression of the gate (so no non-null assertion is needed). Hoist the `wiki/` `resolveRoot` call in `listWorkbenchFilePaths` into a local and pass its `entries`. -- DW-202/203: one listable row per slug, decided from a listing already in hand.
- `src/lib/workbench-files.ts` -- Route `resolveWorkbenchFile`'s wiki branch through `wikiLeafName(displayPath)` instead of `rest.length !== 1`, and refresh the three doc comments (`wikiLeafFilter`, the READ-GATE block, `resolveWorkbenchFile`) so they cite the predicate and the canonical-row rule rather than the old prose warnings. -- Third site; the doc comments were the only thing binding the rule.
- `src/app/api/workbench/preview/route.ts` -- Derive the editable-Page slug via `wikiLeafName(displayPath)` + `wikiLeafSlug(...)`. -- Second site; behaviour identical, spelling shared.
- `src/lib/__tests__/workbench-tree.test.ts` -- Add tests covering the I/O matrix: the collision case (both names seeded, only `wiki/cased.md` lists, its name equals `` `${wikiLeafSlug(name)}.md` ``, and it serves the CANONICAL object's bytes), the two-variant case with NO canonical `<slug>.md` (`cased.MD` + `cased.Md`, exactly one lists), the collision case with an unreadable slug, and an assertion that the defeated sibling is still readable through `readWorkbenchFile` while unlisted. Also add a `maxDepth: 1` case pinning the depth-cap PROBE's display-path argument: a readable `.md` leaf hidden by the cap must report `truncated: true` (fixture must hold no `wiki/` directory and an empty `raw/`, both of which set the flag by other routes). Keep the existing `:840-864` tests unmodified. -- The decision explicitly asks for a test seeding both names; the probe is the one `allowLeaf` call site no listing assertion reaches.
- `src/lib/__tests__/workbench-preview.test.ts` -- Add a direct test of exported `wikiLeafName` (accepts `wiki/a.md`, rejects `wiki/`, `wiki/d/a.md`, `raw/a.md`, `purpose.md`). -- The shared predicate is now load-bearing for three call sites and deserves its own binding.

**Acceptance Criteria:**
- Given a case-sensitive store holding both `wiki/cased.md` and `wiki/cased.MD` with slug `cased` readable, when the Files tab listing is built, then exactly one `wiki/cased*` row is emitted and it is `wiki/cased.md`.
- Given a case-sensitive store holding `wiki/cased.MD` and `wiki/cased.Md` and NO `wiki/cased.md`, when the listing is built, then exactly one `wiki/cased*` row is emitted (the lexicographically first name), and which one it is does not depend on the order storage returned the entries in.
- Given that same state, when the emitted row is previewed and then saved, then the bytes read and the object written are the same key, because the listed name is the canonical one.
- Given only `wiki/cased.MD` on disk with slug `cased` readable, when the listing is built, then `wiki/cased.MD` is still listed exactly once and still reads.
- Given the depth rule is now one exported predicate, when `wikiLeafName` is changed, then all three of the listing filter, `resolveWorkbenchFile`, and the preview route's slug derivation change with it — no site restates the rule.
- Given the full listing suite, when `pnpm vitest run` executes it, then the pre-existing DW-41 invariant test still passes unmodified.

## Spec Change Log

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 1, low 7)
- defer: 2: (high 0, medium 2, low 0)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` `wikiLeafFilter`'s literal-sibling test only fired when a real `<slug>.md` was on disk, so `cased.MD` + `cased.Md` with no canonical both listed under the one slug `cased` — the DW-202/203 defect in a worse form (a save from either writes a third object). Replaced with a total election over `rootEntries`: canonical wins if present, else lexicographically first. `readableWikiLeaf` kept its name, signature and role as the sole read-gate boolean (DW-41); the winner set is built from `wikiLeafSlug(entry.name)`, which also removed the `wikiLeafSlug(name)!` non-null assertion. Doc comment now states that correctness is scoped to the seeding listing and that unknown names fail closed. Mutation-verified: reverting to the literal-sibling rule fails the new two-variant test.
  - `[low]` `[patch]` Doc drift: the module header and `WorkbenchFileOptions.readableSlugs` still asserted listing == read-gate EQUALITY; both now say strict SUBSET. `allowEveryLeaf` no longer cites the `rest.length` spelling DW-204 retired.
  - `[low]` `[patch]` The `wikiLeafName` test header said "three call sites" while a later comment said "both callers"; the second now names each of the three and what it pairs with.
  - `[low]` `[patch]` `vi.restoreAllMocks()` ran after two awaited `fs.rm` calls, so a rejecting `rm` could leak the `listFiles` spy into later cases through the module-level singleton provider. Moved into a `finally`.
  - `[low]` `[patch]` The depth-cap probe's new display-path argument had no discriminating test — mutating it back to the bare name left all 283 tests green. Added a `maxDepth: 1` case (empty `raw/`, no `wiki/` subdirectory) asserting `truncated: true` for a readable `.md` leaf hidden by the cap. Mutation-verified.
  - `[low]` `[patch]` Folded into the election above: the `wikiLeafSlug(name)!` non-null assertion and the comment defending it are gone.
  - `[low]` `[patch]` The collision fixture's distinguishable bytes were never read, so "still READS the shadowed sibling" could not tell a right object from a wrong one. The helper now reads back what the canonical object holds and the test asserts the listed row serves those bytes, plus that the row's name equals `` `${wikiLeafSlug(name)}.md` `` — the spec's second acceptance criterion, previously untested.
  - `[low]` `[patch]` `wikiLeafName`'s unit test gained `"Wiki/a.md"`, `"wiki//a.md"` and `"raw"`, the inputs a `startsWith`/`toLowerCase` rewrite would silently break.

## Design Notes

The rule must be an ELECTION over the slug's candidate names, not a test against one privileged name, and that is the thing easy to get wrong here — twice over, in opposite directions.

Too strict, and it hides a real page. A store's case sensitivity is not knowable from a name: on a case-INSENSITIVE store `cased.MD` IS the Page (the listing returns whatever casing was written), so an unconditional "only exactly `<slug>.md` may list" would hide something the Knowledge tab edits. A lone variant must therefore still list.

Too loose, and it does not fix the defect. A first draft dropped a variant only when a literal `<slug>.md` sat beside it — which leaves `cased.MD` + `cased.Md` with no canonical at all BOTH listing under the one slug `cased`, the same defect in a worse form: a save from either row conjures a third object. Electing a winner covers both shapes at once, because every candidate for a slug is weighed against every other rather than against a name that may not exist.

The tiebreak must be a TOTAL order on the names (lexicographic), not "whichever came first", so the winner does not depend on the order storage happened to return and the tab cannot reorder itself between renders.

```ts
/** Is `displayPath` a direct child of the `wiki/` display root? Its leaf name, or null. */
export function wikiLeafName(displayPath: string): string | null {
  const segments = displayPath.split("/");
  if (segments.length !== 2 || segments[0] !== "wiki") return null;
  return segments[1].length > 0 ? segments[1] : null;
}

function wikiLeafFilter(readableSlugs: ReadonlySet<string>, rootEntries: readonly Listing[]): LeafFilter {
  const winners = new Map<string, string>();
  for (const entry of rootEntries) {
    if (entry.isDirectory) continue;
    const slug = wikiLeafSlug(entry.name);
    if (slug === null) continue;
    const canonical = `${slug}.md`;
    const standing = winners.get(slug);
    if (standing === canonical) continue;
    if (entry.name === canonical || standing === undefined || entry.name < standing) {
      winners.set(slug, entry.name);
    }
  }
  const listable = new Set(winners.values());
  return (displayPath) => {
    const name = wikiLeafName(displayPath);
    return name !== null && readableWikiLeaf(name, readableSlugs) && listable.has(name);
  };
}
```

The filter's correctness is scoped to the listing it was built from: it can only recognise a winner it saw in `rootEntries`, which are exactly the depth-1 entries `walkRoot` is seeded with. Any other name is absent from the set and so FAILS CLOSED — the safe direction for a filter whose job is to withhold filenames.

Dropping a defeated name is a GATE decision, not a truncation: `walkRoot`'s `continue` leaves `budget.truncated` alone, which is what `workbench-tree.test.ts:938-944` already pins.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-preview.test.ts` -- expected: all pass, including the unmodified DW-41 tests
- `pnpm lint` -- expected: no new errors
- `npx tsc --noEmit` -- expected: no new type errors

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** DW-202/203/204 resolved together. The Workbench `wiki/` root now has ONE spelling of "a direct child of the wiki root" and elects ONE listable row per slug.

- **DW-204.** New exported `wikiLeafName(displayPath): string | null` in `src/lib/workbench-files.ts` replaces all three independent restatements — `depth === 1` in `wikiLeafFilter`, `rest.length !== 1` in `resolveWorkbenchFile`, and `segments.length === 2 && segments[0] === "wiki"` in the preview route. `LeafFilter` changed from `(name, depth) => boolean` to `(displayPath) => boolean` so the walk can share the predicate; both `walkRoot` call sites (emit loop and depth-cap probe) pass the display path they already build. Behaviour-preserving at each site.
- **DW-202/203.** `wikiLeafFilter` elects one name per slug from the depth-1 entries `resolveRoot` already returned: the literal `<slug>.md` when the root holds one, otherwise the lexicographically first name carrying that slug. No `stat()`, no extra round trip. The election is total rather than conditional, so `cased.MD` + `cased.Md` with no canonical also collapses to one row. A lone variant still lists — a store's case sensitivity is not knowable from a name, and on a case-INSENSITIVE store that name IS the Page.
- The read gate's reach is deliberately unchanged: `wiki/cased.MD` asked for directly still serves its bytes. The listing's admissible set is now a strict SUBSET of the gate's, which preserves the DW-41 invariant.

**Files changed**
- `src/lib/workbench-files.ts` -- added `wikiLeafName`; reshaped `LeafFilter`; election rule in `wikiLeafFilter`; `resolveWorkbenchFile` routed through the predicate; `listWorkbenchFilePaths` hoists the `wiki/` `resolveRoot` so the filter is seeded with the same entries the walk uses; doc comments across the module updated from equality to subset.
- `src/app/api/workbench/preview/route.ts` -- editable-Page slug derived via `wikiLeafName` + `wikiLeafSlug`; no behaviour change.
- `src/lib/__tests__/workbench-tree.test.ts` -- collision fixture (`seedCasedCollision` / `alsoListInWikiRoot`) plus cases for the canonical-row election, the two-variant/no-canonical shape, the still-readable shadowed sibling, an unreadable-slug collision, and the depth-cap truncation probe; `afterEach` restores mocks in a `finally`.
- `src/lib/__tests__/workbench-preview.test.ts` -- direct unit binding for `wikiLeafName`, including the case-variant root, doubled separator and bare-root inputs.

**Review findings breakdown.** 4 review layers (blind-hunter, edge-case-hunter, verification-gap, intent-alignment). intent_gap 0, bad_spec 0, patch 8 (1 medium, 7 low, all applied in one iteration), defer 2 (both medium, recorded in frontmatter `deferred`), reject 8 (all low — silo-vs-flat fixture duplication, a branded `LeafFilter` type, a shared display-root constant, the `raw/` collision non-path, `listRawSourceFilePaths`' pre-existing duplicate BFS, a directory literally named `<slug>.md`, `split()` allocation on the listing path, and `selectionRefreshAction` reporting a deliberately dropped row as removed).

**Follow-up review recommendation:** true. Patched findings by severity: high 0, medium 1, low 7. Score = 3x1 + 1x7 = 10, which is >= 5.

**Verification performed**
- `npx tsc --noEmit` -- clean (exit 0).
- `pnpm lint` -- clean; only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, in unrelated files.
- `pnpm vitest run src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-preview.test.ts` -- 285 passed.
- `pnpm vitest run` (full suite) -- 328 files, 7534 passed, 1 skipped, 0 failed.
- Mutation checks: reverting the election to the literal-sibling rule fails the new two-variant test; passing the bare name to the depth-cap probe fails the new truncation test. Both restored.
- Matrix audit: every I/O matrix row is covered by a test that ran and passed.

**Residual risks**
- The dev host's volume is case-insensitive, so the collision fixtures write both names for real and add the sibling to the listing through a `storage.listFiles` spy only when the disk did not already report it — a no-op on a case-sensitive host. The byte-level "right object" assertion is therefore only fully discriminating on case-sensitive CI.
- Two medium deferrals carry the unclosed half of the defect: the read gate and the preview route still hand `wiki/cased.MD` slug `cased`, so a deep link or restored selection still previews one object and saves another; and the row that CREATES a collision (a lone variant on a case-sensitive store) is still editable, so its first save orphans the previewed bytes. Both were scoped out by the recorded 2026-08-19 decision, which is a listing decision, and closing them needs a rule that can tell the two store semantics apart at the edit surface.
