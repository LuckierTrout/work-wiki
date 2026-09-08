---
title: 'Brand scan reaches .github/ and documents every waived member'
type: 'bugfix'
created: '2026-09-05'
baseline_revision: '56759e96f6701fe7c87f04d2129021c9c11d1d6f'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      No allowlist pattern outside the two enumerated families has a minimality
      sweep, so a single-host deployment-origin waiver outlives the host it
      waives.
    evidence: |-
      Both enumerated families carry "keeps every waived ... earning its place"
      sweeps that fail when a member stops occurring in the shipped tree; the
      eleven plain IDENTIFIER_ALLOWLIST patterns carry none. A reviewer rewrote
      .github/workflows/seed-yoyo.yml:93 to drop the host entirely and all 22
      tests still passed, leaving /yopedia\.christianlee-flightwall\.workers\.dev/g
      as a repo-wide licence to write that host as display prose. The sibling
      /yopedia\.yuanhao-li\.workers\.dev/g has the identical gap and predates
      this change, so the class is pre-existing; this story adds one instance to
      it. AGENTS.md states the principle for the families ("a name no scanned
      file spells any more is a standing licence to write that word as copy")
      but nothing enforces it for the single-host origins.
    location: >-
      src/lib/__tests__/brand-copy.test.ts:282
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two coverage holes let brand drift ship unseen. `.github/` is reached by neither `scannedSources()` nor `maintainerSources()` in `src/lib/__tests__/brand-copy.test.ts`, yet it carries live hits (`deploy-cloudflare.yml:4` bare-prose `yopedia`, `seed-yoyo.yml:93` a second `workers.dev` deployment host). And the DW-356 AGENTS.md parity test iterates `IDENTIFIER_ALLOWLIST` per PATTERN, so both enumerated families collapse to one pattern each — a member added to or dropped from either enumeration is never forced into AGENTS.md prose.

**Approach:** Walk `.github/` from `maintainerSources()` with the shared `SOURCE_TEXT` filter, waive the second deployment origin in `IDENTIFIER_ALLOWLIST` with a matching backticked AGENTS.md bullet, and backtick the one bare-prose hit the widened scan then flags. Separately, make the parity test's direction 2 iterate a per-member expansion of the allowlist, built from the member patterns that already exist for both families.

## Boundaries & Constraints

**Always:**
- `SOURCE_TEXT` stays the ONE source-type filter; `.github/` is walked through `walkRoot(...)` so its root is stat-checked like every other named path.
- The new allowlist entry is the full literal host, escaped — never a generalised `yopedia\.[a-z0-9.-]+` host shape.
- The per-member expansion must fail loudly if a family pattern stops being referenced by `IDENTIFIER_ALLOWLIST`, so DW-589 cannot silently reappear.
- Every backticked `yopedia` spelling in AGENTS.md's `## Frozen identifiers` section stays fully waived by `IDENTIFIER_ALLOWLIST` (parity direction 1).

**Block If:**
- A `.github/` hit turns out to be a live wire/identifier string with no existing waiver and no AGENTS.md entry that could honestly describe it.

**Never:**
- Do not add a per-file entry to `YOPEDIA_PROSE_EXEMPT` for a `.github/` file — the two hits are fixed or waived, not grandfathered.
- Do not change workflow behaviour in `.github/` (triggers, jobs, env, secrets, opt-in gates). The only permitted `.github/` edit is the prose correction on `deploy-cloudflare.yml:4`.
- Do not rename any frozen identifier, and do not touch `WORKWIKI_IDENTIFIER_ALLOWLIST` or the workwiki parity test.
- Do not widen `SKIPPED_DIRS` in `src/lib/__tests__/source-scan.ts`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `.github/` in the corpus | Suite run on today's tree | `maintainerSources()` includes `.github/workflows/deploy-cloudflare.yml`; every yopedia/workwiki predicate reads it | No error expected |
| Second deployment host | `YOPEDIA_URL: ... 'https://yopedia.christianlee-flightwall.workers.dev'` | `hasStrayYopedia` is false — waived as a frozen deployment origin | No error expected |
| Lookalike host | `"Yopedia.christianlee-example.com is where the docs live"` | `hasStrayYopedia` is true — the literal waiver does not generalise | Fails the scan |
| Bare-prose yopedia in a workflow | `# ... still binds yopedia KV/R2 IDs` | Flagged until backticked; `` `yopedia` `` passes | Fails the scan |
| Enumeration member undocumented | A `YOPEDIA_HYPHEN_IDENTIFIERS` / `X_YOPEDIA_HEADERS` member with no backticked AGENTS.md spelling | Parity direction 2 fails, naming that member's pattern | Fails the test |
| Family pattern unlinked | `IDENTIFIER_ALLOWLIST` no longer contains `YOPEDIA_HYPHEN_PATTERN` or `X_YOPEDIA_PATTERN` by reference | Parity test fails — the expansion went vacuous | Fails the test |

</intent-contract>

## Code Map

- `src/lib/__tests__/brand-copy.test.ts` -- the whole change surface for DW-589 and the scan half of DW-350.
  - `:256-283` `IDENTIFIER_ALLOWLIST` — 12 patterns today; `/yopedia\.yuanhao-li\.workers\.dev/g` (`:279`) is the existing single-host deployment-origin entry and the model for the new one.
  - `:166-176` `YOPEDIA_HYPHEN_MEMBER_PATTERNS`, `:247-253` `X_YOPEDIA_MEMBER_PATTERNS` — `[name, RegExp]` pairs, no `g` flag, sharing the family bounds. Already used by the two minimality sweeps at `:1067` and `:1108`. Reuse these; do not mint new per-member regexes.
  - `:126-130` `YOPEDIA_HYPHEN_PATTERN`, `:236-238` `X_YOPEDIA_PATTERN` — the two collapsed family patterns inside the allowlist.
  - `:611-627` `maintainerSources()` — root listing + `tools/` (`ANY_FILE`), `docs/` (`SOURCE_TEXT`), `scripts/` (`ANY_FILE`). Add `.github` here.
  - `:373-379` `walkRoot(relative, include?, skipDirs?)` — stats the dir via `requireDir` then walks. Use it.
  - `:791-831` the maintainer pin test — pins one file per class then `expect(scanned.length).toBeGreaterThan(30)` with a "~38 files today" comment. Add a `.github` pin; the comment's count becomes ~50.
  - `:1392-1441` the DW-356 parity test. Direction 2 at `:1425-1440` is the defect: the floor is `IDENTIFIER_ALLOWLIST.length` and the loop is `for (const pattern of IDENTIFIER_ALLOWLIST)`.
  - `:944-1035` the frozen/slip case table — add a frozen case for the new host and a lookalike slip case beside the existing `"Yopedia.example.com is where the docs live"` near-miss.
- `src/lib/__tests__/source-scan.ts` -- `walkFiles`; `SKIPPED_DIRS` is `__tests__`, `node_modules`, `.git`, `.next`. The root argument is never name-checked, so `walkRoot(".github")` reaches `workflows/`. Read-only.
- `AGENTS.md` -- `:170-197` the durable `## Frozen identifiers` section below `<!-- /bmad:context -->`. `:178-181` already backticks all four `X-Yopedia-` members; `:194-196` already backticks all thirteen hyphen members, so parity direction 2 lands green with no prose edit beyond the new host bullet. `:177` says "Eleven of the twelve waivers are here" — that count moves. `:11` marks `.github/` protected; DW-350's recorded decision is the explicit authorisation for the one prose edit.
- `.github/workflows/deploy-cloudflare.yml` -- `:4` the single bare-prose hit. Comment line only.
- `.github/workflows/seed-yoyo.yml` -- `:93` the second `workers.dev` host. Read-only evidence for the waiver; do not edit.
- Verified today: the widened walk flags exactly those two lines across `.github`'s 12 `.yml` files — no `WorkWiki` and no stray `workwiki` anywhere in the tree.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/brand-copy.test.ts` -- add `/yopedia\.christianlee-flightwall\.workers\.dev/g` to `IDENTIFIER_ALLOWLIST` beside the existing deployment origin, with a comment stating it is the second deployment host seeded by `.github/workflows/seed-yoyo.yml` and spelled in full for the same reason as its sibling -- a shape would wave through any `Yopedia.<something>`.
- `src/lib/__tests__/brand-copy.test.ts` -- add `...(await walkRoot(".github"))` to `maintainerSources()` with a comment: CI/deploy workflows are operator tooling like `scripts/`, they carry frozen env names and a deployment origin, and until now no scan read them -- rationale: the union means one list is enough to hold the tree to all three rules.
- `src/lib/__tests__/brand-copy.test.ts` -- pin `.github/workflows/deploy-cloudflare.yml` in the maintainer pin test and refresh the corpus-count comment (~50 today); leave the floor at 30 -- rationale: a walk that stops matching the new root must fail here, not shrink silently.
- `src/lib/__tests__/brand-copy.test.ts` -- add a frozen case (`YOPEDIA_URL: ... 'https://yopedia.christianlee-flightwall.workers.dev'`) and a lookalike slip case to the "tells a frozen yopedia identifier apart from a display-brand slip" table -- rationale: the new waiver's anchoring is fixed by a case, exactly as the sibling host's is.
- `src/lib/__tests__/brand-copy.test.ts` -- introduce a module-level `ENUMERATED_FAMILIES` pairing each family pattern with its member-pattern list, derive `DOCUMENTED_WAIVERS` by expanding `IDENTIFIER_ALLOWLIST` through it, and rewrite parity direction 2 to take its floor and its loop from `DOCUMENTED_WAIVERS`; assert first that `IDENTIFIER_ALLOWLIST` still contains each family pattern by reference -- rationale: DW-589; without the containment assertion the expansion silently reverts to per-PATTERN if someone inlines a family regex.
- `AGENTS.md` -- add a backticked `yopedia.christianlee-flightwall.workers.dev` bullet in `## Frozen identifiers` beside the existing origin bullet, and correct the "Eleven of the twelve waivers" count -- rationale: parity direction 2 fails on an allowlist pattern with no documented spelling.
- `.github/workflows/deploy-cloudflare.yml` -- backtick the identifier on `:4` (`` binds `yopedia` KV/R2 IDs ``) -- rationale: it is the identifier named as itself, which `` /`yopedia`/g `` already waives; nothing executable changes.

**Acceptance Criteria:**
- Given the suite on today's tree, when `maintainerSources()` runs, then its result contains `.github/workflows/deploy-cloudflare.yml` and the maintainer corpus still clears its floor.
- Given `.github/` is now scanned, when `every remaining "yopedia" is a runtime identifier` and `no brand source says "WorkWiki"` run, then both report zero offenders and no `.github` path was added to `YOPEDIA_PROSE_EXEMPT`.
- Given a member is appended to `YOPEDIA_HYPHEN_IDENTIFIERS` or `X_YOPEDIA_HEADERS` with no backticked AGENTS.md spelling, when the parity test runs, then it fails naming that member's own pattern rather than passing on a sibling's strength.
- Given a family pattern is removed from `IDENTIFIER_ALLOWLIST` (inlined or dropped), when the parity test runs, then it fails on the containment assertion rather than quietly reverting to per-PATTERN iteration.
- Given the full suite, when `pnpm vitest run src/lib/__tests__/brand-copy.test.ts` runs, then every test passes.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 1: (high 0, medium 0, low 1)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` `ENUMERATED_FAMILIES` was guarded in one direction only — a deleted registry row or a copy-paste mis-pairing collapsed a family back to one parity question with every test green (reproduced: deleting the `X_YOPEDIA_PATTERN` row plus one AGENTS.md bullet passed all 22 tests). Added a `MEMBER_LISTS` check keyed off the member-pattern constants directly, plus a duplicate-entry assertion; both mutations now fail by name.
  - `[medium]` `[patch]` AGENTS.md stated the parity contract at pattern granularity, so a maintainer appending an enumeration member read the wrong obligation. Restated at member granularity and widened the intro bullet's member-by-member carve-out to cover both closed enumerations.
  - `[low]` `[patch]` The member-pattern comments claimed the patterns are "only ever used with `.test()`", which this change falsified by running them through `String.match`. Both comments now name both call sites and say which one needs the `g` flag absent.
  - `[low]` `[patch]` AGENTS.md's protected-path bullet did not record that `.github/` is now scan-governed. Added the coupling in one clause.
  - `[low]` `[patch]` The `.github` walk comment defended `SOURCE_TEXT` with a mojibake argument that does not distinguish it from its `ANY_FILE` siblings. Replaced with the real residual: all `.yml` today, but a later extensionless `CODEOWNERS` would fall outside the filter.
  - `[low]` `[patch]` The maintainer corpus floor stayed at 30 while the corpus grew to ~50, so eleven of the twelve unpinned workflows could stop being read. Raised to 40; verified load-bearing (shrinking the walk to the pinned file alone passes at 30, fails at 40).
  - `[low]` `[patch]` The new DW-589 comments claimed the drop direction was unguarded. It was not — direction 1 already fails on a dropped member. Both comments now claim only the add direction.

## Design Notes

The expansion is a small, explicit table rather than a clever transform, so the link between a collapsed pattern and its members is readable:

```ts
const ENUMERATED_FAMILIES = [
  [YOPEDIA_HYPHEN_PATTERN, YOPEDIA_HYPHEN_MEMBER_PATTERNS],
  [X_YOPEDIA_PATTERN, X_YOPEDIA_MEMBER_PATTERNS],
] as const;

const DOCUMENTED_WAIVERS: readonly RegExp[] = IDENTIFIER_ALLOWLIST.flatMap((pattern) => {
  const family = ENUMERATED_FAMILIES.find(([collapsed]) => collapsed === pattern);
  return family ? family[1].map(([, member]) => member) : [pattern];
});
```

13 allowlist patterns expand to 28 documented waivers (13 − 2 collapsed + 13 hyphen members + 4 headers). AGENTS.md names 36 backticked yopedia spellings after the new bullet, so the `>= DOCUMENTED_WAIVERS.length` floor holds with slack. Member patterns carry no `g` flag, so direction 2's `spelling.match(pattern)` is safe against `lastIndex` resumption either way.

`.github` goes in `maintainerSources()` rather than `scannedSources()`: workflows ship no rendered copy, they are deploy/operator tooling in the same family as `scripts/setup-cloudflare.sh`. The union makes the choice non-load-bearing for coverage — every predicate reads it — but it keeps the scanned-corpus floor a statement about authored product surfaces.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/brand-copy.test.ts` -- expected: all tests pass.
- `pnpm vitest run src/lib/__tests__/source-scan.test.ts` -- expected: all tests pass (walk contract untouched).
- `pnpm exec tsc --noEmit` -- expected: no new type errors.
- `pnpm test` -- expected: no new failures relative to the pre-change baseline.
- `git diff --stat -- .github` -- expected: exactly one file, one line, comment-only.

## Auto Run Result

Status: done

**Implemented change.** Closed two brand-scan coverage holes. `.github/` (12 workflow files) is now walked by `maintainerSources()` through the shared `SOURCE_TEXT` filter, so every brand predicate reads it via `allBrandSources()`. The one live prose hit it exposed was corrected and the one real deployment host it names was waived with a matching AGENTS.md bullet. Separately, the DW-356 parity test's direction 2 now iterates a per-member expansion of `IDENTIFIER_ALLOWLIST` (`DOCUMENTED_WAIVERS`, 28 waivers from 13 patterns) rather than the collapsed patterns, so a member appended to either enumerated family must be documented in AGENTS.md on its own strength.

**Files changed.**
- `src/lib/__tests__/brand-copy.test.ts` — `.github` walk in `maintainerSources()` with a pin and a raised corpus floor (30 -> 40); new `/yopedia\.christianlee-flightwall\.workers\.dev/g` waiver with a frozen case and a lookalike slip case; `ENUMERATED_FAMILIES` / `DOCUMENTED_WAIVERS` and the rewritten parity direction 2 with three structural guards.
- `AGENTS.md` — new backticked host bullet in `## Frozen identifiers`, waiver count corrected, parity contract restated at member granularity, `.github/` protected-path coupling recorded.
- `.github/workflows/deploy-cloudflare.yml` — one comment line, bare `yopedia` backticked. Nothing executable changed.

**Review findings breakdown.** 7 patches applied (2 medium, 5 low), 1 item deferred (low), 6 rejected. Rejected as noise or pre-existing idiom: the unbounded host pattern (mirrors its sibling exactly), the hand-maintained "thirteen"/"seventeen" counts (this file's established idiom, accurate today), switching `.github` to `ANY_FILE` (contradicts the spec's Always clause), the frozen case being a transcription rather than a read (same idiom as the existing `setup-cloudflare.sh` cases), `seed-yoyo.yml`'s pre-existing self-contradiction between its header comment and its `env:` default, and a zero-member-family guard subsumed by the `MEMBER_LISTS` check.

**Follow-up review recommendation.** Patched findings by severity: high 0, medium 2, low 5. Score: no high-severity patch, so `followup_review_recommended: false`.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/source-scan.test.ts` — 29 passed.
- `pnpm test` — 386 files, 9663 passed, 1 pre-existing skip, 0 failures.
- `pnpm exec tsc --noEmit` — exit 0. `pnpm lint` — exit 0.
- `git diff --stat -- .github` — 1 file, 1 insertion, 1 deletion.
- Mutation-tested every new guard, reverting each: appending an undocumented `X-Yopedia-Trace-Id` or `yopedia-audit-log` fails by member pattern (and passes on the pre-change file, confirming DW-589 was real); inlining a family regex fails the containment guard; deleting a registry row or mis-pairing one fails the `MEMBER_LISTS` guard; duplicating a member list fails the duplicate guard; removing the `.github` walk fails the maintainer pin; shrinking it to the pinned file alone fails the raised floor; un-backticking `deploy-cloudflare.yml:4` and dropping the new host waiver each fail the yopedia scan.
- Matrix audit: all six I/O rows are covered by tests that ran and passed in this session.

**Residual risks.**
- The `.github/` corpus now feeds the two family minimality sweeps as evidence. It can only add evidence, never remove it, so it cannot mask a retired resource — but a future workflow spelling a dead identifier would keep that name looking alive.
- `.github/` is a protected path (`.yoyo/yoyo.toml`, AGENTS.md), and it is now scan-governed: a brand string landing in a workflow can only be cleared by editing a protected file. Recorded in AGENTS.md rather than left implicit.
- An extensionless file added under `.github/` later (a `CODEOWNERS`) falls outside `SOURCE_TEXT` and would be read by no scan. Stated in the walk's comment; not guarded.
- The deferred item above: the new single-host waiver has no liveness sweep, so it outlives its host if `seed-yoyo.yml`'s default is retargeted.
