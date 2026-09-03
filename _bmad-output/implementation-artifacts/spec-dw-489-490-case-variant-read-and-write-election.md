---
title: 'DW-489/490: the elected wiki object is what the read gate serves and what a save writes'
type: 'bugfix'
created: '2026-08-28'
status: 'done'
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
  - summary: >-
      The delete and existence doors still address a Page as `<slug>.md` only,
      so a Page whose bytes this change deliberately parks on a case variant
      survives a "successful" hard delete and reads as absent to
      `wikiPageExists`.
    evidence: |-
      This spec retargeted the three doors its decision named — `readWikiPage`
      recovery, `writeWikiPage` and `writeWikiPageIfContentMatches` — so a
      variant-held Page is now a live, listed, readable, WRITABLE state rather
      than an anomaly `readWikiPage` refused to serve at all. Two sibling doors
      did not move with it, and each is a wrong answer the owner can hit:
      (1) DELETE. `src/lib/lifecycle.ts`'s delete branch unlinks exactly
      `tenantWikiRelPath(deleteTenant, `${slug}.md`)` and
      `wikiRelPath(`${slug}.md`)`, swallowing ENOENT on both. On a
      case-SENSITIVE store holding only `wiki/cased.MD`, the pre-delete read
      NOW succeeds (it did not before this change), both unlinks miss, the op
      reports success — and the next `readWikiPage("cased")` recovers the
      variant and serves the full body. A hard delete that reports success and
      removes nothing is worse than the pre-change state, where the Page was
      simply unreadable through `readWikiPage`.
      (2) EXISTENCE. `wikiPageExists` (`src/lib/wiki.ts`) probes
      `tenantWikiRelPath(tenant, `${slug}.md`)` then `wikiRelPath(`${slug}.md`)`
      and answers `false` on ENOENT, so it now DISAGREES with `readWikiPage`
      about the same slug. `src/app/api/ingest/status/[jobId]/route.ts` reads
      that as `gone` and answers 404, dropping a completed ingest from the
      Recent-ingests strip on a Page that reads fine.
      Both were left alone deliberately: like the `createWikiPage` entry above,
      each is a DECISION rather than a relocation — which spellings a delete is
      entitled to sweep, and whether an existence probe may cost three extra
      reads on every miss — and neither is named by the recorded 2026-08-28
      decisions this spec implements.
    location: >-
      src/lib/lifecycle.ts (delete branch); src/lib/wiki.ts (wikiPageExists)
    severity: medium
baseline_revision: 'c39e6267b4429f7e929793b3b5fcf28aedcb8762'
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

- `src/lib/workbench-files.ts:538-563` -- `wikiLeafFilter`, holding the election inline today (`winners` map at `:546-556`, canonical-else-lexicographic-first; `listable` at `:557`). The loop body is what moves to the shared helper; the docblock at `:473-537` states the rule and MUST be updated where it says the read gate's reach is deliberately unchanged (`:534-537`).
- `src/lib/workbench-files.ts:968-1015` -- `resolveWorkbenchFile`. `const { prefix } = await resolveRoot(root, silo, flat)` at `:1012` DISCARDS `entries` — the election's input is already in hand there. The wiki gate at `:989-992` runs before the root is resolved; the election test has to sit after `:1012`.
- `src/lib/workbench-files.ts:392-412` -- `resolveRoot`, which already returns `{ prefix, entries }` (silo-first for `wiki`, falling back to the flat prefix only when the silo listing is empty). Its `entries` are what the listing elects over, so electing over the same value is what makes the two answers identical by construction.
- `src/lib/workbench-files.ts:855-894` -- the READ GATE docblock plus `wikiLeafSlug` (exported, `:882-889`) and `readableWikiLeaf` (`:891-894`). `wikiLeafSlug` moves to the new leaf module and is re-exported here; `readableWikiLeaf` stays put. The docblock at `:861-867` asserts the gate's reach is wider than the listing's and MUST be updated.
- `src/lib/workbench-files.ts:155-160` -- `wikiLeafName`, the DW-204 predicate. Unchanged; stays in this module (only `resolveWorkbenchFile` and the preview route need it, and neither is `wiki.ts`).
- `src/lib/workbench-files.ts:50-68` -- the import block. It already imports `./wiki`, which is why the shared election cannot live in either module and needs a leaf both can import.
- `src/lib/workbench-files.ts:693` -- `listWorkbenchFilePaths`' hoisted `wikiRoot = await resolveRoot("wiki", siloWiki, wikiRelPath(""))`, the shape `resolveWorkbenchFile` now mirrors.
- `src/app/api/workbench/preview/route.ts:271-284` -- the editable-Page slug derivation (`wikiLeafName` then `wikiLeafSlug`). No code change: after this, a non-elected spelling is refused by `readWorkbenchFile`/`workbenchFileExists` above it (`:250-269`) and never reaches here. The comment must record that.
- `src/lib/wiki.ts:420-540` -- `readWikiPage`. `flatPath` at `:433` and `readSilo`'s `siloPath` at `:451` build `${slug}.md`; `attemptedTenants` (`:448`) records which silos were tried; the total miss returns at `:497-503` after the negative-cache write. Recovery hooks in there, before that return.
- `src/lib/wiki.ts:582-613` -- `writeWikiPage`. Already reads `storagePath` for the revision snapshot (`:596-597`) and has an ENOENT-tolerant catch at `:598-603`; that catch is where the target is re-elected.
- `src/lib/wiki.ts:642-670` -- `writeWikiPageIfContentMatches`. `readFileWithEtag(storagePath)` at `:654` returns `false` on ENOENT at `:657`; that branch re-elects before giving up.
- `src/lib/wiki.ts:623-633` -- `createWikiPage`. READ-ONLY: named in the deferral, not changed.
- `src/lib/wiki.ts:42-44` (`wikiRelPath`) and `:144` (`tenantWikiRelPath`) -- the two key builders the resolution must use so silo and flat stay one spelling each.
- `src/lib/storage/types.ts` -- `listFiles(prefix)` and `fileExists(path)`; `readFile` throws ENOENT-shaped errors that `isEnoent` classifies (`src/lib/errors.ts`).
- `src/lib/__tests__/workbench-tree.test.ts:1008-1020` -- `alsoListInWikiRoot`, the `listFiles` spy that stages a case-sensitive multi-object root on a case-insensitive host (it stubs ONLY the flat wiki prefix's listing; `readFile` still hits the real file). Reuse it.
- `src/lib/__tests__/workbench-tree.test.ts:1074-1093` -- "elects one row per slug even when NO canonical exists" asserts BOTH variants still read. `src/lib/__tests__/workbench-tree.test.ts:1095-1108` -- "still READS the defeated sibling it refuses to list". Both encode the reach DW-489 retires and MUST be rewritten (assertions AND their comments).
- `src/lib/__tests__/workbench-tree.test.ts:969-980` -- the lone-`cased.MD` test. MUST stay green unmodified: it is the case-INSENSITIVE store's shape and the thing a naive revert breaks.
- `src/lib/__tests__/workbench-preview.test.ts:1193-1227` -- the `wikiLeafName` unit describe, where the `electWikiLeafNames`/`wikiPageNames` bindings belong. `:1352-1359` and `:1984-1993` read and preview a LONE `alpha.MD` / `cased.MD`; both stay green because a lone variant wins its own slug.
- `src/lib/__tests__/wiki.test.ts:1-72` -- tmp-dir + `WIKI_DIR`/`RAW_DIR`/`DATA_DIR` env harness with `_resetStorage()`. `:2226-2333` (`silo-primary reads`) and `:2342-2396` (`writeWikiPage with tenant parameter`) are the describes the new write-side cases sit beside, and `:2320-2332` shows the `vi.spyOn(storage, "readFile")` pattern for simulating a store that answers only exact keys.

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

- **2026-09-03 — resumed from an unimplemented spec.** This file was committed on 2026-08-28 (in `002843ce`, a sweep for an unrelated DW id) carrying `status: in-review`, but no implementation ever landed: `src/lib/wiki-file-names.ts` does not exist and `electWikiLeafNames` / `wikiPageNames` / `readStoredPageVariant` appear nowhere in `src/`. The status was therefore phantom. Re-dispatched from the `case-variant-file-election` bundle (DW-489, DW-490), the `<intent-contract>` was PRESERVED VERBATIM — it was written from the same recorded 2026-08-28 decisions this bundle carries — and only the Code Map anchors and `baseline_revision` were refreshed against the current tree. KEEP: the intent contract, the deferral recorded for `createWikiPage`, and the "elect over the entries `resolveRoot` already returned" approach, which is what makes the read gate's answer identical to the listing's by construction rather than by agreement.

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 4, low 3)
- defer: 1: (high 0, medium 1, low 0)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[medium]` `[patch]` A FAILED root listing turned every `wiki/` read into a 404: the new gate elected over `resolveRoot`'s `entries`, which are `[]` on an unreadable listing, so a transient LIST blip refused every readable page at `readWorkbenchFile` / `readWorkbenchFileBytes` / `workbenchFileExists`. `resolveRoot` now propagates `failed` on both wiki returns and the gate skips the election when the candidate set is indeterminate — safe because the election is not the security gate (`readableWikiLeaf` is, DW-41) and only picks among spellings of an already-readable slug. Pinned with a rejecting `listFiles` over an intact `readFile`.
  - `[medium]` `[patch]` `writeWikiPage`'s variant probe was non-strict, so a non-ENOENT fault fell through to the canonical name and silently created the SECOND object DW-490 exists to prevent — orphaning the bytes and skipping the revision. Now `strict: true`, matching the CAS door; both write doors' fault paths are pinned.
  - `[medium]` `[patch]` A recovered FLAT variant skipped the frontmatter-inferred silo re-route, because that block is guarded by `actualPath === flatPath` and a variant path never equals it — so a stale public flat copy could win over silo bytes, the exact harm that guard exists for. Replaced with an explicit `fromFlatRoot` flag; the comment that claimed the recovery already lost to everything an ordinary read prefers is now true.
  - `[medium]` `[patch]` The headline DW-489 symptom was pinned only at the library surface while the intent states it at the door. Added a `GET /api/workbench/preview` case asserting a defeated spelling answers the ordinary 404 rather than a payload carrying the slug and `editable: true`.
  - `[low]` `[patch]` The new gate block re-derived the leaf as `rest[0]` and carried a dead `slug === null` branch — a second expression of one rule in the module whose docblocks warn that exactly that is how `wiki/alpha.MD` was gated in and then served with no slug. Hoisted and reused the already-computed leaf; the election now tests the same elected-names membership `wikiLeafFilter` tests.
  - `[low]` `[patch]` Three docblocks claimed the listing stays narrower than the gate "in the two respects `wikiLeafName` covers — a non-`.md` leaf and anything below the root". Both halves were wrong (`wikiLeafName` decides depth only; the non-`.md` refusal is `wikiLeafSlug` via `readableWikiLeaf`; and the gate applies all three), so the `wiki/` half is now an EQUALITY. Corrected in the module header, `wikiLeafFilter`, the READ GATE docblock and `WorkbenchFileOptions`.
  - `[low]` `[patch]` Every DW-489 gate test drove the flat root while the tenant silo is the production-normal path. Added a silo-root election case.


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

## Auto Run Result

Status: done

**Implemented change.** DW-202/203's elected-winner rule stopped at the LISTING; it now reaches the read gate and the wiki page key as well, so the elected object is the object everywhere. The election has ONE spelling, in a new pure leaf module both `wiki.ts` and `workbench-files.ts` import (neither could host it — `workbench-files.ts` imports `wiki.ts`). DW-489: `resolveWorkbenchFile` elects over the same depth-1 entries `resolveRoot` already returned and discarded, so the gate's answer is identical to the listing's by construction at no extra storage call — a directly named `wiki/cased.MD` the listing elected against now answers the same indistinguishable `null` every other refusal answers. DW-490: on the ENOENT branch each write door already had, the target is re-elected onto the object carrying the slug, so a save from a lone case-variant row rewrites that object instead of creating a second one and orphaning it; `readWikiPage` recovers the same object, which it previously could not read at all.

**Files changed.**
- `src/lib/wiki-file-names.ts` -- NEW pure leaf, zero imports: `wikiLeafSlug` (moved verbatim), `wikiPageNames`, `electWikiLeafNames` — the one spelling of the election, shared by three callers across two modules.
- `src/lib/workbench-files.ts` -- re-exports `wikiLeafSlug` so no importer moved; `wikiLeafFilter` derives its set from the shared election instead of restating it; `resolveWorkbenchFile` applies the election to the wiki root; `resolveRoot` now propagates `failed` so an indeterminate listing does not elect; four docblocks corrected where they asserted the gate's reach is wider than the listing's.
- `src/lib/wiki.ts` -- internal `readStoredPageVariant` (three bounded probes, ENOENT-as-absent, strict-rethrows) wired into `readWikiPage`'s total-miss branch, `writeWikiPage`'s ENOENT catch and `writeWikiPageIfContentMatches`' ENOENT branch; the flat-root silo re-route now keys on an explicit flag so a recovered variant gets it too.
- `src/app/api/workbench/preview/route.ts` -- comment only: the refusal is upstream, and nothing at the slug derivation enforces it.
- `src/lib/__tests__/wiki.test.ts` -- `case-variant page keys`: a `simulateStore` harness spying the storage singleton so only exact keys answer (a simulated case-SENSITIVE store), covering both write doors, read recovery, the silo root, the flat/silo preference and both fault paths.
- `src/lib/__tests__/workbench-tree.test.ts` -- the two tests encoding the retired wider reach rewritten; new cases for an unlisted spelling, the silo-root election, and an indeterminate listing.
- `src/lib/__tests__/workbench-preview.test.ts` -- unit bindings for `electWikiLeafNames` / `wikiPageNames`, and a door-level case pinning that a defeated spelling 404s at `GET /api/workbench/preview`.

**Review findings.** 7 patches applied (medium 4, low 3; no high). 1 deferred: the delete and existence doors still address `<slug>.md` only, so a variant-held Page survives a "successful" hard delete and reads as absent to `wikiPageExists` — recorded in frontmatter `deferred` alongside the pre-existing `createWikiPage` create-conflict entry. 12 rejected: sibling canonical-only call sites in other modules (pre-existing blast radius, not caused here), spec-directed test placement, the `queries/` depth-2 probe shape (it mirrors the canonical key the same slug already uses), a probe/CAS race the etag still closes, and several descriptive intent-alignment observations.

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 4, low 3. The score counts only `high` patched findings; there were none.

**Verification.**
- `npx tsc --noEmit` -- clean.
- `npx vitest run src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/wiki.test.ts` -- 487 passed.
- `npx vitest run` -- 372 files, 9243 passed, 1 skipped, 0 failed (baseline before this work: 9237 passing).
- `pnpm lint` -- no errors (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` warnings).
- Matrix audit: every I/O row has a covering test that ran and passed, including the unmodified lone-variant listing test at `src/lib/__tests__/workbench-tree.test.ts:969-980`, which is the case-INSENSITIVE store's shape and the pin a naive revert breaks.

**Residual risks.**
- The read gate now depends on the root LISTING succeeding. A failed listing no longer refuses everything (patched), but a listing that succeeds while lagging behind a just-written object will refuse that object until the prefix catches up — the same window the Files tab itself has, which is the equality this change is for rather than a defect it introduced.
- A genuinely absent page costs three extra reads per attempted root on the ENOENT branch (negative caching, first writes). Unreachable on a case-insensitive store, where the canonical spelling resolves the object and no probe runs.
- On a case-INSENSITIVE store, asking the gate for `wiki/cased.md` when the listing elected `wiki/cased.MD` now answers `null` where the filesystem's folding would once have resolved it. That is the matrix's "Unlisted spelling is refused" row — intended, and the one narrowing beyond the collision case.
- Both deferrals share one root cause: doors other than the three this decision named still spell a Page `<slug>.md`. Each is a decision (create-conflict, delete sweep, existence probe cost) rather than a relocation, which is why they were recorded rather than taken here.
