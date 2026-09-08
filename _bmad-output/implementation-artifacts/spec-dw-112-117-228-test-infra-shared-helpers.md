---
title: 'Shared test infrastructure: DOM shim barrel, source-scan walk, Settings harness (DW-112, DW-117, DW-228)'
type: 'refactor'
created: '2026-08-27'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      Two source-tree walkers still hand-roll the traversal `walkFiles` now owns, and both
      descend into `__tests__`.
    evidence: |-
      `routeFiles()` (src/lib/__tests__/read-only-door-coverage.test.ts:113) and
      `retiredSurfacesOnDisk()` (src/lib/__tests__/retired-surfaces.test.ts:49) implement the
      same "descend and collect by basename" contract as the seven suites migrated here, with
      no exclusions at all. Neither is named `walk()`, so neither appeared in the intent's
      census of eight; migrating them was out of scope on the intent's own authority. No file
      exists under a `__tests__` directory that either would currently mishandle, so this is
      latent rather than active.
    location: >-
      src/lib/__tests__/read-only-door-coverage.test.ts:113
    severity: low
  - summary: >-
      The fifth mounted Settings suite still carries its own ~50-field payload because the
      shared harness is not reachable from its directory.
    evidence: |-
      `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` duplicates the
      fixture the new `settings-harness.tsx` consolidates for the four workbench suites, but
      the harness lives inside `src/components/workbench/__tests__/` and is reachable only by
      a `./` sibling import. Folding it in would need the harness to move somewhere aliasable
      (mirroring `src/test/`), which the intent did not ask for.
    location: >-
      src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx
    severity: low
  - summary: >-
      Two settings fixtures override `version` to a different stamp shape than the shared base
      with no explanation of why both shapes exist.
    evidence: |-
      `settings-vector-namespace.test.tsx` and `settings-embedding-provider-switch.test.tsx`
      state `version: "w1:2-0000000000000000"` where `settingsPayload()`'s base is
      `"s1:00000000000000000000000000000000"`. No assertion in either file reads `version`, and
      both values predate this change, so the consolidation preserved rather than caused the
      divergence — but it is now visible as an unexplained delta on the shared base.
    location: >-
      src/components/workbench/__tests__/settings-vector-namespace.test.tsx
    severity: low
baseline_revision: '61634ac95c8897026a11378e8ad7a4db9a688bba'
---

<intent-contract>

## Intent

**Problem:** Three kinds of test infrastructure are copy-pasted instead of shared: six DOM suites reach `vitest.setup.dom.ts` through hardcoded relative ladders that encode each file's directory depth (DW-112); eight suites define their own `walk()` with inconsistent directory exclusions, so scans that read as equivalent silently cover different file sets (DW-117); and four mounted Settings suites carry verbatim copies of the same ~50-field `payload()`, `fetchMock` hooks, `announcedFor()` and `mount()` harness (DW-228).

**Approach:** Add three non-`.test`-named helper modules — a barrel that re-exports the DOM shim controls under the `@` alias, a shared source-scan `walkFiles()` with one documented exclusion set, and a shared Settings mount harness — then point every affected suite at them. No production code and no assertion changes: each suite must scan exactly the file set and mount exactly the payload it does today.

## Boundaries & Constraints

**Always:** Helper modules are named so neither vitest project collects them (`vitest.config.ts` includes only `**/__tests__/**/*.test.ts(x)`, and its config-load guard rejects a stray `*.test.tsx`). Every shim implementation stays in `vitest.setup.dom.ts` — the new `src/` module is a re-export barrel only, so AGENTS.md's "`vitest.setup.dom.ts` holds every shim and nothing in `src/` does" stays literally true. Preserve each suite's covered file set and each fixture's field values exactly; a suite whose defaults differ from the shared base states the delta locally with its existing explanatory comment kept beside it. Update the AGENTS.md bullet that documents the relative-ladder convention, since it becomes false.

**Block If:** A migration would change which files a scan covers or which payload a mounted case asserts against, and the intent gives no basis for choosing the new set.

**Never:** Do not touch production source under `src/` other than the new test-only barrel. Do not migrate `read-only-kernel-gate.test.ts`'s `walk()` (it snapshots a temp data dir's contents, not a source tree — a different function wearing the same name). Do not fold `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx`'s `body()` into the Settings harness (different directory, different fixture shape). Do not add or remove assertions, rename tests, or "improve" coverage while migrating.

</intent-contract>

## Code Map

- `vitest.config.ts` — two inline projects; `node` = `src/**/__tests__/**/*.test.ts`, `dom` = `src/**/__tests__/**/*.test.tsx`, both aliasing `@` → `./src`. A helper not named `*.test.ts(x)` is collected by neither. Read-only.
- `vitest.setup.dom.ts` — exports `setMediaQuery`, `resetMediaQueries`, `setElementRect`, `resetElementRects`, `setVisibilityState`, `fireVisibilityChange`, `type DeclaredRect`. Read-only.
- Ladder importers to repoint: `src/hooks/__tests__/useSidecarStatus.test.tsx:5`, `src/components/__tests__/workspace-purpose-settings.test.tsx:3`, `src/components/workbench/__tests__/workbench-sheet.test.tsx:9`, `preview-announcements.test.tsx:27`, `workbench-split-wiring.test.tsx:23`, `data-version-watcher.test.tsx:16`.
- Source-scan `walk()` owners (all in `src/lib/__tests__/`): `english-only.test.ts:26` (skips `__tests__`+`node_modules`; roots `SRC`, `workers/`, `integrations/`), `single-ia.test.ts:19` (skips `__tests__`), `single-main-landmark-scan.test.ts:38` (skips `__tests__`), `workbench-left-column.test.ts:51` (skips `__tests__`), `workbench-data-version.test.ts:1305` (skips nothing; both call sites at :1064 and :1280 filter `__tests__` inline afterwards), `brand-copy.test.ts:105` (skips `__tests__`+`node_modules`, plus per-call `skipDirs`), `pnpm-workspace-root.test.ts:278` (`UNWALKED` = `node_modules`, `.git`, `.next`, `.yoyo`; returns lockfile-bearing dirs as repo-relative paths).
- Settings harness duplication: `src/components/workbench/__tests__/settings-read-only.test.tsx:38-152` is the canonical copy; `settings-vector-namespace.test.tsx:34-157`, `settings-research-provider.test.tsx:24-99` and `settings-embedding-provider-switch.test.tsx:29-113` repeat it. Payload deltas from the majority base: read-only (`hasEmbeddingApiKey: true`, `readOnly: true`), vector-namespace (`version: "w1:2-0000000000000000"`, `embeddingProvider: "workers-ai"`, `hasWorkersAiBinding: true`), embedding-provider-switch (`version: "w1:2-0000000000000000"`, `embeddingBaseUrl: "https://o/v1"`, `hasEmbeddingApiKey: true`), research-provider (none). All four mount `SettingsCanvas` with `headingId="wb-set-heading"` and wait out `SETTINGS_LOADING_COPY` (`"Loading…"`, `src/lib/workbench-settings.ts:184`).
- Precedent for non-`.test` helpers beside their suites: `src/lib/__tests__/internal-link-fixture.ts`, `src/lib/__tests__/email-ingest-wire.ts`, imported as `./name`.
- `AGENTS.md:61-64` — states the setup helpers are not aliased and are reached by relative ladder. Must be rewritten. `AGENTS.md:70-76` — "nothing in `src/` [holds a shim]" must stay true.
- `src/lib/__tests__/workbench-chrome.test.ts:580-600` — scans every `src/`+`e2e/` `.ts|.tsx|.css|.md` file plus `AGENTS.md` for retired DOM-environment claims. New comments must not describe the runner as one environment or claim there is no DOM test environment.

## Tasks & Acceptance

**Execution:**
- `src/test/dom-helpers.ts` — new; re-export the seven public names from `../../vitest.setup.dom` and nothing else, with a comment saying the shims themselves stay in the setup file and this is only the aliased door to them.
- The six ladder importers listed above — replace `"../../../vitest.setup.dom"` / `"../../../../vitest.setup.dom"` with `"@/test/dom-helpers"`; leave the imported names and every assertion untouched.
- `src/lib/__tests__/source-scan.ts` — new; export `SKIPPED_DIRS` (`__tests__`, `node_modules`, `.git`, `.next`) with a comment on why each is never walked, and `walkFiles(dir, { include: RegExp, skipDirs?: readonly string[] })` returning absolute file paths whose basename matches `include`, descending past nothing in `SKIPPED_DIRS` or `skipDirs`.
- `src/lib/__tests__/brand-copy.test.ts`, `english-only.test.ts`, `single-ia.test.ts`, `single-main-landmark-scan.test.ts`, `workbench-left-column.test.ts` — delete the local `walk()`, call `walkFiles` with the suite's existing include regex and per-call `skipDirs`, keeping each suite's own doc comments about what it scans.
- `src/lib/__tests__/workbench-data-version.test.ts` — same, and drop the now-redundant inline `__tests__` filters at both call sites since the shared walk already excludes them.
- `src/lib/__tests__/pnpm-workspace-root.test.ts` — replace the local `walk()`/`UNWALKED` with `walkFiles(ROOT, { include: /^pnpm-lock\.yaml$/, skipDirs: [".yoyo"] })`, deriving the sorted repo-relative directory list from the returned paths and still excluding the root itself; note in a comment that a lockfile under a `__tests__` directory is a fixture, not a package.
- `src/components/workbench/__tests__/settings-harness.tsx` — new; export `settingsPayload(overrides)` (the majority base, carrying the existing field-group comments), `installSettingsFetchMock()` (registers the `beforeEach` stub and the `cleanup()`-first `afterEach`, returns the mock), `announcedFor(control)`, and `mountSettings(category, stored)`.
- `settings-read-only.test.tsx`, `settings-vector-namespace.test.tsx`, `settings-research-provider.test.tsx`, `settings-embedding-provider-switch.test.tsx` — replace the four duplicated blocks with harness imports; keep each file's local `payload()` as a thin wrapper stating only its deltas, and keep file-specific helpers (`expectNoSaveAttempted`) local.
- `AGENTS.md` — rewrite the "setup helpers are not aliased" bullet to state the `@/test/dom-helpers` door and that the shims still live only in `vitest.setup.dom.ts`; add a line that shared test helpers live in non-`.test`-named modules because the collection guard would otherwise pick them up.

**Acceptance Criteria:**
- Given the full suite before the change, when `pnpm test` runs after it, then the same tests exist and all pass with no new skips.
- Given a suite that scanned a tree, when its `walk()` is replaced by `walkFiles`, then the assertions that pin reach (`english-only`'s named files and >100 floor, `brand-copy`'s pin tests, `workbench-chrome`'s named-file check) still pass, proving the covered set did not narrow.
- Given `src/test/dom-helpers.ts` exists, when the dom project runs, then no suite imports `vitest.setup.dom` by relative path from `src/` and the shim state still resets between tests (the `setMediaQuery` unobserved-query guard still throws, so both halves share one module instance).
- Given the new helper modules, when `vitest.config.ts` loads, then its collection guard raises nothing — no helper is named `*.test.ts(x)`.
- Given a mounted Settings case, when it mounts through the shared harness, then it asserts against the same stored payload values as before, deltas included.

## Design Notes

`walkFiles` keeps `include` matched against the entry basename, exactly as every current copy does, so no call site's regex changes. `skipDirs` stays per-call, for the reason `brand-copy.test.ts` already documents: a globally-skipped extra name would silently shrink the brand scan too.

```ts
const dirs = await walkFiles(ROOT, { include: /^pnpm-lock\.yaml$/, skipDirs: [".yoyo"] });
const nested = dirs
  .map((f) => path.relative(ROOT, path.dirname(f)).split(path.sep).join("/"))
  .filter((rel) => rel !== "")
  .sort();
```

`installSettingsFetchMock()` returns one module-level `vi.fn()` reset in `beforeEach` rather than a fresh mock, so every existing `fetchMock.mockResolvedValue(...)` / `expect(fetchMock)...` call site keeps working verbatim.

## Verification

**Commands:**
- `pnpm test` -- expected: exit 0, both projects reported, no collection error from `vitest.config.ts`
- `pnpm exec vitest run --project dom` -- expected: exit 0, mounted suites collected
- `pnpm lint` -- expected: no new errors or warnings
- `pnpm exec tsc --noEmit` -- expected: no new type errors from the new modules or the repointed imports

## Auto Run Result

Status: done

**Implemented change.** Three kinds of copy-pasted test infrastructure were replaced by shared, non-`.test`-named modules, and every affected suite repointed at them. No production code changed and no assertion changed meaning: each migrated scan covers the same file set and each mounted case asserts against the same payload values as before.

**Files changed**

- `src/test/dom-helpers.ts` (new) -- re-export barrel for the seven public names of `vitest.setup.dom.ts`; implements nothing, so every shim still lives only in the setup file.
- `src/lib/__tests__/source-scan.ts` (new) -- `SKIPPED_DIRS` plus `walkFiles(dir, { include, skipDirs })`, the one traversal the source scans share; refuses a global/sticky `include`.
- `src/lib/__tests__/source-scan.test.ts` (new) -- direct suite over a temp fixture tree pinning the exclusion contract.
- `src/lib/__tests__/test-infra-conventions.test.ts` (new) -- guards the aliased door, the production-import ban, and the barrel's re-export-only shape.
- `src/components/workbench/__tests__/settings-harness.tsx` (new) -- `settingsPayload()`, `installSettingsFetchMock()`, `announcedFor()`, `mountSettings()`.
- Six DOM suites (`useSidecarStatus`, `workspace-purpose-settings`, `workbench-sheet`, `preview-announcements`, `workbench-split-wiring`, `data-version-watcher`) -- relative ladders replaced by `@/test/dom-helpers`.
- Seven scan suites (`english-only`, `single-ia`, `single-main-landmark-scan`, `workbench-left-column`, `workbench-data-version`, `brand-copy`, `pnpm-workspace-root`) -- local `walk()` replaced by `walkFiles`, plus member pins and count floors.
- Four Settings suites (`settings-read-only`, `settings-vector-namespace`, `settings-research-provider`, `settings-embedding-provider-switch`) -- duplicated harness replaced by imports; each keeps a local wrapper stating only its deltas.
- `AGENTS.md` -- the setup-helper convention rewritten for the aliased door, plus bullets for the shared walk and the helper-naming rule.

**Review findings breakdown.** 8 patches applied (3 medium, 5 low), 3 items deferred (all low), 8 rejected.

**Follow-up review recommendation:** true. Patched findings this pass: high 0, medium 3, low 5. Score = 3x3 + 1x5 = 14, which is 5 or more.

**Verification.** `pnpm test` -> exit 0, 327 files, 7489 passed / 1 skipped (the skip is pre-existing; baseline was 325 files / 7477 passed). `pnpm exec vitest run --project dom` -> exit 0, 53 files / 803 tests, so no helper module was collected as a suite and the config-load guard did not fire. `pnpm lint` -> exit 0 (the three `TSNonNullExpression` notices from `jsx-ast-utils` are present on the baseline commit too). `pnpm exec tsc --noEmit` -> exit 0. Coverage preservation was checked directly rather than inferred: the old and new traversals were run side by side over all 24 migrated call sites with an identical result set at every one.

**Residual risks.**

- `pnpm-workspace-root.test.ts`'s nested-lockfile scan now refuses to descend into `__tests__`, the one intentional coverage change. It is inert today (the repo's only two lockfiles are the root one and `workers/sandbox-runner`), and it is commented in place.
- The new guard against production code importing `@/test/` pins the rule, not the build. The failure mode it describes -- a devDependency import plus prototype mutation at module load breaking `next build` -- is argued from the code rather than executed; `next build` was not run.
- `installSettingsFetchMock()` returns one module-level mock rather than a fresh instance per file. That is correct only under vitest's default per-file module isolation, which `vitest.config.ts` does not override and no test pins.
