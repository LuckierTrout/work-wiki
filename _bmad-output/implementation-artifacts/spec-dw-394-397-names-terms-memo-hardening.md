---
title: 'Names & Terms and Workspace guidance memos: tenant keys and frozen entries'
type: 'bugfix'
created: '2026-08-27'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `listNamesTerms` returns entries that are frozen at runtime while the
      exported `NamesTermEntry` type and the `Promise<NamesTermEntry[]>` return
      type still advertise them as mutable, so a would-be mutation compiles
      cleanly and fails only when that line executes.
    evidence: |-
      DW-397 was closed with `Object.freeze` plus tests, and the spec put
      `readonly` types explicitly out of scope as a ripple beyond the fix. The
      residual asymmetry is real: `createNamesTerm` / `updateNamesTerm` return
      UNFROZEN entries of the same declared type, and both shapes reach
      `src/app/api/names-terms/route.ts` as `NamesTermEntry`, so a consumer
      reasoning from the type is right only half the time. A readonly return
      type (e.g. `Readonly<Omit<NamesTermEntry, "aliases">> & { readonly
      aliases: readonly string[] }`) would move the failure to compile time.
    location: >-
      src/lib/names-terms.ts:16
    severity: low
  - summary: >-
      A corrupt `names-terms.json` holding a non-object element alongside real
      entries still throws out of the sort comparator in `resolveSortedEntries`,
      so the read fails rather than degrading.
    evidence: |-
      `readEntries` validates only `Array.isArray(parsed)`. The freeze loop
      added by this story now skips non-object elements, but the `.sort()` that
      runs BEFORE it dereferences `a.kind` / `a.canonical`, so `[null, entry]`
      throws `TypeError: Cannot read properties of null (reading 'kind')`.
      Confirmed empirically during this story: `[null]` alone resolves (the
      comparator is never called for a single element), two-or-more does not.
      Pre-existing — the throw predates this change and is unrelated to
      DW-394/DW-397 — but nothing validates entry shape at the read boundary.
    location: >-
      src/lib/names-terms.ts:169
    severity: low
baseline_revision: '121649eee01f45b16835105188da5542ac07e465'
---

<intent-contract>

## Intent

**Problem:** Both caller-owned guidance memos key on the raw `owner` string while the files they memoize are addressed by TENANT (`ownerToTenant` lowercases and collapses punctuation), so `"Alice"` and `"alice"` occupy two map slots over one file — two reads and two snapshots that can diverge under one handle (DW-394). Separately, `listNamesTerms` returns `[...(await memo)]`, copying only the top-level array, so under a handle every caller of the operation shares the same ENTRY OBJECTS and a future `entry.aliases.push(...)` would leak into every later caller (DW-397).

**Approach:** Key both memos on the derived tenant instead of the raw owner, and freeze the dictionary entries (and their `aliases` arrays) at resolve time so the shared objects cannot be mutated at all. Correct the docblocks that still claim owner-keying, and pin both invariants with tests.

## Boundaries & Constraints

**Always:**
- Derive the memo key with the SAME function the file address uses: `tenant(owner)` in `names-terms.ts` (the module's existing local helper over `tenantForOwner` + `validateTenant`), and `ownerToTenant` in `workspace-guidance.ts`.
- `buildWorkspaceGuidance` must keep its never-rejects contract — its key derivation must not be able to throw, which is why it uses `ownerToTenant` (total: always a non-empty tenant, `DEFAULT_TENANT` on fallback) rather than the throwing `validateTenant` pair.
- The uncached path stays behaviourally identical apart from the entries now being frozen; no `cache` argument means no memo, exactly as today.
- Freeze in `resolveSortedEntries` only, so cached and uncached paths cannot drift. `readEntries` stays unfrozen — `createNamesTerm` / `updateNamesTerm` / `deleteNamesTerm` mutate the array they read.
- Freeze covers the entry object AND its `aliases` array (the only nested mutable value on `NamesTermEntry`).
- Every docblock that states the key must state the tenant: `names-terms.ts` `NamesTermsCache`, `workspace-guidance.ts` `WorkspaceGuidanceCache`, and `guidance-cache.ts`'s "owner-keyed" framing.

**Block If:** A consumer of `listNamesTerms` turns out to mutate an entry or its `aliases` (investigation found none — all five consumers read only).

**Never:** Do not introduce a module-level/global/TTL cache, do not change the public signatures of `listNamesTerms`, `buildNamesTermsGuidance` or `buildWorkspaceGuidance`, do not change the exported TypeScript types to `readonly` (a ripple beyond this fix), and do not freeze the returned top-level array — callers legitimately sort/splice their own copy.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Two owner casings, one handle | `listNamesTerms("Alice", h)` then `listNamesTerms("alice", h)`, dictionary at `tenants/alice/names-terms.json` | One storage read of that path; both calls return the same snapshot | No error expected |
| Same for workspace guidance | `buildWorkspaceGuidance("Alice", h)` then `buildWorkspaceGuidance("alice", h)` | One read of `tenants/alice/wikis.json` and one of the profile; identical strings | Fail-soft `""` unchanged |
| Distinct tenants, one handle | `listNamesTerms("alice", h)` and `listNamesTerms("bob", h)` | Separate entries, no crossing (existing tests keep passing) | No error expected |
| Entry mutation attempt | `(await listNamesTerms(o, h))[0].aliases.push("x")` | Throws `TypeError` (frozen); a later call under the same handle still sees the original aliases | TypeError surfaces to the mutating caller |
| Array mutation still allowed | Caller does `entries.sort()` / `entries.splice(0,1)` on its result | Succeeds; next cached caller gets a fresh, complete array | No error expected |
| Failed read under a handle | Non-ENOENT storage error | Rejection still evicted under the TENANT key, next call re-reads | Original error propagates |

</intent-contract>

## Code Map

- `src/lib/names-terms.ts` -- the fix site. `tenant()` :82-86 is the shared derivation; `dictionaryPath` :88-90 and `lockKey` :92-94 already route through it. `NamesTermsCache` docblock :186-223 (the "Keyed by `owner`" claim is :219-221). `resolveSortedEntries` :234-238 is where the freeze belongs. `listNamesTerms` :257-282 does `cache.get(owner)` / `cache.set(owner, …)` at :262-279 (including the eviction `cache.get(owner) === pending` at :278) and `[...(await memo)]` at :281; its docblock :240-256 claims "The entry objects themselves are shared … and no caller mutates them" and must be rewritten.
- `src/lib/workspace-guidance.ts` -- the sibling memo. `WorkspaceGuidanceCache` docblock :29-43 ("Keyed by `owner`" at :40-42); `buildWorkspaceGuidance` :111-121 does `cache.get(owner)` / `cache.set(owner, pending)` at :116-119. `resolveWorkspaceGuidance` :55-80 catches everything and returns `""`, so the key derivation must not throw outside it.
- `src/lib/links.ts` -- `ownerToTenant` :130-138 (pure leaf, only imports `./slugify`): lowercases, replaces whitespace/control/`/`/`\`/`.` runs with `-`, trims dashes, falls back to `DEFAULT_TENANT`. Total function — its output can never fail `validateTenant`. Import it here for the workspace-guidance key.
- `src/lib/wiki.ts` -- `tenantForOwner` :105-107 delegates to `ownerToTenant`; `validateTenant` :83-95 is the defensive guard `names-terms.ts`'s `tenant()` already applies.
- `src/lib/guidance-cache.ts` -- composite handle; docblock :1-2 and :42-47 still say "owner-keyed"/"per owner". Comment-only correction.
- `src/lib/__tests__/names-terms.test.ts` -- `describe("names and terms dictionary caching")` from :141; reusable helpers `dictionaryFile` :143-145, `writeDictionaryBytes` :148-157, `entry` :159-167, `countReads` :173-183. The array-copy test "hands every cached caller its own array…" is at :250-267 — the new object-level test sits beside it; the cross-owner test is at :328-339.
- `src/lib/__tests__/workspace-guidance.test.ts` -- `describe("buildWorkspaceGuidance caching")` from :91; helpers `writeProfileBytes` :55-75, `countReads` :80-89; `createWiki` / `wikiRegistryPath` / `wikiProfilePath` already imported.
- READ-ONLY EVIDENCE (do not change these; they are why freezing is safe): every consumer of `listNamesTerms` reads only — `src/lib/monitor-digests.ts:437`, `src/lib/action-items.ts:102` and `:180`, `src/lib/structured-knowledge.ts:308`, `src/lib/action-extractor.ts:42`, `src/lib/ingest.ts:1864`, and `src/app/api/names-terms/route.ts:19` (serializes to JSON). `canonicalizeNamesTerm` :340-356, `applyNamesTermsToGeneratedText` :362-380 and `renderNamesTermsGuidance` :403-417 are pure over `readonly NamesTermEntry[]`.

## Tasks & Acceptance

**Execution:**
- `src/lib/names-terms.ts` -- key the memo on `tenant(owner)` (compute once, use for `get`, `set` and the eviction identity check), and freeze each entry plus its `aliases` array in `resolveSortedEntries` -- the memo must be keyed by whatever addresses the file, and freezing at the single shared resolve point keeps cached and uncached paths identical.
- `src/lib/names-terms.ts` -- rewrite the `NamesTermsCache` docblock's "Keyed by `owner`" paragraph and the `listNamesTerms` "entry objects are shared … no caller mutates them" paragraph -- the old text now states the opposite of the invariant the code enforces.
- `src/lib/workspace-guidance.ts` -- import `ownerToTenant` from `./links`, key the memo on it, and correct the "Keyed by `owner`" paragraph -- same defect, same file-addressing reason; `ownerToTenant` is total so the fail-soft contract survives.
- `src/lib/guidance-cache.ts` -- correct the "owner-keyed" / "per owner" wording to tenant -- comment-only, so the composite does not re-assert the claim the leaves just dropped.
- `src/lib/__tests__/names-terms.test.ts` -- add a tenant-collapse test (two owner casings, one handle, one counted read, same snapshot) and an object-level immutability test (entry and `aliases` frozen; a `push` throws; the next cached caller still sees the original aliases; array sort/splice still works) -- these are the I/O matrix rows and the invariant DW-397 asks to pin.
- `src/lib/__tests__/workspace-guidance.test.ts` -- add a tenant-collapse test (two owner casings, one handle, one registry read and one profile read, identical guidance) -- pins the sibling half of DW-394.

**Acceptance Criteria:**
- Given a dictionary at `tenants/alice/names-terms.json` and one `NamesTermsCache` handle, when `listNamesTerms` is called with `"Alice"` and then `"alice"`, then the storage layer reads that path exactly once and both results carry the same entries.
- Given one `WorkspaceGuidanceCache` handle and a Wiki owned by `"alice"`, when `buildWorkspaceGuidance` is called with `"Alice"` and then `"alice"`, then `tenants/alice/wikis.json` and the profile file are each read exactly once and both calls return the same string.
- Given entries returned by `listNamesTerms` (with or without a handle), when a caller attempts `entry.aliases.push(...)` or assigns to `entry.canonical`, then a `TypeError` is thrown and no later caller observes a change.
- Given entries returned by `listNamesTerms` under a handle, when a caller sorts or splices the returned array, then the next call under the same handle still returns the full, correctly-ordered array.
- Given the existing suites for both modules, when they run unchanged, then every prior assertion still passes (owner separation, in-flight sharing, failed-read eviction, fail-soft `""`).

## Spec Change Log

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 0, low 7)
- defer: 2: (high 0, medium 0, low 2)
- reject: 8
- addressed_findings:
  - `[low]` `[patch]` The freeze loop dereferenced `entry.aliases` on values straight out of `JSON.parse`, so a dictionary holding a single `null` element threw a `TypeError` out of `listNamesTerms` where it previously passed through — a regression introduced by this change. Added a non-object skip guard in `resolveSortedEntries`.
  - `[low]` `[patch]` The failed-read eviction test used `"alice"`, whose raw handle already equals its tenant, so it could not distinguish the old `owner` key from the new `tenant(owner)` key — reverting the two eviction lines left the suite green. Added `"evicts a FAILED read under the TENANT key, not the raw handle"` (mutation-checked: fails against the reverted key).
  - `[low]` `[patch]` The uncached freeze test asserted only that `aliases.push` throws, while the acceptance criterion and the cached test also cover property assignment. Added the `entry.canonical = …` assertion.
  - `[low]` `[patch]` `workspace-guidance.ts` claimed `ownerToTenant` is "the same derivation the registry and profile paths use"; those paths call `tenantFor` (`tenantForOwner` + `validateTenant`). Reworded to state the sameness holds by delegation, not by symbol.
  - `[low]` `[patch]` The `resolveSortedEntries` docblock said the CRUD functions "mutate the array and entries they read"; they mutate only the array and build replacements by spread. Corrected.
  - `[low]` `[patch]` Both suites still framed the memo as "per owner" in a section docblock and two test titles after the modules moved to tenant keys. Updated the wording; no assertions changed.
  - `[low]` `[patch]` The finding-1 guard had no permanent test. Added `"does not throw on a non-object element in a corrupt dictionary file"` (mutation-checked against guard removal).

## Design Notes

Why the two modules derive the key differently: `names-terms.ts` already owns a private `tenant()` that validates, and its read path can genuinely reject, so reusing it keeps ONE derivation in that file and surfaces the same error the read would. `workspace-guidance.ts` documents that it never rejects (`resolveWorkspaceGuidance` catches everything and fail-softs to `""`); calling a throwing derivation outside that `try` would break that contract, and `ownerToTenant` — total, never empty — gives the identical string without it.

Freeze shape (the only nested mutable field on `NamesTermEntry` is `aliases`):

```ts
async function resolveSortedEntries(owner: string): Promise<NamesTermEntry[]> {
  const entries = (await readEntries(owner)).sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.canonical.localeCompare(b.canonical),
  );
  for (const entry of entries) {
    Object.freeze(entry.aliases);
    Object.freeze(entry);
  }
  return entries;
}
```

The array itself stays mutable — callers sort and splice their copy, and `[...(await memo)]` still hands each cached caller a fresh one.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/names-terms.test.ts src/lib/__tests__/workspace-guidance.test.ts` -- expected: all pass, including the new tenant-collapse and immutability tests
- `pnpm vitest run src/lib/__tests__/ingest.test.ts src/lib/__tests__/names-terms-routes.test.ts` -- expected: pass; the consumers of the frozen entries are unaffected
- `pnpm lint` -- expected: clean
- `pnpm exec tsc --noEmit` -- expected: no new type errors

## Auto Run Result

Status: done

### Summary

Both caller-owned guidance memos now key on the TENANT that addresses the files they memoize instead of the raw `owner` string (DW-394), and the Names & Terms dictionary entries are frozen at the single resolve point so the objects shared across every caller under a handle cannot be mutated (DW-397). Two spellings of one handle (`"Alice"` / `"alice"`) now share one memo slot over one file instead of taking two reads and two snapshots that can diverge; an `entry.aliases.push(...)` now throws at the mutating line instead of leaking into every later caller.

### Files changed

- `../../src/lib/names-terms.ts` — memo keyed on `tenant(owner)` for `get`/`set`/eviction; `resolveSortedEntries` freezes each entry and its `aliases` (skipping non-object elements from a corrupt file); three docblocks corrected.
- `../../src/lib/workspace-guidance.ts` — memo keyed on `ownerToTenant(owner)` (the total variant, so the never-rejects contract survives a key derivation outside the fail-soft `catch`); two docblocks corrected.
- `../../src/lib/guidance-cache.ts` — comment-only: "owner-keyed" / "per owner" → tenant.
- `../../src/lib/__tests__/names-terms.test.ts` — six new tests: tenant collapse across casings, entry/aliases frozen under a handle, frozen on the uncached path, tenant-keyed eviction of a failed read, corrupt single-`null` element resolves.
- `../../src/lib/__tests__/workspace-guidance.test.ts` — one new test: two casings collapse to one resolution (one registry read, one profile read).

### Review findings breakdown

- Patches applied: 7 (all low severity) — see the Review Triage Log.
- Items deferred: 2 (both low) — the runtime-only freeze with no compile-time counterpart, and the pre-existing unvalidated entry shape at the read boundary.
- Items rejected: 8 — additional punctuation-collapse cases for an invariant already pinned, an object-identity assertion the freeze tests do not need, the pre-existing duplication of the tenant derivation across `wikis.ts` / `wiki-paths.ts`, the fail-soft warning interpolating the raw owner (unchanged by this diff), the absent `guidance-cache.test.ts` (comment-only change there), extra fail-soft casing permutations, the unstated strict-mode dependency (every module here is ESM, so always strict), and the ledger/spec-status bookkeeping the orchestrator owns.

### Follow-up review recommendation

`true`. Patched findings by severity: high 0, medium 0, low 7. Score = 3 × 0 + 1 × 7 = 7, which is ≥ 5.

### Verification performed

- `pnpm vitest run src/lib/__tests__/names-terms.test.ts src/lib/__tests__/workspace-guidance.test.ts` — 27/27 pass.
- `pnpm vitest run src/lib/__tests__/ingest.test.ts src/lib/__tests__/names-terms-routes.test.ts` — 253/253 pass; the frozen entries break no consumer.
- `pnpm exec tsc --noEmit` — clean (exit 0).
- `pnpm lint` — clean (exit 0; the only output is pre-existing `jsx-ast-utils` `TSNonNullExpression` noise from JSX files).
- Matrix test audit: all six I/O rows are covered by tests that ran and passed — tenant collapse (names-terms and workspace-guidance), owner separation (pre-existing), entry mutation throws, array sort/splice still allowed, and failed-read eviction under the tenant key (new).
- Both behavioral fixes were mutation-checked: reverting the tenant key and removing the freeze failed exactly the new tests; reverting the eviction key failed the new eviction test alone; removing the null guard failed the new corrupt-file test.

### Residual risks

- The freeze is runtime-only; the exported types stay mutable by design, so a future mutating consumer compiles and fails only when that line executes. Deferred above.
- A corrupt dictionary with a non-object element alongside real entries still throws out of the sort comparator, before the freeze loop. Pre-existing, deferred above.
- All seven `listNamesTerms` consumers were traced and are read-only, so the freeze introduces no `TypeError` at any current call site; the risk is entirely about future consumers.
