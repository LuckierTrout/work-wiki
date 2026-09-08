---
title: 'Research run route: typed errors and a GET catch'
type: 'refactor'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `POST /api/tasks/run` still decides a task's poison-vs-retry by
      `/not found/i` over the message, and it is the consumer of
      `runResearchProject`'s newly typed not-found throw.
    evidence: |-
      `src/app/api/tasks/run/route.ts:918` returns 422 (permanent, poison the
      task) when the message matches `/not found/i`, and `:883` uses the same
      regex for the Graphify terminal decision. `runResearchProject` now throws
      `ResearchProjectNotFoundError` at `src/lib/research-runtime.ts:1303` and
      `:1491`, and the `run-research` task lands in exactly that catch. Nothing
      breaks today only because this bundle preserved the message verbatim — the
      poison decision is now silently coupled to the class's DEFAULT message
      string, with no test pinning the coupling. It is the same anti-pattern
      DW-480/DW-577 retired, one door over, and out of this bundle's named
      scope.
    location: >-
      src/app/api/tasks/run/route.ts:918
    severity: low
  - summary: >-
      Same-shaped refusals at `POST /api/research/[id]/run` still answer 500,
      including one retired project that the GET on the same path answers 404
      for.
    evidence: |-
      `"Research project is retired"` (`src/lib/research-runtime.ts:322`),
      `"Research project completion is still being delivered"` (`:325`, `:390`),
      the rerun-baseline race (`:393`) and `applyResearchProjectMutation`'s
      `"Research projects were busy; retry the request."`
      (`src/lib/research-projects.ts:387`) all stay plain `Error` and so keep the
      500 the old regex ladder also gave them. Two are genuinely caller-visible
      states: a retired project is a 404 on `GET /api/research/[id]/run` and a
      500 on the POST, and a CAS exhaustion is transient contention reported as a
      permanent server fault with no retry signal. Deliberately excluded here —
      the bundle intent authorises typing not-found and conflict, not remapping
      statuses — and now documented as excluded in
      `ResearchProjectConflictError`'s docblock.
    location: >-
      src/lib/research-runtime.ts:322
    severity: low
baseline_revision: 'dc26b0194fe3d1039122b4a392496ae324845c55'
---

<intent-contract>

## Intent

**Problem:** `POST /api/research/[id]/run` decides 404/409/500 by matching the error MESSAGE (`/not found/i`, `/already running/i`), so a storage fault whose sentence happens to contain "not found" is reported as the caller's fault — the exact idiom DW-296 deleted from `POST /api/research` — and it has no `ClientInputError` branch. `GET` on the same file has no `try` at all, so a registry that `getResearchProject` refuses (DW-297, widened by DW-476) escapes as a framework 500 with no `{ error }` body, while every sibling door answers JSON.

**Approach:** Introduce `ResearchProjectNotFoundError` and `ResearchProjectConflictError` in `src/lib/research-projects.ts`, throw them from the `research-runtime.ts` sites that produce those two faults, and classify the POST catch by `instanceof` alone — adding the `ClientInputError` → 400 branch the create route already has. Wrap the GET handler so a refused registry answers a real `{ error }` body.

## Boundaries & Constraints

**Always:**
- Observable statuses are PRESERVED exactly: "Research project not found" still 404, "Research project is already running" still 409, everything else still 500. This bundle changes HOW the status is decided, not which status a given fault gets.
- Error messages stay verbatim — `research-runtime.test.ts` asserts several of them by regex (`/already running/i`, `/retired/i`), and the response body still returns the message unchanged.
- The POST catch keeps returning `availableProviders` alongside `error`, on every status.
- New error classes follow the file's existing class idiom (`ResearchLeaseError`, `ClientInputError`): plain `extends Error`, `this.name` set to the class name.

**Block If:** Preserving an existing status and classifying by type turn out to conflict for some fault reachable at this door (i.e. two different faults share one type but need different statuses).

**Never:**
- Do not remap any fault that is 500 today. `"Research project is retired"`, `"…completion is still being delivered"`, `"…changed while the rerun baseline was captured; retry"` and `ResearchLeaseError` all stay 500 — they are not named by this bundle and re-labelling them is a behaviour change nobody asked for.
- Do not add a read-only 403 backstop here: `applyResearchProjectMutation` is deliberately ungated (DW-385), so `queueResearchProject`/`cancelResearchProject` never throw `ReadOnlyError`.
- Do not touch the GET's dynamic `await import(...)`, the 202-and-poll contract, or the read-only gate ordering.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Run a project that is gone | `queueResearchProject` throws `ResearchProjectNotFoundError` | 404, `{ error, availableProviders }` | Classified by `instanceof` |
| Run a project already in flight | `queueResearchProject` throws `ResearchProjectConflictError("Research project is already running")` | 409, `{ error, availableProviders }` | Classified by `instanceof` |
| Store refuses the caller's input | `queueResearchProject` throws `ClientInputError` | 400, `{ error, availableProviders }` | New branch, matching `POST /api/research` |
| Storage fault whose sentence says "not found" | `queueResearchProject` throws `new Error("R2 object not found for research-projects.json")` | 500, `{ error, availableProviders }` | The regression this bundle exists to close |
| Storage fault whose sentence says "already running" | `queueResearchProject` throws `new Error("lock already running for research-projects.json")` | 500 | Same |
| Provider misconfigured | `ResearchProviderUnconfiguredError` / `ResearchProviderOverrideError` | 400 (unchanged) | Existing typed branches keep precedence |
| GET a wrong-shaped registry | `getResearchProject` throws `Error("Research projects file is not a list.")` | 500 with `{ error: "Research projects file is not a list." }` | New catch; no framework 500 |
| GET a project that is absent or retired | `getResearchProject` resolves `null`, or a `deleteRequested` row | 404 `{ error: "Research project not found." }` (unchanged) | No error expected |

</intent-contract>

## Code Map

- `src/app/api/research/[id]/run/route.ts` -- the door. POST catch at lines 83-102 holds the message-regex ladder (DW-480, DW-577); GET at 105-113 runs entirely outside any `try` (DW-576). `getErrorMessage` and `availableProviders()` are already imported.
- `src/lib/research-projects.ts` -- where the new classes go. Already imports/uses `ClientInputError` (lines 167-168, 446, 567) and already exports `getResearchProject` (line 388). `parseRegistry` (line 264) is the throw that DW-297/DW-476 made reachable and that the GET must now catch — deliberately a plain `Error`, i.e. a 500.
- `src/lib/research-runtime.ts` -- the throw sites, all currently `new Error(...)`:
  - line 319 (`queueResearchProject`, project absent) → not-found
  - line 385 (inside the `mutateResearchProject` mutator, in-flight status) → conflict
  - line 411 (`queueResearchProject`, row vanished mid-mutation) → not-found
  - line 435 (`cancelResearchProject`, row vanished) → not-found
  - lines 1301 and 1489 (`runResearchProject`) → not-found; these do not reach the route catch (the inline start is `.catch()`-swallowed) but carry the same sentence for the same fault, so leaving them untyped invites the regex back.
  Mutator throws propagate: `mutateResearchProject` → `lockedMutation` → `applyResearchProjectMutation` re-throws without swallowing.
- `src/lib/research-concurrency.ts:36` -- `ResearchLeaseError`, the class idiom to copy.
- `src/app/api/research/route.ts:145-152` -- the `instanceof ClientInputError ? 400 : 500` reference this door is being brought in line with; its comment names the `EINVAL` mislabelling.
- `src/lib/__tests__/research-run-route.test.ts` -- the suite. Line 20 mocks `@/lib/research-projects` with a BARE factory, so the route's new class imports would be `undefined` and `instanceof` would throw; convert it to the repo's `importOriginal` spread idiom (`src/lib/__tests__/context-route.test.ts:9`). Lines 167-173 pin the two message-regex cases and must move to the typed errors. `GET` is not imported yet.
- `src/lib/__tests__/research-delivery.test.ts` -- also drives this POST, but does not mock `research-projects`; no change expected.
- `src/components/KnowledgeStudio.tsx:777` -- the only caller of the GET; it reads the `{ error }` body, which is why the bare framework 500 is user-visible.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- add exported `ResearchProjectNotFoundError` (default message `"Research project not found"`) and `ResearchProjectConflictError`, each `extends Error` with `this.name` set, beside the file's existing error usage -- gives the door something to classify by type.
- `src/lib/research-runtime.ts` -- import both classes and replace the six `new Error(...)` throws named in the Code Map with the typed equivalents, messages unchanged -- the runtime is where the faults originate.
- `src/app/api/research/[id]/run/route.ts` -- replace the POST catch's regex ladder with `instanceof` branches (`ClientInputError` → 400 alongside the two provider errors, `ResearchProjectNotFoundError` → 404, `ResearchProjectConflictError` → 409, else 500), and wrap the GET body in `try`/`catch` returning `{ error: getErrorMessage(error) }` at 500 -- closes DW-480, DW-577 and DW-576.
- `src/lib/__tests__/research-run-route.test.ts` -- switch the `@/lib/research-projects` mock to the `importOriginal` spread, retarget the 404/409 test at the typed errors, add the `ClientInputError` → 400 case, add the two storage-fault-that-matches-the-old-regex → 500 cases, and add GET cases for the refused registry (500 with a body) and the unchanged 404 -- pins every row of the I/O matrix.

**Acceptance Criteria:**
- Given a fault that is neither a research-project error nor a provider error nor a `ClientInputError`, when it reaches the POST catch, then the response is 500 regardless of what its message says.
- Given `getResearchProject` rejects, when the GET handler runs, then the caller receives a JSON `{ error }` body rather than a framework error page.
- Given the full suite, when `pnpm test` runs, then no assertion that depended on the old message-regex classification remains and nothing else regresses.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 2: (high 0, medium 0, low 2)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[medium]` `[patch]` The runtime->route seam was unpinned: two reviewers independently reverted all six typed throws to `new Error(...)` and the suite stayed green, so the door could silently degrade 404/409 to 500 with CI passing. Added type assertions in `research-runtime.test.ts` -- `queueResearchProject` and `cancelResearchProject` on a missing id now assert `ResearchProjectNotFoundError`, and the in-flight case asserts `ResearchProjectConflictError` -- keeping the message assertions, since `POST /api/tasks/run` still poisons by `/not found/i`. Confirmed the new assertions fail when a throw site is reverted.
  - `[low]` `[patch]` The POST catch comment claimed "the provider branches stay FIRST so nothing can pre-empt their 400", which is false -- every class in the ladder extends `Error` directly and none subclasses another, so the branches are disjoint. Comment corrected to say the order is presentation, not precedence.
  - `[low]` `[patch]` The GET comment and the DW-576 test docblock both claimed the Workbench renders `{ error }` from this door "so it showed nothing at all". The only GET caller is the Studio's 3-second Research poll (`KnowledgeStudio.tsx:777`), whose `catch {}` discards the body either way. Both rewritten to state the real gain (the same `{ error }` JSON shape every sibling door returns, instead of a framework error page) and to name the Studio poll correctly.
  - `[low]` `[patch]` `ResearchProjectConflictError`'s docblock said "the project exists but its current state refuses the requested transition", overclaiming coverage of refusals deliberately left as plain `Error`. Narrowed to the single in-flight-run refusal it is thrown for, naming the excluded siblings.
  - `[low]` `[patch]` The test file's header docblock still described only the mutate doors while the file now pins a read door. Updated to cover the GET suite.
  - `[low]` `[patch]` The new GET 200 test asserted only `{ project }`; `availableProviders` is half that response's contract. Now asserted.

## Design Notes

Two classes, not one shared `ResearchProjectError` with a `kind` field: the door
branches on exactly two outcomes, and `instanceof` on two names reads at the call
site without a second lookup — the same shape `ResearchProviderUnconfiguredError`
and `ResearchProviderOverrideError` already have in this catch.

The catch keeps the provider branches FIRST so their 400 cannot be pre-empted,
then the caller-input 400, then the two project branches:

```ts
const status =
  error instanceof ResearchProviderUnconfiguredError ||
  error instanceof ResearchProviderOverrideError ||
  error instanceof ClientInputError
    ? 400
    : error instanceof ResearchProjectNotFoundError
      ? 404
      : error instanceof ResearchProjectConflictError
        ? 409
        : 500;
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/research-run-route.test.ts src/lib/__tests__/research-runtime.test.ts src/lib/__tests__/research-delivery.test.ts src/lib/__tests__/research-projects.test.ts` -- expected: all pass
- `pnpm test` -- expected: full suite green, no new failures
- `pnpm lint` -- expected: clean
- `pnpm exec tsc --noEmit` -- expected: no type errors

## Auto Run Result

Status: done

**Implemented.** `POST /api/research/[id]/run` no longer decides 404/409/500 by
running `/not found/i` and `/already running/i` over the error message: two new
typed errors carry those two faults out of the runtime and the catch classifies
by `instanceof` alone, with the `ClientInputError` -> 400 branch the create
route already had. `GET` on the same file, which ran entirely outside a `try`,
is wrapped and now answers the `{ error }` JSON body every sibling door returns
instead of a framework error page. No status was remapped -- what changed is how
each status is decided, not which fault gets which.

**Files changed:**
- `src/lib/research-projects.ts` -- adds exported `ResearchProjectNotFoundError`
  and `ResearchProjectConflictError`, plain `extends Error` with `this.name` set,
  matching the `ClientInputError` / `ResearchLeaseError` idiom.
- `src/lib/research-runtime.ts` -- six throw sites retyped (`:321`, `:387`,
  `:413`, `:437`, `:1303`, `:1491`), messages verbatim so the downstream
  message-regex consumer in `POST /api/tasks/run` is unaffected.
- `src/app/api/research/[id]/run/route.ts` -- POST catch is `instanceof`-only;
  GET is wrapped in `try`/`catch` returning `{ error }` at 500.
- `src/lib/__tests__/research-run-route.test.ts` -- partial (`importOriginal`)
  mock so the route's class imports resolve, the 404/409 cases retargeted at the
  typed errors, plus new cases for `ClientInputError` -> 400, two storage faults
  whose messages match the retired regexes -> 500, and a full GET suite.
- `src/lib/__tests__/research-runtime.test.ts` -- pins the runtime side of the
  seam by TYPE, so a throw site reverted to a bare `Error` fails the suite.

**Review findings:** 6 patches applied (1 medium, 5 low), 2 deferred (both low,
recorded in frontmatter `deferred`), 12 rejected.

**Follow-up review recommended: true.** Patched by severity: high 0, medium 1,
low 5. Score = 3x1 + 1x5 = 8, which is >= 5.

**Verification:**
- `pnpm exec vitest run --project node` over the four research suites -- 176
  passed, 1 skipped.
- `pnpm test` -- 354 files, 8277 passed, 1 skipped. No regressions (8276 before
  the patch pass).
- `pnpm exec tsc --noEmit` -- clean.
- `pnpm lint` -- clean; only the three pre-existing `jsx-ast-utils`
  `TSNonNullExpression` warnings that are present on the baseline.
- Mutation check: reverting the six typed throws to `new Error(...)` fails three
  tests in `research-runtime.test.ts`, so the seam is genuinely pinned.

**Residual risks:**
- Classification is by `instanceof`, which `read-only.ts` documents as
  unreliable across a duplicated module graph; `DW-578` already tracks that
  hazard for `ClientInputError` across ~16 route sites, and this change follows
  the intent's explicit direction to match the create route rather than opening
  a second mechanism.
- The `ClientInputError` -> 400 branch on this door has no reachable production
  path today (`queueResearchProject` / `cancelResearchProject` patch only
  statuses, never title/question), so it is defensive parity with the create
  route, exercised only by mock injection.
- The test file's `importOriginal` spread means every store function it does not
  stub is the real implementation; isolation now depends on which store
  functions the handlers under test happen to call.
- Both deferred items are pre-existing and named above.
