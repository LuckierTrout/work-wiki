---
title: 'DW-741: the delete and existence doors name the elected object, not the canonical spelling'
type: 'bugfix'
created: '2026-09-05'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A hard delete removes only the ELECTED spelling, so on a case-SENSITIVE
      store holding two case siblings the defeated one survives, is promoted to
      the winner on the next read, and the Page serves a body after a delete
      that reported success.
    evidence: |-
      `src/lib/lifecycle.ts`'s delete branch resolves one key per root through
      `findStoredPageKey`, which returns the `electWikiLeafNames` winner. With
      `wiki/cased.MD` and `wiki/cased.Md` both present, the delete unlinks
      `.MD` (the lexicographic winner) and the next `readWikiPage("cased")`
      recovers `.Md` and serves it — the verbatim symptom DW-741 names, on a
      shape DW-741 did not stage (its ledger entry and this bundle's intent
      both describe a store "holding only `wiki/cased.MD`").
      It is WORSE than the survivor's pre-delete state, not merely unfixed:
      steps 2b-2e already ran, so the index entry, revisions, discussions and
      backlinks are gone while the URL still serves content.
      Left open deliberately. The intent directs "the ENOENT-branch variant
      probe ... with the `electWikiLeafNames` election", and the election names
      ONE object; sweeping every spelling instead is the wider ruling the
      source ledger entry calls out as a decision ("which spellings a delete is
      entitled to sweep"). Closing it means deciding that a defeated sibling —
      which is not listed, not readable and not writable — is nonetheless
      deletable.
    location: >-
      src/lib/lifecycle.ts (delete branch, elected-key resolution)
    severity: low
baseline_revision: '44555cf2ecdbb754347467d797a74c35344d27b0'
---

<intent-contract>

## Intent

**Problem:** DW-489/490 retargeted three doors — `readWikiPage` recovery, `writeWikiPage`, `writeWikiPageIfContentMatches` — onto the stored object that carries a slug, so a Page held on a case variant (`wiki/cased.MD`) is now live, listed, readable and writable. Two sibling doors did not move with it and each is a wrong answer the owner can hit: `src/lib/lifecycle.ts:636,:644` unlinks exactly `<slug>.md` and swallows ENOENT, so on a case-SENSITIVE store a hard delete of a variant-held Page reports success, removes nothing, and the next `readWikiPage` serves the full body; and `wikiPageExists` (`src/lib/wiki.ts:305`) probes the same single spelling and answers `false`, so `GET /api/ingest/status/[jobId]` calls a readable Page `gone` and 404s a completed ingest out of the Recent-ingests strip.

**Approach:** Give both doors the same election the read and write doors already use. One exported helper in `src/lib/wiki.ts` answers "which storage key under this root carries this slug" — canonical first, then the existing `readStoredPageVariant` probe on the ENOENT branch — and both `wikiPageExists` and the lifecycle delete branch resolve their target through it instead of building `<slug>.md`.

## Boundaries & Constraints

**Always:**
- ONE spelling of the resolution: a single exported helper in `src/lib/wiki.ts` wrapping the existing `readStoredPageVariant`, used by both doors. No call site restates the candidate set or the election.
- Canonical-first and ENOENT-gated, exactly as the write doors are: the variant probe runs only after `<slug>.md` itself answered ENOENT under that root. On a case-INSENSITIVE store the canonical spelling resolves the stored object, so the probe is unreachable and both doors target the key they target today.
- `wikiPageExists` keeps its documented contract verbatim: `false` for a genuinely absent page and for a malformed slug, a RE-THROWN non-ENOENT storage failure, silo-then-flat order, and the O(1) page-index lookup only (never `tenantForSlug`, which recurses).
- The delete branch resolves its target with the same strictness it already delivers: a non-ENOENT storage failure fails the delete rather than being flattened into "no variant, nothing to remove". `deleteFile`'s own ENOENT stays swallowed on both arms.
- The delete resolution must NOT hang off `deleteFile`'s ENOENT: `deleteFile` is provider-dependent on a missing key (R2 deletes silently, filesystem throws), so the target is resolved BEFORE the unlink or the fix would not exist on R2.
- When no spelling of the slug is present under a root, the delete still issues the canonical unlink it issues today — resolution narrows the target, it never turns the delete into a no-op.
- Both doors are pinned against a SIMULATED case-sensitive store, because the dev host's volume is case-insensitive and cannot keep two spellings apart.

**Block If:**
- Closing either door turns out to require a change to `readStoredPageVariant`'s own rule (its candidate set, its election, or its `strict` semantics) rather than a new caller of it.

**Never:**
- Do not sweep every spelling on delete. The elected object is the Page; a defeated sibling is not listed, not readable and not writable, and deciding it is also deletable is a separate ruling this bundle does not carry.
- Do not change `createWikiPage` or `src/lib/lifecycle.ts`'s `createOnly` branch — that is DW-740, a create-conflict decision awaiting a human ruling.
- Do not change `electWikiLeafNames`, `wikiPageNames`, `wikiLeafSlug`, `readableWikiLeaf`, or `wikiLeafName`.
- Do not change `readWikiPage`, `writeWikiPage`, `writeWikiPageIfContentMatches`, or `resolveWorkbenchFile`.
- Do not change `GET /api/ingest/status/[jobId]`'s response shape or its fall-through-on-error handling.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Delete removes the variant it read | case-SENSITIVE store, flat root holds only `wiki/cased.MD` | `deleteWikiPage("cased")` removes `wiki/cased.MD`; a following `readWikiPage("cased", { fresh: true })` answers `null` | No error expected |
| Delete removes a silo variant | case-SENSITIVE store, page index routes `cased` to `alice`, only `tenants/alice/wiki/cased.MD` present | that object is removed | No error expected |
| Canonical delete unchanged | canonical `<slug>.md` present under a root | that exact key is unlinked and no variant is probed under that root | ENOENT still swallowed |
| Genuinely absent page | no spelling present under either root | the canonical unlink is still issued and its ENOENT swallowed; the op behaves exactly as today | No error expected |
| Delete resolution hits a fault | canonical ENOENT, a variant read rejects non-ENOENT | the delete rejects with that error rather than reporting success | Rethrow |
| Existence sees the variant | case-SENSITIVE store, only `wiki/cased.MD` present | `wikiPageExists("cased")` → `true`, agreeing with `readWikiPage` | No error expected |
| Existence sees a silo variant | index routes `cased` to `alice`, only `tenants/alice/wiki/cased.MD` present | `wikiPageExists("cased")` → `true` | No error expected |
| Existence still says absent | no spelling present | `wikiPageExists` → `false` | No error expected |
| Existence hits a fault | canonical ENOENT, a variant read rejects non-ENOENT | rethrown, so the ingest-status route logs and returns the job rather than 404ing it | Rethrow |
| Malformed slug | `wikiPageExists("../etc")` | `false`, probing nothing | No error expected |

</intent-contract>

## Code Map

- `src/lib/wiki.ts:406-471` -- `readStoredPageVariant`, the DW-490 probe: three bounded parallel reads of the NON-canonical spellings, ENOENT-as-absent, non-ENOENT rethrown under `strict`, elected through `electWikiLeafNames`, returning `{ key, content }` or `null`. Already private to this module; the new helper wraps it and is what both doors import. Its docblock states the ENOENT-branch-only rule that both new callers must obey.
- `src/lib/wiki.ts:298-337` -- `wikiPageExists`. Its docblock states the re-throw contract (the ingest-status route must not drop a live job on a blip). `:317-327` is the silo arm (page-index lookup, `readFile` on `tenantWikiRelPath(tenant, `${slug}.md`)`, fall through on ENOENT); `:329-336` the flat arm. Both are what the helper replaces. Note it deliberately uses `readFile` rather than `fileExists` so a non-ENOENT fault is distinguishable — `fileExists` swallows every error on the filesystem provider (`src/lib/storage/filesystem.ts:512-519`).
- `src/lib/wiki.ts:42-44` (`wikiRelPath`) and `:144` (`tenantWikiRelPath`) -- the two key builders the helper must use so silo and flat stay one spelling each. `getStorage`, `isEnoent`, `logger`, `tenantForOwner`, `getPageIndex` are all already in scope here.
- `src/lib/lifecycle.ts:600-651` -- the delete branch of `writeWikiPageWithSideEffects`. `:601-623` is the pre-delete read; `:629-632` the required revision erasure; `:634` `const deleteTenant = tenantForOwner(deletedOwner)`; `:635-641` the silo unlink and `:643-650` the flat unlink, each building `${slug}.md` and swallowing ENOENT inline. Both unlinks stay, with resolved targets.
- `src/lib/lifecycle.ts:5-22` -- the `./wiki` import block, where the new helper is added.
- `src/lib/storage/types.ts:355-360` -- `deleteFile`'s contract: "throws if the file does not exist (provider-dependent)". `src/lib/storage/r2.ts:135-138` deletes silently on a missing key. This is why the delete target must be resolved before the unlink rather than on its ENOENT.
- `src/app/api/ingest/status/[jobId]/route.ts:43-59` -- the only production caller of `wikiPageExists`. READ-ONLY: it already falls through on a thrown error and 404s only on a `false`; the fix lands entirely under it.
- `src/lib/__tests__/wiki.test.ts:2410-2467` -- the `case-variant page keys` describe and its `simulateStore` harness (exact-key map spying `readFile`/`readFileWithEtag`/`fileExists`/`writeFile`/`writeFileIfMatch` on the storage singleton; seeding `derived-indexes/pages.json` is how a slug is routed to a silo). Reuse it for the `wikiPageExists` cases; it does NOT yet spy `deleteFile`.
- `src/lib/__tests__/lifecycle.test.ts:36-77` -- the tmp-dir + `WIKI_DIR`/`RAW_DIR`/`DATA_DIR` harness on the REAL filesystem provider. `:673-1131` is the `deleteWikiPage` describe. Because the host volume folds case, a case-sensitive store is staged here by spying `readFile`/`deleteFile` to answer ENOENT for the canonical key only and delegating everything else to the real provider (`:1509-1518` shows the delegate-to-real spy pattern).
- `src/lib/__tests__/lifecycle.test.ts:1519-1523` -- the comment recording that this file's `afterEach` does not restore mocks, so any spy taken inside a test must come back off in a `finally`.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki.ts` -- Add an exported `findStoredPageKey(slug, tenant: string | null, strict = true): Promise<string | null>`: build the canonical key with `tenantWikiRelPath`/`wikiRelPath`, `readFile` it and return it on a hit, and on ENOENT delegate to `readStoredPageVariant(slug, tenant, strict)` and return its `key` (or `null`). Non-ENOENT on the canonical read follows `strict` exactly as the probe does. Docblock: this is the ONE resolution the delete and existence doors share, it is ENOENT-gated so a case-insensitive store never reaches the probe, and it uses `readFile` rather than `fileExists` because only `readFile` distinguishes a fault from an absence. -- DW-741 needs one resolution, not two restatements of the candidate set.
- `src/lib/wiki.ts` -- Re-express `wikiPageExists` over `findStoredPageKey`: silo arm (when the page index resolves an entry) then flat arm, each `!== null`. The docblock gains a line recording that it now agrees with `readWikiPage` about a variant-held Page, which is the disagreement DW-741 names. -- The existence half.
- `src/lib/lifecycle.ts` -- In the delete branch, resolve each unlink target with `findStoredPageKey` before unlinking — silo with `deleteTenant`, flat with `null` — falling back to the canonical key when it answers `null` so an absent page behaves exactly as today. Keep both `try`/`catch` ENOENT swallows. Comment: `deleteFile` is provider-dependent on a missing key, so the resolution cannot hang off its ENOENT. -- The delete half; a hard delete must remove the object the pre-delete read was shown.
- `src/lib/__tests__/wiki.test.ts` -- In `case-variant page keys`, add `wikiPageExists` cases: lone flat variant → `true`; lone silo variant (seeded page index) → `true`; nothing present → `false`; malformed slug → `false` with no storage call; a non-ENOENT variant fault → rejects. -- The matrix's existence rows on a simulated case-SENSITIVE store.
- `src/lib/__tests__/lifecycle.test.ts` -- Add a describe staging a case-SENSITIVE store (spy `readFile`/`deleteFile` to answer ENOENT for the canonical wiki keys of one slug and delegate everything else to the real provider; restore in a `finally`): a hard delete of a variant-held Page removes `wiki/cased.MD` and the following `readWikiPage(..., { fresh: true })` answers `null`; a canonical-held page still unlinks the canonical key and probes nothing; deleting an absent page still behaves as today. -- The matrix's delete rows; the headline data-loss symptom pinned at the door.

**Acceptance Criteria:**
- Given a case-SENSITIVE store whose only object for slug `cased` is a case variant, when the Page is hard-deleted, then no spelling of it reads back and the op's reported success is true rather than vacuous.
- Given the same store, when `wikiPageExists` and `readWikiPage` are both asked about that slug, then they agree — the disagreement that 404s a completed ingest out of the Recent-ingests strip is gone.
- Given a case-INSENSITIVE store or any page whose canonical `<slug>.md` is present, when either door runs, then it makes the same storage calls against the same key it does today and no variant is probed.
- Given the full suite, when `pnpm vitest run` executes it, then no existing test regresses.

## Spec Change Log

_No spec amendments: no finding in this run's review was routed `bad_spec`._

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 3, low 6)
- defer: 1: (high 0, medium 0, low 1)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` THE DELETE-SIDE HARNESS DID NOT SIMULATE A CASE-SENSITIVE STORE. `simulateCaseSensitive` hid only the canonical name by suffix and delegated every other key to the real, case-FOLDING host volume — so `cased.Md` and `cased.mD` still resolved the file staged as `cased.MD`, the probe saw three hits where the store presents one, and the tests could pass on `electWikiLeafNames`' tie-break rather than on the fix. Rewritten as an exact-key simulation: only the staged spellings answer, and every other `.md` casing of that slug is ENOENT under any root. Added a both-roots case whose two roots hold DIFFERENT spellings (`tenants/alice/wiki/cased.MD` and `wiki/cased.Md`), which the old harness could not have passed.
  - `[medium]` `[patch]` The two canonical-unlink assertions were satisfied by a LATER call from a different site: `removeSiloForPage`'s fail-soft `deleteSafe` unlinks the same `tenants/<t>/wiki/<slug>.md` in the cleanup batch, on the same spy. A mutation that dropped the delete branch's own silo unlink entirely still passed. Both now assert against a snapshot of `deleteFile.mock.calls` taken AT the flat unlink — the delete branch's last storage act — and the same mutation now fails.
  - `[medium]` `[patch]` A flat-key resolution fault threw AFTER the silo object was already unlinked and after `deleteRevisions` had erased history, leaving a half-applied delete: revisions gone, silo object gone, flat copy and every derived-index cleanup untouched. Both keys now resolve before the revision erasure, so a strict-read fault aborts with nothing destroyed; the fault test was re-armed on the silo probe (a key only the delete branch's resolution reaches) and now also asserts that no `deleteFile` and no `deleteDirectory` ran.
  - `[low]` `[patch]` `findStoredPageKey`'s `strict` parameter was dead — both call sites took the `true` default, so the log-and-continue branch was unreachable and untested. Parameter and branch removed; the helper is always strict, which is the only mode either door can correctly use.
  - `[low]` `[patch]` The helper's docblock claimed "no extra round trips", true only on the canonical-HIT path. Corrected to state that a hit costs exactly what it cost before and a miss costs four reads per root, and that both callers reach a miss only on a slug with no Page under that root.
  - `[low]` `[patch]` No test pinned the canonical-hit "probes nothing" half for `wikiPageExists` — the door whose cost is paid per poll on the ingest-status route. Added a case asserting `true` with exactly the canonical page read and no variant spelling.
  - `[low]` `[patch]` The delete-branch comment read as an unconditional closure ("A HARD DELETE MUST REMOVE THE OBJECT THE PRE-DELETE READ WAS SHOWN") while the resolution elects ONE spelling per root. It now records that a defeated sibling survives and is promoted on the next read, and points at the deferral.
  - `[low]` `[patch]` `simulateCaseSensitive`'s docblock justified its `finally` with a claim the file contradicts: `afterEach` calls `_resetStorage()`, so a leaked storage spy cannot reach a later test. Reworded as hygiene within the test, with the real trap (case folding) stated instead.
  - `[low]` `[patch]` `findStoredPageKey` is exported but builds a storage key without `validateSlug`, unlike its exported siblings. Both callers validate first; recorded in the docblock as the helper's contract rather than duplicating the check.

## Design Notes

The elected object is the Page — that is DW-489/490's rule, and this is the same rule applied to the two doors that were left addressing a name instead of an object. Nothing new is decided: the candidate set, the election and the `strict` semantics are `readStoredPageVariant`'s, unchanged.

The one shape that is NOT a copy of the write doors is where the delete hooks in. `writeWikiPage` re-elects inside its own ENOENT catch because `readFile` reliably reports absence. `deleteFile` does not — the interface says "throws if the file does not exist (provider-dependent)" and R2 deletes a missing key silently — so a variant sweep hung off that catch would be dead code on R2, which is the deployment the case-SENSITIVE store actually is. Resolving the target first is what makes the fix exist on both providers:

```ts
// `deleteFile` is silent on a missing key on R2 and throws on the filesystem,
// so the target is resolved BEFORE the unlink, never on its ENOENT.
const siloKey =
  (await findStoredPageKey(slug, deleteTenant)) ??
  tenantWikiRelPath(deleteTenant, `${slug}.md`);
```

Deleting only the ELECTED spelling, not all four, is deliberate. A defeated sibling is not listed, not readable and not writable; treating it as deletable is a wider ruling than "the delete removes what the reader was shown", and this bundle carries the narrower one.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/wiki.test.ts src/lib/__tests__/lifecycle.test.ts` -- expected: all pass, including the new delete and existence cases
- `npx vitest run` -- expected: no regressions against the baseline suite
- `npx tsc --noEmit` -- expected: no new type errors
- `pnpm lint` -- expected: no new errors

## Auto Run Result

Status: done

**Implemented change.** DW-489/490 moved three doors onto the stored OBJECT that carries a slug; DW-741 moves the two that were left addressing the NAME. `src/lib/wiki.ts` gains one exported resolution — `findStoredPageKey(slug, tenant | null)`: canonical `<slug>.md` first, and only on its ENOENT the same `readStoredPageVariant` probe and `electWikiLeafNames` election the read and write doors already use. `wikiPageExists` is re-expressed over it (silo arm then flat arm), so it now agrees with `readWikiPage` about a variant-held Page instead of calling it `gone` and 404ing a completed ingest out of the Recent-ingests strip. The lifecycle delete branch resolves both unlink targets through it, so a hard delete of a variant-held Page removes the object the pre-delete read was shown rather than reporting success and removing nothing.

Two shapes differ from the write doors on purpose. The delete resolution runs BEFORE the unlink rather than on its ENOENT, because `deleteFile` is provider-dependent on a missing key (R2 deletes silently) and a re-election hung off that catch would be dead code on the deployment that is actually case-sensitive. And both keys resolve before `deleteRevisions`, so a strict-read fault aborts the op with nothing destroyed rather than leaving revisions erased under a surviving Page.

**Files changed.**
- `src/lib/wiki.ts` -- new exported `findStoredPageKey`, always strict, `readFile`-based so a fault stays distinguishable from an absence; `wikiPageExists` re-expressed over it with its documented contract (malformed slug, silo-then-flat, non-ENOENT re-throw, page-index-only lookup) intact.
- `src/lib/lifecycle.ts` -- the delete branch resolves both unlink targets through `findStoredPageKey` before the revision erasure, each falling back to the canonical key so an absent page behaves exactly as today; both ENOENT swallows kept.
- `src/lib/__tests__/wiki.test.ts` -- six `wikiPageExists` cases in the `case-variant page keys` describe: lone flat variant, lone silo variant, canonical-hit probing nothing, genuine absence, malformed slug, and a non-ENOENT fault that rethrows.
- `src/lib/__tests__/lifecycle.test.ts` -- a `deleteWikiPage case-variant targets` describe with an exact-key case-sensitive simulation: flat variant, silo variant, both roots on different spellings, the canonical path probing nothing, the no-spelling root still unlinking canonically, and an indeterminate resolution failing before anything is destroyed.

**Review findings.** 9 patches applied (medium 3, low 6; no high) — the three medium ones were all verification defects rather than behaviour defects: a delete-side harness that modelled a case-FOLDING volume rather than a case-sensitive store, two canonical-unlink assertions that a later fail-soft cleanup satisfied on the delete branch's behalf, and a resolution ordering that could leave a half-applied delete. 1 deferred: deleting the elected spelling promotes a defeated case sibling, so a two-variant store still serves a body after a "successful" delete — recorded in frontmatter `deferred`, because sweeping every spelling is the wider ruling the source ledger entry names as a decision. 6 rejected: reported intermittent test failures (not reproducible — three review agents were concurrently editing `src/lib/lifecycle.ts` and `src/lib/silo.ts` in this working copy while running tests; 8 consecutive clean runs of the pair and two clean full suites on the reviewed tree), re-resolving instead of reusing the pre-delete read's `page.path` (an absolute FS path, not a storage key), `removeSiloForPage`'s canonical-only unlink (pre-existing, fail-soft, and downstream of the primary unlink that now resolves), a suggestion that a silo-arm fault fall back to flat (the re-throw contract exists to forbid exactly that masking), reading whole bodies to obtain a key (`fileExists` cannot distinguish a fault from an absence, which is what both doors need), and the eight-reads-per-miss cost (the miss path is terminal — the route 404s and the client drops the job — while the hit path is unchanged at one read).

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 3, low 6. The score counts only `high` patched findings; there were none.

**Verification.**
- `npx tsc --noEmit` -- clean.
- `pnpm lint` -- clean (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices).
- `npx vitest run src/lib/__tests__/wiki.test.ts src/lib/__tests__/lifecycle.test.ts` -- 259 passed, and stable across repeated runs.
- `npx vitest run` -- 388 files, 9794 passed, 1 skipped, 0 failed (baseline before this work: 9789 passing).
- Mutation checks: reverting `src/lib/lifecycle.ts` fails 3 of the new delete tests; reverting `src/lib/wiki.ts` fails 3 of the new existence tests; replacing the silo key's canonical fallback fails "still issues the canonical unlink" (it did not before the snapshot fix).
- Matrix audit: every I/O row has a covering test that ran and passed — five delete rows in `lifecycle.test.ts`, five existence rows in `wiki.test.ts`.

**Residual risks.**
- The recorded deferral: a defeated case sibling survives the delete and is promoted on the next read. Reachable only on a case-sensitive store that already holds two spellings for one slug.
- A miss now costs four reads per root instead of one, on both doors. Unreachable on a case-insensitive store (the canonical spelling resolves the object), and on the polled ingest-status route the miss is terminal — it 404s the job and the client drops it.
- The delete resolves its target independently of the pre-delete read rather than reusing it (`readWikiPage` reports an absolute filesystem `path`, not a storage key). The two elections agree by construction — same candidate set, same rule, same roots — but not by structure.
