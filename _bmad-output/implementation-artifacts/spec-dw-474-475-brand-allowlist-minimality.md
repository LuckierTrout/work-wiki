---
title: 'Brand waiver minimality sweeps and hyphen-family leading-dot narrowing'
type: 'chore'
created: '2026-09-05'
baseline_revision: '808567188a23ff74afe3ad995b63261ecb9c890c'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The literal-host rows of IDENTIFIER_ALLOWLIST and both workwiki hyphen/host rows carry no
      leading boundary at all, so DW-475's lookalike-host hole stays open one row over.
    evidence: |-
      DW-475 narrowed YOPEDIA_HYPHEN_BOUNDS's leading class, but `/yopedia\.yolog\.dev/g`,
      `/yopedia\.yuanhao-li\.workers\.dev/g`, `/yopedia\.christianlee-flightwall\.workers\.dev/g`,
      `/workwiki\.app/g` and `/\.?workwiki-(?:source-sync|backups|portable-archive|archive|actions\.ics|[*.$0-9])/g`
      have no lookbehind. Verified by mutation during review: adding
      "cdn.yopedia.yolog.dev is not the upstream origin", "Xyopedia.yolog.dev is not the upstream origin",
      "cdn.workwiki-archive.example.com" and "Xworkwiki-backups" to the slip tables makes each of them
      FAIL — they are stripped whole today and the residue carries no brand word to count. The existing
      near-misses for those rows all vary the SUFFIX only, so nothing pins the prefix direction. The
      workwiki hyphen row is the awkward one: its leading `\.?` is deliberate (`.workwiki-source-sync.json`),
      so it needs an explicit alternative rather than a copied lookbehind.
      Out of scope for this bundle: DW-475's intent says to add `.` to the leading class of
      YOPEDIA_HYPHEN_BOUNDS only.
    location: >-
      src/lib/__tests__/brand-copy.test.ts (IDENTIFIER_ALLOWLIST origin rows, WORKWIKI_IDENTIFIER_ALLOWLIST)
    severity: low
---

<intent-contract>

## Intent

**Problem:** In `src/lib/__tests__/brand-copy.test.ts` only the two hoisted enumerations
(`YOPEDIA_HYPHEN_IDENTIFIERS`, `X_YOPEDIA_HEADERS`) are swept for minimality, so every pattern in
`IDENTIFIER_ALLOWLIST` and in `WORKWIKI_IDENTIFIER_ALLOWLIST` can outlive the identifier it waives —
a retired identifier stays a permanently waived display word as long as AGENTS.md still names it
(DW-474). Separately, `YOPEDIA_HYPHEN_BOUNDS`'s leading lookbehind blocks only `[A-Za-z0-9_-]`, so a
lookalike host such as `cdn.yopedia-raw.example.com` is waived as if it were this deployment's
bucket (DW-475).

**Approach:** Add two evidence sweeps in the shape of the existing two — one per allowlist, keyed by
pattern instead of by member name — sharing one helper so the `FREEZE_PROSE` self-certification
exclusion lives in one place. Then add `.` to the leading character class of
`YOPEDIA_HYPHEN_BOUNDS` only, leaving the trailing lookahead untouched.

## Boundaries & Constraints

**Always:**
- Both new sweeps run over `scanBrandSources()`/`allBrandSources()` and assert `expectUnionCorpus(read)`,
  like every other content test in the file.
- Both new sweeps exclude `FREEZE_PROSE` (`AGENTS.md`) as evidence and assert the excluded file WAS
  read, so the exclusion cannot rot into a no-op — the two existing sweeps' guard, verbatim.
- Evidence is taken with `String.prototype.match`, not `RegExp.prototype.test`: the allowlist patterns
  carry the `g` flag, so `test()` would resume from `lastIndex`.
- Failure messages name the offending pattern (`String(pattern)`) and say what the maintainer must do.
- Comments in this file are the design record: any comment that stops being true after these edits
  (the `YOPEDIA_HYPHEN_BOUNDS` "both boundaries block ..." paragraph and the `X_YOPEDIA_BOUNDS`
  cross-reference to it) is updated in the same change.
- The whole suite stays green: `pnpm vitest run src/lib/__tests__/brand-copy.test.ts`.

**Block If:**
- A pattern in either allowlist turns out to have NO evidence in the shipped tree outside `AGENTS.md`.
  Deciding whether such a waiver is dead (drop it) or merely unwritten is a judgement about production
  identifiers — HALT with status `blocked` naming the pattern. (Planning found evidence for every
  pattern in both lists, so this is a guard, not an expectation.)
- Narrowing the lookbehind moves any pinned `YOPEDIA_PROSE_EXEMPT` count. (Planning found zero
  `.yopedia-` occurrences repo-wide, so this too is a guard.)

**Never:**
- Do not touch the trailing lookahead of `YOPEDIA_HYPHEN_BOUNDS` — a trailing `.` is deliberately
  allowed and documented (the live `*.workers.dev` health-check hostname, the `/tmp/*.log` basenames).
- Do not change `X_YOPEDIA_BOUNDS`'s character classes; DW-475 is scoped to the hyphen family.
- Do not rewrite the two existing member sweeps (`keeps every waived yopedia resource name earning its
  place`, `keeps every waived X-Yopedia- wire header earning its place`) onto the new helper: they use
  `.test()` deliberately, so that a `g` flag added to a member pattern breaks something instead of
  being silently absorbed.
- Do not add, remove or generalise any allowlist pattern, and do not touch `YOPEDIA_PROSE_EXEMPT`.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Every yopedia waiver is written somewhere | Repo as it stands today | The `IDENTIFIER_ALLOWLIST` sweep passes | No error expected |
| Every workwiki waiver is written somewhere | Repo as it stands today | The `WORKWIKI_IDENTIFIER_ALLOWLIST` sweep passes | No error expected |
| A waiver's only evidence is the freeze prose | Pattern matches in `AGENTS.md` alone | The sweep FAILS naming that pattern | Message says: drop the pattern, or fix its spelling if the identifier was renamed |
| `FREEZE_PROSE` stops naming a scanned file | `AGENTS.md` absent from every source list | The sweep FAILS on `sawFreezeProse` | Message says the exclusion has become a no-op |
| Lookalike host | `"cdn.yopedia-raw.example.com is not the bucket"` | `hasStrayYopedia` returns `true` | n/a — this is a slip case |
| Live log basename | `"... 2>&1 \| tee /tmp/yopedia-r2.log; then"` | `hasStrayYopedia` returns `false` | n/a — leading `/` stays allowed |
| Live health-check hostname | `https://yopedia-task-consumer.<subdomain>.workers.dev` | Still waived | n/a — trailing `.` stays allowed |

</intent-contract>

## Code Map

- `src/lib/__tests__/brand-copy.test.ts` -- the only file this change touches. 1639 lines.
  - `:143` `YOPEDIA_HYPHEN_BOUNDS` -- `["(?<![A-Za-z0-9_-])yopedia-", "(?![A-Za-z0-9_-])"]`; DW-475
    edits the FIRST element only. Its doc comment (`:124-142`) states "Both boundaries block ..." and
    explains why a trailing `.` is allowed — both halves need updating for the new asymmetry.
  - `:229` `X_YOPEDIA_BOUNDS` -- unchanged, but its comment says "the same classes and for the same
    reason as {@link YOPEDIA_HYPHEN_BOUNDS}", which stops being exactly true; note the asymmetry.
  - `:256` `IDENTIFIER_ALLOWLIST` -- 13 patterns today (all `g`). Two of them are the collapsed family
    patterns `X_YOPEDIA_PATTERN` and `YOPEDIA_HYPHEN_PATTERN`.
  - `:486` `WORKWIKI_IDENTIFIER_ALLOWLIST` -- 7 patterns today (all `g`).
  - `:800` `FREEZE_PROSE = "AGENTS.md"` -- the self-certification exclusion, with the rationale the new
    sweeps inherit.
  - `:735` `scanBrandSources(offense)` -- the one corpus iteration; returns `{ offenders, read }`.
  - `:748` `expectUnionCorpus(read)` -- the both-lists witness assertion every content test runs.
  - `:1145` and `:1187` -- the two existing member sweeps; the new tests are modelled on their shape and
    placed immediately after them, before `every remaining "yopedia" is a runtime identifier` (`:1225`).
  - `:1010` `it("tells a frozen yopedia identifier apart from a display-brand slip")` -- the frozen/slip
    case table. Its slip list already carries one near-miss per boundary class
    (`"not-yopedia-tasks ..."`, `"Xyopedia-raw ..."` at `:1135-1136`); the leading-dot case joins them.
- Read-only evidence gathered during planning (do not re-derive):
  - Every pattern in BOTH allowlists has at least one match in the shipped tree outside `AGENTS.md`
    and outside `__tests__` — including `yopedia\.christianlee-flightwall\.workers\.dev`
    (`.github/workflows/seed-yoyo.yml`, reached by `maintainerSources()`'s `.github` walk).
  - `rg --hidden '\.yopedia-'` over the repo (excluding `.git`, `node_modules`, `_bmad-output`,
    `.bmad-loop`) returns NOTHING, so narrowing the lookbehind changes no existing match and moves no
    `YOPEDIA_PROSE_EXEMPT` count.
  - `cdn.yopedia-raw.example.com` is waived today by `YOPEDIA_HYPHEN_PATTERN` alone — no other
    allowlist pattern strips it — so blocking a leading `.` is sufficient to make it a stray.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/brand-copy.test.ts` -- add `.` to the leading class of `YOPEDIA_HYPHEN_BOUNDS[0]`
  (`(?<![A-Za-z0-9_.-])yopedia-`) and rewrite its doc comment so the boundaries' new asymmetry, and the
  reason the trailing `.` stays allowed, are both stated plainly -- DW-475.
- `src/lib/__tests__/brand-copy.test.ts` -- adjust the `X_YOPEDIA_BOUNDS` comment's cross-reference so it
  no longer claims identical classes -- the comment is the design record and must not go stale.
- `src/lib/__tests__/brand-copy.test.ts` -- add a shared `async function unusedWaivers(probes)` helper
  next to `FREEZE_PROSE`: it runs one `scanBrandSources` pass, skips `FREEZE_PROSE` as evidence while
  recording that it was read, asserts `expectUnionCorpus(read)` and the `sawFreezeProse` guard, and
  returns the labels with no evidence. Document why the two existing member sweeps are NOT retrofitted
  onto it, and state the residual: a pattern whose only matches would have been consumed by an earlier
  allowlist pattern during stripping still counts as earning its place here -- DW-474.
- `src/lib/__tests__/brand-copy.test.ts` -- add `it("keeps every waived yopedia identifier pattern
  earning its place")` sweeping all of `IDENTIFIER_ALLOWLIST` through the helper, labelled by
  `String(pattern)`. Document that the two collapsed family rows are a weaker restatement of the member
  sweeps above, kept rather than excluded so this test needs no registry-keyed exclusion that can rot -- DW-474.
- `src/lib/__tests__/brand-copy.test.ts` -- add `it("keeps every waived workwiki identifier pattern
  earning its place")` sweeping `WORKWIKI_IDENTIFIER_ALLOWLIST` the same way, with a message naming
  that constant -- DW-474.
- `src/lib/__tests__/brand-copy.test.ts` -- add `"cdn.yopedia-raw.example.com is not the bucket"` to the
  slip list beside the existing leading-attachment near-misses, so the narrowing is pinned by a case
  that fails without it -- DW-475.

**Acceptance Criteria:**
- Given the repository as it stands, when `pnpm vitest run src/lib/__tests__/brand-copy.test.ts` runs,
  then every test passes, including the two new sweeps.
- Given the leading class is reverted to `[A-Za-z0-9_-]`, when the suite runs, then the slip case
  `cdn.yopedia-raw.example.com is not the bucket` fails — the narrowing is pinned, not merely present.
- Given `FREEZE_PROSE` is changed to a path no source list reads, when either new sweep runs, then it
  fails with the no-op-exclusion message rather than passing.
- Given a pattern is appended to either allowlist that nothing in the shipped tree spells, when the
  suite runs, then the corresponding new sweep fails and names that pattern.
- Given the whole suite runs (`pnpm test`), when it finishes, then no test outside
  `src/lib/__tests__/brand-copy.test.ts` changes status because of this change.

## Design Notes

The helper keys probes by an opaque label so both allowlists can share it:

```ts
async function unusedWaivers(probes: readonly (readonly [string, RegExp])[]): Promise<string[]>
```

Call sites pass `list.map((p) => [String(p), p] as const)`. `String(pattern)` is the regex source with
its flags — the spelling a maintainer greps for — so the failure message points straight at the line to
edit. Evidence uses `text.match(pattern) !== null`: the allowlist patterns carry `g`, and `match` sets
`lastIndex` to 0 both before and after, which `test()` does not (the same reason DW-589's parity loop
uses `match`).

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/brand-copy.test.ts` -- expected: all tests pass, including the two
  new sweeps and the extended slip table.
- `pnpm test` -- expected: the full suite is green, no new failures anywhere.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

**Summary.** `src/lib/__tests__/brand-copy.test.ts` now proves its brand-copy waivers are still
earning their place, and one of them stops over-waiving. DW-474: a shared `unusedWaivers(probes)`
helper runs one corpus pass over `allBrandSources()`, skips `AGENTS.md` as evidence while asserting it
WAS read, and returns the probes nothing outside the freeze prose matches; two new tests feed it
`IDENTIFIER_ALLOWLIST` and `WORKWIKI_IDENTIFIER_ALLOWLIST`, keyed by `String(pattern)` so a failure
names the line to edit. DW-475: `YOPEDIA_HYPHEN_BOUNDS`'s leading lookbehind became
`(?<![A-Za-z0-9_.-])`, pinned by a new slip case `cdn.yopedia-raw.example.com is not the bucket`; the
trailing lookahead is untouched, so the live `*.workers.dev` health-check hostname and the
`/tmp/*.log` basenames stay waived. A third new test asserts the two member-pattern lists stay
non-global, which is what the existing `.test()` sweeps depend on.

**Files changed.**
- `src/lib/__tests__/brand-copy.test.ts` — the only file touched (+264/−14). New `unusedWaivers()`
  helper with vacuity, duplicate-label and freeze-prose guards; three new tests; the leading-class
  narrowing; one new slip case; and the comment blocks on `YOPEDIA_HYPHEN_BOUNDS` and
  `X_YOPEDIA_BOUNDS` rewritten so the file's design record matches the new asymmetry.

**Review findings.** 8 patches applied (0 high, 3 medium, 5 low) — see the Review Triage Log.
1 item deferred (low): the literal-host rows of `IDENTIFIER_ALLOWLIST` and the two `workwiki` rows
have no leading boundary, so DW-475's lookalike-host hole stays open one row over. 6 rejected: the
trailing-side lookalike `yopedia-raw.example.com` (explicitly out of scope — the intent says leave the
lookahead alone); basename-matching `FREEZE_PROSE` (only one `AGENTS.md` is tracked, and exact-path
matching is what the two existing sweeps do); the `g`-dependence of `strayYopedia`/`strayWorkwiki`'s
`.replace` (pre-existing, and its failure mode is a loud false positive rather than a silent waiver);
the intent's stale pattern counts and line anchors (descriptive only); the observation that the
narrowing is pinned by a case-table string rather than corpus evidence (no scanned file writes
`.yopedia-`, and the case table is this file's idiom for exactly that); and the suggestion to narrow
the trailing class (Never clause).

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 3, low 5;
no high-severity patch, so no further review pass is recommended.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/brand-copy.test.ts` — 25 passed (22 before this change).
- `pnpm test` — 386 files, 9666 passed, 1 skipped, 0 failures. Run three times after the patches, green
  each time.
- `pnpm lint` — exit 0 (the three `TSNonNullExpression` lines are pre-existing jsx-ast-utils noise).
- Mutation checks, each reverted afterwards: reverting the leading class to `[A-Za-z0-9_-]` fails the
  new slip case and nothing else; `FREEZE_PROSE = "NOWHERE.md"` fails all four evidence sweeps with the
  no-op-exclusion message; a never-written pattern appended to either allowlist fails the matching new
  sweep and names it (the yopedia one also trips the pre-existing AGENTS.md parity test, as designed);
  adding `"g"` to the `YOPEDIA_HYPHEN_MEMBER_PATTERNS` construction fails only the new flags test,
  which independently confirms the review finding that the two member sweeps stayed silent under it.
- Read-only planning evidence re-confirmed before editing: every pattern in both allowlists has a match
  in the shipped tree outside `AGENTS.md`, and `rg --hidden '\.yopedia-'` finds nothing outside this
  test file, so the narrowing moves no `YOPEDIA_PROSE_EXEMPT` count.

**Residual risks.**
- One earlier full-suite run (before the three green ones, with the patched file in place) reported
  `1 failed | 9665 passed`. Only the summary lines were captured, so the failing test was not
  identified; three consecutive full runs since have been green, as was the implementation agent's own
  run. Recorded rather than explained away.
- The sweeps ask whether a pattern matches SOMETHING, not whether it does work an earlier pattern does
  not already do, and a shape or alternation row earns its place on any one of the identifiers it
  covers. Both residuals, plus the fact that grandfathered `YOPEDIA_PROSE_EXEMPT` history counts as
  evidence, are written into the helper's docblock.
- `WORKWIKI_IDENTIFIER_ALLOWLIST`'s entries have thin evidence by nature (a persisted extension id, an
  on-disk state filename), so unrelated work that drops the last written occurrence now fails this
  suite. That is the intended coupling, but it is a new way for unrelated changes to go red.
