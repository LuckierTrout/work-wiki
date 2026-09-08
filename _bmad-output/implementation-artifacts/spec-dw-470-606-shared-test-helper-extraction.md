---
title: 'Shared test helpers: migrate two hand-rolled walkers onto walkFiles, extract the sidecar listen() harness (DW-470, DW-606)'
type: 'refactor'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      `reapStrandedScratchFiles`' two grace-window cases in `storage-fs.test.ts` fail
      intermittently under full-suite load, so `pnpm test` is not reliably green.
    evidence: |-
      Two cases — "stops at STRANDED_SCRATCH_CANDIDATE_CAP and reclaims the remainder
      next pass" and "honours an explicit window, so the grace period is a parameter and
      not a hardcode" — failed in three of five full-suite runs during this story and
      passed in the other two. They pass standalone every time. Proven pre-existing and
      unrelated to this change: with every file of this story stashed (`git stash -u`,
      tree at f095692c), a full `pnpm test` failed the same two cases. The assertions
      turn on real wall-clock mtime grace windows (one case took 5352 ms), so they lose
      under the scheduling pressure of 369 parallel test files. Nothing in this story
      touches `storage-fs.ts` or its suite.
    location: >-
      src/lib/__tests__/storage-fs.test.ts
    severity: low
baseline_revision: 'f095692ca477e1d655ffeed631d5eba8bccd9d2e'
---

<intent-contract>

## Intent

**Problem:** Two test helpers are duplicated against the repo's own one-helper-per-concern convention. `routeFiles()` (`read-only-door-coverage.test.ts:188`) and `retiredSurfacesOnDisk()` (`retired-surfaces.test.ts:57`) hand-roll the descend-and-collect-by-basename contract `walkFiles` already owns, with no exclusions at all, so both descend into `__tests__` (DW-470 — latent today, since no file under a `src/app` `__tests__` directory matches either pattern). Separately, the sidecar `listen()` harness now lives in near-verbatim triplicate in `sidecar.test.ts`, `workbench-epic8.test.ts` and `epic8-remediation.test.ts`, `as never` casts included, and the three copies have already drifted: only one rejects on a bind error, only one refuses a non-object address, and only one calls `closeAllConnections()` before `close()` (DW-606).

**Approach:** Point both walkers at `walkFiles` from `src/lib/__tests__/source-scan.ts`, keeping each scan's covered file set and every assertion exactly as it is. Add one new sibling helper, `src/lib/__tests__/sidecar-harness.ts`, that owns building a `createSidecarServer`, binding it to an ephemeral loopback port, tracking it for teardown and closing everything; each suite keeps its own thin `listen()` wrapper so no call site changes. Update the prose and the enforcement that name the old state: `source-scan.ts`'s header (which currently says these two walkers are deliberately left alone), the two `AGENTS.md` bullets, and `test-infra-conventions.test.ts`'s helper roll.

## Boundaries & Constraints

**Always:** Preserve each scan's covered file set and each suite's call sites and assertions verbatim — no test renamed, added, removed, or re-scoped. The new helper is not named `*.test.ts(x)` and sits beside the three suites in `src/lib/__tests__/`, imported as `./sidecar-harness`, because all three importers share that one directory (the `src/test/` tier is for helpers reached from more than one directory). Where the three harness copies disagree, the shared one takes the STRICTEST behaviour of the three (reject on `error`, throw on a non-object address, `closeAllConnections()` before `close()`) — every difference is failure-path only, so the success path of all three suites is unchanged. `allowedOrigins` must stay absent from the options object entirely when the caller passes nothing, so `createSidecarServer`'s own env-reading default runs. Prose and enforcement move together: `AGENTS.md`'s "There are six" / "Four sit beside the suites" bullet, its "the three walkers deliberately left alone" clause, `source-scan.ts`'s header, and `test-infra-conventions.test.ts`'s helper roll all describe the post-change state.

**Block If:** Migrating either walker would change which files its scan covers — i.e. a file matching `^route\.ts$` or `^(page|route|opengraph-image)\.tsx?$` exists under a `__tests__`, `node_modules`, `.git` or `.next` directory inside `src/app`. (Verified absent at plan time; re-check before migrating.)

**Never:** Do not touch production source — `sidecar/server.mjs`, anything under `src/` outside `__tests__`/`src/test/`, and the app's own modules stay read-only. Do not migrate `read-only-kernel-gate.test.ts`'s `walk()`: it snapshots a temp data directory's contents rather than selecting by basename, and must not exclude anything. Do not fold the three suites' `afterEach` bodies into the helper — `sidecar.test.ts`'s also saves and restores `SIDECAR_ALLOWED_ORIGINS_ENV`, and the helper must not import `vitest`. Do not change any suite's default `wikiRegistry`, settings fixture, or the `as never` casts they carry.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Route scan after migration | `src/app/api` on disk | `walkFiles(API, { include: /^route\.ts$/ })` returns the same >20 absolute `route.ts` paths the recursion returned | No error expected |
| Retired-surface scan after migration | `src/app` on disk | Sorted surfaces still equal `RETIRED_SURFACES` exactly | No error expected |
| Excluded directory in scan root | A `route.ts` placed under `src/app/**/__tests__/` | Not returned — `walkFiles` skips `__tests__` | No error expected (behaviour change is intended and latent) |
| Harness bind succeeds | `listen()` with no overrides | `http://127.0.0.1:<port>`; server tracked for teardown | No error expected |
| Harness bind fails | Port refused or permission denied | The `listen` promise rejects with the server's `error` | Named failure, not a suite-timeout hang |
| Server binds no port | `address()` returns a string or `null` | Throws naming the address | Explicit `Error` |
| Suite starts its own server | `workbench-epic8`'s stub kernel | `track(kernel)` registers it, and `closeAll()` closes it with the sidecars | No error expected |

</intent-contract>

## Code Map

- `src/lib/__tests__/source-scan.ts` — exports `SKIPPED_DIRS` (`__tests__`, `node_modules`, `.git`, `.next`) and `walkFiles(dir, { include, skipDirs })`: matches BASENAME, returns ABSOLUTE paths, throws on a `g`/`y` regex, and name-checks CHILD directories only. Header lines 14-25 claim `routeFiles()` and `retiredSurfacesOnDisk()` are deliberately out of reach — that paragraph must be rewritten to name only `read-only-kernel-gate.test.ts`'s `walk()`.
- `src/lib/__tests__/read-only-door-coverage.test.ts` — `routeFiles(dir, out)` at :188-194 collects `entry.name === "route.ts"`; sole call `routeFiles(API)` at :226 where `API = path.resolve(__dirname, "../../app/api")` (:32), followed by `expect(files.length).toBeGreaterThan(20)`. `readdir` (:29) is used ONLY here — drop it from the import; `readFile` stays (:232, :266, :317, :335).
- `src/lib/__tests__/retired-surfaces.test.ts` — `retiredSurfacesOnDisk(dir = APP_DIR)` at :57-84 interleaves walk + `fs.readFile` + `@/lib/retired` filter + segment→surface mapping; `APP_DIR` at :49. Sole call at :135, `.sort()`ed and compared for equality against `RETIRED_SURFACES`, which is the count floor and member pin already. `fs` (default `fs/promises` import) is used elsewhere (:398) — keep it. Comment at :395 references the function by name; it survives.
- `src/lib/__tests__/sidecar.test.ts` — `open` (:124) and `afterEach` (:135-147, `closeAllConnections()` then `close()`, plus env save/restore) inside `describe(...)`; `listen(allowedOrigins?)` :150-152 delegates to `listenWith(extra, allowedOrigins)` :154-186. Fixed settings source (enabled/unauth true), `wikiRegistry: { current: () => [], currentId: () => null } as never`, `extra` spread after it, `allowedOrigins` spread last and only when defined. Rejects on `error`; throws on a non-object address. 17 `listen`/`listenWith` call sites — none change.
- `src/lib/__tests__/workbench-epic8.test.ts` — module-scope `open` (:96), `listen(value, extra)` :107-121 (NO `wikiRegistry`, no error handler, port falls back to `0`), `afterEach` :123-131 (`close()` only). Local `type Settings` :75-81 and `settings(overrides)` :83-92. `open.push(kernel)` at :625 tracks a stub kernel this suite starts itself — must become `track(kernel)`. `Settings` is referenced at :83 (×2), :108, :375.
- `src/lib/__tests__/epic8-remediation.test.ts` — module-scope `open` (:75), `listen(extra)` :94-117 (fixed settings source, `wikiRegistry` with `currentId: () => TEST_CURRENT_WIKI_ID` (:76) `as never`, `extra` last), `afterEach` :119-127 (`close()` only). Call sites pass `capabilities` / `wikiRegistry` / `workspace` in `extra` and rely on `extra` overriding the default `wikiRegistry`. A local `const open = vi.spyOn(fs, "open")` at :678 shadows the registry name inside one test — leave it alone.
- `sidecar/server.mjs:447-470` — READ-ONLY. `createSidecarServer({ settingsSource, gate, status, kernel, workspace, capabilities, approvals, wikiRegistry = [], chatSessionFactory, allowedOrigins })`; `settingsSource.current()` is called per request (:513) and never mutated, `allowedOrigins`'s default reads the env at construction. Untyped `.mjs` (no `.d.ts`), which is why every caller writes `createSidecarServer({...}) as Server` and `wikiRegistry: {...} as never`.
- `src/lib/__tests__/sidecar-harness.test.ts` — NEW, added during review. Executes the two harness rules a suite cannot provoke (bind `error` rejects; a non-`AddressInfo` `address()` throws) plus the detach-on-success and defaults-then-overrides properties. `closeAllConnections()` is NOT pinned and the header says so: deleting the line leaves every suite green, so the case for it rests on the argument in `sidecar-harness.ts`'s header.
- `src/lib/__tests__/test-infra-conventions.test.ts:~270-290` — "every shared helper avoids the `*.test.ts(x)` suffix" iterates a literal roll of six helpers and asserts each is present in `sourceFiles()`; add the new helper there. Its `src/test/` case ("holds only the two modules that must be aliasable") is unaffected, as is `expect(files.length).toBeGreaterThan(300)`.
- `AGENTS.md:76-85` — the `walkFiles` bullet, incl. "its header names the three walkers deliberately left alone". `AGENTS.md:86-104` — "There are six." / "Four sit beside the suites that use them" and the enumerated list. Both must be restated for the new counts.
- Verified at plan time: no file under any `__tests__` in `src/app` matches `^route\.ts$` or `^(page|route|opengraph-image)\.tsx?$` (11 such files exist, all `*.test.ts(x)`), so both migrations preserve their covered sets. 151 `route.ts` and 187 page/route/og files exist under `src/app`.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/sidecar-harness.ts` — NEW. Export `type SidecarSettings` (the five-field shape the three suites share), `settingsSource(value)` returning `{ current: () => value, refresh: async () => value }`, and `sidecarHarness(defaults: Record<string, unknown> = {})` returning `{ listen(overrides?), track(server), closeAll() }`. `listen` builds `createSidecarServer({ kernel: { base: "", token: "" }, ...defaults, ...overrides }) as Server`, tracks it, binds `(0, "127.0.0.1")` with `server.once("error", reject)`, throws if `address()` is not a non-null object, and returns `http://127.0.0.1:${address.port}`. `closeAll` drains the registry with `closeAllConnections()` then `close(cb)`. No `vitest` import. Header explains why the strictest variant won and why `allowedOrigins` is never defaulted here. — one home for the harness DW-606 names.
- `src/lib/__tests__/sidecar.test.ts` — replace the local `open`/server-construction body with `const harness = sidecarHarness({ settingsSource: settingsSource({...}), wikiRegistry: {...} as never })`; keep `listen`/`listenWith` as wrappers passing `{ ...extra, ...(allowedOrigins === undefined ? {} : { allowedOrigins }) }`; `afterEach` keeps its env restore and calls `await harness.closeAll()`. — behaviour identical; this suite is where the strict variant came from.
- `src/lib/__tests__/workbench-epic8.test.ts` — replace `type Settings` with `type SidecarSettings as Settings` imported from the helper; `listen(value, extra)` becomes `harness.listen({ settingsSource: settingsSource(value), ...extra })`; `open.push(kernel)` → `harness.track(kernel)`; `afterEach` calls `closeAll()`. — no `wikiRegistry` default, exactly as today.
- `src/lib/__tests__/epic8-remediation.test.ts` — `const harness = sidecarHarness({ settingsSource: settingsSource({...}), wikiRegistry: { current: () => [], currentId: () => TEST_CURRENT_WIKI_ID } as never })`; `listen(extra)` becomes `harness.listen(extra)`; `afterEach` calls `closeAll()`. — the `vi.spyOn(fs, "open")` local at :678 is untouched.
- `src/lib/__tests__/sidecar-harness.ts` — ADDED DURING REVIEW: export `bindLoopback(server)`, the bind-and-read-the-port half of `listen`, split out as its own seam so the two failure paths are reachable without a `createSidecarServer`. It detaches its `error` handler in the resolve path, so a post-bind error still surfaces unhandled exactly as it did in the two suites that attached no listener at all.
- `src/lib/__tests__/sidecar-harness.test.ts` — NEW, ADDED DURING REVIEW. Pins the rules above; registers every server and harness it creates with its own `afterEach` and closes unconditionally (no `server.listening` guard — `listening` flips true a tick after `listen()` returns, so a guard leaks a real port on the case that settles in a microtask).
- `src/lib/__tests__/read-only-door-coverage.test.ts` — delete `routeFiles`, call `walkFiles(API, { include: /^route\.ts$/ })` at :226, drop `readdir` from the `node:fs/promises` import, add `import { walkFiles } from "./source-scan";`. ADDED DURING REVIEW: the migrated scan inherits `SKIPPED_DIRS`, and the case asserts `untreated` is EMPTY — which a shrunken corpus satisfies by construction — so it also carries the `english-only.test.ts` idiom: eight member pins, one real `route.ts` per major `src/app/api` subtree, plus floors raised from 20/20 to 100 files and 25 writer-reaching routes. No new `it()`. — DW-470.
- `src/lib/__tests__/retired-surfaces.test.ts` — rewrite `retiredSurfacesOnDisk()` to `walkFiles(APP_DIR, { include: /^(page|route|opengraph-image)\.tsx?$/ })`, then for each absolute path read it, keep only sources importing `@/lib/retired`, and derive the surface from `path.relative(APP_DIR, path.dirname(file))` with the same `[[`-segment filter and `opengraph-image` special case (keyed off `path.basename(file)`). — DW-470; result is `.sort()`ed at the call site, so traversal order is immaterial.
- `src/lib/__tests__/source-scan.ts` — rewrite the "WHAT THIS IS NOT THE SINGLE DEFINITION OF" paragraph so it names only `read-only-kernel-gate.test.ts`'s `walk()`. — the header must not keep claiming two now-migrated walkers are out of reach.
- `src/lib/__tests__/test-infra-conventions.test.ts` — add `"lib/__tests__/sidecar-harness.ts"` to the shared-helper roll. — prose and enforcement stay in step.
- `AGENTS.md` — update the `walkFiles` bullet (one walker left alone, not three) and the shared-helper bullet (seven helpers, five beside their suites), naming `src/lib/__tests__/sidecar-harness.ts` and what it is for. — the roll is the documented convention.

**Acceptance Criteria:**
- Given the repo after the change, when `grep -rn "async function routeFiles\|async function retiredSurfacesOnDisk(dir" src/` runs, then it returns nothing and both suites import `walkFiles` from `./source-scan`.
- Given the three sidecar suites, when their sources are read, then none of them calls `createSidecarServer` itself and each obtains its sidecar base URL through `sidecar-harness`; the only surviving direct `listen(0, "127.0.0.1", …)` in the three files is `workbench-epic8`'s stub kernel, which is handed to `track()`.
- Given `pnpm test`, when the full suite runs, then every test that passed before still passes, and no test in the five MIGRATED suites (`read-only-door-coverage`, `retired-surfaces`, `sidecar`, `workbench-epic8`, `epic8-remediation`) is added, removed or renamed — the point being that the refactor moves code without re-scoping coverage. The new `sidecar-harness.test.ts` adds its own cases, which is what a helper's pin suite is for.
- Given `AGENTS.md` and `test-infra-conventions.test.ts`, when the helper roll in each is compared, then both list the same seven helpers.

## Spec Change Log

### 2026-09-02 — amended during review (post-implementation)

**Trigger:** a review of the implemented change returned nine patch findings. Three of them changed the shape of what was built rather than only its prose, so the spec no longer described the artifact:

1. The migrated route scan inherited `SKIPPED_DIRS` while keeping only two loose floors (`> 20`, `>= 20`) against a corpus of 149 route files / 31 writer-reaching. Appending `"wiki"` to `SKIPPED_DIRS` deleted the whole `src/app/api/wiki` subtree and the suite still passed — a coverage cut that shows up as green, which is the exact failure `AGENTS.md` prescribes the member-pin idiom against. The scan was structurally immune to this before the migration, so the migration introduced the exposure and had to pay for it.
2. `bindLoopback` was split out of `sidecarHarness().listen()` as an exported seam, and `sidecar-harness.test.ts` was added to execute the harness rules. Neither existed when this spec was frozen.
3. The acceptance criterion "no test names added, removed or renamed" was written when no new suite was planned. Read literally it now forbids the pin suite the review asked for, so it was reworded to say what it meant: the five MIGRATED suites keep their exact test set; a new helper's pin suite adding its own cases is not the drift that criterion guards against.

**Scope:** Code Map, Execution list, Acceptance Criteria and Verification only. `<intent-contract>` was NOT touched — the Intent, Boundaries & Constraints, Block If, Never list and I/O matrix all still describe this change correctly, and the amendments above add enforcement and a pin suite rather than changing what the change is for.

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 3, low 6)
- defer: 1: (high 0, medium 0, low 1)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[medium]` `[patch]` The migrated route scan inherited `SKIPPED_DIRS` but kept only two `> 20` floors against 149 route files / 31 writer-reaching, so appending a name to `SKIPPED_DIRS` deleted a whole `src/app/api` subtree with the suite still green. Added eight member pins (one real `route.ts` per major subtree) and raised the floors to 100 / 25, the second derived from the measured largest-subtree size so losing any one subtree trips it.
  - `[medium]` `[patch]` `bindLoopback` never detached its `error` listener after a successful bind, so the first post-bind error landed on a settled promise and vanished — a success-path change for the two suites that previously attached no listener at all. The handler is now removed in the resolve path.
  - `[medium]` `[patch]` The new pin suite's bind-error case leaked a listening server: the real `listen()` completed after the synthetic emit, so the `!server.listening` teardown guard skipped it and it bound a real port for the rest of the worker's life. Teardown is now unconditional.
  - `[low]` `[patch]` The pin suite closed its harnesses inline on the last line of two cases, so a failing assertion leaked a bound port. Every harness is now registered with the file's `afterEach`.
  - `[low]` `[patch]` `source-scan.ts`'s rewritten header and the matching `AGENTS.md` bullet claimed "ONE other recursive walker survives on purpose" — a false census (`owner-single-reader.test.ts:50`, `owner-gate-parity.test.ts:304`, `read-only-copy-parity.test.ts:85` all match the contract and are unmigrated). Both now name what the module deliberately does not reach without claiming exhaustiveness. `discuss-fixtures.ts` was also added to the sibling roll, which had omitted it.
  - `[low]` `[patch]` Two overclaims corrected: the helper header said "One `listen()` for every suite that binds a REAL sidecar" when `workbench-epic3.test.ts:51` holds a fourth, unbound-factory copy; and the pin suite's header claimed all three drifted rules were pinned when `closeAllConnections()` is not (deleting it leaves everything green).
  - `[low]` `[patch]` `settingsSource<T>(value: T)` inferred freely, so the two suites passing inline literals got no field checking. Typed as `SidecarSettings`; a typo now fails `tsc`.
  - `[low]` `[patch]` The override case asserted `GET /api/v1/skills` → 503, coupling a helper test to `sidecar/server.mjs` door semantics this change declares read-only. It now observes which `settingsSource` the server consults instead.
  - `[low]` `[patch]` The spec predated the pin suite and the `bindLoopback` seam. Code Map, Execution list, Verification and the over-literal "no test names added" acceptance criterion were amended outside `<intent-contract>`, with a Spec Change Log entry.


## Design Notes

The three `listen()` copies differ only in failure paths and in their per-suite fixtures. Taking the union of the strict behaviours is safe because every difference fires on a path no passing test reaches: a bind that fails today hangs `workbench-epic8` and `epic8-remediation` to the suite timeout instead of naming the port error, and a server that binds no port hands them `http://127.0.0.1:0`. The fixtures stay per-suite, expressed as harness `defaults` merged before per-call `overrides` — which is exactly the order the copies already use, so `extra` keeps overriding `wikiRegistry` in the two suites that rely on it.

```ts
const harness = sidecarHarness({
  settingsSource: settingsSource(OPEN),
  wikiRegistry: { current: () => [], currentId: () => null } as never,
});
async function listenWith(extra: Record<string, unknown>, allowedOrigins?: string[]) {
  // `allowedOrigins` stays ABSENT when undefined so the env-reading default runs.
  return harness.listen({ ...extra, ...(allowedOrigins === undefined ? {} : { allowedOrigins }) });
}
```

`settingsSource(value)` returns the same object from every `current()` call rather than rebuilding a literal, matching `workbench-epic8` exactly; the other two rebuilt an equal literal per call and nothing reads or mutates its identity (`sidecar/server.mjs:513` calls `current()` per request and only reads fields).

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/source-scan.test.ts` -- expected: all pass, same test count as before
- `pnpm vitest run src/lib/__tests__/sidecar.test.ts src/lib/__tests__/workbench-epic8.test.ts src/lib/__tests__/epic8-remediation.test.ts src/lib/__tests__/test-infra-conventions.test.ts src/lib/__tests__/sidecar-harness.test.ts` -- expected: all pass; same test count as before in the first four, plus the new pin suite's own cases
- `pnpm test` -- expected: whole suite green, no new failures
- `pnpm lint` -- expected: clean; in particular no unused `readdir` import
- `npx tsc --noEmit` -- expected: clean

## Auto Run Result

Status: done

**Summary.** Both halves of the bundle landed. DW-470: `routeFiles()` and `retiredSurfacesOnDisk()` are gone, replaced by `walkFiles` calls, so no source-tree scan in the repo hand-rolls its own traversal any more. DW-606: the `listen()` harness the three sidecar suites each carried is now one module, `src/lib/__tests__/sidecar-harness.ts`, with the suites keeping only thin wrappers so no call site changed. Where the three copies disagreed — reject on bind `error`, throw on a non-`AddressInfo` address, `closeAllConnections()` before `close()` — the shared home takes the strictest of the three; every difference fires only on a path no passing test reaches. Prose and enforcement moved with the code: `source-scan.ts`'s header, two `AGENTS.md` bullets and `test-infra-conventions.test.ts`'s helper roll all describe the post-change state.

**Files changed.**
- `src/lib/__tests__/sidecar-harness.ts` (new) — the shared harness: `SidecarSettings`, `settingsSource()`, `bindLoopback()` and `sidecarHarness()` (`listen` / `track` / `closeAll`).
- `src/lib/__tests__/sidecar-harness.test.ts` (new) — executes the harness rules the three suites cannot provoke: bind-`error` rejection, the non-`AddressInfo` throw, `track()`/`closeAll()`, and that a per-call override beats the suite default.
- `src/lib/__tests__/sidecar.test.ts` — harness with this suite's settings source and `wikiRegistry`; `listen`/`listenWith` kept verbatim as wrappers; `afterEach` keeps its `SIDECAR_ALLOWED_ORIGINS_ENV` save/restore.
- `src/lib/__tests__/workbench-epic8.test.ts` — local `Settings` type now imported from the harness; no `wikiRegistry` default, as before; the stub kernel goes through `track()`.
- `src/lib/__tests__/epic8-remediation.test.ts` — harness carries the fixed settings source and the `TEST_CURRENT_WIKI_ID` registry; `listen(extra)` delegates.
- `src/lib/__tests__/read-only-door-coverage.test.ts` — `routeFiles()` deleted for `walkFiles(API, { include: /^route\.ts$/ })`; eight member pins and raised floors added so a `SKIPPED_DIRS` cut fails by name rather than passing on a smaller corpus.
- `src/lib/__tests__/retired-surfaces.test.ts` — `retiredSurfacesOnDisk()` rebuilt on `walkFiles`, deriving each surface from `path.dirname`/`path.basename`.
- `src/lib/__tests__/source-scan.ts` — header rewritten: names what the module deliberately does not reach, without claiming an exhaustive census, and records that the two DW-470 walkers migrated with their covered sets intact.
- `src/lib/__tests__/test-infra-conventions.test.ts` — helper roll gains `lib/__tests__/sidecar-harness.ts`.
- `AGENTS.md` — the `walkFiles` bullet and the shared-helper bullet (seven helpers, five beside their suites) restated.

**Review findings.** 9 patched (medium 3, low 6), 1 deferred (low), 7 rejected, 0 intent gaps, 0 spec defects. The three medium patches were the route scan's missing member pins, `bindLoopback` swallowing post-bind errors, and a leaked listening server in the new pin suite. Rejected findings were speculative guards on paths no caller reaches (`address()` without a numeric port, an explicit `allowedOrigins: undefined`, `close()` on a never-bound server), the settings-object identity change the helper header already documents, and two scope observations the intent's own authority excludes (a guard forbidding a fifth copy, which the DW-117 precedent this bundle cites does not have either; and net line count rising, which extraction plus a pin suite makes expected).

**Follow-up review recommended:** false. Patched findings by severity — high 0, medium 3, low 6. The rule counts only `high` patches, and there were none.

**Verification.**
- `npx tsc --noEmit` — exit 0.
- `pnpm lint` — exit 0 (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices).
- `npx vitest run` over the eight touched/added suites plus `storage-fs.test.ts` — 9 files, 347 tests, all passing.
- `pnpm test` — 369 files, 9078 passed, 1 skipped. Per-suite counts for the five migrated suites are identical to the pre-change run; the whole-repo delta is exactly the new pin suite.
- Block-If precondition re-checked before migrating: no file under any `__tests__`, `node_modules`, `.git` or `.next` directory inside `src/app` matches `^route\.ts$` or `^(page|route|opengraph-image)\.tsx?$`, so both scans cover exactly what they covered before.
- Every I/O matrix row is covered by a test that ran and passed: rows 1-2 by the two migrated suites' own cases, row 3 by `source-scan.test.ts`'s `SKIPPED_DIRS` case, rows 4-7 by `sidecar-harness.test.ts` and the three suites' live binds.
- Patches were verified by mutation, not just by a green run: removing the member pins' target from `SKIPPED_DIRS` coverage, deleting the `removeListener`, and reversing the defaults/overrides spread each fail a named assertion.

**Residual risks.**
- `storage-fs.test.ts`'s two `reapStrandedScratchFiles` grace-window cases fail intermittently under full-suite load. Proven pre-existing: with every file of this story stashed, the baseline at `f095692c` fails the same two cases on a full run. Recorded in `deferred`.
- `closeAllConnections()` in `closeAll()` is the one adopted rule with no test: deleting it leaves every suite green on this machine, and a keep-alive pin did not discriminate. The harness header now says so plainly rather than implying it is pinned.
- `workbench-epic3.test.ts` holds a fourth sidecar-server factory. It is a different shape — an unbound factory with no registry and no `afterEach` — and the intent names three suites, so it was left alone and named in the harness header so the module is not read as exhaustive.
- Two byte-identical `sourceFiles()` walkers (`owner-single-reader.test.ts:50`, `owner-gate-parity.test.ts:304`) and `read-only-copy-parity.test.ts:85`'s `storageModuleFiles()` still match the `walkFiles` contract unmigrated. All three skip or avoid the directories that would change their results, so none is wrong today; they are named in `source-scan.ts`'s header as candidates rather than migrated, since the intent names two functions by name.
