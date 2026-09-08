---
title: 'DW-740: a case variant counts as the page already existing at the create door'
type: 'bugfix'
created: '2026-09-05'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A crash-resume whose silo object is spelled with a case variant now throws
      `LifecyclePageConflictError` on every retry instead of completing, so the
      lifecycle receipt can never be written and the op is stuck.
    evidence: |-
      `src/lib/lifecycle.ts`'s `pageAlreadyWritten` branch reads the CANONICAL
      silo key, and on its ENOENT calls `createWikiPage(slug, op.content, tenant)`
      and throws a conflict on a `false`. Since DW-740 that `false` is exactly
      what a variant-held silo object produces, so the resume raises instead of
      repairing. The receipt is written only after `runPageLifecycleOp` returns,
      so every later retry repeats the throw. It is a live path, not a
      hypothetical one: `writeResearchPage` (`src/lib/research-completion.ts`) is
      the caller that pairs `createOnly` with `idempotency`.
      This is BETTER than what it replaced — before DW-740 the same call forked
      the identity into a second object — and DW-740's Design Notes rules the
      loud conflict deliberate. What is left open is the repair: the branch reads
      the canonical key where `readWikiPage` would have recovered the variant, so
      it cannot see the bytes that already landed. Closing it means teaching the
      recovery read the same resolution the other doors carry, which is a
      different door from the create-conflict ruling this bundle answered.
    location: >-
      src/lib/lifecycle.ts (pageAlreadyWritten recovery, silo repair create)
    severity: low
baseline_revision: 'f8e8dbdb951ec5c98aaeb18d26fa9c17e9a00a50'
---

<intent-contract>

## Intent

**Problem:** DW-489/490 moved the read and save doors onto the stored OBJECT that carries a slug, and DW-741 moved the delete and existence doors with them. The CREATE door was left addressing the NAME on purpose, because "does `cased.MD` count as the page `cased` already existing?" is a create-conflict ruling, not a retarget. A human has now ruled: **variants block a create**. Today `createWikiPage` (`src/lib/wiki.ts:796-807`) calls `writeFileIfAbsent` on `<slug>.md` unconditionally and `src/lib/lifecycle.ts:501`'s `createOnly` precondition probes `storageFileExists(wikiRelPath(`${slug}.md`))` — canonical only — so on a case-SENSITIVE store a create over a variant-held Page lands a SECOND object for one slug, orphaning the one the Files tab lists and the reader was shown.

**Approach:** Resolve the create's conflict question through the same one resolution DW-741 introduced: `findStoredPageKey`. `createWikiPage` refuses (returns `false`) when any spelling of `<slug>.md` is present under its target root, and lifecycle's `createOnly` gate refuses on the same answer for the flat root. The route and MCP guards already read through `readWikiPage` and so already see a recovered variant — they get pinned, not changed.

## Boundaries & Constraints

**Always:**
- ONE spelling of the resolution: both new call sites go through the exported `findStoredPageKey` from `src/lib/wiki.ts`. No call site restates the candidate set, the election, or the ENOENT gate.
- `createWikiPage` keeps its contract shape verbatim: `validateSlug` first, `false` when the target is taken, `true` on a create, the `pageCache` invalidation only on a create, and the SAME canonical key written when nothing holds the slug.
- Atomicity is unchanged: `writeFileIfAbsent` on the canonical key stays the create-only guarantee. The probe only ADDS a refusal; it never replaces the atomic check.
- Strictness is inherited, not restated: `findStoredPageKey` is always strict, so a non-ENOENT storage failure fails the create rather than being flattened into "the slug is free" — which is the same reason `writeWikiPage`'s recovery is strict.
- Lifecycle's `createOnly` gate keeps its current fault semantics: `storageFileExists` already re-throws non-ENOENT, and so does `findStoredPageKey`. Only the variant probe is new.
- Every new claim is pinned against a SIMULATED case-sensitive store: the dev host's volume folds case, so a test staging `wiki/cased.MD` and reading `wiki/cased.md` for real would pass without the fix.

**Block If:**
- Closing the create door turns out to require a change to `readStoredPageVariant`'s or `findStoredPageKey`'s own rule (candidate set, election, ENOENT gate, strictness) rather than a new caller of it.

**Never:**
- Do not change `readStoredPageVariant`, `findStoredPageKey`, `electWikiLeafNames`, `wikiPageNames`, `wikiLeafSlug`, or `wikiPageExists`.
- Do not change `readWikiPage`, `writeWikiPage`, `writeWikiPageIfContentMatches`, `resolveWorkbenchFile`, or the lifecycle DELETE branch.
- Do not change `POST /api/wiki` or `handleCreatePage` — their guards already resolve through `readWikiPage`. They get test pins only.
- Do not delete, rename, or reconcile a defeated case sibling anywhere. This bundle refuses a create; it does not clean up a collision.
- Do not turn the refusal into a new error type or message. `createWikiPage` still answers `false`; lifecycle still throws `LifecyclePageConflictError(slug, "already exists")`.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Variant blocks a flat create | case-SENSITIVE store, flat root holds only `wiki/cased.MD` | `createWikiPage("cased", …)` → `false`; `wiki/cased.md` is never written | No error expected |
| Variant blocks a silo create | case-SENSITIVE store, only `tenants/alice/wiki/cased.MD` present | `createWikiPage("cased", …, "alice")` → `false`; nothing written | No error expected |
| Canonical create unchanged | `wiki/cased.md` present | `false`, exactly one page read (the canonical key) and no variant spelling probed; stored bytes untouched | No error expected |
| Free slug still creates | no spelling present under the root | `true`, and `wiki/fresh.md` holds the content — the default target is byte-for-byte what it was | No error expected |
| Create resolution hits a fault | canonical ENOENT, a variant read rejects non-ENOENT | `createWikiPage` rejects with that error and writes nothing | Rethrow |
| Lifecycle gate refuses a variant-held flat page | `createOnly` write, flat root holds only `wiki/cased.MD` | rejects `LifecyclePageConflictError` "already exists"; no `writeFileIfAbsent` runs | Throw |
| Lifecycle refuses a variant-held silo page | `createOnly` write, flat root empty, silo holds only `<silo>/cased.MD` | rejects "already exists" from the silo `createWikiPage` | Throw |
| Lifecycle create still works | `createOnly` write on a slug with no stored spelling | succeeds exactly as today, silo and flat copies created | No error expected |
| Route guard sees the variant | case-SENSITIVE store, only `wiki/cased.MD` present | `POST /api/wiki` → 409 `page already exists: cased`; the variant's bytes unchanged | No error expected |
| MCP guard sees the variant | same store | `handleCreatePage` rejects `Page already exists: cased`; bytes unchanged | Throw |

</intent-contract>

## Code Map

- `src/lib/wiki.ts:796-807` -- `createWikiPage`. `validateSlug`, builds `${slug}.md` under the silo (`tenantWikiRelPath`) or flat (`wikiRelPath`) root, one `writeFileIfAbsent`, `pageCache.delete` only when it created. The whole change is one refusal added before the write; the docblock ("Returns `false` when the target already exists") is what has to start saying "the target" means the object, not the name.
- `src/lib/wiki.ts:466-513` -- `findStoredPageKey(slug, tenant | null)`, the DW-741 resolution to reuse: canonical `readFile` first, `readStoredPageVariant` only on its ENOENT, always strict, no `validateSlug` of its own (callers validate — `createWikiPage` already does). Its docblock names the delete and existence doors as its callers; DW-740 adds the create door to that list.
- `src/lib/wiki.ts:400-465` -- `readStoredPageVariant`: three bounded parallel reads of the non-canonical spellings, elected through `electWikiLeafNames`. READ-ONLY here.
- `src/lib/lifecycle.ts:499-536` -- the `createOnly` branch. `:500` `const flatPath = wikiRelPath(`${slug}.md`)` (still needed at `:520` for the ambiguous-timeout re-read); `:501-503` the canonical-only precondition to replace; `:508` the silo `createWikiPage` whose `false` throws "already exists"; `:513` the flat `createWikiPage`; `:526-534` the compensation that unlinks the silo bytes when the flat claim fails.
- `src/lib/lifecycle.ts:259-267` -- `storageFileExists`: already `readFile`-based and already re-throws non-ENOENT, so replacing its use at `:501` changes only what counts as present. Its other caller (`:569`, the flat compatibility repair) stays as it is — the `createWikiPage` on that line now refuses a variant on its own.
- `src/lib/lifecycle.ts:469-497` -- the `pageAlreadyWritten` recovery branch, which also calls `createWikiPage` (`:476`, `:496`) inside an ENOENT catch. Not modified; see Design Notes for what the shared refusal does to it.
- `src/app/api/wiki/route.ts:110-121` and `src/mcp.ts:246-261` -- the two create-conflict guards. READ-ONLY: both already read `readWikiPage(slug, { fresh: true, strict: true })`, which recovers a variant since DW-490, so both already answer their conflict. They need pins, not edits.
- `src/lib/__tests__/wiki.test.ts:2411-2471` -- the `case-variant page keys` describe and its `simulateStore` exact-key harness (spies `readFile`, `readFileWithEtag`, `fileExists`, `writeFile`, `writeFileIfMatch` on the storage singleton; seeding `derived-indexes/pages.json` routes a slug to a silo). It does NOT yet spy `writeFileIfAbsent` — that spy is what the create cases need, and it belongs in the same harness so every door in this describe reads one map.
- `src/lib/__tests__/lifecycle.test.ts:1146-1400` -- `describe("deleteWikiPage case-variant targets")` and its `simulateCaseSensitive(slug, present)` helper (`:1166-1192`): hides EVERY `.md` case spelling of one slug under any root from `readFile`/`deleteFile` unless it is an exact staged key, delegating everything else to the real provider. The create describe needs the same simulation, so hoist the helper (and its `enoent`) to module scope rather than copying it.
- `src/lib/__tests__/lifecycle.test.ts:1519-1523` -- the note that this file's `afterEach` does not restore mocks, so a spy taken inside a test comes off in a `finally`.
- `src/lib/__tests__/wiki-routes.test.ts:2124-2419` -- `describe("unreadable ≠ absent …(DW-496)")`, which owns the `POST /api/wiki` create-guard rows and its `create(slug)` helper (`:2237-2246`). The route pin is a sibling describe with the same `create` shape.
- `src/lib/__tests__/mcp.test.ts:556-645` -- the `handleCreatePage` conflict rows, including the `Page already exists: dup-page` pin and the DW-496 blip row whose one-shot `readFile` spy is the idiom to follow.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki.ts` -- In `createWikiPage`, after `validateSlug` and before the write, return `false` when `findStoredPageKey(slug, tenant ?? null)` answers a key. Update the docblock: the create refuses when any spelling of `<slug>.md` holds the slug under this root (DW-740, the human ruling), the probe is ENOENT-gated so a canonical hit costs the one read it always cost and a case-INSENSITIVE store never reaches it, a genuine create now costs four reads, and `writeFileIfAbsent` remains the atomic guarantee — the probe adds a refusal, it does not replace the check. -- The create door must answer about the object, like every other door.
- `src/lib/lifecycle.ts` -- In the `createOnly` branch, replace the `storageFileExists(flatPath)` precondition with `(await findStoredPageKey(slug, null)) !== null`, keeping `flatPath` for its later uses and keeping the thrown `LifecyclePageConflictError(slug, "already exists")` verbatim. Comment: this gate refuses BEFORE the silo is published, so a variant-held flat claim never reaches the compensation path. -- The gate carried its own canonical-only precondition, so the fix in `createWikiPage` alone would still publish a silo before refusing.
- `src/lib/__tests__/wiki.test.ts` -- Add a `writeFileIfAbsent` spy to `simulateStore` (create-only against the same exact-key map) and add `createWikiPage` cases to `case-variant page keys`: lone flat variant → `false` with `wiki/cased.md` never written; lone silo variant → `false`; canonical present → `false` with exactly the canonical page read and no variant spelling; genuinely absent → `true` and the canonical key holds the bytes; a non-ENOENT variant fault → rejects and writes nothing. -- The matrix's first five rows on a simulated case-SENSITIVE store.
- `src/lib/__tests__/lifecycle.test.ts` -- Hoist `enoent` and `simulateCaseSensitive` to module scope, extend the helper to also spy `writeFileIfAbsent` (a hidden key is ABSENT in this store, so record the call and report a create WITHOUT touching the folding host volume, which would otherwise overwrite the staged variant), and add `describe("createOnly on a case-SENSITIVE store (DW-740)")`: a variant-held flat page rejects "already exists" with no `writeFileIfAbsent` call; a variant-held silo page rejects the same way; an unrelated free slug still creates both copies. -- The matrix's three lifecycle rows; without the faked create the unfixed code would reach a conflict by the host's case folding and the rows would pass on the wrong mechanism.
- `src/lib/__tests__/wiki-routes.test.ts` -- Add a DW-740 describe pinning `POST /api/wiki` at 409 for a slug held only on `wiki/cased.MD`, with the canonical spelling hidden from `readFile` so the row cannot pass by the host's folding, and the variant's bytes asserted unchanged. -- The ledger's "pin the case-sensitive-store create-conflict case at the route guard".
- `src/lib/__tests__/mcp.test.ts` -- Add the same pin for `handleCreatePage` (rejects `Page already exists: <slug>`, bytes unchanged). -- The same ruling at the MCP door, where its sibling conflict rows already live.

**Acceptance Criteria:**
- Given a case-SENSITIVE store whose only object for slug `cased` is a case variant, when any create door is asked for `cased`, then it refuses as already-existing and no second object for the slug is written — the same answer DW-741 gives at the delete and existence doors.
- Given a case-INSENSITIVE store, or any root where the canonical `<slug>.md` is present, when a create runs, then it refuses or creates exactly as it does today and no variant spelling is read.
- Given the full suite, when `npx vitest run` executes it, then no existing test regresses.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 0, low 9)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[low]` `[patch]` `createWikiPage`'s docblock contradicted itself: it claimed a case-INSENSITIVE store "never reaches the variant probe at all" and then said the create's normal path is a miss that pays four reads. Both cannot hold — a create for an absent slug probes on either store kind. The cheap-refusal claim is now scoped to a canonical HIT, which is what actually closes the gate.
  - `[low]` `[patch]` `findStoredPageKey`'s docblock carried the same now-wrong sentence ("that is the only path ever taken there" on a case-insensitive store). Reworded to the true, caller-independent claim: a hit costs one read and probes nothing, on either store kind. `readStoredPageVariant` left untouched — its own ENOENT-branch rule is still true and the Never clause covers it.
  - `[low]` `[patch]` The race-window paragraph rested on a false premise — "nothing in this module ever writes a non-canonical name". `writeWikiPage` and `writeWikiPageIfContentMatches` both retarget onto a recovered variant key. The conclusion survives on the true premise: neither brings a NEW spelling into existence, so the probe→write window still needs a store-external writer.
  - `[low]` `[patch]` The cost paragraph understated the change twice. A lifecycle `createOnly` write pays about TWELVE reads for one created page (the gate probes the flat root and the flat `createWikiPage` probes it again), and `createOnly` writes do arrive from bulk pipelines — the "no bulk caller" claim is gone.
  - `[low]` `[patch]` Nothing at `lifecycle.ts`'s `pageAlreadyWritten` silo create recorded that DW-740 changed what its `false` means: a variant-spelled silo object now makes a crash-resume conflict rather than fork the identity. Comment added; behaviour unchanged and the repair recorded as deferred.
  - `[low]` `[patch]` The new refusal created a SILENT skip at the conditional-edit flat repair: `storageFileExists` says "absent" for a variant-held flat slug and the following `createWikiPage`'s `false` was discarded, so the copy was neither repaired nor mentioned while both sibling branches log or raise. It now warns.
  - `[low]` `[patch]` The recovery flat create's warn said the copy "appeared" — a race-only description that a variant cause makes simply false. Reworded to be true of both causes.
  - `[low]` `[patch]` The lifecycle SILO row's closing assertions could not fail: the harness fakes `writeFileIfAbsent` for hidden keys, so the disk checks are structurally green whether or not a create was attempted. It now carries the same `expect(sim.writeFileIfAbsent).not.toHaveBeenCalled()` its sibling row had.
  - `[low]` `[patch]` No test pinned the GATE's own fault semantics, though its comment claims the re-throw — a non-ENOENT fault on a VARIANT spelling now fails a create that used to succeed. Added a row asserting the write rejects with the storage error (never a conflict sentence) and that no create-only claim goes out; it also made the free-slug row's staging non-inert by pinning the refusal's blast radius.

## Design Notes

The ruling is the human's: a case variant counts as the page already existing at the create door. That makes the create door the fourth caller of one resolution rather than a new rule — `findStoredPageKey` already answers "which storage key under this root carries this slug", and the create simply refuses when the answer is not `null`.

Two shapes are worth stating because they differ from the doors that came before.

**The probe is an extra refusal, not the check.** `writeFileIfAbsent` stays exactly where it is:

```ts
// DW-740: a case variant IS the page here — the human ruling. ENOENT-gated, so
// a canonical hit costs the one read it always cost.
if ((await findStoredPageKey(slug, tenant ?? null)) !== null) return false;
// Still the atomic create-only guarantee for the canonical key.
const created = await getStorage().writeFileIfAbsent(storagePath, content);
```

**The ENOENT gate does not make the probe unreachable here, the way it does at the read, delete and existence doors.** Those reach a miss only on a slug with no Page; a create's NORMAL path is a miss, so a successful create now pays four reads per root instead of one (twelve for a lifecycle `createOnly` write: gate, silo, flat). That is bounded, O(1), and paid once per page creation — `createWikiPage` has no bulk caller — so it is the right trade for the ruling, but it should not be described as free.

One shared consequence is deliberate and not separately fixed: the `pageAlreadyWritten` recovery branch (`lifecycle.ts:469-497`) also creates through `createWikiPage` inside an ENOENT catch. On a case-sensitive store whose silo object is variant-spelled, that resume now throws `LifecyclePageConflictError` instead of forking the identity into a second object. A loud conflict over a silent fork is the ruling applied consistently; teaching the recovery branch to READ the variant is a different door and is not in this bundle.

Race window, unchanged in kind by this fix: a variant that appears between the probe and the write still gets a canonical sibling, because no provider offers a create-if-no-spelling-exists. Nothing inside this module ever writes a non-canonical name, so the window needs a store-external writer.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/wiki.test.ts src/lib/__tests__/lifecycle.test.ts` -- expected: all pass, including the new create cases
- `npx vitest run src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/mcp.test.ts` -- expected: all pass, including the two new door pins
- `npx vitest run` -- expected: no regressions against the baseline suite
- `npx tsc --noEmit` -- expected: no new type errors
- `pnpm lint` -- expected: no new errors

## Auto Run Result

Status: done

**Implemented change.** DW-489/490 moved the read and save doors onto the stored OBJECT that carries a slug and DW-741 moved the delete and existence doors with them; the CREATE door was held back because "does `cased.MD` count as the page `cased` already existing?" is a create-conflict RULING, not a retarget. The human ruled that it does. `createWikiPage` now refuses — returns `false` — when `findStoredPageKey` finds any spelling of `<slug>.md` under its target root, and `lifecycle.ts`'s `createOnly` gate asks the same question of the flat root instead of `storageFileExists` on the canonical name. So on a case-SENSITIVE store a create over a variant-held Page is refused as already-existing rather than landing a second object that orphans the one the Files tab lists.

Three shapes are deliberate. The refusal goes through the ONE resolution DW-741 introduced, so no call site restates the candidate set, the election or the ENOENT gate. `writeFileIfAbsent` on the canonical key remains the atomic create-only guarantee — the probe only ADDS a refusal ahead of it. And the gate had to move too: `createWikiPage`'s own refusal alone would have published the authoritative silo copy before anything refused, so a variant-held flat claim would have reached the compensation path rather than being stopped ahead of it.

The ENOENT gate does NOT make the probe unreachable at this door the way it does at the others: a create's normal path is a miss, so a successful create pays four reads per root (about twelve for a lifecycle `createOnly` write, the flat root probed once by the gate and again by the flat create). That is bounded and O(1) per page, and it is stated in the code rather than glossed.

**Files changed.**
- `src/lib/wiki.ts` -- `createWikiPage` refuses through `findStoredPageKey` before writing; docblock records the ruling, the ENOENT gate, the real cost, the inherited strictness and the probe→write race window. `findStoredPageKey`'s docblock adds the create door to its caller list and drops a claim the create door falsifies.
- `src/lib/lifecycle.ts` -- the `createOnly` precondition resolves through `findStoredPageKey`; the `pageAlreadyWritten` silo create records what DW-740 changed about its `false`; the two flat-compatibility-copy sites the new refusal reaches now log instead of skipping silently or naming the wrong cause.
- `src/lib/__tests__/wiki.test.ts` -- `simulateStore` gains a `writeFileIfAbsent` spy over the same exact-key map; five `createWikiPage` rows (lone flat variant, lone silo variant, canonical hit probing nothing, genuine absence, indeterminate probe).
- `src/lib/__tests__/lifecycle.test.ts` -- `enoent` and `simulateCaseSensitive` hoisted to module scope and shared by both case-variant describes, the helper now faking `writeFileIfAbsent` for hidden keys; a new `createOnly on a case-SENSITIVE store (DW-740)` describe with four rows (flat variant, silo variant, free slug plus blast radius, indeterminate gate probe).
- `src/lib/__tests__/wiki-routes.test.ts` -- `POST /api/wiki` pinned at 409 for a slug held only by `cased.MD`.
- `src/lib/__tests__/mcp.test.ts` -- `handleCreatePage` pinned at `Page already exists` for the same store.

**Review findings.** 9 patches applied (all low; no high, no medium) — four were docblock claims the change falsified (a self-contradiction about the probe's reachability, the same sentence in `findStoredPageKey`, a false premise under the race argument, and an understated cost with a wrong "no bulk caller" aside), two were honesty fixes at lifecycle sites the new refusal reaches (a discarded `false` that skipped a flat repair silently, and a warn that still described a race), one recorded the refusal's meaning at the crash-resume call site, and two were verification defects (a silo row whose closing assertions could not fail, and the gate's own fault semantics going unpinned). 1 deferred: a crash-resume whose silo object is variant-spelled now conflicts on every retry — better than the identity fork it replaced, but the branch still reads the canonical key where `readWikiPage` would recover the variant. 8 rejected: the route and MCP pins being green pre-change (that is what a regression pin for an already-correct guard IS, and the ledger asked for exactly these), `readStoredPageVariant`'s docblock (its rule is still true and the Never clause covers it), three copies of the case-sensitive simulation with no shared home (a cross-file helper is an eighth shared test module, governed by AGENTS.md and its parity test), `src/cli.ts`'s sibling create guard (the intent names the route and MCP guards), the gate now failing a create on a variant-read blip (that is the mandated strictness), a speculative future delete row tripping over the faked `writeFileIfAbsent`, the gate comment's rationale, and the unpinned miss-path cost.

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 0, low 9. The score counts only `high` patched findings; there were none.

**Verification.**
- `npx vitest run src/lib/__tests__/wiki.test.ts src/lib/__tests__/lifecycle.test.ts src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/mcp.test.ts` -- 625 passed.
- `npx vitest run` -- 398 files, 9961 passed, 1 skipped, 0 failed (baseline before this work: 9952 passing).
- `npx tsc --noEmit` -- clean. `pnpm lint` -- clean (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices).
- Mutation checks: reverting `src/lib/wiki.ts` fails 4 of the 5 new `createWikiPage` rows plus the lifecycle silo row; reverting the `lifecycle.ts` gate fails the flat-variant row and the new gate-fault row.
- Matrix audit: every I/O row has a covering test that ran and passed — five `createWikiPage` rows in `wiki.test.ts`, three lifecycle rows in `lifecycle.test.ts`, one route row, one MCP row.

**Residual risks.**
- The recorded deferral: a variant-spelled silo object makes a crash-resume conflict on every retry rather than complete.
- A successful create now costs four reads per root — about twelve for a lifecycle `createOnly` write, with the flat root probed twice — and `createOnly` writes do arrive from bulk pipelines.
- The refusal is advisory, not atomic: a variant appearing between the probe and `writeFileIfAbsent` still gets a canonical sibling. No provider offers create-if-no-spelling-exists, and nothing in `wiki.ts` brings a new spelling into existence, so the window needs a store-external writer.
- Every case-sensitive claim is pinned against a SIMULATED store, because the dev host's volume folds case. The simulation's fidelity to a real case-sensitive store is argued in prose, not asserted in code — and the route and MCP rows pin DW-490's recovery rather than DW-740's ruling, which is what the ledger asked them to be.
