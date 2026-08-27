---
title: 'DW-155/156/157/158 — pin the single-owner Schema resolution invariant at its untested surfaces'
type: 'chore'
created: '2026-08-27'
status: 'done'
baseline_revision: '587f47fb95226587aedc7c9c10825c217a6f394b'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `e2eOwnerHandle()`'s consumers were entirely unpinned before this change:
      every fixture set `NEXT_PUBLIC_OWNER_HANDLE` to the literal string
      `E2E_DEFAULT_HANDLE` already is.
    evidence: |-
      `E2E_DEFAULT_HANDLE` is `"e2e-owner"` (`src/lib/e2e-identity.ts:24`), and
      `e2e-identity.test.ts`, `auth.test.ts`, `middleware-write-gate.test.ts`
      and `e2e/env.ts` all configured exactly that handle, so
      `expect(x ?? DEFAULT).toBe(DEFAULT)` was the shape of every assertion —
      replacing the function body with `return E2E_DEFAULT_HANDLE;` left the
      whole suite green. This change closes the hole at the handle itself
      (`src/lib/__tests__/e2e-identity.test.ts`), but the SAME
      same-string-as-the-default fixture convention still governs
      `YOPEDIA_OWNER_USER_ID` / `e2eOwnerUserId()` and the middleware write
      gate, so sibling assertions there may be vacuous for the same reason.
      Pre-existing; the convention predates this change.
    location: >-
      src/lib/__tests__/auth.test.ts and src/lib/__tests__/middleware-write-gate.test.ts
    severity: low
  - summary: >-
      `src/lib/__tests__/lint.test.ts:670` still `process.chdir`s into its
      tmpdir, which makes the suite cwd-sensitive if it ever throws before the
      `finally`.
    evidence: |-
      The `includes SCHEMA.md conventions in contradiction detection prompt`
      test changes the process working directory and restores it in a `finally`.
      Vitest runs a file's tests in one worker process, so a restore that is
      skipped leaves every later test in that worker with a cwd it did not set,
      and `rootSchemaPath()` is `${process.cwd()}/SCHEMA.md`. The new DW-158
      block deliberately avoids `chdir` for exactly this reason; making the
      older test use the explicit `schemaPath` override instead would remove
      the hazard. Pre-existing.
    location: >-
      src/lib/__tests__/lint.test.ts:670
    severity: low
---

<intent-contract>

## Intent

**Problem:** Four surfaces of the single-owner / active-Wiki Schema resolution invariant are load-bearing but unpinned: `readActiveWikiSchema()`'s catch branch (unreadable/unparseable registry → warn + root fallback) has no test; owner-handle case normalization is pinned only in isolation, never at the Schema path; `src/app/api/tasks/scan/route.ts:183` re-implements `getOwnerHandle()` inline so a `getOwnerHandle` grep misses a reader of the env var; and neither `lint-checks.ts` detector has a test that it resolves the ACTIVE Wiki's Schema — pinning both to the repo-root file passes the whole suite today.

**Approach:** One behavior-preserving refactor (route the scan route's owner read through `getOwnerHandle()`) plus three regression pins added to the existing suites — a corrupt-`wikis.json` fixture and a mixed-case owner-handle case in `wiki-schema-source.test.ts`, and active-Wiki Schema resolution pins for both lint detectors in `lint.test.ts`.

## Boundaries & Constraints

**Always:** Runtime behavior stays identical — the only production edit is swapping a duplicated env read for the existing helper, which is byte-equivalent (`getOwnerHandle()` returns the trimmed value or `null`; the current expression yields the trimmed value or `undefined`, and both call sites are truthiness-guarded). New tests live in the existing suites and follow their fixtures: `wiki-schema-source.test.ts` uses `DATA_DIR` + `NEXT_PUBLIC_OWNER_HANDLE` env swaps and `createWiki`; `lint.test.ts` uses its module-level `../llm` mock, `writeWikiPage`/`updateIndex`, and `_resetStorage`. Every new pin must FAIL against the mutation it names (verify by hand-applying the mutation, then revert).

**Block If:** The scan-route refactor would change observable behavior (it does not), or a new pin cannot be made to fail against its named mutation.

**Never:** Do not add a tenant/owner parameter to `loadPageConventions()` or `readActiveWikiSchema()` — the signature pin at `wiki-schema-source.test.ts:291` forbids it. Do not change `src/lib/owner.ts`, `getOwnerHandle()`, `isOwnerHandle()`, or `ownerToTenant()`. Do not change `readRegistry`'s error handling in `src/lib/wikis.ts` (an unparseable registry rethrowing is the behavior under test). Do not touch the `loadPageTemplates()` path. Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unparseable registry (DW-155) | `NEXT_PUBLIC_OWNER_HANDLE=alice`; alice has a `reading` Wiki; `tenants/alice/wikis.json` overwritten with non-JSON | `loadPageConventions()` returns the repo-root conventions, never the Wiki's; `logger.warn("wikis", …)` fires once | SyntaxError is caught inside `readActiveWikiSchema`; no throw reaches the caller |
| Mixed-case owner handle (DW-156) | Wiki created for `alice`; `NEXT_PUBLIC_OWNER_HANDLE="Alice"` | Resolves alice's Wiki conventions — the `reading` scenario prose is present | No error expected |
| Mixed-case Wiki creation (DW-156) | Wiki created for `"Alice"`; `NEXT_PUBLIC_OWNER_HANDLE="alice"` | Same single tenant, same conventions — case never splits the silo | No error expected |
| Lint detectors on an active Wiki (DW-158) | `NEXT_PUBLIC_OWNER_HANDLE=alice`; alice has a `reading` Wiki; LLM key mocked present | `checkContradictions()` and `checkMissingConceptPages()` system prompts carry the ACTIVE Wiki's conventions | No error expected |
| Backup owner unset (DW-157) | `NEXT_PUBLIC_OWNER_HANDLE` unset or blank | Scan skips the backup check and reports `backupOwnerConfigured: false`, exactly as today | No error expected |

</intent-contract>

## Code Map

- `src/app/api/tasks/scan/route.ts:183` -- `const backupOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE?.trim();`. The duplicate reader. Used at `:184` (`isOwnerBackupDue`), `:186-187` (`enqueueTask({ kind: "create-backup", owner: backupOwner })`) and `:234` (`backupOwnerConfigured: Boolean(backupOwner)`) — all truthiness-guarded, so `null` substitutes for `undefined` cleanly. Import `getOwnerHandle` from `@/lib/owner` (the file's import block is at `:1-25`).
- `src/lib/e2e-identity.ts:44` -- `e2eOwnerHandle()`, the OTHER remaining raw reader: `process.env.NEXT_PUBLIC_OWNER_HANDLE?.trim()` with an `E2E_DEFAULT_HANDLE` fallback. `getOwnerHandle() ?? E2E_DEFAULT_HANDLE` is exactly equivalent (both treat blank/whitespace as absent). Route it through the helper too, or DW-157's "exactly one reader" claim stays false.
- `src/lib/owner.ts:16-19` -- `getOwnerHandle()`. Read-only; the sole intended reader after this change.
- `src/lib/__tests__/scan-route.test.ts` -- host for the DW-157 matrix row. Module-level mocks for `@/lib/backups` (`:13`) and `@/lib/tasks`; `beforeEach` (`:68-89`) deletes `AUTONOMOUS_MAINTENANCE`/`NEXT_PUBLIC_OWNER_HANDLE`/`YOPEDIA_READONLY` and `afterEach` restores them. The owner-backup cases are `:132-166`; nothing there pins the unset/blank-owner branch.
- `src/lib/wikis.ts:2135-2153` -- `readActiveWikiSchema()`. `getOwnerHandle()` → `getCurrentWiki(owner)` → `readWikiArtifact(...)`, wrapped in the `try` whose `catch` logs `logger.warn("wikis", …)` and returns `null`. Read-only.
- `src/lib/wikis.ts:288-296` -- `readRegistry()`. Catches ENOENT only; a `JSON.parse` SyntaxError on a corrupt `wikis.json` is RETHROWN, which is what drives `readActiveWikiSchema`'s catch. Read-only — this is the mechanism the DW-155 fixture relies on.
- `src/lib/wikis.ts:149` -- `wikiRegistryPath(owner)` → `tenants/<tenant>/wikis.json`, already exported. Use it to place the corrupt fixture at `path.join(tmpDir, wikiRegistryPath(OWNER))`.
- `src/lib/links.ts` (`ownerToTenant`, re-exported as `tenantForOwner` from `src/lib/wiki.ts`) -- lowercases the owner handle into the tenant path segment. The mechanism DW-156 pins. Read-only.
- `src/lib/__tests__/wiki-schema-source.test.ts` -- host for DW-155 and DW-156. `OWNER = "alice"` (`:29`), `OTHER_TENANT = "bob"` (`:31`), `beforeEach` at `:37-46` (tmpdir + `DATA_DIR` + `NEXT_PUBLIC_OWNER_HANDLE` + `_resetLocks()` + `_resetStorage()`), `afterEach` at `:48-55` restores both env vars. The `describe("single-owner Schema resolution invariant")` block is `:192-311`; its signature pin is `:291`. Add `wikiRegistryPath` and `logger` to the imports (`:18-27`).
- `src/lib/lint-checks.ts:408` and `:563` -- the two no-argument `loadPageConventions()` calls (`checkContradictions`, `checkMissingConceptPages`). Both append the result to their system prompt as `conventions (from SCHEMA.md)`. Read-only — this is the resolution under test.
- `src/lib/__tests__/lint.test.ts` -- host for DW-158. Module-level `vi.mock("../llm", …)` at `:10-13` gives `mockedCallLLM`; `beforeEach` at `:46-60` sets `WIKI_DIR`/`RAW_DIR`/`DATA_DIR` under a fresh tmpdir and resets the mocks; `afterEach` at `:62-80` restores them. `describe("checkContradictions")` starts `:528`; the existing root-only conventions test is `:670-724` (it `process.chdir`s into tmpDir — the new tests must NOT, since the root fallback must remain the real repo `SCHEMA.md` for the contrast to hold). `describe("checkMissingConceptPages")` is `:791-917`.
- `src/lib/workspace-profile-schema.ts:85` -- source of `"Preserve sequence when it matters"`, the `reading` scenario's `pageConventions` line. Present in a seeded Wiki `schema.md`, absent from the repo-root `SCHEMA.md` (verified: `grep -c` returns 0). The marker every active-Wiki pin asserts on.
- `src/lib/schema-source.ts:26-49` -- `rootSchemaPath()` = `${process.cwd()}/SCHEMA.md`; `readSchemaFile` reads it via the storage provider using `path.relative(getDataDir(), schemaPath)`, so with `DATA_DIR` pointed at a tmpdir the root fallback still reaches the real repo file. Read-only.

## Tasks & Acceptance

**Execution:**

- `src/app/api/tasks/scan/route.ts` -- import `getOwnerHandle` from `@/lib/owner` and replace the inline `process.env.NEXT_PUBLIC_OWNER_HANDLE?.trim()` at `:183` with `getOwnerHandle()` -- DW-157: one reader of the env var, so a `getOwnerHandle` grep is complete.
- `src/lib/e2e-identity.ts` -- replace the inline read in `e2eOwnerHandle()` with `getOwnerHandle() ?? E2E_DEFAULT_HANDLE` -- DW-157: the second duplicate reader; behavior-identical, and leaving it makes the invariant's "one reader" claim untrue.
- `src/lib/__tests__/scan-route.test.ts` -- add a case pinning the unset AND whitespace-only owner handle: with `AUTONOMOUS_MAINTENANCE=on`, `isOwnerBackupDue` is never called, no `create-backup` task is enqueued, and the response reports `backupOwnerConfigured: false` -- covers the DW-157 matrix row and pins the blank-is-absent semantics `getOwnerHandle()` inherits from the inline `?.trim()`.
- `src/lib/wikis.ts` -- update the `readActiveWikiSchema()` docstring paragraph that names the scan route as an independent reader (around `:2081-2085`) so it matches the new single-reader reality, and point the catch-branch/case-normalization claims at their new pins -- keeps the invariant's prose true after the refactor.
- `src/lib/__tests__/wiki-schema-source.test.ts` -- add a corrupt-registry test to the `single-owner Schema resolution invariant` block: create the owner's `reading` Wiki, overwrite `path.join(tmpDir, wikiRegistryPath(OWNER))` with non-JSON, spy on `logger.warn`, assert the conventions equal the repo-root ones, do not contain `"Preserve sequence when it matters"`, and that the warn fired with the `"wikis"` tag -- DW-155.
- `src/lib/__tests__/wiki-schema-source.test.ts` -- add two case-normalization tests: (a) Wiki created for `"alice"` with `NEXT_PUBLIC_OWNER_HANDLE="Alice"`, (b) Wiki created for `"Alice"` with `NEXT_PUBLIC_OWNER_HANDLE="alice"`; both resolve the same Wiki's conventions -- DW-156.
- `src/lib/__tests__/lint.test.ts` -- add save/restore of `NEXT_PUBLIC_OWNER_HANDLE` to the file's `beforeEach`/`afterEach` (delete it in `beforeEach` so existing tests keep exercising the root fallback deterministically) and call `_resetLocks()` alongside `_resetStorage()` so `createWiki` is safe to use -- fixture groundwork for DW-158.
- `src/lib/__tests__/lint.test.ts` -- add a `describe` covering both detectors: set `NEXT_PUBLIC_OWNER_HANDLE`, `createWiki(owner, { name: …, scenario: "reading" })`, seed the pages each detector needs, run it with `hasLLMKey` mocked true, and assert the system prompt handed to `callLLM` contains `"Preserve sequence when it matters"` -- DW-158: the mutation `loadPageConventions(<template literal for cwd + "/SCHEMA.md">)` fails here.

**Acceptance Criteria:**

- Given the repo after this change, when `grep -rn "NEXT_PUBLIC_OWNER_HANDLE" src --include='*.ts' --include='*.tsx'` is run and comment/test lines are excluded, then `src/lib/owner.ts` is the only file that reads the variable.
- Given `pnpm test`, when the suite runs, then every previously passing test still passes and the new pins pass.
- Given each new pin, when its named mutation is hand-applied (registry-corruption fixture removed; owner handle forced lowercase before tenant resolution; both `lint-checks.ts` detectors changed to `loadPageConventions(<template literal for cwd + "/SCHEMA.md">)`), then that pin fails.
- Given `pnpm lint` and `pnpm exec tsc --noEmit`, when run, then neither reports a new error.

## Spec Change Log

No bad_spec loopbacks. Empty.

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 3, low 5)
- defer: 2: (high 0, medium 0, low 2)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[medium]` `[patch]` `e2eOwnerHandle()`'s edit shipped unpinned — every existing fixture set `NEXT_PUBLIC_OWNER_HANDLE` to the same literal as `E2E_DEFAULT_HANDLE`, so `return E2E_DEFAULT_HANDLE;` passed the whole suite. Added minted-principal pins in `e2e-identity.test.ts` using a configured handle that differs from the default, plus unset/empty/whitespace fallback rows.
  - `[medium]` `[patch]` DW-156's behavioral half was near-vacuous on macOS: `os.tmpdir()` is case-insensitive APFS, so removing `.toLowerCase()` from `ownerToTenant` still passed. Added a filesystem-independent pin that spies on the storage provider and asserts the Schema path requested the literal key `tenants/alice/wikis.json` and never `tenants/Alice/`.
  - `[medium]` `[patch]` DW-157's invariant (one reader, so a `getOwnerHandle` grep is complete) had no mechanized guard — only a manual grep in this spec's ACs. Added `src/lib/__tests__/owner-single-reader.test.ts`, a source scan asserting `src/lib/owner.ts` is the sole non-test reader.
  - `[low]` `[patch]` The scan-route skip-the-backup case asserted only that no `create-backup` task was enqueued, which passes vacuously if the route short-circuits earlier. Added a positive control on the maintenance enqueues.
  - `[low]` `[patch]` The scan-route `it.each` covered unset and whitespace-only but not `""`, and never covered the trim-passthrough case that actually distinguishes `getOwnerHandle()` from a raw env read on a storage key. Added both.
  - `[low]` `[patch]` The DW-155 warn assertion pinned only the tag and the call count, so an emptied message/payload — the undiagnosable fallback the branch exists to prevent — still passed, and an unrelated warn failed it spuriously. Now filters to `"wikis"`-tagged calls and asserts the message names the owner and the root `SCHEMA.md` and that the underlying error is carried.
  - `[low]` `[patch]` The `wikis.ts` docstring claimed "exactly ONE reader repo-wide", which the three test files in this change falsify. Reworded to one PRODUCTION reader, noted that fixtures set the env directly, pointed at the new source-scan pin, and reflowed the stranded `* read/write —` fragment.
  - `[low]` `[patch]` DW-156 pinned `wikiRegistryPath` case-collapse but not `wikiArtifactPath`; DW-158's non-vacuity guard carried a dead `delete process.env…` and an unexplained dynamic import. Added the artifact-path and trim-plus-case cases; removed the dead code.

## Design Notes

The DW-155 fixture depends on a mechanism worth stating outright: `readRegistry` catches ENOENT only, so `JSON.parse` on a corrupt `tenants/<t>/wikis.json` throws a `SyntaxError` that propagates out of `getCurrentWiki` into `readActiveWikiSchema`'s catch. Writing an EMPTY or `{}` registry would not reach that branch — it parses fine and degrades to `emptyRegistry()` through the `null`-Wiki path, which is already covered. The fixture must be genuinely unparseable text.

For DW-158, do not `process.chdir` (as `lint.test.ts:670` does): the contrast the pin depends on is "active Wiki's seeded conventions" vs "the real repo-root `SCHEMA.md`", and the root file must stay reachable through `path.relative(DATA_DIR, cwd + "/SCHEMA.md")` for the assertion to mean anything.

## Verification

**Commands:**
- `pnpm test` -- expected: the full suite passes, including the new pins.
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm lint` -- expected: no new errors.
- `grep -rn "NEXT_PUBLIC_OWNER_HANDLE" src` -- expected: the only non-comment, non-test read is in `src/lib/owner.ts`.

**Manual checks (if no CLI):**
- Hand-apply each named mutation, confirm the corresponding new test fails, then revert.

## Auto Run Result

Status: done

**Implemented change.** Behavior-preserving refactor plus regression pins for the single-owner / active-Wiki Schema resolution invariant. `NEXT_PUBLIC_OWNER_HANDLE` now has exactly one production reader (`getOwnerHandle()`), and the four previously untested surfaces — the `readActiveWikiSchema()` catch branch, owner-handle case normalization at the Schema path, the scan route's owner read, and both `lint-checks.ts` detectors' active-Wiki resolution — are pinned.

**Files changed**
- `src/app/api/tasks/scan/route.ts` -- reads the site owner through `getOwnerHandle()` instead of an inline `process.env.NEXT_PUBLIC_OWNER_HANDLE?.trim()` (DW-157).
- `src/lib/e2e-identity.ts` -- `e2eOwnerHandle()` is now `getOwnerHandle() ?? E2E_DEFAULT_HANDLE`, removing the second raw reader.
- `src/lib/wikis.ts` -- `readActiveWikiSchema()` docstring: one production reader, and an inventory of the new pins. Comments only.
- `src/lib/__tests__/wiki-schema-source.test.ts` -- DW-155 corrupt-`wikis.json` pin with a diagnosability assertion on the warn; DW-156 case-normalization pins in both directions, including a storage-key spy that is filesystem-independent and a trim-plus-case case.
- `src/lib/__tests__/lint.test.ts` -- DW-158 pins that both detectors' system prompts carry the ACTIVE Wiki's conventions, plus a non-vacuity guard; `NEXT_PUBLIC_OWNER_HANDLE` save/restore and `_resetLocks()` added to the file fixture.
- `src/lib/__tests__/scan-route.test.ts` -- unset / empty / whitespace-only owner skips the backup check with a positive control on the maintenance enqueues, and a trim-passthrough case pinning the handle as a storage key.
- `src/lib/__tests__/e2e-identity.test.ts` -- minted-principal pins with a configured handle that differs from `E2E_DEFAULT_HANDLE`.
- `src/lib/__tests__/owner-single-reader.test.ts` (new) -- source scan mechanizing DW-157's grep-completeness invariant.

**Review findings breakdown.** 8 patches applied (medium 3, low 5); 2 items deferred (both low, both pre-existing); 9 rejected as noise.

**Follow-up review recommendation: true.** Patched counts by severity: high 0, medium 3, low 5. Score = 3x3 + 1x5 = 14, which is >= 5. No high-severity patch.

**Verification performed**
- `pnpm test` -- 329 files, 7589 passed, 1 skipped (the skip is pre-existing). Up from 328/7579 at the baseline.
- `pnpm exec tsc --noEmit` -- clean, exit 0.
- `pnpm lint` -- clean; only the three pre-existing `jsx-ast-utils` notices.
- `grep -rn "process.env.NEXT_PUBLIC_OWNER_HANDLE" src` excluding tests -- `src/lib/owner.ts:17` is the only hit.
- Mutation checks, each hand-applied then reverted by re-editing (never by a git command): pinning both `lint-checks.ts` detectors to the repo-root `SCHEMA.md` fails the two DW-158 pins; removing `.toLowerCase()` from `ownerToTenant` fails all three DW-156 pins, including the storage-key one that carries no path-helper assertion; silencing the `readActiveWikiSchema` catch warn fails the DW-155 pin; a raw untrimmed `process.env` read in the scan route fails the DW-157 blank case; `e2eOwnerHandle()` returning the constant fails the new e2e pin; a raw env read added to `src/lib/authz.ts` fails the source-scan pin.
- Matrix test audit: all five I/O matrix rows are covered by tests that ran and passed in the final suite.

**Residual risks**
- `owner-single-reader.test.ts` scans source text, so a computed `process.env[someVar]` read cannot be caught; its comment stripper is naive and biases toward missing a read rather than inventing one, so a false pass is possible in a contrived case and a false failure is not.
- The DW-156 behavioral assertions (as opposed to the storage-key spy) are only load-bearing on a case-sensitive filesystem; the spy is what makes the pin bite on macOS.
- Two pre-existing test-hygiene issues are recorded in frontmatter `deferred` rather than fixed here: the same-string-as-the-default fixture convention around the E2E identity vars, and the `process.chdir` in `lint.test.ts:670`.
