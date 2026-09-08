---
title: 'DW-271 + DW-578: remove two module-graph duplication traps'
type: 'refactor'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `isStoreFault` still leads with `error instanceof StoreFaultError`, the exact
      identity check DW-578 removed from `ClientInputError` three lines above it in
      the same file.
    evidence: |-
      `src/lib/errors.ts` now classifies `ClientInputError` structurally on `err.name`,
      and its doc block cites `isStoreFault` as the ordering precedent — but `isStoreFault`
      itself is still an identity check plus an errno probe. A `StoreFaultError` from a
      second copy of the module carries no errno `code`, so it falls through to `false`.
      At `src/app/api/tasks/run/route.ts:929` that loses the transient 500-and-retry and
      drops the task onto the `/not found/i` 422 below it, poisoning work that should have
      been retried. A `err.name === "StoreFaultError"` arm would close it the same way this
      pass closed the sibling. Out of scope here: the bundle intent names `ClientInputError`
      and `commons.ts` only.
    location: >-
      src/lib/errors.ts:82
    severity: low
baseline_revision: 'a7312cfa5b0a66edcd44279381a2ccae07389de3'
---

<intent-contract>

## Intent

**Problem:** Two places let a duplicated module graph turn a correct answer into a wrong one. `ClientInputError` is classified by `instanceof` at ~25 sites, the exact mechanism `src/lib/read-only.ts:20-22` documents as unreliable across vitest's two projects, bundler chunking and the stdio MCP entry point — a second copy of `errors.ts` silently degrades a 400 to a 500 in production, with no test able to see it. Separately, `src/lib/commons.ts:17` imports the client-safe predicates `isAgentScopedType`/`isArtifactType` through `./wiki`, which merely re-exports them from `./page-types`, so every route suite that mocks `@/lib/wiki` must stub them or `belongsInCommons` calls `undefined` and the 403 path answers 500.

**Approach:** Add an `isClientInputError(err)` helper beside the class in `src/lib/errors.ts` that matches on `err.name` — the same structural check `isReadOnlyError` uses — and sweep every `instanceof ClientInputError` classification site in `src/` onto it. Point `commons.ts` at `./page-types` directly for the two predicates. Both changes are behaviour-preserving for a single module graph.

## Boundaries & Constraints

**Always:**
- `isClientInputError` matches structurally on `err instanceof Error && err.name === "ClientInputError"`, mirroring `isReadOnlyError` (`src/lib/read-only.ts:436-438`), and carries a doc comment naming the duplicated-graph failure mode.
- Its signature is a type predicate `err is Error`, so `document-extract.ts:1002` can still read `error.message` after the check under `strict` mode.
- `ClientInputError` stays exported and constructible; every `throw new ClientInputError(...)` site is untouched.
- Every swept site keeps its exact status code, branch order and logging.
- `commons.ts` keeps importing `listWikiPages` and `tenantForOwner` from `./wiki`; only the two predicates move to `./page-types`.

**Block If:**
- Sweeping a site would change which status code a caught value maps to.

**Never:**
- Do not change test assertions that use `toBeInstanceOf(ClientInputError)` / `toThrow(ClientInputError)` — those run in one module graph and pin the class itself.
- Do not touch the `vi.mock("@/lib/wiki")` factories in `ingest-history-delete-route.test.ts` / `ingest-routes.test.ts`; they already re-export the real `@/lib/page-types` predicates, so they stay correct and harmless.
- Do not introduce a `isStoreFault`-style errno branch, retire `StoreFaultError`, or restructure any route's catch ladder.
- Do not remove the `./wiki` re-export of the two predicates — other server importers rely on it.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Own-realm error | `new ClientInputError("bad")` | `isClientInputError` → `true` | No error expected |
| Foreign-realm error | `Object.assign(new Error("bad"), { name: "ClientInputError" })` — a second copy of `errors.ts` | `isClientInputError` → `true` (the DW-578 fault: `instanceof` returns `false` here) | No error expected |
| Sibling typed error | `new StoreFaultError("boom")` | `isClientInputError` → `false` — a 500 ladder still ends in 500 | No error expected |
| Plain error | `new Error("bad")` | `false` | No error expected |
| Non-error value | `null`, `undefined`, `"bad"`, `{ name: "ClientInputError" }` | `false` — never throws on a property read | Returns `false`, does not throw |
| Commons predicate under a wiki mock | Route suite mocks `@/lib/wiki` without the two predicates; page has `visibility: "public"`, `type: "note"` | `belongsInCommons` → `true` (403/permission path answers correctly) | No `TypeError` from calling `undefined` |

</intent-contract>

## Code Map

- `src/lib/errors.ts:16-26` -- `ClientInputError` class; the new `isClientInputError` goes directly beneath it, above `StoreFaultError`. `isStoreFault` (l.57) and `isEnoent` are the local shape precedents.
- `src/lib/read-only.ts:20-22, 426-438` -- the documented rationale and the exact helper shape to mirror (`err instanceof Error && err.name === "…"`). Read-only, reference only.
- `src/lib/__tests__/errors.test.ts` -- existing `describe` blocks for `getErrorMessage`/`StoreFaultError`/`isStoreFault`; add an `isClientInputError` block in the same style.
- `src/lib/__tests__/read-only-kernel-gate.test.ts:436` -- precedent for pinning a name-matched classifier against a foreign error object.
- Route classification sites to sweep (one `instanceof` each unless noted):
  - `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:167`
  - `src/app/api/research/route.ts:156`
  - `src/app/api/research/[id]/route.ts:99, 132`
  - `src/app/api/research/[id]/run/route.ts:127` (inside a multi-branch ternary ladder)
  - `src/app/api/monitors/route.ts:61`
  - `src/app/api/tasks/run/route.ts:888` (boolean expression), `:938`
  - `src/app/api/ingest/route.ts:239`
  - `src/app/api/ingest/pdf/route.ts:193`
  - `src/app/api/ingest/document/route.ts:193`
  - `src/app/api/ingest/image/route.ts:209`
  - `src/app/api/wikis/route.ts:97`
  - `src/app/api/wikis/current/route.ts:52`
  - `src/app/api/wikis/[id]/route.ts:52, 91`
  - `src/app/api/wikis/[id]/template/route.ts:55`
  - `src/app/api/system/evaluations/route.ts:66`
  - `src/app/api/workbench/intake/route.ts:115`
  - `src/app/api/workbench/artifact/route.ts:87`
  - `src/app/api/workbench/artifact/revisions/route.ts:185`
  - `src/app/api/review/proposals/route.ts:86`
- `src/lib/document-extract.ts:457, 961, 1002` -- three lib-side sites; `:1002` reads `error.message` after the check, which is why the helper is a `err is Error` predicate.
- `src/lib/commons.ts:17` -- the DW-271 import line; `belongsInCommons` (l.47-56) is the consumer.
- `src/lib/page-types.ts:21, 32` -- `isAgentScopedType` / `isArtifactType`, pure and client-safe (imports only `./types` and `./agent-handle`, which itself imports nothing).
- `src/lib/wiki.ts:48` -- `export { isAgentScopedType, isArtifactType } from "./page-types";` — the re-export stays.

## Tasks & Acceptance

**Execution:**
- `src/lib/errors.ts` -- add `export function isClientInputError(err: unknown): err is Error` returning `err instanceof Error && err.name === "ClientInputError"`, placed immediately after the `ClientInputError` class, with a doc comment naming the duplicated-graph failure mode (vitest's two projects, bundler chunking, the stdio MCP entry point) and cross-linking `isReadOnlyError` -- so one helper closes the classification repo-wide.
- `src/app/api/**/route.ts` (the 21 route sites in the Code Map) -- replace each `X instanceof ClientInputError` with `isClientInputError(X)` and update the `@/lib/errors` import; drop `ClientInputError` from a file's import list only when nothing else in that file still uses the class -- so a foreign-realm `ClientInputError` keeps its 400/422 instead of degrading to 500.
- `src/lib/document-extract.ts` -- replace the three `instanceof ClientInputError` checks with `isClientInputError(...)`, importing it alongside the class (which the file still constructs) -- same classification, one mechanism.
- `src/lib/commons.ts` -- move `isAgentScopedType, isArtifactType` out of the `./wiki` import onto a new `import { isAgentScopedType, isArtifactType } from "./page-types";`, leaving `listWikiPages, tenantForOwner` on `./wiki` -- so a suite mocking `@/lib/wiki` cannot make `belongsInCommons` call `undefined`.
- `src/lib/__tests__/errors.test.ts` -- add an `isClientInputError` describe block covering every row of the I/O matrix's first five scenarios, including the foreign-realm object that `instanceof` misses -- the regression this change exists to prevent.
- `src/lib/__tests__/commons-import-isolation.test.ts` (new) -- a suite whose only `vi.mock("@/lib/wiki")` factory supplies `listWikiPages` and `tenantForOwner` and NOT the two predicates, asserting `belongsInCommons({ visibility: "public", type: "note" })` is `true` and that agent-scoped/artifact types are still excluded -- covers the last I/O matrix row and pins DW-271 shut for every future route suite. `commons.test.ts` stays unmocked and untouched.

**Acceptance Criteria:**
- Given an error object whose `name` is `"ClientInputError"` but which is not `instanceof` the imported class, when a swept route classifies it, then the route answers the caller-fault status it answers for a same-realm `ClientInputError` (400, or 422 on `tasks/run`), not 500.
- Given a `StoreFaultError` or a plain `Error`, when a swept route classifies it, then the response status is unchanged from before this change.
- Given a route suite that mocks `@/lib/wiki` without the two predicates, when `belongsInCommons` runs, then it returns a boolean rather than throwing a `TypeError`.
- Given the repository after the sweep, when `grep -rn "instanceof ClientInputError" src/` runs, then it reports no matches.
- Given the full suite, when `pnpm test` and `pnpm lint` run, then both pass with no new failures.

## Design Notes

The helper mirrors `isReadOnlyError` exactly, one file over:

```ts
export function isClientInputError(err: unknown): err is Error {
  return err instanceof Error && err.name === "ClientInputError";
}
```

Two deliberate choices. The `instanceof Error` guard comes first so the classifier never throws on a property read from a hostile or exotic caught value — the same ordering `isStoreFault` documents. And the return type is `err is Error`, not `err is ClientInputError`: under a duplicated graph the value genuinely is not an instance of the imported class, so claiming that type would be a lie, while narrowing to `Error` is both true and enough for `document-extract.ts:1002` to read `.message` under `strict`.

## Verification

**Commands:**
- `grep -rn "instanceof ClientInputError" src/ --include="*.ts" --include="*.tsx"` -- expected: no matches
- `pnpm lint` -- expected: no new errors (in particular no unused `ClientInputError` imports)
- `npx tsc --noEmit` -- expected: clean; confirms the `err is Error` narrowing satisfies `document-extract.ts:1002`
- `pnpm test` -- expected: full suite green, including the new `isClientInputError` block

## Auto Run Result

Status: done

**Implemented change.** Two duplicated-module-graph traps closed, both behaviour-preserving for a single graph. DW-578: a name-matching `isClientInputError` helper now sits beside the class in `errors.ts`, mirroring `isReadOnlyError`, and all 25 `instanceof ClientInputError` classification sites (22 across 19 route files, 3 in `document-extract.ts`) were swept onto it — status codes, branch order and log lines byte-identical. DW-271: `commons.ts` reaches `isAgentScopedType`/`isArtifactType` from `./page-types` directly instead of through `./wiki`'s re-export, so a route suite that mocks `@/lib/wiki` can no longer leave `belongsInCommons` calling `undefined`.

**Files changed.**
- `src/lib/errors.ts` — added `isClientInputError(err): err is Error`, matching on `err.name`; class untouched and still exported.
- 19 route files under `src/app/api/` — 22 classification sites onto the helper; `@/lib/errors` import lists adjusted (class kept only in `research/route.ts`, which still throws it).
- `src/lib/document-extract.ts` — three lib-side sites onto the helper; class kept (constructed ~35 times).
- `src/lib/commons.ts` — predicate import moved to `./page-types`, with a comment recording why it must not drift back.
- `src/lib/__tests__/errors.test.ts` — new `isClientInputError` block: own-realm, foreign-realm, `StoreFaultError`, plain `Error`, non-error values (including a throwing `name` getter), and the `.message` narrowing.
- `src/lib/__tests__/commons-import-isolation.test.ts` (new) — springs the DW-271 trap on purpose: a `vi.mock("@/lib/wiki")` factory that omits the predicates.
- `src/lib/__tests__/store-fault-routes.test.ts`, `src/lib/__tests__/wikis-routes.test.ts`, `src/lib/__tests__/ingest-document-route.test.ts` — foreign-realm route cases across the three ladder shapes (added at review).

**Review findings.** 2 patches applied (1 medium, 1 low — see the Review Triage Log), 1 deferred (low: `isStoreFault` still classifies by identity), 13 rejected as out of scope on the bundle intent's authority (sibling `./wiki` predicate importers, the research-run route's other `instanceof` arms, `src/mcp.ts`, an eslint guard rule, and pre-existing test-pin and archive-coverage residue).

**Follow-up review recommendation.** Patched findings this pass: 0 high, 1 medium, 1 low. Score = 3x1 + 1x1 = 4, below the threshold of 5, and no high-severity patch. `followup_review_recommended: false`.

**Verification.**
- `grep -rn "instanceof ClientInputError" src/ --include="*.ts" --include="*.tsx"` — no matches anywhere in `src/`, tests included.
- `npx tsc --noEmit` — clean; confirms the `err is Error` narrowing satisfies `document-extract.ts:1002`.
- `pnpm lint` — clean apart from three pre-existing `jsx-ast-utils` TSNonNullExpression notices.
- `pnpm test` — 9056 passed, 1 skipped. The touched suites re-run together: 103/103 pass.
- Negative-tested both guards. Reverting `commons.ts` to the `./wiki` import fails 4 of `commons-import-isolation.test.ts`'s 5 cases with `isAgentScopedType is not a function`. Reverting the helper body to `err instanceof ClientInputError` fails exactly the foreign-realm rows — the unit case plus the three route ladders — and nothing else.

**Residual risks.**
- `src/lib/__tests__/storage-fs.test.ts > reapStrandedScratchFiles` times out at 5s under full-suite parallelism. It reproduces at `a7312cfa` with this change stashed, passes in isolation here, and shares no import with anything touched — a pre-existing load flake, not a regression.
- The foreign-realm error objects in the tests are hand-built stand-ins (`Object.assign(new Error(...), { name: "ClientInputError" })`), not a genuine second load of `errors.ts`. They pin the classifier's contract, which is what the mechanism turns on, but a true duplicated graph remains unreproduced in-suite.
- `document-extract.ts:457` and `:961` now rethrow any value merely *named* `ClientInputError` verbatim rather than wrapping it as "could not be opened" — the intended widening, and no library in that catch path names its errors that way, but it is the one place the sweep is not strictly behaviour-identical.
