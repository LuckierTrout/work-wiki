---
title: 'DW-667/DW-669: query-stream route test mock fidelity'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
baseline_revision: '3b032d41c3a6c83bd6feb0ef8e8f8a0fe4827554'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      The streaming query route excludes saved artifacts only on the UNSCOPED
      path, while the non-streaming query() excludes them regardless of scope,
      so a scoped stream query can feed artifact markup into the LLM context.
    evidence: |-
      `src/lib/query.ts:298-306` filters `!isArtifactType(e.type)` BEFORE the
      scope branch, with an explicit comment: artifacts "must never enter the
      LLM context - so exclude them REGARDLESS of scope (incl. a vault that
      curated one, or the owner/'Mine' scope)". `src/app/api/query/stream/route.ts:124-128`
      applies the same predicate INSIDE `if (!scopeSlugs)`, so it only runs on
      an unscoped query. `resolveScopeSlugs` for `mine` / `owner:<handle>`
      returns that owner's slugs, which include their saved `html`/`slides`
      pages - so an owner-scoped streaming question can answer from raw
      artifact markup (and inlined illustration data URIs) that the
      non-streaming path deliberately withholds. Pre-existing and untouched by
      this story; surfaced by the review because DW-667 widened the artifact
      stub at exactly that filter. No test covers the scoped-artifact case in
      either streaming suite.
    location: >-
      src/app/api/query/stream/route.ts:124-128
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Two doubles in the `query-stream-route.test.ts` module factory diverge from the production shapes they stand in for, so the suite's assertions are weaker than they read. `isArtifactType` is stubbed as `t === "html"` while the real predicate (`src/lib/page-types.ts:32-34`) is `type === "html" || type === "slides"`, and the artifact-exclusion fixture carries no `slides` page — so a route that stopped filtering slides passes green. `hasLLMKey` is stubbed synchronously (`vi.fn(() => true)`) while production is `async` (`src/lib/llm.ts:248`); the mock passes only because `await true` works, and this repo treats that gate's promise-ness as load-bearing (DW-548, `llm-key-cold-config.test.ts`).

**Approach:** Widen the `isArtifactType` stub to match the real predicate, add a `slides` page to the artifact-exclusion fixture and assert it is excluded alongside `html`, and make the `hasLLMKey` double async. Test-only change; no production source is touched.

## Boundaries & Constraints

**Always:** Keep the mock factory's existing comments accurate — the "saved artifacts are `html`" note must be updated to name both artifact types, since it is now wrong. Keep the DW-546 status/body assertions in every existing case intact (the header comment forbids stripping them). Mirror production shape exactly: the artifact predicate returns true for `"html"` and `"slides"` and nothing else; the `hasLLMKey` double resolves `true` rather than returning it.

**Block If:** The route's artifact filter or LLM-key gate turns out not to be reachable from this suite (i.e. widening the stub or awaiting the gate cannot change any observable assertion) — that would mean the ledger entries mis-describe the code.

**Never:** Do not edit `src/lib/page-types.ts`, `src/lib/llm.ts`, `src/lib/wiki.ts`, or `src/app/api/query/stream/route.ts` — production is already correct; only the doubles drifted. Do not add a `slides` case to any other suite, do not touch `llm-key-cold-config.test.ts`, and do not rewrite unrelated cases in this file. Do not switch `hasLLMKey` to `mockResolvedValue` in `beforeEach` — the implementation belongs on the `vi.fn` itself, because `vi.clearAllMocks()` clears calls but not implementations, and no per-test override exists.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unscoped query, fixture holds an `html` artifact | `listReadableWikiPages` → `concept-a` + `saved-chart` (`type: "html"`) | Route answers 200 with the streamed body; `selectPagesForQuery` receives `["concept-a"]` only | No error expected |
| Unscoped query, fixture holds a `slides` artifact | `listReadableWikiPages` → `concept-a` + `saved-deck` (`type: "slides"`) | Route answers 200; `selectPagesForQuery` receives `["concept-a"]` only — no `slides` entry reaches the LLM context | No error expected |
| LLM-key gate resolves true | `hasLLMKey` double resolves `true` | `await hasLLMKey()` in the route passes the gate; every existing case still reaches 200 with a body | No error expected |

</intent-contract>

## Code Map

- `src/lib/__tests__/query-stream-route.test.ts` -- the only file to change. Line 27 (inside the `vi.mock("@/lib/wiki", ...)` factory) is the `isArtifactType` stub plus the comment above it at lines 24-26 that says artifacts "are `html`". Line 31 is `hasLLMKey: vi.fn(() => true)` inside the `vi.mock("@/lib/llm", ...)` factory. The artifact case is `it("excludes saved html artifacts from an unscoped query (and accepts format:html)")` — its inline `mockedList.mockResolvedValue([...])` fixture and the `not.toContain("html")` / slug-equality assertions are what widen.
- `src/lib/page-types.ts:32-34` -- READ-ONLY. `isArtifactType` = `type === "html" || type === "slides"`; the shape the stub must mirror. Re-exported through `@/lib/wiki`, which is what the route imports.
- `src/lib/llm.ts:248` -- READ-ONLY. `export async function hasLLMKey(): Promise<boolean>`; the shape the double must mirror.
- `src/app/api/query/stream/route.ts:126` -- READ-ONLY. `(e) => !isAgentScopedType(e.type) && !isArtifactType(e.type)` — the filter the widened stub exercises. Line 141 is `if (!(await hasLLMKey()))`, the gate the async double feeds.
- `src/lib/__tests__/llm-key-cold-config.test.ts:404-414` -- READ-ONLY evidence. Its "every `hasLLMKey()` call in `src/` is awaited" scan excludes `__tests__` via `walkFiles`, so changing this double cannot perturb that scan.
- `vitest.config.ts` -- READ-ONLY evidence. No `clearMocks`/`mockReset` option is set, so `vi.clearAllMocks()` in `beforeEach` clears call history only; a `vi.fn(async () => true)` implementation survives every test.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/query-stream-route.test.ts` -- widen the `isArtifactType` stub in the `@/lib/wiki` factory to `t === "html" || t === "slides"` and correct the comment above it to name both artifact types -- the real predicate matches both, and a stub narrower than production makes a route that stopped filtering slides invisible (DW-667).
- `src/lib/__tests__/query-stream-route.test.ts` -- in the artifact-exclusion case, add a `slides` page to the `mockedList` fixture, assert the passed entries contain neither `"html"` nor `"slides"`, keep the slug-equality assertion at `["concept-a"]`, and retitle the case so it names both artifact types -- the widened stub is only load-bearing if a `slides` row actually flows through the filter (DW-667).
- `src/lib/__tests__/query-stream-route.test.ts` -- make the `hasLLMKey` double async (`vi.fn(async () => true)`) and note beside it that production is `async` and the route awaits it -- the sync double passed only by `await true` coincidence, the same mock-shape drift DW-546 fixed one line below it (DW-669).

**Acceptance Criteria:**
- Given the mocked `@/lib/wiki` factory, when a test calls its `isArtifactType` with `"slides"`, then it returns `true` — matching `src/lib/page-types.ts`.
- Given the artifact-exclusion case's fixture now carries a `slides` page, when the route's filter is reverted to exclude `"html"` only, then that case fails — the assertion can now see a route that stopped filtering slides.
- Given the mocked `@/lib/llm` factory, when `hasLLMKey` is called, then it returns a Promise resolving to `true`, so the route's `await hasLLMKey()` is exercised against a production-shaped gate.
- Given the whole change is test-only, when the suite runs, then no file under `src/lib/page-types.ts`, `src/lib/llm.ts`, `src/lib/wiki.ts`, or `src/app/api/query/stream/route.ts` has been modified.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 1: (high 0, medium 1, low 0)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The async `hasLLMKey` double was unfalsifiable — no case ever resolved it false, so a sync and an async double behaved identically and reverting DW-669 broke nothing, while the route's no-key 500 branch had zero coverage in this suite. Added a sixth case (`mockResolvedValueOnce(false)` → 500, `/API key/i`, no `selectPagesForQuery`, no `callLLMStream`) and rewrote the double's comment to claim only what is now true. Mutation-confirmed: dropping the `await` at `route.ts:141` now fails that case with `expected 200 to be 500`.
  - `[low]` `[patch]` The `@/lib/wiki` factory hand-copied `isAgentScopedType`/`isArtifactType`, which is the mechanism that produced DW-667 in the first place — a comment saying "mirror production" enforces nothing, and the next artifact type would reintroduce the drift. Replaced both copies with the real predicates imported from `@/lib/page-types`, using the existing repo idiom at `src/lib/__tests__/ingest-routes.test.ts:32-39`.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/query-stream-route.test.ts` -- expected: all cases pass, including the widened artifact-exclusion case.
- `pnpm lint src/lib/__tests__/query-stream-route.test.ts` -- expected: no errors.
- `git diff --name-only` -- expected: exactly `src/lib/__tests__/query-stream-route.test.ts` (plus the spec file).

**Manual checks (if no CLI):**
- Temporarily narrow `src/app/api/query/stream/route.ts:126` to exclude `html` only and confirm the artifact-exclusion case fails; revert immediately. This proves the new `slides` row is load-bearing rather than decorative.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Repaired both mock-shape divergences in the `query-stream-route.test.ts` module factory (DW-667, DW-669), then hardened both halves under review. The `@/lib/wiki` factory no longer hand-copies the realm predicates at all — it imports the real `isAgentScopedType`/`isArtifactType` from `@/lib/page-types`, so a stub can never again be narrower than production. The artifact-exclusion case carries a `slides` page and asserts it is filtered alongside `html`. The `hasLLMKey` double is async, matching production, and a new case resolves it `false` so that shape is load-bearing rather than decorative. Test-only: no production source was modified.

**Files changed.**
- `src/lib/__tests__/query-stream-route.test.ts` — real predicates imported instead of restated; `slides` fixture row + exclusion assertion; async `hasLLMKey` double; new "500s when no API key is configured" case; comments rewritten to claim only what the assertions deliver.
- `_bmad-output/implementation-artifacts/spec-dw-667-669-query-stream-mock-fidelity.md` — this spec (new).

**Review findings breakdown.** 2 patches applied (1 medium, 1 low), 1 item deferred (medium), 6 rejected. Rejected as noise or out of scope on the intent's authority: the same-shape `html`-only stubs in sibling suites (`query-stream-deadline.test.ts`, `trail.test.ts`, `lint-fix.test.ts`, `workbench-lint-fix.test.ts`) — mock residue the intent did not name; a hypothetical future `mockReset`/`restoreMocks` vitest config change; the uncovered empty-after-artifact-filter 400 branch; uncovered `format: "slides"`/`"table"` mapping; the unstamped deferred-work ledger (orchestrator-owned by explicit instruction); and the observation that narrowing `page-types.ts` itself does not fail this suite (already held by `page-types.test.ts` and `search.test.ts`).

**Follow-up review recommendation.** `false`. Patched findings this pass: high 0, medium 1, low 1 — no high-severity patch, so no further loop.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/query-stream-route.test.ts` — 6/6 pass.
- `pnpm lint src/lib/__tests__/query-stream-route.test.ts` — clean (exit 0).
- `pnpm exec tsc --noEmit` — clean.
- Regression: `llm-key-cold-config.test.ts` (11) and `ingest-routes.test.ts` (57) pass; the `__tests__`-excluding source scan for un-awaited `hasLLMKey()` is unaffected, as predicted.
- Mutation check (a): narrowing `route.ts:126` to `e.type !== "html"` fails the artifact case (`expected [ undefined, 'slides' ] to not include 'slides'`). Route restored, `git diff` empty for it.
- Mutation check (b): dropping the `await` at `route.ts:141` fails the new no-key case (`expected 200 to be 500`). Route restored, `git diff` empty for it.
- `git status --porcelain` — the test file plus this spec only; no production source touched.

**Matrix audit.** All three I/O rows are covered by cases that ran and passed: the `html` and `slides` exclusion rows by the widened artifact case (one combined fixture carrying both artifact types, each asserted absent, slugs pinned to `["concept-a"]`), and the gate row by the 200-with-body assertions across every case plus the new false-resolving case on the other side of the gate.

**Residual risks.**
- The manual mutation checks temporarily edit `src/app/api/query/stream/route.ts`; an interrupted run would leave a production route mutated. Both were verified reverted (`git diff` empty for that file) before finalize.
- The deferred item is a real production divergence, not test residue: the streaming route filters artifacts only when unscoped, so an owner-scoped stream query can still put artifact markup into the LLM context. Out of this bundle's scope — the intent named the doubles, not the route's scope branch — and recorded for focused attention.
