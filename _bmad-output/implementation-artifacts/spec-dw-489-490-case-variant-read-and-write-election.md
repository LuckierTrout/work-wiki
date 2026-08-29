---
title: 'DW-489/490: the elected wiki object is what the read gate serves and what a save writes'
type: 'bugfix'
created: '2026-08-28'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `createWikiPage` still creates `<slug>.md` unconditionally, so on a
      case-SENSITIVE store its "create only if absent" guard can miss a page
      already stored under a variant casing of the extension and create a
      second object for one slug.
    evidence: |-
      `src/lib/wiki.ts:createWikiPage` builds `${slug}.md` and calls
      `writeFileIfAbsent` on it; unlike `writeWikiPage` and
      `writeWikiPageIfContentMatches` it was left untouched here on purpose (a
      Never clause of this spec). The reason is that the two decisions differ:
      a save is retargeting bytes onto the object the reader was shown, while
      "create if absent" is a CREATE-CONFLICT question — whether `cased.MD`
      counts as the page `cased` already existing — and answering it by
      probing three variants changes when a create is REFUSED, not merely
      where it lands.
      THE REACH IS WIDER THAN "a caller that skips the conflict read". The
      route- and MCP-level guards (`src/app/api/wiki/route.ts`, `src/mcp.ts`)
      do read through `readWikiPage` and so now see a recovered variant, but
      `src/lib/lifecycle.ts`'s `createOnly` branch (`:527-531`) carries its
      OWN precondition — `storageFileExists(wikiRelPath(`${slug}.md`))`,
      canonical only — and then calls `createWikiPage` twice (`:536` for the
      silo, `:541` for the flat copy). On a case-sensitive store holding only
      `cased.MD`, that pre-check misses, `writeFileIfAbsent("wiki/cased.md")`
      succeeds, and a second object appears for one slug — the very split this
      spec closed on the save path, still open on the create path. The
      surviving hole is therefore that branch plus any direct
      `createWikiPage` caller, and closing it means deciding the
      create-conflict question, not relocating a write.
    location: >-
      src/lib/wiki.ts
    severity: low
baseline_revision: '144767a4fc2899698ae33bd65f34662aa46eb7c2'
---

<intent-contract>

## Intent

**Problem:** DW-202/203's elected-winner rule stops at the LISTING. DW-489 — `resolveWorkbenchFile` (`src/lib/workbench-files.ts:965-1013`), and therefore `readWorkbenchFile`, `readWorkbenchFileBytes` and `workbenchFileExists`, still serve a directly-named `wiki/cased.MD` that the listing elected against, and the preview route still hands it slug `cased` with `editable: true` — so a deep link or a selection restored from `workbench-state` previews one object and saves another. DW-490 — `writeWikiPage` (`src/lib/wiki.ts:578`) and `writeWikiPageIfContentMatches` (`:638`) target `${slug}.md` unconditionally, so on a case-SENSITIVE store a save whose bytes came from a lone `wiki/cased.MD` row creates a SECOND object and orphans the first (today it cannot even get that far: `readWikiPage` only ever reads `${slug}.md`, so the save door 404s on a page the Files tab shows as editable).

**Approach:** Give the election ONE spelling in a pure leaf module and apply it at both remaining layers. The read gate elects over the same depth-1 entries `resolveRoot` already returned, so `resolveWorkbenchFile` answers exactly as the listing does at no extra round trip. The wiki page key — read recovery and write target alike — resolves to the stored object carrying the slug rather than to the canonical name, on the ENOENT branch each call site already has, so read and write name the same object on either store kind.

## Boundaries & Constraints

**Always:**
- ONE election, in a new pure leaf module with no imports that both `src/lib/wiki.ts` and `src/lib/workbench-files.ts` import. `wikiLeafSlug` moves there with it and is RE-EXPORTED from `src/lib/workbench-files.ts`, so every existing importer (`preview/route.ts`, both test files) is untouched.
- The candidate set for a slug is exactly `slug` + the four case spellings of `.md`, because that is precisely what `wikiLeafSlug` admits (case-insensitive on the extension, exact on the slug). Bounded and O(1) — never a directory listing.
- The election rule itself is unchanged: the literal `<slug>.md` wins whenever it is among the candidates, otherwise the lexicographically first name. A total order, so the winner never depends on the order storage returned names in.
- `resolveWorkbenchFile`'s wiki branch decides from the entries `resolveRoot` ALREADY returned (it currently discards them). No `stat()`, no second listing, no extra storage call.
- After this change the `wiki/` half of the listing's admissible set EQUALS the read gate's rather than being a strict subset. Every refusal stays the same indistinguishable `null` — no new error, no existence oracle.
- The wiki page key resolution runs ONLY on the branch where the canonical `${slug}.md` already answered ENOENT. On a case-INSENSITIVE store the canonical spelling resolves the stored object, so no probe ever runs there and the write target is byte-for-byte what it is today.
- `readWikiPage` keeps its `null` contract, its `fresh` / `strict` / `owner` semantics, its silo-then-flat order and its negative caching. A recovered variant is an ordinary hit whose `path` names the object actually read. Under `strict`, a non-ENOENT failure during recovery rethrows exactly as the canonical read does.
- `saveRevision` stays keyed by slug; only the storage key the bytes land on changes.
- Both halves are pinned on a SIMULATED case-sensitive store and a SIMULATED case-insensitive store, because the dev host's volume is case-insensitive and the host cannot be trusted to keep two spellings apart.

**Block If:**
- Closing DW-490 turns out to require threading the display path through `PUT /api/wiki/[slug]`'s request or response shape — that is a public API change, not a patch.

**Never:**
- Do not change `wikiLeafSlug`'s rule, `readableWikiLeaf`'s name/signature/role as the sole read-gate boolean (DW-41), or `wikiLeafName`'s definition (DW-204).
- Do not change `createWikiPage`: "create if absent" against a variant is a create-conflict decision, not a save target. Record it as a deferral instead.
- Do not add an option to `ReadWikiPageOptions`, and do not change any existing `readWikiPage` call site.
- Do not touch `raw/` behaviour, the per-root budget split, the depth cap, truncation reporting, `PREVIEW_FAILED_COPY`, or the Knowledge tab.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Read gate follows the election | wiki root holds `cased.md` + `cased.MD`, slug `cased` readable | `readWorkbenchFile("wiki/cased.md")` serves the canonical bytes; `wiki/cased.MD` answers `null` and `workbenchFileExists` answers `false` | No error expected |
| Two variants, no canonical | root holds `cased.MD` + `cased.Md` | only `wiki/cased.MD` lists AND reads; `wiki/cased.Md` answers `null` | No error expected |
| Lone variant still serves | root holds only `cased.MD` (the case-INSENSITIVE store's shape) | `wiki/cased.MD` lists and reads exactly as today | No error expected |
| Unlisted spelling is refused | root holds only `cased.MD`, caller asks for `wiki/cased.md` | `null` — the listing never emitted that path | No error expected |
| Save lands on the read object | case-SENSITIVE store, only `cased.MD` present | `writeWikiPage("cased", …)` writes `…/cased.MD`; no `cased.md` is created | No error expected |
| Canonical present wins the save | store holds `cased.md` (case-insensitive store, or a collision) | `writeWikiPage` writes `…/cased.md` and probes nothing | No error expected |
| CAS save follows the same object | case-SENSITIVE store, only `cased.MD`, `expectedContent` = its bytes | `writeWikiPageIfContentMatches` compares against and rewrites `…/cased.MD`, returns `true` | Mismatch still returns `false` |
| Genuinely absent page | no spelling present | `readWikiPage` → `null`; `writeWikiPage` creates `…/<slug>.md` | No error expected |
| Recovery hits a storage fault | canonical ENOENT, a variant read rejects with a non-ENOENT error | `strict` rethrows; non-strict logs and answers as it does today | Rethrow / log |

</intent-contract>

## Code Map

- `src/lib/workbench-files.ts:539-563` -- `wikiLeafFilter`, holding the election inline today (`winners` map, canonical-else-lexicographic-first). The loop body is what moves to the shared helper; the docblock at `:476-538` states the rule and MUST be updated where it says the read gate's reach is unchanged.
- `src/lib/workbench-files.ts:965-1013` -- `resolveWorkbenchFile`. `const { prefix } = await resolveRoot(root, silo, flat)` at `:1010` DISCARDS `entries` — the election's input is already in hand there. The wiki gate at `:987-990` runs before the root is resolved; the election test has to sit after `:1010`.
- `src/lib/workbench-files.ts:876-891` -- `wikiLeafSlug` (exported) and `readableWikiLeaf`. `wikiLeafSlug` moves to the new leaf module and is re-exported here; `readableWikiLeaf` stays put.
- `src/lib/workbench-files.ts:152-160` -- `wikiLeafName`, the DW-204 predicate. Unchanged; stays in this module (only `resolveWorkbenchFile` and the preview route need it, and neither is `wiki.ts`).
- `src/lib/workbench-files.ts:688-697` -- `listWorkbenchFilePaths`' hoisted `wikiRoot`, the shape `resolveWorkbenchFile` now mirrors.
- `src/app/api/workbench/preview/route.ts:265-275` -- the editable-Page slug derivation. No code change: after this, a non-elected spelling is refused by `readWorkbenchFile`/`workbenchFileExists` above it and never reaches here. The comment must record that.
- `src/lib/wiki.ts:416-540` -- `readWikiPage`. `flatPath`/`readSilo` build `${slug}.md`; `attemptedTenants` records which silos were tried; the total miss returns at `:497-503` after the negative-cache write. Recovery hooks in there, before that return.
- `src/lib/wiki.ts:578-609` -- `writeWikiPage`. Already reads `storagePath` for the revision snapshot and has an ENOENT catch at `:592-598`; that catch is where the target is re-elected.
- `src/lib/wiki.ts:638-666` -- `writeWikiPageIfContentMatches`. `readFileWithEtag(storagePath)` at `:650` returns `false` on ENOENT at `:653`; that branch re-elects before giving up.
- `src/lib/wiki.ts:621-630` -- `createWikiPage`. READ-ONLY: named in the deferral, not changed.
- `src/lib/wiki.ts:42-44`, `:tenantWikiRelPath` -- the two key builders the resolution must use so silo and flat stay one spelling each.
- `src/lib/storage/types.ts:187,193` -- `listFiles(prefix)` and `fileExists(path)`; `readFile` throws ENOENT-shaped errors that `isEnoent` classifies (`src/lib/errors.ts`).
- `src/lib/__tests__/workbench-tree.test.ts:1009-1021` -- `alsoListInWikiRoot`, the `listFiles` spy that stages a case-sensitive multi-object root on a case-insensitive host. Reuse it.
- `src/lib/__tests__/workbench-tree.test.ts:1074-1094` -- "elects one row per slug even when NO canonical exists" asserts BOTH variants still read. `src/lib/__tests__/workbench-tree.test.ts:1096-1110` -- "still READS the defeated sibling it refuses to list". Both encode the reach DW-489 retires and MUST be rewritten (assertions AND their comments).
- `src/lib/__tests__/workbench-tree.test.ts:969-980` -- the lone-`cased.MD` test. MUST stay green unmodified: it is the case-INSENSITIVE store's shape and the thing a naive revert breaks.
- `src/lib/__tests__/workbench-preview.test.ts` -- holds the `wikiLeafName` unit binding and the read-gate/preview `.MD` coverage; grep `cased`/`alpha.MD` there for cases that assert the old reach.
- `src/lib/__tests__/wiki.test.ts:1-45, 2226-2400` -- tmp-dir + env harness and the existing silo-primary / tenant-write describes; the write-side cases hang off the same harness with storage spies.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-file-names.ts` -- NEW pure leaf module, no imports. Move `wikiLeafSlug` here verbatim (keeping its docblock's rule), and add `wikiPageNames(slug): readonly string[]` (the four `.md` case spellings, canonical first) and `electWikiLeafNames(names: Iterable<string>): Map<string, string>` (slug → elected name), the loop lifted verbatim from `wikiLeafFilter`. Docblock states that this is the ONE spelling of the election and names its three callers. -- Both `wiki.ts` and `workbench-files.ts` need it, and `workbench-files.ts` imports `wiki.ts`, so it cannot live in either.
- `src/lib/workbench-files.ts` -- Import from the new module, re-export `wikiLeafSlug`, and make `wikiLeafFilter` derive its `listable` set from `electWikiLeafNames` instead of restating the loop. Apply the election in `resolveWorkbenchFile`: destructure `entries` from `resolveRoot`, and for the wiki root refuse (`null`) unless the leaf name is the elected winner for its slug. Update the `wikiLeafFilter` docblock, the READ GATE header, and the `resolveWorkbenchFile` docblock — all three currently assert the gate's reach is deliberately WIDER than the listing's. -- DW-489: the read gate answers exactly as the listing does.
- `src/app/api/workbench/preview/route.ts` -- Comment-only: record that a non-elected spelling is now refused before the slug is derived, so `slug` names the object whose bytes this payload carries. -- The decision names this site; the behaviour change lands upstream and the comment is what stops the next reader re-widening it.
- `src/lib/wiki.ts` -- Add an internal `readStoredPageVariant(slug, tenant | null, strict)` that, for the three NON-canonical spellings, reads them in parallel, classifies ENOENT as absent, rethrows non-ENOENT under `strict` (logs otherwise), and returns the elected `{ key, content }` or `null`. Call it (a) in `readWikiPage`'s total-miss branch before the negative cache write, for each tenant in `attemptedTenants` in order and then the flat root, setting `content`/`actualPath` on a hit; (b) in `writeWikiPage`'s ENOENT catch, to retarget the write and snapshot the revision from the recovered bytes; (c) in `writeWikiPageIfContentMatches`' ENOENT branch, to retarget the etag read, the comparison and the CAS. -- DW-490: the save lands on the object the read resolved, and the read can resolve it at all.
- `src/lib/__tests__/workbench-tree.test.ts` -- Rewrite the two tests named in the Code Map to assert the narrowed reach (defeated sibling now answers `null` from `readWorkbenchFile` and `false` from `workbenchFileExists`), add the "unlisted spelling is refused" row (lone `cased.MD`, ask for `wiki/cased.md`), and leave `:969-980` untouched. -- The I/O matrix's read half; the untouched test is the case-insensitive pin.
- `src/lib/__tests__/wiki.test.ts` -- Add a describe covering the write half against SIMULATED stores: spy `readFile`/`readFileWithEtag`/`fileExists`/`writeFile`/`writeFileIfMatch` on the storage singleton so a case-SENSITIVE store answers only the exact key. Cover: save targets `cased.MD` when it is the only spelling; save targets `cased.md` when the canonical exists and probes nothing; `writeWikiPageIfContentMatches` compares and CASes against the variant; `readWikiPage` recovers the variant and reports its `path`; a genuinely absent page still creates `<slug>.md`; a non-ENOENT variant failure rethrows under `strict`. -- The I/O matrix's write half, on both store kinds.
- `src/lib/__tests__/workbench-preview.test.ts` -- Add a direct unit binding for `electWikiLeafNames` (canonical wins; lexicographic tiebreak; order-independence; a non-`.md` name contributes nothing) and for `wikiPageNames` (exactly four names, canonical first). -- The election is now load-bearing for three callers across two modules.

**Acceptance Criteria:**
- Given a wiki root whose listing elected `wiki/cased.md`, when any Workbench read door is asked for `wiki/cased.MD`, then it answers exactly as it answers for a path that does not exist — `null` from `readWorkbenchFile` and `readWorkbenchFileBytes`, `false` from `workbenchFileExists`, one 404 from the preview route.
- Given the election is now shared, when `electWikiLeafNames` is changed, then the listing filter, the read gate and the wiki page key all change with it — no site restates the rule.
- Given a case-SENSITIVE store holding only `wiki/cased.MD` with slug `cased` readable, when the row is previewed and then saved, then the bytes previewed and the object written are the same key and no `cased.md` appears.
- Given a case-INSENSITIVE store, when any of these paths runs, then it makes exactly the storage calls it makes today and targets the same key — the recovery probe is unreachable there because the canonical spelling resolves the stored object.
- Given the full suite, when `pnpm vitest run` executes it, then the unmodified lone-variant listing test still passes and no other test regresses.

## Spec Change Log

## Review Triage Log

## Design Notes

The two halves are one rule seen from two sides: **the elected object is the object**. The listing already elects it; after this the read gate refuses everything else, and the write path targets it rather than the name it would have been given.

What makes the candidate set cheap is `wikiLeafSlug` itself: it lowercases the whole name and tests a `.md` suffix, taking the slug as written. So the only names carrying slug `s` are `s` + one of `.md` / `.mD` / `.Md` / `.MD` — four, always. The write path never needs a listing; three bounded probes on a branch that already proved the canonical absent is the whole cost, and only ever on that branch.

```ts
// One spelling, in the leaf module both sides import.
export function electWikiLeafNames(names: Iterable<string>): Map<string, string> {
  const winners = new Map<string, string>();
  for (const name of names) {
    const slug = wikiLeafSlug(name);
    if (slug === null) continue;
    const canonical = `${slug}.md`;
    const standing = winners.get(slug);
    if (standing === canonical) continue;
    if (name === canonical || standing === undefined || name < standing) {
      winners.set(slug, name);
    }
  }
  return winners;
}
```

The case-INSENSITIVE store is what a naive revert breaks, and the reason every step here is conditional on the canonical answering ENOENT. On such a store `listFiles` returns ONE name for the Page — whatever casing was written — so the election makes THAT name the winner and it keeps listing and reading; and `readFile("cased.md")` resolves the object whatever it is called, so no probe runs and no target changes. The behaviour difference between the two store kinds therefore lives entirely in branches the case-insensitive store cannot reach.

Refusing a spelling the listing elected against NARROWS the read gate, which DW-202/203 deliberately did not do. That is the recorded 2026-08-28 decision, and the direction is safe: a refusal is the same `null` every other refusal is, and the only paths it can withhold are paths the listing never emitted.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/wiki.test.ts` -- expected: all pass, including the unmodified lone-variant listing test
- `pnpm vitest run` -- expected: no regressions against the baseline suite
- `npx tsc --noEmit` -- expected: no new type errors
- `pnpm lint` -- expected: no new errors
