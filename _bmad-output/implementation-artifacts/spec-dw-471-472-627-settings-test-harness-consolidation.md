---
title: 'Finish the Settings test-harness consolidation (DW-471, DW-472, DW-627)'
type: 'refactor'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      A sixth verbatim ~50-field WorkbenchSettingsPayload literal survives in a mounted
      Settings suite that the harness could always have reached, so the "one home for the
      payload" property this bundle claims is not actually true repo-wide.
    evidence: |-
      `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx:50-98` holds the same
      ~50-field literal, differing from `settingsPayload()` in exactly four fields
      (`hasEmbeddingApiKey: true`, `apiEnabled: true`, `hasLoopbackApiToken: true`,
      `loopbackTokenSource: "store"`). It sits in the directory the harness used to occupy,
      so the reachability argument DW-471 makes never applied to it — it was simply not
      named by DW-228's census or by this bundle's intent, which names the fifth suite only.
      It can import `settingsPayload` alone, exactly as the parity suite now does, with no
      `installSettingsFetchMock`. Left as-is here because the intent names one suite; folding
      it is the same mechanical change and would finish the property.
    location: >-
      src/components/workbench/__tests__/epic8-skills-canvas.test.tsx:50
    severity: low
baseline_revision: '9ccc7358a712e6a15778d9c93e434ef8e070e960'
---

<intent-contract>

## Intent

**Problem:** DW-228 consolidated four mounted Settings suites onto `settings-harness.tsx`, but left it inside `src/components/workbench/__tests__/`, reachable only by a `./` sibling import — so the fifth mounted suite, `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx`, still carries its own verbatim ~50-field `WorkbenchSettingsPayload` fixture (DW-471). Since then two suites have each grown a private verbatim copy of the same one-response-per-call mount helper and PUT-body reader (DW-627), and two fixtures override `version` to a `w1:`-shaped stamp the settings store never mints, with nothing saying why (DW-472).

**Approach:** Move the harness to `src/test/settings-harness.tsx` so every mounted suite reaches it as `@/test/settings-harness` whatever its directory, fold `mountWritable`/`patchOf` into it as shared exports, restate the parity suite's fixture as overrides on `settingsPayload()`, and normalise the stray `w1:` stamps onto the store's real `s1:` scheme.

## Boundaries & Constraints

**Always:**
- Behaviour-preserving. No assertion is added, removed, weakened, or renamed; every suite must run the same cases against the same observable states as before.
- The harness stays a shared helper, not a suite: it keeps a non-`*.test.ts(x)` name, and it must not gain a `describe`/`it`.
- Every per-file DELTA stays stated as an override in the file it belongs to, with the comment that says what that suite is about — the DW-228 rule this change extends rather than replaces.
- Prose and its enforcement move together: `AGENTS.md`'s shared-helper bullet and `src/lib/__tests__/test-infra-conventions.test.ts`'s pins must both name the harness's new home.
- `src/test/` stays test-only. Nothing the app ships may import from `@/test/`, and `vitest.setup.dom.ts` remains the only place a DOM shim is defined.

**Block If:**
- A source scan or convention suite fails against `src/test/settings-harness.tsx` in a way that cannot be resolved without widening `SKIPPED_DIRS` or exempting the file from a whole-tree scan — that is a placement decision, not a mechanical one.
- Normalising a `version` stamp changes any assertion's outcome, i.e. some suite turns out to read `version` after all.

**Never:**
- Do not fold `settings-page-legacy-surface-parity.test.tsx`'s `body()` — the flat legacy wire object — into the harness. Only its `workbench()` payload is the duplicate DW-471 names; the flat half is that page's own shape and stays local.
- Do not fold `settings-save-in-flight.test.tsx`'s `installRoutes`/`mount`/`patchOf`: they route by URL and index a FILTERED `/api/settings` call list, so they answer a different question. Leave them, and say so at the harness.
- Do not migrate `settings-read-only.test.tsx`'s `ifMatchOf`/`methodOf` (single-use) or rewrite the "load that carries no version at all" case onto the queue helper.
- Do not add jsdom to the `node` project, widen `SKIPPED_DIRS`, or change `DOM_INCLUDE` in `vitest.config.ts`.
- Do not touch production source under `src/` other than the moved test-only module.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Aliased reach | A mounted suite in any directory imports `@/test/settings-harness` | Resolves through the `@` → `src` alias restated in both vitest projects | No error expected |
| Queue exhausted | `mountSettingsQueue` given fewer responses than calls made | The LAST response answers every further call, exactly as both copies did | No error expected |
| Queue without the stub | `mountSettingsQueue` called with no `installSettingsFetchMock()` in the file | Throws naming the missing setup line | Explicit `Error`, same shape as `mountSettings` |
| Body read off a GET | `patchOf(n)` where call `n` carried no body | Throws naming the call index and that it carried no body | Explicit `Error`, not a `JSON.parse` of `"undefined"` |
| Parity fixture | `workbench()` in the parity suite | `settingsPayload()` plus that page's seven stated deltas; every other field tracks the shared base | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/__tests__/settings-harness.tsx` -- the harness to MOVE (git mv) to `src/test/settings-harness.tsx`. Exports `settingsPayload`, `installSettingsFetchMock`, `announcedFor`, `mountSettings`; module-level `const fetchMock = vi.fn()` and `let installed` are per-test-file state (vitest gives each file its own registry) — the new exports read that same `fetchMock`. Its header's "Named `settings-harness.tsx`, not `*.test.tsx`" paragraph is still true and must gain the new "why `src/test/`" reason.
- `src/components/workbench/__tests__/settings-read-only.test.tsx:374-426` -- `mountWritable(responses)` (category `llm-models`) and `patchOf(call)` inside the DW-63 `describe`; `read`/`saved`/`typeChatModel`/`ifMatchOf`/`methodOf` sit beside them and STAY. `render`/`SettingsCanvas`/`SETTINGS_LOADING_COPY` imports must remain — line 751 still renders directly for the versionless-load case. Line 217 `cleanup()` also stays.
- `src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx:310-343` -- the second `mountWritable` (category `embeddings`) and `patchOf` inside the DW-553 `describe`. Line 279 renders directly under a route-aware `mockImplementation` and is NOT the queue shape — leave it, so `render`/`SettingsCanvas` imports stay. `payload()` at line 50 and the save answer at line 419 carry the `w1:` stamps.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx:53-58` -- `payload()` with the same `w1:2-0000000000000000` override and the "the store's own stamp shape" comment that is the false claim DW-472 names.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx:49-108` -- `const VERSION = "w1:1a-1111111122222222"` and the ~50-field `workbench()` to restate as overrides. `body()` (109-141) is the flat legacy half and STAYS. This file mounts `SettingsPage` with its own `stubFetch` + `afterEach`, so it uses `settingsPayload` ONLY — never `installSettingsFetchMock`/`mountSettings`.
- `src/lib/config.ts:797-818,1001` -- proof the settings store mints `s1:${32 hex}` and accepts only that or `s1:unstamped`; `src/lib/write-precondition.ts:168,196` -- `w1:`/`w1s:` are the CONTENT-version schemes for wiki bytes. This is the evidence that the `w1:` overrides are wrong-scheme, not a second legitimate shape.
- `src/lib/__tests__/test-infra-conventions.test.ts` -- pins to update: the helper list (`components/workbench/__tests__/settings-harness.tsx` → `test/settings-harness.tsx`), and `it("is the only src/ module under a test/ directory")` whose `expect(inTestDir).toEqual([DOM_HELPERS])` now has two members. The two `production = files.filter(!__tests__ && !== DOM_HELPERS)` filters must generalise to exclude everything under `test/`, or the harness is scanned as production code.
- `AGENTS.md:86-101` -- the "There are six" shared-helper bullet, currently "Five sit beside the suites … `src/test/dom-helpers.ts` is the exception".
- `vitest.config.ts:5,84` -- `DOM_INCLUDE` collects `src/**/__tests__/**/*.test.tsx` only, and `alias = { "@": src }` is restated per project. Read-only evidence: the move needs no config change.
- `src/lib/__tests__/source-scan.ts:66` -- `SKIPPED_DIRS` does NOT exclude `src/test`, so whole-tree scans will newly see the harness. VERIFIED read-only during planning: with a copy at `src/test/settings-harness.tsx`, `english-only`, `brand-copy`, `llm-key-cold-config`, `workbench-left-column`, `workbench-data-version`, `single-main-landmark-scan` and `single-ia` all pass (184 tests). No exemption is needed.

## Tasks & Acceptance

**Execution:**
- `src/test/settings-harness.tsx` -- `git mv` from `src/components/workbench/__tests__/settings-harness.tsx`; extend the header to say why it lives outside `__tests__` (it must be aliasable as `@/test/…` for the fifth suite, the `dom-helpers.ts` reason) while keeping the existing "not `*.test.tsx`" paragraph -- the move is what makes DW-471's fold possible.
- `src/test/settings-harness.tsx` -- add `mountSettingsQueue(category, responses)` (one response per call, last response repeats once exhausted, `installed` guard like `mountSettings`) and `patchOf(call)` (the `workbench` object of the nth `fetch` call's JSON body, throwing when that call carried none); note at `patchOf` why `settings-save-in-flight.test.tsx`'s same-named local reader is NOT this one -- DW-627's two verbatim copies get one home.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- import from `@/test/settings-harness`; delete local `mountWritable`/`patchOf`, calling `mountSettingsQueue("llm-models", …)` at their call sites -- removes copy one.
- `src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx` -- same import switch; delete local `mountWritable`/`patchOf` for `mountSettingsQueue("embeddings", …)`; replace both `w1:` stamps with `s1:`-scheme ones and restate the fixture comment to say the stamp is the store's `s1:` shape -- removes copy two and half of DW-472.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- switch the import to `@/test/settings-harness`; drop the `version` override so the fixture takes the shared base, and drop the now-false "the store's own stamp shape for this deployment" line -- the other half of DW-472.
- `src/components/workbench/__tests__/settings-env-supplied-keys.test.tsx`, `settings-research-provider.test.tsx`, `settings-save-in-flight.test.tsx`, `settings-api-mcp-pane.test.tsx`, `preview-dirty-guard.test.tsx` -- switch the `./settings-harness` import to `@/test/settings-harness` (these five change nothing else) -- the sibling path no longer exists.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` -- import `settingsPayload` from `@/test/settings-harness`; restate `workbench()` as `settingsPayload({ …deltas })` keeping a comment naming why each delta is this page's, and give `VERSION` an `s1:`-scheme value -- DW-471.
- `src/lib/__tests__/test-infra-conventions.test.ts` -- update the helper-list pin to the new path, widen the `test/` directory pin to the two members with a comment on what still holds the barrel rule, and generalise the two `production` filters to exclude `test/` -- prose and enforcement move together.
- `AGENTS.md` -- restate the shared-helper bullet: still six, four beside their suites, two under `src/test/` because they must be aliasable -- the document must not go stale on the move.
- `src/components/workbench/__tests__/settings-harness-guards.test.tsx` -- new; cover the two REFUSAL rows of the I/O matrix (`mountSettingsQueue` without the stub, `patchOf` on a body-less read), which no existing suite can reach because every one of them uses the harness correctly -- the matrix's error rows need a test that actually runs. This adds a file; it changes no existing suite's cases, which is what the behaviour-preserving rule is about.

**Acceptance Criteria:**
- Given the harness at `src/test/settings-harness.tsx`, when the full suite runs, then every previously-passing Settings suite still passes and `vitest.config.ts` loads without throwing.
- Given `settings-page-legacy-surface-parity.test.tsx`, when a new field is added to `WorkbenchSettingsPayload`, then only `settingsPayload()` needs the field — the parity suite states deltas only and no longer enumerates the payload.
- Given `mountWritable`, when the repo is searched, then no definition of it remains outside `src/test/settings-harness.tsx`.
- Given any Settings fixture, when its `version` is read, then it is `s1:`-scheme — no `w1:` stamp survives in a `WorkbenchSettingsPayload` or a settings wire body.
- Given `src/lib/__tests__/test-infra-conventions.test.ts`, when it runs, then it names the harness at its real path and still fails if a third module appears under `src/test/` unannounced.

## Design Notes

`w1:` is not a second legitimate stamp shape. `src/lib/config.ts` mints settings tokens as `s1:${randomUUID hex}` and `isStoredConfigVersion` accepts only that or `s1:unstamped`; `w1:`/`w1s:` are `write-precondition.ts`'s CONTENT-version schemes for wiki file bytes. So DW-472's "record why both shapes exist" branch has no honest answer to record — the overrides are leftovers from a fixture written against the wrong scheme, and normalising is the resolution. Nothing reads `version` in either file (`settings-vector-namespace.test.tsx` mentions it once, in the comment being deleted), so this is observably inert; `settings-read-only.test.tsx`'s `SEEDED`/`LANDED`/`RECOVERED` already show the right shape for a stamp that IS asserted against.

The queue helper, as both copies wrote it:

```tsx
export async function mountSettingsQueue(
  category: SettingsCategoryId,
  responses: Array<() => unknown>,
) {
  let call = 0;
  fetchMock.mockImplementation(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next() as Response;
  });
  // …render + wait for SETTINGS_LOADING_COPY to go, as mountSettings does.
}
```

`mountSettings` (one response for every call) and `mountSettingsQueue` (one per call) stay two functions rather than one with an overloaded argument: the four suites that mount a fixed store read as a statement about that store, and collapsing them would make every one of those call sites carry a single-element array that says nothing.

## Verification

**Commands:**
- `pnpm test` -- expected: every test file passes, both projects collect (a `dom` project that collected nothing would exit 0 silently, so confirm the report lists `|dom|` files).
- `grep -rn "mountWritable" src` -- expected: NO hits anywhere. The fold renamed the helper to `mountSettingsQueue`, so the old name survives in neither the harness nor a consumer; a hit is a copy that was missed.
- `grep -rn "w1:" src/components/workbench/__tests__ src/app/settings/__tests__` -- expected: hits ONLY in `preview-dirty-guard.test.tsx` and `preview-revision-history.test.tsx`, which hold wiki CONTENT versions (`contentVersion`'s own scheme, correct as written). No hit inside a `WorkbenchSettingsPayload` or a settings wire body, which is what acceptance criterion 4 states.
- `grep -rn "settings-harness" src AGENTS.md` -- expected: every importer spells it `@/test/settings-harness`; no `./settings-harness` remains.
- `npx tsc --noEmit -p tsconfig.json` -- expected: no new errors versus the pre-change baseline.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

DW-228 left `settings-harness.tsx` inside `src/components/workbench/__tests__/`, reachable only by a `./` sibling import. It now lives at `src/test/settings-harness.tsx` and every mounted Settings suite reaches it as `@/test/settings-harness`, whatever its directory. On the back of that: the fifth suite dropped its verbatim ~50-field payload for seven stated overrides (DW-471); the two verbatim `mountWritable`/`patchOf` copies folded into the harness as `mountSettingsQueue`/`patchOf` (DW-627); and every `w1:`-scheme stamp in a settings fixture was normalised onto the store's real `s1:` scheme, with the reason recorded in-tree (DW-472). Behaviour-preserving throughout: no existing suite gained, lost, or changed a case.

### Files changed

- `src/test/settings-harness.tsx` -- moved here from `components/workbench/__tests__/` (git rename); header states why it sits outside `__tests__`; gained `mountSettingsQueue` and `patchOf` with empty-queue, uninstalled and bad-index guards, and an in-tree note on the `s1:`/`w1:` schemes.
- `src/components/workbench/__tests__/settings-harness-guards.test.tsx` -- new; three cases over the harness's own contract (uninstalled refusal, `patchOf` on a body-less read, exhausted queue answered by the last entry).
- `src/components/workbench/__tests__/settings-read-only.test.tsx` -- local `mountWritable`/`patchOf` deleted; 13 call sites on `mountSettingsQueue("llm-models", …)`.
- `src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx` -- same for `"embeddings"` (6 sites); both `w1:` stamps normalised.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- `version` override dropped (takes the shared base); the false "store's own stamp shape" line removed.
- `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` -- `workbench()` is now `settingsPayload({…7 deltas})`; `body()` untouched; the base-tracking trade stated both ways.
- `src/app/settings/__tests__/{settings-page-embedding-wiring,settings-page-provider-verdict-reason,settings-page-read-only-controls}.test.tsx` -- `w1:` wire-body stamps normalised to `s1:`.
- `src/components/workbench/__tests__/{settings-env-supplied-keys,settings-research-provider,settings-save-in-flight,settings-api-mcp-pane}.test.tsx`, `preview-dirty-guard.test.tsx` -- import path only.
- `src/lib/__tests__/test-infra-conventions.test.ts` -- helper-list pin repointed; `src/test/` pin widened to two members; both `production` filters generalised to an `isTestOnly()` prefix check; new case pinning that the harness defines no shim.
- `AGENTS.md` -- shared-helper bullet restated (six helpers, four beside their suites, two under `src/test/`), with the prototype-mutation hazard attributed to `dom-helpers.ts` alone.

### Review findings

- Patches applied: 9 (high 0, medium 1, low 8).
- Items deferred: 1 (low) -- a sixth verbatim ~50-field payload in `epic8-skills-canvas.test.tsx`, out of the intent's named scope.
- Items rejected: 7 -- `w1:` stamps in `useSettings.test.tsx` / `workbench-settings.test.ts` (not overrides on the shared base, so outside DW-472's stated pair, and inert); speculative `patchOf` guards for non-JSON bodies; the `isTestOnly` widening called preemptive (backstopped by the two-member pin); `mountSettings`' and `installSettingsFetchMock`'s own pre-existing untested guards; a repo-wide `s1:`-scheme enforcement scan (scope the intent did not open — the in-tree record covers the reason); the ledger entries still reading `status: open` (the orchestrator records resolution); and the note that whole-tree scans now walk the harness (verified green across all seven).
- Follow-up review recommended: **false** -- patched findings were high 0, medium 1, low 8; no high-severity patch, so no further loop.

### Verification

- `npx vitest run --project dom` -- 74 files / 1132 tests, all passing (73 -> 74 with the new guards suite).
- `npx vitest run --project node` -- 294 files / 7941 passed, 1 skipped.
- `pnpm test` -- the only failure seen across runs is `src/lib/__tests__/storage-fs.test.ts`'s `reapStrandedScratchFiles` cases, the pre-existing baseline flake already ledgered as DW-722 (reproduced at baseline there, passes 95/95 run alone, touches no code in this change). A full run also completed clean at 367/367.
- `npx tsc --noEmit -p tsconfig.json` -- exit 0. `npx eslint src` -- exit 0.
- `grep -rn "mountWritable" src` -- no hits. `grep -rn '"./settings-harness"' src` -- no hits; every importer spells `@/test/settings-harness`.
- `grep -rn "w1:" src/components/workbench/__tests__ src/app/settings/__tests__` -- only `preview-dirty-guard.test.tsx:631` and `preview-revision-history.test.tsx:136`, both wiki CONTENT versions where `w1:` is the correct scheme.
- Matrix audit: all five I/O rows are covered by tests that ran and passed -- aliased reach and the parity fixture by the parity suite (16), queue exhaustion and both refusals by `settings-harness-guards.test.tsx` (3).
- Two mutation probes confirmed the new pins are not vacuous: replacing the queue clamp with `responses[call]` fails the exhaustion case while leaving both consuming suites green, and adding an `Object.defineProperty` to the harness fails the new shim case.

### Residual risks

- `patchOf` on an out-of-range index now throws a named `Error` where it previously threw a `TypeError` from destructuring. No caller passes one, so no assertion moved.
- The parity suite now inherits `settingsPayload()`'s CONFIGURED base while its own premise is a deployment that chose nothing. A future field added to the base with a configured value would silently move that premise; the header now says so and says to override it back, but nothing enforces it.
- `src/test/` is not in `SKIPPED_DIRS`, so seven whole-tree source scans now walk the harness under production-source rules. All seven pass today; a future scan tightening would surface as a failure inside a test helper.
