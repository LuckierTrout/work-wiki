---
title: 'DW-41: the Files tab lists only wiki/ leaves the read gate will serve'
type: 'bugfix'
created: '2026-08-17'
status: 'done'
baseline_revision: 'e397a68ee04c81db792263c4b57063630d76161c'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      On a case-sensitive store, `wiki/cased.md` and `wiki/cased.MD` both list as rows
      for the one slug `cased`, and an edit from either row writes `<slug>.md`.
    evidence: |-
      The listing is case-insensitive on the extension because it derives from
      `wikiLeafSlug` (`src/lib/workbench-files.ts`), which lowercases before testing
      `.md`. Both names therefore pass `readableWikiLeaf` for the same slug, and
      `resolveWorkbenchFile` builds a key from the name as written, so the two rows
      read two different objects. The preview route decides "is this the editable
      Page" from `wikiLeafSlug` alone (`src/app/api/workbench/preview/route.ts`), so
      a save reached from the `.MD` row lands on `wiki/cased.md` and the previewed
      bytes go stale. Wholly pre-existing, and NARROWED rather than introduced by
      DW-41: the old `wikiLeafFilter` opened with `if (!name.endsWith(".md")) return
      true`, and `cased.MD` does not end in `.md`, so it listed UNGATED next to
      `cased.md` before this change; deriving from the read gate now at least
      subjects it to the slug set. Deciding what the tab should do when both exist —
      hide one, mark the pair, or refuse the slug — is a Files-tab surface decision
      beyond DW-41's recorded intent.
    location: >-
      src/lib/workbench-files.ts (wikiLeafSlug / wikiLeafFilter); the save half is
      src/app/api/workbench/preview/route.ts (slug derivation) and the wiki write path
    severity: low
  - summary: >-
      "A direct child of the wiki root" is now spelled three independent times, and
      only a test binds them together.
    evidence: |-
      `wikiLeafFilter` says `depth === 1` (`src/lib/workbench-files.ts`),
      `resolveWorkbenchFile` says `rest.length !== 1` in a different numbering, and
      the preview route says `segments.length === 2 && segments[0] === "wiki"`. DW-41
      derived the NAME half from one predicate (`readableWikiLeaf`) precisely so it
      could not drift; the DEPTH half was left restated in each place, held together
      only by the new "never lists a wiki path the read gate would refuse" test and
      by prose warnings in three doc comments. Extracting a single shared predicate
      is not blocked by DW-41's Block If, which froze only the two FILTERS as
      distinct functions — but it touches the preview route's page/file
      disambiguation, which DW-41's intent puts out of bounds.
    location: >-
      src/lib/workbench-files.ts (wikiLeafFilter, resolveWorkbenchFile);
      src/app/api/workbench/preview/route.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** `wikiLeafFilter` (`src/lib/workbench-files.ts:210-218`) admits every leaf under the `wiki/` display root whose name does not end in `.md`, while the read gate `readableWikiLeaf` (`:357-360`) refuses exactly those leaves. So `wiki/notes.txt`, `wiki/dump.json` and the real `wiki/query-history/<key>.json` files render as clickable Files-tab rows that answer with `PREVIEW_FAILED_COPY` ("This file couldn't be loaded."), which reads as a broken Preview rather than as a gate.

**Approach:** Apply DW-41's recorded decision: keep the two filters as two functions with two distinct documented reasons, but derive the listing's admissible set for the `wiki/` root from the same predicate the read gate applies, so the listing can no longer emit a leaf the Preview will refuse. Update the frozen `readableWikiLeaf` doc comment (`:326-347`) so it records the new rule instead of the old divergence.

## Boundaries & Constraints

**Always:**
- `readableWikiLeaf` / `wikiLeafSlug` stay the single definition of "may these bytes be read"; the listing derives from that predicate rather than restating it.
- `wikiLeafFilter` remains a separate named function with its own doc comment stating the LISTING's reason (a filename is a disclosure) — the two reasons stay distinct even though the admissible set is now derived from one predicate.
- Under the `wiki/` display root the listing's admissible leaf set must equal what `resolveWorkbenchFile` will serve: a direct child of the root (`rest.length === 1` there) whose name passes `readableWikiLeaf`.
- `raw/` behaviour is untouched: every visible leaf at every depth still lists (`allowEveryLeaf`), and nested `raw/` subdirectories still list and still read.
- Directories are still never leaf-filtered — `workbench-tree.ts:194,208` makes a directory a disclosure, not a previewable row, so a directory cannot produce the refusal sentence.
- Dotfile filtering (`visible()`), the per-root budget split, the depth cap and the truncation reporting all keep their current behaviour.

**Block If:**
- Removing `wikiLeafFilter` or `readableWikiLeaf` as distinct functions would be required to make the listing derive from the read gate — the previous review pass froze the two-filters/two-reasons split on security grounds and DW-41's decision preserves it.

**Never:**
- Do not widen the read gate to admit non-`.md` leaves; the fix is at the LISTING.
- Do not partition the `wiki/` or `raw/` silo per Wiki (that is DW-17), and do not revisit DW-30's flat-lens decision.
- Do not add a `stat()`, an existence probe, or any extra storage round trip to decide listability — the name already decides it.
- Do not change the Knowledge tab, the preview route's page/file disambiguation, or `PREVIEW_FAILED_COPY`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Readable page | `wiki/mine.md` present, `mine` in `readableSlugs` | `wiki/mine.md` is listed and `readWorkbenchFile` returns its bytes | No error expected |
| Unreadable page | `wiki/theirs.md` present, `theirs` not in the set | Not listed; read still returns `null` | Refusal is the listing's absence, not a row |
| Non-markdown leaf | `wiki/notes.txt`, `wiki/dump.json` present | Neither is listed; read still returns `null` | The regression this spec fixes |
| Odd-cased extension | `wiki/cased.MD` present, `cased` in the set | Listed once, and readable — the listing is case-insensitive on the extension exactly as the gate is | No error expected |
| Generated index | `wiki/index.md` present, `index` not a page slug | Not listed (unchanged) | No error expected |
| Nested wiki leaf | `wiki/query-history/alice.json`, or a nested `.md` whose basename is a readable slug | The directory row still lists; no leaf below the root lists, because the read gate serves only a direct child of `wiki/` | No error expected |
| Nested raw leaf | `raw/topic/abc.md` | Still listed and still readable | No error expected |
| Depth cap over a wiki subtree | A `wiki/` subtree deeper than the cap holding only unlistable leaves | Truncation reporting keeps its current rule: a directory that would have been shown still counts, an all-filtered leaf set does not | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-files.ts:91` -- `type LeafFilter = (name: string) => boolean`. The wiki root's gate is depth-sensitive (`resolveWorkbenchFile` serves only a direct child), so the filter needs the leaf's depth to express the read gate exactly.
- `src/lib/workbench-files.ts:159-207` -- `walkRoot`. Two `allowLeaf(entry.name)` call sites: the depth-cap truncation probe (`:185`) and the emit test (`:191`). `node.depth` is in scope at both; the root node is depth 1, so its entries are the leaves at `wiki/<name>`.
- `src/lib/workbench-files.ts:210-218` -- `wikiLeafFilter`. THE CHANGE: its first line `if (!name.endsWith(".md")) return true` is what admits `notes.txt`.
- `src/lib/workbench-files.ts:220-221` -- `allowEveryLeaf`, the `raw/` filter. Ignores its arguments, so a widened signature costs it nothing.
- `src/lib/workbench-files.ts:315-320` -- the `walkRoot(..., wikiLeafFilter(options.readableSlugs))` call for the wiki root.
- `src/lib/workbench-files.ts:322-347` -- the FROZEN doc comment on the read gate ("Deliberately NOT {@link wikiLeafFilter}, whose first line is …"). Must be rewritten: that sentence becomes false.
- `src/lib/workbench-files.ts:349-360` -- `wikiLeafSlug` (exported; the preview route also calls it) and `readableWikiLeaf`. `readableWikiLeaf` is a hoisted function declaration, so `wikiLeafFilter` may call it despite appearing earlier in the file.
- `src/lib/workbench-files.ts:455-460` -- `resolveWorkbenchFile`'s wiki branch: `if (rest.length !== 1 || !readableWikiLeaf(rest[0], options.readableSlugs)) return null` — the exact predicate the listing must mirror.
- `src/lib/workbench-tree.ts:198` -- `selectionExists`: a directory is a disclosure, never a row. Read-only evidence that directory rows need no change.
- `src/lib/query-history.ts:188` -- writes `wiki/query-history/<key>.json`, so a non-dotted nested directory under `wiki/` is real, not hypothetical, and its per-owner filenames are today listed under the shared flat root.
- `src/lib/wiki.ts:181-197` -- `validateSlug` rejects `/`, so a page is always a direct child of the wiki root; nothing the kernel writes puts a page inside a `wiki/` subdirectory.
- `src/lib/__tests__/workbench-tree.test.ts:698-717` -- "lists only the pages the read gate returned, in either branch". Asserts `expect(flat.paths).toContain("wiki/notes.txt")` (`:710`) with a comment saying non-markdown "is not gated" — that assertion and comment invert here.
- `src/lib/__tests__/workbench-tree.test.ts:451-524` -- the suite's fixture helpers: `gate(...slugs)`, `writeSilo`, and the `WIKI_DIR`/`RAW_DIR` per-case temp roots. Reuse them; do not build a new harness.
- `src/lib/__tests__/workbench-preview.test.ts:1080-1097` -- "refuses a non-page leaf under wiki/". Behaviour is unchanged, but its comment narrates `wikiLeafFilter`'s old first line and must be corrected.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-files.ts` -- widen `LeafFilter` to `(name: string, depth: number) => boolean`, documenting that `depth` is the leaf's level under the display root (`wiki/alpha.md` is 1), and pass `node.depth` at both `walkRoot` call sites -- the wiki root's gate is depth-sensitive, so the filter cannot express it from the name alone.
- `src/lib/workbench-files.ts` -- rewrite `wikiLeafFilter`'s body to `(name, depth) => depth === 1 && readableWikiLeaf(name, readableSlugs)`, and rewrite its doc comment to state the LISTING's own reason (a filename is a disclosure) and that its admissible set is now derived from the read gate rather than restated -- one predicate, two reasons, no row the Preview refuses.
- `src/lib/workbench-files.ts` -- rewrite the frozen `readableWikiLeaf` doc comment (`:326-347`) so it records the new rule: the listing derives from this predicate, the two functions remain distinct because their REASONS differ (disclosure of a filename vs. disclosure of bytes from a possibly-shared flat root), and re-unifying them into one function is still refused -- the old text asserts a divergence that no longer exists.
- `src/lib/__tests__/workbench-tree.test.ts` -- flip the `wiki/notes.txt` assertion to `not.toContain` and correct its comment; add cases for the matrix rows that are new here: a `wiki/dump.json` that is not listed, a `wiki/cased.MD` with a readable slug that IS listed, and a nested `wiki/<dir>/<readable-slug>.md` whose directory lists while its leaf does not -- the listing's admissible set is the behaviour under change.
- `src/lib/__tests__/workbench-tree.test.ts` -- add a case that asserts the listing and the read gate agree: for a fixture holding both readable and refused `wiki/` names, every listed `wiki/…` path returns non-null from `readWorkbenchFile` under the same gate -- this is the invariant DW-41 asks for, and asserting it directly is what keeps the two functions from drifting apart again.
- `src/lib/__tests__/workbench-preview.test.ts` -- correct the comment at `:1081-1085` that narrates `wikiLeafFilter`'s old first line, keeping the assertions as they are -- the read gate's behaviour is unchanged; only the sentence about the listing is now wrong.

**Acceptance Criteria:**
- Given a `wiki/` root holding `mine.md` (readable), `theirs.md` (not readable), `notes.txt` and `dump.json`, when `listWorkbenchFilePaths` runs, then the returned paths contain `wiki/mine.md` and none of the other three.
- Given any listing `listWorkbenchFilePaths` returns for a gate, when each returned path beginning `wiki/` is passed to `readWorkbenchFile` under that same gate, then none of them returns `null` for gate reasons — the Files tab cannot show a `wiki/` row the Preview refuses.
- Given a `raw/` root with `topic/abc.md` and `scan.pdf`, when the listing runs, then `raw/topic/`, `raw/topic/abc.md` and `raw/scan.pdf` are all still listed — narrowing applied to the wiki root only.
- Given the read gate's doc comment after the change, when a reader looks for why the two filters are not one function, then the comment states the two distinct reasons and that the listing now derives its admissible set from this predicate, with no surviving claim that the listing passes non-`.md` names.

## Design Notes

`readableWikiLeaf` is a hoisted `function` declaration further down the file, so calling it from `wikiLeafFilter` needs no reordering — keep both where they are so the read-gate section stays intact.

The depth term is what makes the listing's set *equal* the gate's rather than merely a subset of `.md` names: `resolveWorkbenchFile` refuses `wiki/<dir>/<name>` outright (`rest.length !== 1`), and `wiki/query-history/` proves a non-dotted subdirectory under the wiki root is real. Directories keep listing — a directory is a disclosure, not a row, so an empty `wiki/query-history/` folder is not a refused Preview.

```ts
/**
 * May `wiki/<name>` be LISTED?
 *
 * A filename is a disclosure — that is this filter's reason, and it is not the
 * read gate's. But the admissible set is now DERIVED from the read gate rather
 * than restated (DW-41): a row the Preview would refuse reads as a broken
 * Preview, not as a gate. `depth === 1` because the gate serves only a direct
 * child of the root; see {@link readableWikiLeaf}.
 */
function wikiLeafFilter(readableSlugs: ReadonlySet<string>): LeafFilter {
  return (name, depth) => depth === 1 && readableWikiLeaf(name, readableSlugs);
}
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/workbench-left-column.test.ts` -- expected: all pass
- `pnpm test` -- expected: no new failures against the pre-change baseline
- `pnpm lint` -- expected: clean
- `npx tsc --noEmit -p tsconfig.json` -- expected: no new type errors


## Review Triage Log

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 18: (high 0, medium 0, low 18)
- addressed_findings:
  - `[low]` `[patch]` The `deferred` entry behind DW-202 claimed this change "adds the second visible door" for `wiki/cased.MD`. False: the old `wikiLeafFilter` opened with `if (!name.endsWith(".md")) return true`, and `"cased.MD".endsWith(".md")` is false, so `cased.MD` listed UNGATED before this change — the two-rows-one-slug defect is wholly pre-existing and DW-41 narrowed it. Rewrote the entry's evidence to say so and widened its `location` to name the save half (the preview route's slug derivation), so the next reader does not chase a regression that never happened.
  - `[low]` `[patch]` "lists a wiki leaf whose extension is cased oddly" passed against the OLD implementation — `cased.MD` fell through the `!endsWith(".md")` pass-through, so the assertion could not tell the two filters apart. Added "does not list an odd-cased wiki leaf whose slug is not readable", the negative case that actually pins the derivation. Verified by mutation: restoring the old filter body now fails 3 tests instead of 1.
  - `[low]` `[patch]` Nothing asserted that a leaf dropped for GATE reasons leaves `truncated` false, and the change made that silent-`continue` path govern almost everything under `wiki/` (`index.md` alone is always rejected, so a mutation there ships a permanently-true flag: a false "File list truncated at 2,000 entries." note plus `selectionRefreshAction` short-circuiting to `keep` forever). Added `expect(truncated).toBe(false)` to the DW-41 invariant test, and — for the complementary direction, since narrowing the leaf filter left `e.isDirectory` as the only surviving truncation trigger under `wiki/` — a new case asserting `truncated === true` for a directory hidden at the depth cap. Both verified by mutation.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** The Files tab's `wiki/` listing now admits exactly the leaf set `resolveWorkbenchFile` will serve, so no row can be shown whose only possible Preview is `PREVIEW_FAILED_COPY`. `LeafFilter` gained a `depth` parameter (the depth of the directory being enumerated; the root is level 1), and `wikiLeafFilter`'s body became `(name, depth) => depth === 1 && readableWikiLeaf(name, readableSlugs)` — the name half derived from the read gate rather than restated, the depth half mirroring the resolver's `rest.length !== 1`. `readableWikiLeaf` and `wikiLeafFilter` remain two functions with two documented reasons, as DW-41's decision and the previous pass's security freeze require. `raw/` is untouched.

**Files changed.**
- `src/lib/workbench-files.ts` — widened `LeafFilter`, passed `node.depth` at both `walkRoot` call sites, derived `wikiLeafFilter` from `readableWikiLeaf`, and rewrote the module header, `readableSlugs` doc, `LeafFilter` doc, `wikiLeafFilter` doc, `allowEveryLeaf` doc, the frozen `readableWikiLeaf` doc, and `resolveWorkbenchFile`'s wiki-branch bullet.
- `src/lib/__tests__/workbench-tree.test.ts` — flipped the `wiki/notes.txt` assertion, and added cases for `dump.json`, odd-cased extensions (positive and negative), wiki subdirectory rows without their leaves, both truncation directions, the DW-41 listing⇔gate invariant, and `raw/scan.pdf`.
- `src/lib/__tests__/workbench-preview.test.ts` — corrected the comment narrating the old listing filter; added a nested-path refusal case.
- `_bmad-output/implementation-artifacts/deferred-work.md` — DW-41 closed, DW-202 recorded (see residual risks).

**Review findings breakdown.** 3 patches applied (all low), 1 item deferred (low), 18 rejected. No intent gaps and no spec defects: the four review layers agreed the diff implements the intent's chosen reading, and the intent-alignment auditor confirmed the module-level invariant transfers to production because `page.tsx` and the preview route derive the same gate from `readableSlugsFromKnowledge(buildKnowledgeTree(...))`.

**Follow-up review recommendation:** false. Patched findings this pass: high 0, medium 0, low 3. Score = 3×0 + 1×3 = 3, below the threshold of 5, and no patched finding was high severity.

**Verification performed.**
- `npx vitest run src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/workbench-left-column.test.ts` — 246 passed, 3 files.
- `npx vitest run` (full suite) — 4724 passed, 225 files, no failures. (`pnpm vitest`/`pnpm test` abort in this checkout with `ERROR packages field missing or empty` before reaching vitest; `npx vitest` runs the same `vitest.config.ts`.)
- `npx eslint src/lib/workbench-files.ts src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-preview.test.ts` — clean.
- `npx tsc --noEmit -p tsconfig.json` — clean.
- Mutation checks on the three new assertions: setting `budget.truncated` on the emit loop's gate-`continue`, dropping the `e.isDirectory` term from the depth-cap probe, and restoring the old `wikiLeafFilter` body each now fail (1, 1 and 3 tests respectively) where all three previously survived the whole suite.

**Residual risks.**
- Two rows for one slug on a case-sensitive store (`cased.md` + `cased.MD`) remains unresolved and is deferred; it is pre-existing and narrower after this change, but a save reached from the `.MD` row still lands on `wiki/cased.md`.
- "A direct child of the wiki root" is spelled three times — `depth === 1` here, `rest.length !== 1` in the resolver, `segments.length === 2` in the preview route — bound only by the new invariant test and by prose. Deferred; factoring it touches the preview route's page/file disambiguation, which this intent puts out of bounds.
- The DW-202 entry already written into `_bmad-output/implementation-artifacts/deferred-work.md` carries the pre-correction wording ("this change adds the second visible door"). This run left the ledger untouched by dispatch instruction; the corrected text lives in this spec's `deferred` frontmatter and needs the orchestrator to re-sync it. The second deferred item added this pass has no ledger entry yet for the same reason.
