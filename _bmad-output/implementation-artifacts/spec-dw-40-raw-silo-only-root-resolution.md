---
title: 'DW-40: raw/ resolves silo-only; wiki/ keeps the flat fallback'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
baseline_revision: '18f9596f0c5e3fce56ce1e374afeb1590272a62d'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** `resolveRoot` in `src/lib/workbench-files.ts` once applied ONE fallback rule to both display roots: when the caller's tenant silo listed empty, it fell back to the shared flat tree. Under `wiki/` that is wanted (a pre-migration workspace still lists its pages); under `raw/` it means an owner whose raw silo has not been written yet lists — and reads the bytes of — another tenant's legacy shared sources.

**Approach:** Split `resolveRoot` into a per-root arm. `raw/` is silo-only and never names the flat prefix; `wiki/` keeps silo-first-then-flat. Record in `src/lib/silo.ts` that the transitional flat tree is now wiki-only for Workbench listing and reads.

## Boundaries & Constraints

**Always:**
- Every `raw/` root resolution — the Files listing walk, the Sources pager, and the single-file resolver — goes through the same `resolveRoot("raw", …)` arm, so listing and read agree exactly.
- An owner with no resolvable tenant gets a prefix that is not the shared `raw/` tree, and `resolveWorkbenchFile` refuses reads under it.
- A FAILED silo listing (a rejection, not an empty list) keeps the silo selected for BOTH roots — a transient error never widens what the tab shows.
- `wiki/` keeps its fallback to the shared flat root for pre-migration workspaces.

**Block If:** The `wiki/` fallback would have to be retired to make `raw/` silo-only — that is a separate migration decision with its own cost.

**Never:**
- Do not retire the flat tree, change ingest's transitional flat raw write, or alter `readRawSourceById` / `listRawSourceSnapshots` fallbacks — those are non-Workbench read paths and out of scope.
- Do not narrow the `raw/` read gate below what the `raw/` listing emits (rows that refuse to open).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Owner silo has a raw source | `tenants/<t>/raw/mine.md` present, flat `raw/theirs.md` present | Listing contains `raw/mine.md`, not `raw/theirs.md`; read of `raw/mine.md` returns its bytes | No error expected |
| Owner raw silo empty, flat raw populated | Only flat `raw/sources/someone-elses-doc.md` exists | Listing is `["raw/", "wiki/"]`; read and exists both refuse | No error expected |
| Owner raw silo unreadable | silo raw prefix rejects (ENOTDIR) | Silo stays selected; `raw/` renders as the empty branch; `failed` is reported | Logged, degrades this branch only |
| Owner tenant unresolvable | `tenantForOwner` throws | Root prefix is the unresolved sentinel, not shared `raw/`; reads under `raw/` return null | Logged, refused |
| Owner wiki silo empty, flat wiki populated | Only flat `wiki/flat-page.md` exists, slug readable | Listing contains `wiki/flat-page.md` (fallback preserved) | No error expected |

</intent-contract>

## Code Map

Every production anchor below was ALREADY in the tree at `baseline_revision` (commit `4525c63b`, "Close Epic 1 retro blockers"), and the ledger records DW-40 `status: done 2026-08-22`, `archived: 2026-08-29`. This run is a ratification pass: it verifies the three deliverables are present and un-regressed, and closes the coverage half of "and its tests". The Tasks below therefore read *confirm*, and only the test file is new.

- `src/lib/workbench-files.ts:392-412` -- `resolveRoot(kind, siloPrefix, flatPrefix)`: the per-root arm. `kind === "raw"` returns the silo prefix (or `UNRESOLVED_RAW_PREFIX` with `failed: true` when there is no tenant) and never consults `flatPrefix`; the `wiki` arm keeps silo-first and falls through to `flatPrefix` at `:412`.
- `src/lib/workbench-files.ts:369-373` -- `UNRESOLVED_RAW_PREFIX = "tenants/_unresolved/raw"`: the no-tenant sentinel that must not be the shared flat tree. Not exported, so it is pinned behaviorally (no listing reaches the flat raw prefix), not by identity.
- `src/lib/workbench-files.ts:677` -- `listWorkbenchFilePaths`' `raw/` walk seed; `:690` the `wiki/` one; `:650-661` the shared silo-resolution `catch` whose comment this run corrected to state the two arms' different outcomes.
- `src/lib/workbench-files.ts:756` -- the Sources pager's `raw/` root, same arm. Its own `catch` at `:751-755` sets `failed` BEFORE `resolveRoot` is consulted, so the pager's return shape alone cannot observe the fallback — the new test pins it by prefix instead.
- `src/lib/workbench-files.ts:1009-1010` -- `resolveWorkbenchFile`: resolves the root, then refuses when the resolved `raw/` prefix is the sentinel or no silo was resolvable. Shared by `readWorkbenchFile`, `readWorkbenchFileBytes` (`:1051`) and `workbenchFileExists` (`:1085`).
- `src/lib/workbench-files.ts:847-885` -- the `wikiLeafSlug` docblock stating why `wiki/` still needs the narrow leaf gate and that `raw/` has no fallback; `readableWikiLeaf` itself is at `:888`.
- `src/lib/workbench-files.ts:287` -- `rawPathAllowed`: allows an ORPHANED source precisely because `raw/` is silo-only (rationale at `:281-286`).
- `src/lib/silo.ts:10-16` -- module doc recording that the flat tree is wiki-only for Workbench listing and reads, and that ingest may still write a transitional flat raw copy the Workbench will not show.
- `src/lib/__tests__/workbench-files-unresolved-tenant.test.ts` -- NEW. The only fixture that can reach `resolveRoot`'s `!siloPrefix` branch (`ownerToTenant` in `src/lib/links.ts:130` is total, so `tenantForOwner` never throws in production); it injects the throw with `vi.mock`, and asserts BOTH arms.
- `src/lib/__tests__/workbench-tree.test.ts:831, 911, 929` -- silo-only listing/read, un-mirrored source excluded from an empty silo, and failed-silo-does-not-fall-back.
- `src/lib/__tests__/workbench-preview.test.ts:1410, 1447, 1454` -- the preview read path's mirror of the same rule (`wiki/` fallback kept, `raw/` not; failed silo does not widen).
- `src/lib/__tests__/epic8-remediation.test.ts:2083` -- the only pin on the raw arm's `failed: true` PROPAGATION (`reason: "listing_unavailable"`), which is why the full suite is a verification command below and not just the five named files.
- `src/lib/__tests__/silo.test.ts:66, 104` and `src/lib/__tests__/raw.test.ts:59, 525` -- the silo/raw writers' tests that depend on the silo-only raw resolve.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-files.ts` -- confirm `resolveRoot` carries the `kind` parameter and the `raw` arm returns only silo-derived prefixes, and that all three `raw/` call sites route through it -- one definition per root is what keeps listing and read in agreement.
- `src/lib/workbench-files.ts:656-661` -- correct the silo-resolution `catch` comment, which still claimed an unvalidatable tenant "leaves only the flat roots" -- that is the pre-DW-40 rule and is contradicted by the raw arm 260 lines above.
- `src/lib/silo.ts` -- confirm the module doc records the wiki-only flat tree and the silo-only `raw/` resolve -- the note is the durable record that ingest's transitional flat raw copy is deliberately Workbench-invisible.
- `src/lib/__tests__/workbench-files-unresolved-tenant.test.ts` -- add the `!siloPrefix` coverage for BOTH arms: `raw/` refusing every flat address (including the hashed snapshot and the `raw/assets/` media door) and `wiki/` still serving its flat fallback -- unpinned, the `raw/` side can regress into a leak and the `wiki/` side into a blackout, and the rest of the suite stays green either way.
- `src/lib/__tests__/workbench-tree.test.ts`, `src/lib/__tests__/workbench-preview.test.ts` -- confirm the remaining I/O matrix rows are each covered by a named test that runs -- the empty-silo and failed-silo rows are the ones that regress silently.

**Acceptance Criteria:**
- Given the intent's three deliverables (per-root `resolveRoot` arm, tests, silo.ts note), when the tree is inspected, then all three are present with no residual `raw/`-to-flat fallback at any of the three call sites.
- Given `resolveRoot`'s `raw` arm is mutated to fall back to `flatPrefix` on a null silo, when the new suite runs, then it fails -- the coverage is not vacuous.
- Given `resolveRoot`'s `wiki` arm is mutated to return a no-tenant sentinel instead of the flat prefix, when the new suite runs, then it fails.
- Given the full `pnpm test` suite, when it runs, then it passes.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 0, medium 2, low 11)
- defer: 0
- reject: 11
- addressed_findings:
  - `[medium]` `[patch]` The Sources-pager case was VACUOUS: `listRawSourceFilePaths` sets `failed` in its own `catch` before `resolveRoot` runs, and its terminal guard returns the same `{ paths: [], failed: true }` either way — mutating the raw arm to fall back left it green. Repinned by spying on `listFiles` and asserting the shared flat `raw/` prefix is never asked for.
  - `[medium]` `[patch]` `resolveRoot`'s `wiki` arm under a NULL silo was unpinned repo-wide: a mutation giving it a no-tenant sentinel passed all 8646 tests. Added a third case asserting the flat `wiki/` fallback survives in the one fixture that can reach that branch.
  - `[low]` `[patch]` `readWorkbenchFileBytes` — the media door sharing `resolveWorkbenchFile` and the only consumer of `raw/assets/<slug>/…` — was not exercised. Added.
  - `[low]` `[patch]` The hashed snapshot address `raw/sources/<slug>/<sha>.md` was absent from the refused-read set. Added.
  - `[low]` `[patch]` The listing assertion was a filtered subset, which a regression dropping the `raw/` root entirely would also satisfy. Tightened to the exact `["raw/", "wiki/"]` shape.
  - `[low]` `[patch]` Matrix row 4's "Logged, refused" was unasserted. Added a `logger.error` spy, which also silences the expected stderr so CI noise stays distinguishable from real failures.
  - `[low]` `[patch]` `src/lib/workbench-files.ts:656` still read "A tenant that will not validate leaves only the flat roots" — the pre-DW-40 rule, contradicted by the raw arm. Rewritten to state both arms' outcomes.
  - `[low]` `[patch]` Code Map cited the wrong symbols and ranges (`850-857` labelled `readableWikiLeaf` is `wikiLeafSlug`'s docblock; `281-285` vs `rawPathAllowed` at `287`; `392-411` truncated the flat return at `412`), carried an unfinished `928-…` citation, and ran two line-number systems for the same three call sites. All corrected to one system.
  - `[low]` `[patch]` The new test file was absent from the Code Map though it is the only file the change creates. Added.
  - `[low]` `[patch]` Verification used `npx` against repo convention (`pnpm exec vitest run --project node`, `pnpm test`, `pnpm lint` per AGENTS.md:40-51) and named five files that leave the raw arm's `failed` PROPAGATION unchecked — `epic8-remediation.test.ts:2083` is its only pin. Commands corrected and the full suite added.
  - `[low]` `[patch]` The acceptance criterion "all pass with no changes to the working tree" contradicted a change that adds a file. Replaced with two mutation-based criteria that state what the coverage must catch.
  - `[low]` `[patch]` The spec read as if it were building already-shipped code without saying DW-40 is `done 2026-08-22` / `archived 2026-08-29`. Code Map now opens by naming this a ratification pass and the baseline commit that shipped the arm.
  - `[low]` `[patch]` Test hygiene: `OWNER` renamed to `owner-with-no-tenant` (the premise is that it resolves to none), the sibling suite's `tenants/` cleanup restored, `new Set()` typed, and the garbled "`vi.mock` is hoisted per module graph" note rewritten.

## Design Notes

The split is per-root rather than per-caller on purpose: the Files listing, the Sources pager, and `resolveWorkbenchFile` each resolve `raw/` through the same arm, so a row that lists is a row that opens. A narrower read gate than the listing would produce rows that refuse to open; a wider one would re-open the disclosure. The `failed !== empty` rule is shared by both arms -- both providers answer a missing prefix with an empty list, so a rejection means unreadable, and answering it by widening to the shared tree is the opposite of degrading.

The new suite asserts the fallback's ABSENCE by the prefixes storage was asked for, not by the paths returned. A membership test over the result cannot tell "the flat tree was consulted and had nothing to show" from "the flat tree was never consulted" -- and the Sources pager in particular returns the identical `{ paths: [], failed: true }` shape either way, because its own `catch` sets `failed` before `resolveRoot` runs. Spying on `listFiles` is what makes that case non-vacuous.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-files-unresolved-tenant.test.ts src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/silo.test.ts src/lib/__tests__/raw.test.ts src/lib/__tests__/epic8-remediation.test.ts` -- expected: all files pass.
- `pnpm test` -- expected: the whole suite passes (the named files above do not cover `failed` propagation on their own).
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm lint` -- expected: clean.

**Manual checks (if no CLI):**
- The three `raw/` root resolutions (`workbench-files.ts:677`, `:756`, `:1009`) each call `resolveRoot("raw", ...)`, and the `raw` arm never reads its `flatPrefix` argument -- confirm no new `raw/`-to-flat fallback has appeared at any call site.

## Auto Run Result

Status: done

**Summary.** DW-40's three named deliverables were already in the tree at `baseline_revision` `18f9596f` (shipped in `4525c63b`), matching the ledger's own `status: done 2026-08-22` / `archived: 2026-08-29`: `resolveRoot` carries a per-root `kind` arm, `raw/` resolves silo-only through all three call sites, `wiki/` keeps its flat fallback, and `src/lib/silo.ts:10-16` records the flat tree as wiki-only. This run ratified that and closed the coverage half of "and its tests" — review found the `!siloPrefix` branch of BOTH arms unpinned repo-wide, which two independent mutations confirmed (a `raw/`-falls-back mutation and a `wiki/`-gets-a-sentinel mutation each passed the full 8646-test suite before this change; each fails it now).

**Files changed.**
- `src/lib/__tests__/workbench-files-unresolved-tenant.test.ts` (new) -- three cases over `resolveRoot`'s no-tenant branch: `raw/` refuses every flat address (residue, flat source, hashed snapshot, and the `raw/assets/` media door) and never asks storage for the shared flat prefix; `wiki/` still serves its flat fallback; the Sources pager reports `failed` without consulting the flat root.
- `src/lib/workbench-files.ts` -- comment-only: the silo-resolution `catch` at `:656-661` still stated the pre-DW-40 rule ("leaves only the flat roots") and now states both arms' different outcomes. No behavior change.
- `_bmad-output/implementation-artifacts/spec-dw-40-raw-silo-only-root-resolution.md` (new) -- this spec.

**Review findings.** 13 patches applied (2 medium, 11 low); 0 intent gaps; 0 bad-spec loopbacks; 0 deferred; 11 rejected. Details in the Review Triage Log above.

**Follow-up review recommendation:** `true`. Patched counts: high 0, medium 2, low 11; score = 3x2 + 1x11 = 17, which is >= 5. No high-severity patch.

**Verification performed.**
- `pnpm exec vitest run --project node` over the six named files -- 6 files, 443 tests passed.
- `pnpm test` (full suite) -- 359 files, 8646 passed, 1 skipped.
- `pnpm exec tsc --noEmit` -- clean.
- `pnpm lint` -- clean (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- Mutation checks, working tree restored after each: raw arm falling back to `flatPrefix` on a null silo fails all three new cases; `wiki` arm returning a no-tenant sentinel fails the `wiki/`-fallback case.

**Residual risks.**
- The no-tenant branch is unreachable in production today (`ownerToTenant`, `src/lib/links.ts:130`, is total), so these three cases are defense-in-depth pinned through a `vi.mock`. If the owner->tenant mapping ever gains a real throwing path, the mock's shape — a bare `throw` from `tenantForOwner` — may not match how it actually fails.
- `UNRESOLVED_RAW_PREFIX` is pinned behaviorally (no listing reaches the flat raw prefix), not by identity: the constant is not exported, so a change to its VALUE that still avoided the flat tree would not be caught. That is the property DW-40 cares about, but the sentinel string itself is unpinned.
