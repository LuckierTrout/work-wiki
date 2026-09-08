---
title: 'Brand-copy scan coverage: root configs, anchored yopedia family, missing-path pins, .agents/skills, clipper name, AGENTS.md parity'
type: 'bugfix'
created: '2026-08-27'
status: 'done'
baseline_revision: 'ac853cf233b9e636814df6f88b663b06bba9b06f'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      IDENTIFIER_ALLOWLIST still waives the X-Yopedia-* wire headers as an unanchored
      SHAPE, which is the same defect DW-352 fixed for the lowercase-hyphen family.
    evidence: |-
      /X-Yopedia-(?:[A-Za-z-]+|\*)/g strips any run of letters and hyphens after the
      prefix, so strayYopedia("See X-Yopedia-Style-Guide for the docs") reports zero and
      that display prose passes the scan. The sibling family was narrowed to a closed
      enumeration with a minimality test; this one was left as a shape. Pre-existing --
      the bundle intent named only /yopedia-[a-z-]+/g.
    location: >-
      src/lib/__tests__/brand-copy.test.ts (IDENTIFIER_ALLOWLIST, X-Yopedia- entry)
    severity: medium
  - summary: >-
      Minimality is enforced for YOPEDIA_HYPHEN_IDENTIFIERS only; every other yopedia
      waiver and all of WORKWIKI_IDENTIFIER_ALLOWLIST can outlive what it waived.
    evidence: |-
      The new "keeps every waived yopedia resource name earning its place" test sweeps
      the corpus for the hyphen enumeration only. /u/yopedia, the health-check bodies,
      yopedia.yolog.dev, yopedia.yuanhao-li.workers.dev, yologdev/yopedia, yopedia--,
      yopedia_ and the whole workwiki allowlist have no equivalent, so a retired
      identifier leaves its word permanently waived as display copy -- the failure mode
      the enumeration comment itself argues is real.
    location: >-
      src/lib/__tests__/brand-copy.test.ts
    severity: low
  - summary: >-
      The anchored hyphen family's LEADING boundary allows a dot, so a lookalike host
      such as cdn.yopedia-raw.example.com stays waived.
    evidence: |-
      YOPEDIA_HYPHEN_BOUNDS blocks [A-Za-z0-9_-] on both sides. A trailing dot is
      deliberately allowed and documented (live workers.dev hostname, /tmp/*.log
      basenames); a LEADING dot is allowed only as a side effect. A leading slash must
      stay allowed for /tmp/yopedia-r2.log, so this is a narrowing of the lookbehind,
      not a removal.
    location: >-
      src/lib/__tests__/brand-copy.test.ts (YOPEDIA_HYPHEN_BOUNDS)
    severity: low
---

<intent-contract>

## Intent

**Problem:** The brand-copy scan has six holes: the repo-root listing is markdown-only so eleven root config files (and `.env.example`) are never read; `IDENTIFIER_ALLOWLIST`'s unanchored `/yopedia-[a-z-]+/g` waives display prose like "the yopedia-first workflow"; literal file paths and walk roots surface a rename as `ENOENT` from inside a content assertion instead of a diagnostic pin failure; `.agents/skills/` (974 scannable tracked files) is read by no scan while the comparable `.opencode/commands/` is walked; the browser clipper's shipped product name has only negative coverage, so a reviewer deleting it passes the suite; and `AGENTS.md`'s frozen list omits yopedia spellings `IDENTIFIER_ALLOWLIST` waives, which `AGENTS.md` itself says must agree.

**Approach:** Widen the root listing to the single `SOURCE_TEXT` filter (retiring the hand-named config list and the `MARKDOWN` selector); restore the anchored `YOPEDIA_HYPHEN_PATTERN` enumeration reverted by commit `f2458e1844b0b2db7377b2b027f67a63431a0fc1`, extended for the new root corpus; stat every literal path and walk root before use; fold `.agents/skills/` in with a vacuity guard; add positive product-name coverage for the clipper; and replace the yopedia half of the `AGENTS.md` freeze list with prose that a derived test proves agrees with every allowlist pattern in both directions.

## Boundaries & Constraints

**Always:** Keep ONE source-type filter (`SOURCE_TEXT`) as `walk()`'s default. Every predicate keeps running over `allBrandSources()`. Every widened root and every new waiver carries its own pin or vacuity guard, so the widening cannot go silently vacuous. `AGENTS.md` must stay clean under the scan itself — every spelling added there must be waived by `IDENTIFIER_ALLOWLIST`.

**Block If:** Any newly scanned file carries genuine stale display copy that cannot be resolved as either a frozen identifier or this deployment's own history.

**Never:** Do not rename any frozen runtime identifier. Do not widen an allowlist pattern to make a new file pass. Do not add a file-level (uncounted) yopedia exemption. Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`. Do not touch `.github/` or `.yoyo/yoyo.toml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Root config drift | `vitest.config.ts` gains "WorkWiki" | `no brand source says "WorkWiki"` fails naming that file | No error expected |
| Anchored yopedia prose | `strayYopedia("the yopedia-first workflow")` | returns a match — display prose is a slip again | No error expected |
| Anchored yopedia identifier | `strayYopedia('"queue": "yopedia-tasks"')` | returns no match — the enumerated name stays waived | No error expected |
| Retired resource name | An enumerated name no longer occurs in the scanned tree | minimality test fails naming the dead waiver | No error expected |
| Renamed literal path | `src/mcp.ts` renamed | pin failure naming the path and the list to update | Diagnostic message, not `ENOENT` |
| Renamed walk root | `.opencode/commands/` removed | pin failure naming the root | Diagnostic message, not `ENOENT` |
| Installer root goes vacuous | `.agents/skills/` contributes 0 files | vacuity guard fails | No error expected |
| Clipper name deleted | `manifest.json` `name` set to `"Clipper"` | positive coverage fails naming the field | No error expected |
| Allowlist widened silently | A new `IDENTIFIER_ALLOWLIST` pattern with no `AGENTS.md` prose | parity test fails naming the unexplained pattern | No error expected |

</intent-contract>

## Code Map

- `src/lib/__tests__/brand-copy.test.ts` -- the whole change lands here except the `AGENTS.md` prose. Key anchors: header comment points 1–4 (`:13-45`); `IDENTIFIER_ALLOWLIST` (`:57-79`, the unanchored `/yopedia-[a-z-]+/g` at `:68`); `SOURCE_TEXT` (`:99-100`); `walk()` (`:110-116`); `scannedSources()` (`:143-181`, literal pushes `:147-148`); `MARKDOWN`/`ANY_FILE` (`:184-185`); `maintainerSources()` (`:299-317`, hand-named root configs `:314-316`); `YOPEDIA_PROSE_EXEMPT` (`:377-385`); pin tests (`:388-470`); yopedia case table (`:541-575`); `operator-facing surfaces name the product` describe (`:604-711`, its header comment concedes the clipper gap at `:596-601`); the `AGENTS.md` workwiki parity test (`:665-711`); stat idiom to copy (`:742-763`).
- `src/lib/__tests__/source-scan.ts` -- `walkFiles`/`SKIPPED_DIRS`; unchanged. `__tests__` is skipped, so the frozen-case table cannot keep a dead enumeration name alive.
- `AGENTS.md` -- `## Frozen identifiers` at `:121`, below the `<!-- /bmad:context -->` marker at `:30`. The yopedia bullet is `:126`; `:135` is the workwiki "enforcing half" bullet the yopedia side needs a mirror of.
- `integrations/browser-clipper/manifest.json` -- `name` `:3`, `description` `:5`, `action.default_title` `:9`; `popup.html` `<title>` `:6` and `<h1>` `:12`. All five say `work-wiki` today.
- `f2458e1844b0b2db7377b2b027f67a63431a0fc1` -- reverted the DW-352 fix. `git show f2458e18 -- src/lib/__tests__/brand-copy.test.ts` is the recovery source (reverse-apply by hand; three later commits touched the file).
- Corpus facts verified: root files new to the scan are brand-clean except `vitest.setup.ts:10` (`"yopedia-test-"` tmpdir prefix) and `playwright.config.ts` (`YOPEDIA_E2E*`, already all-caps waived). `.agents/skills/` = 974 scannable files, 10.3 MB, zero brand hits, ~120 ms per pass. `docs/production-owner-session-acceptance-2026-08-03.md` carries `yopedia-project-tracking` twice — waived by the wildcard today, a 2-count exemption under the anchored pattern.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/brand-copy.test.ts` -- add `^\.env\.example$` to `SOURCE_TEXT` beside `^Dockerfile$`; replace `maintainerSources()`'s markdown-only root listing with a non-recursive `SOURCE_TEXT` listing and delete the four hand-named config paths and the now-unused `MARKDOWN` selector; state the `pnpm-lock.yaml` decision in the comment -- DW-351: no root text file stays unread and no second listing filter survives to drift.
- `src/lib/__tests__/brand-copy.test.ts` -- restore `YOPEDIA_HYPHEN_IDENTIFIERS` + `YOPEDIA_HYPHEN_PATTERN` from `f2458e18`, swap them into `IDENTIFIER_ALLOWLIST`, restore the frozen/slip case rows and the minimality test, restore the `docs/production-owner-session-acceptance-2026-08-03.md` exemption at 2, and add the `test-` member for `vitest.setup.ts`'s tmpdir prefix -- DW-352: display prose stops being waived by a shape.
- `src/lib/__tests__/brand-copy.test.ts` -- add `requireFile()`/`walkRoot()` stat helpers (the `scripts.sync` idiom) and route every literal path and every walk root through them -- DW-353: a rename fails with a diagnostic instead of `ENOENT`.
- `src/lib/__tests__/brand-copy.test.ts` -- add `.agents/skills` to `scannedSources()` with a comment documenting the split, a contributes-> 0 vacuity guard beside `.opencode/commands`'s, and a corpus floor that excludes both installer roots -- DW-354: the tracked installer tree is scanned without letting it satisfy the floor on its own.
- `src/lib/__tests__/brand-copy.test.ts` -- add a positive clipper test to `operator-facing surfaces name the product` covering `manifest.json` `name`/`description`/`action.default_title` and `popup.html` `<title>`/`<h1>`, each asserted to contain `APP_NAME` and to carry neither stale spelling; correct the describe's header comment, which currently records the gap -- DW-355: a deleted product name is a failing state on the widest-audience surface.
- `AGENTS.md` -- rewrite the yopedia half of `## Frozen identifiers` so every `IDENTIFIER_ALLOWLIST` pattern has a backticked example spelling, including `X-Yopedia-*`, `yopedia.yolog.dev` and `yopedia.yuanhao-li.workers.dev`; add the yopedia mirror of the `:135` enforcing-half bullet -- DW-356: prose and allowlist agree.
- `src/lib/__tests__/brand-copy.test.ts` -- add the yopedia parity test beside the workwiki one: every backticked yopedia spelling in the section is waived, and every `IDENTIFIER_ALLOWLIST` pattern matches at least one of them -- DW-356: the omission failure mode becomes impossible rather than hand-fixed.

**Acceptance Criteria:**
- Given the widened root listing, when the suite runs, then `maintainerSources()` reads `docker-compose.yml`, `next.config.ts`, `open-next.config.ts`, `tailwind.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `postcss.config.mjs` and `.env.example` alongside the four previously hand-named config files, and each is pinned by name.
- Given `.agents/skills/`, when the suite runs, then it contributes more than zero files to `scannedSources()` and the corpus floor is computed over the non-installer roots only, so deleting the app tree still fails.
- Given `pnpm test src/lib/__tests__/brand-copy.test.ts`, when it runs on the unmodified tree, then every test passes.
- Given the full `pnpm test` node project, when it runs, then no other suite regresses.

## Spec Change Log

_No bad_spec loopback occurred; this spec was not amended after planning._

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 1, medium 3, low 5)
- defer: 3: (high 0, medium 1, low 2)
- reject: 6: (high 0, medium 1, low 5)
- addressed_findings:
  - `[high]` `[patch]` The minimality test certified itself: `AGENTS.md` is in the scanned corpus and the DW-356 parity test forces it to spell the enumerated names, so renaming `vitest.setup.ts`'s `yopedia-test-` prefix left the test green. It also matched by substring, so `yopedia-tasks-dlq` kept the `tasks` member alive forever. Fixed by excluding `FREEZE_PROSE` (`AGENTS.md`) from the evidence sweep — with a `sawFreezeProse` guard so the exclusion cannot rot into a no-op — and by matching each member with the waiver's own anchored boundaries (`YOPEDIA_HYPHEN_BOUNDS`).
  - `[medium]` `[patch]` `requireFile()`'s diagnostic hard-coded "update scannedSources()/maintainerSources()" while also firing for `AGENTS.md` and the clipper files, which neither function names. Added an optional `where` argument and passed an accurate one at every call site.
  - `[medium]` `[patch]` The DW-353 comment claimed every literal path below it was stat'd; six were not. Routed `src/app/layout.tsx`, `scripts/setup-cloudflare.sh`, the `workers/` readdir root and each worker `README.md`, `workers/task-consumer/index.ts`, `src/app/api/tasks/run/route.ts` and `package.json` through `requireFile()`/`requireDir()`.
  - `[medium]` `[patch]` `backtickedSpellings()` paired backticks across a line, capturing inter-span text as a fabricated spelling and failing Direction 1 with a message accusing the author of freezing something they never wrote. Now matches every backtick span first and filters by brand, which also removes the unescaped `brand` interpolation into `new RegExp`.
  - `[low]` `[patch]` The clipper had a sixth shipped name surface — `service-worker.js`'s `chrome.contextMenus.create` title, which DW-355's own reason names — with no positive coverage while the rewritten comment declared the gap closed. Covered it, wrapped the manifest `JSON.parse` in a diagnostic, and corrected the comment.
  - `[low]` `[patch]` `f2458e18` also reverted an `AGENTS.md` bullet enumerating the whole hyphen family by name; the recovery directive covers it and the high-severity fix above makes restoring it safe. Restored, split into wrangler-resident names vs. the rest, gave the `` `yopedia` `` doc-comment waiver its own sub-bullet, and softened "verified at its call site" to name the one entry a test actually checks on both sides.
  - `[low]` `[patch]` Comment accuracy: the header said "Four things" then "Those five points"; point 3 did not mention the installer-root exclusion; the `maintainerSources()` comment enumerated eleven root files as though that were the whole widening (~30 are read); the floor comment had lost its justifying figure. All corrected.
  - `[low]` `[patch]` Pins: added `pnpm-workspace.yaml` (the `.yaml` half of the `ya?ml` alternative) and `pnpm-lock.yaml`, and gave `maintainerSources()` a corpus floor so the root listing collapsing to exactly the pinned set no longer passes.
  - `[low]` `[patch]` `INSTALLER_ROOTS[0]`/`[1]` coupled two call-site comments to array order. Replaced with named constants composed into `INSTALLER_ROOTS as const`.

## Design Notes

`f2458e18` is a revert, not a design change: its message ("sweep dw3-embedding-readiness-truthfulness: DW-402, DW-403") has nothing to do with the brand scan, and it deleted 157 lines of DW-352's fix along with 16 unrelated spec artifacts. Recover from the diff rather than re-deriving.

The anchored pattern blocks `A-Z`, `a-z`, `0-9`, `_` and `-` on both sides but deliberately still allows a trailing `.` (live hostname `yopedia-task-consumer.<subdomain>.workers.dev`, log basenames `/tmp/yopedia-r2.log`). `vitest.setup.ts`'s prefix ends in a hyphen, so its enumeration member is `test-`, not `test` — the trailing lookahead would otherwise reject it. That member is only reachable because DW-351 puts root `.ts` files in the corpus; if that widening is ever undone the minimality test fails loudly, which is the intended coupling.

The `AGENTS.md` parity test checks spellings in their backticked form, because `/`yopedia`/g` is itself a backtick-anchored waiver — the section has to survive the brand scan exactly as written.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/brand-copy.test.ts` -- expected: all tests pass.
- `pnpm exec vitest run --project node` -- expected: no new failures versus the pre-change tree.
- `pnpm exec tsc --noEmit` -- expected: clean (or unchanged versus the pre-change tree).
- Plant-and-revert: set `integrations/browser-clipper/manifest.json` `name` to `"Clipper"`, re-run the suite, confirm the new clipper test fails, then revert -- expected: fails on the planted edit, passes after revert.

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** Closed six brand-copy scan holes (DW-351 … DW-356). The repo-root listing is now a non-recursive `SOURCE_TEXT` listing rather than a markdown-only one with four hand-named config files beside it, so ~30 root files — every config, `.env.example`, `pnpm-lock.yaml` — are read and only one source-type filter survives in the file. The `yopedia-` waiver is a closed anchored enumeration again (recovered from `f2458e1844b0b2db7377b2b027f67a63431a0fc1`, which had reverted it as collateral in an unrelated sweep), extended with the `test-` tmpdir prefix and backed by a minimality test that no longer accepts the freeze prose as its own evidence. Every literal path and walk root is stat'd, so a rename is a diagnostic rather than an `ENOENT` from inside a content assertion. `.agents/skills/` (974 files) joined the corpus behind a vacuity guard, with the corpus floor recomputed over authored files only. The browser clipper's six shipped product-name surfaces have positive coverage. `AGENTS.md`'s frozen list and `IDENTIFIER_ALLOWLIST` now agree in both directions, enforced by a derived parity test rather than by hand.

**Files changed.**
- `src/lib/__tests__/brand-copy.test.ts` — all six scan changes: widened `SOURCE_TEXT` and root listing, anchored `YOPEDIA_HYPHEN_PATTERN` + per-member evidence patterns, `requireFile()`/`requireDir()`/`walkRoot()` stat helpers, `.agents/skills/` root and installer-root guards, positive clipper coverage, `AGENTS.md`↔allowlist parity test.
- `AGENTS.md` — `## Frozen identifiers` yopedia half rewritten: one worked example per waiver, the closed hyphen enumeration restored by name, and a yopedia mirror of the workwiki enforcing-half bullet.
- `_bmad-output/implementation-artifacts/spec-dw-351-356-brand-copy-scan-coverage.md` — this spec.

**Review findings.** 9 patches applied (1 high, 3 medium, 5 low); 3 deferred (1 medium, 2 low — see frontmatter `deferred`); 6 rejected (bundle-triage policy objections about `severity: low` entries and about the ledger not being marked resolved, both outside this session's authority; a memoization suggestion; three speculative edge cases).

**Follow-up review recommendation.** `true`. Patched severities: high 1, medium 3, low 5. A high-severity patch alone sets the flag; the score is also `3 × 3 + 1 × 5 = 14`, over the threshold of 5.

**Verification.**
- `pnpm exec vitest run --project node src/lib/__tests__/brand-copy.test.ts` — 21/21 passed, 732 ms (238 ms before; the added 10.3 MB installer tree is read ~7×).
- `pnpm exec vitest run --project node` — 274 files, 6689 passed, 1 skipped. No regressions.
- `pnpm exec tsc --noEmit` — clean. `pnpm exec eslint src/lib/__tests__/brand-copy.test.ts` — clean.
- Plant-and-revert, re-verified independently for the clipper (`manifest.json` `name` → `"Clipper"` fails naming the field, passes after revert) and reported by the implementer for every other matrix row, including the two P1 cases (renaming the `vitest.setup.ts` tmpdir prefix now fails the minimality test; the anchored per-member match rejects `yopedia-tasks-dlq` as evidence for `tasks`).

**Residual risks.**
- The three deferred items in frontmatter, chiefly the still-unanchored `X-Yopedia-*` shape — the same defect class DW-352 fixed for its sibling family.
- `pnpm-lock.yaml` and `next-env.d.ts` are now scanned. Both are generated; a future regeneration that introduced a brand-named dependency would fail the suite, which is the intended signal but will read as surprising.
- `.agents/skills/` is installer-generated and not authored here. It is brand-clean today; an upstream BMAD bump that lands a "Yopedia" or "WorkWiki" inside it would fail the suite, and the only available lever is `YOPEDIA_PROSE_EXEMPT`'s per-file count, which fits a tree this repo does not author poorly.
- Bundle composition, for the orchestrator's attention rather than this session's: five of the six ledger entries are `severity: low`, and `AGENTS.md`'s recorded preference says low entries belong in `skip`, not in a bundle. They were implemented as dispatched.
- The deferred-work ledger was not edited, per the invocation.
