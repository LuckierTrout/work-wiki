---
title: 'DW-668/DW-670/DW-671: query-stream route test assertion coverage'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
baseline_revision: '90933214295b11bd5138aa4126fd2ed6d834877c'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Three cases in `src/lib/__tests__/query-stream-route.test.ts` promise more in their title or comment than they assert. The 401 case's comment claims "no page selection, no LLM stream" and the invalid-format 400 case stops before any work, yet neither pins `callLLMStream` — the claim holds only transitively, because the route reaches `callLLMStream` (route.ts:174) after `selectPagesForQuery` (route.ts:156); `mockedStream` is in scope and unused there (DW-668). The artifact case's title promises "(and accepts format:html)" but asserts only a 200 and the filtered slugs, so a route coercing every request to `"prose"` passes green even though the mocked `buildQuerySystemPrompt` is observable (DW-671). And nothing covers an unscoped query whose readable pages are ALL agent-scoped, where the `#413` filter empties `entries` and the route answers a user-visible "The wiki is empty" 400 (route.ts:124-139) — an outcome produced entirely by the filter this file exists to test (DW-670).

**Approach:** Add the missing assertions to the two early-exit cases, assert the format actually reaching `buildQuerySystemPrompt` in the artifact case, and add one case for the all-agent-scoped unscoped query. Test-only change; no production source is touched.

## Boundaries & Constraints

**Always:** Keep every existing DW-546 status/body assertion and every DW-667/DW-669 assertion intact — the file header forbids stripping them. Assert `buildQuerySystemPrompt`'s format by its POSITION in the real signature (`src/lib/query.ts:180-186`: `context, entries, selectedSlugs, format, owner` — index 3), not by a reshaped call. Every comment this change touches must claim only what the assertions now deliver. New assertions go on the existing cases where one exists; only DW-670 adds a case.

**Block If:** The empty-after-filter 400 turns out to be unreachable from this suite — e.g. `resolveScopeSlugs` or `listReadableWikiPages` cannot be driven to an all-agent-scoped unscoped set — which would mean DW-670 mis-describes the route.

**Never:** Do not edit `src/app/api/query/stream/route.ts`, `src/lib/query.ts`, `src/lib/page-types.ts`, `src/lib/llm.ts`, or `src/lib/wiki.ts` — production is correct; only the assertions are thin. Do not add the same assertions to sibling suites (`query-stream-deadline.test.ts`, `query.test.ts`) — the intent names this file. Do not rewrite the unrelated scoped/unscoped filtering cases, the mock factories, or `scriptStream`. Do not add coverage for `format: "slides"` / `"table"` mapping — the intent names `html` only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Anonymous caller | `getPrincipal` resolves `null` | 401, `/sign in/i`; neither `selectPagesForQuery` NOR `callLLMStream` called | 401 JSON body |
| Invalid `format` | `{ question: "?", format: "bogus" }` | 400; neither `selectPagesForQuery` NOR `callLLMStream` called | 400 JSON body |
| Unscoped `format: "html"` | default principal, artifact fixture | 200 with body; `buildQuerySystemPrompt` receives `"html"` at argument index 3 | No error expected |
| Unscoped query, ALL readable pages agent-scoped | `listReadableWikiPages` → only `agent-identity` / `agent-knowledge` rows; `scopeSlugs` undefined | 400, `/wiki is empty/i`; the key gate, `selectPagesForQuery` and `callLLMStream` are all unreached | 400 JSON body |

</intent-contract>

## Code Map

- `src/lib/__tests__/query-stream-route.test.ts` -- the only file to change. Line 70 is the `buildQuerySystemPrompt: vi.fn(() => "system")` double inside the `vi.mock("@/lib/query", ...)` factory — it is NOT currently imported at the top or wrapped in `vi.mocked`, so DW-671 needs both. Line 88 is `const mockedStream = vi.mocked(callLLMStream)` — already in scope, already used by the no-key case at line 253, unused by the 401 (line 226) and invalid-format (line 220) cases. Line 197 is the artifact case whose title promises `format:html`. Line 135 is the shared `ENTRIES` fixture; DW-670 needs a per-case `mockedList.mockResolvedValue([...])` override carrying agent-scoped rows only.
- `src/app/api/query/stream/route.ts:124-139` -- READ-ONLY. `if (!scopeSlugs) entries = entries.filter(...)` then `if (entries.length === 0)` returns the "The wiki is empty. Please ingest some content first..." 400. The exact branch DW-670 covers.
- `src/app/api/query/stream/route.ts:141` -- READ-ONLY. `if (!(await hasLLMKey()))` sits AFTER the empty-entries 400, so the DW-670 case can additionally pin that ordering by asserting `hasLLMKey` was never reached.
- `src/app/api/query/stream/route.ts:165-171` -- READ-ONLY. `buildQuerySystemPrompt(context, entries, selectedSlugs, queryFormat, principal.handle)` — `queryFormat` is argument index 3, derived at route.ts:77-84 (`"html"` in, `"html"` through).
- `src/app/api/query/stream/route.ts:102-107` and `:65-76` -- READ-ONLY. The 401 and invalid-format early returns, both above every call DW-668 asserts absent.
- `src/lib/query.ts:180-186` -- READ-ONLY. Real `buildQuerySystemPrompt` signature; the source of the index-3 position.
- `_bmad-output/implementation-artifacts/spec-dw-667-669-query-stream-mock-fidelity.md` -- READ-ONLY continuity. The immediately preceding story on this same file; its Never clauses (no production edits, no sibling-suite spread) and its mutation-check discipline carry forward.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/query-stream-route.test.ts` -- add `expect(mockedStream).not.toHaveBeenCalled()` to the 401 case and to the "rejects an invalid format with 400" case, and give the 400 case the same "no page selection, no LLM stream" comment its sibling carries -- both comments claim the LLM was never reached while only `selectPagesForQuery` was pinned; the claim currently rides on route ordering rather than on an assertion (DW-668).
- `src/lib/__tests__/query-stream-route.test.ts` -- import `buildQuerySystemPrompt` from `@/lib/query`, add `const mockedPrompt = vi.mocked(buildQuerySystemPrompt)` beside the other handles, and in the artifact case assert it was called once with `"html"` at argument index 3, noting in a comment why the position is asserted rather than the whole call -- the title promises the format reached the prompt builder, and without this a route coercing every request to `"prose"` still passes (DW-671).
- `src/lib/__tests__/query-stream-route.test.ts` -- add a case for an unscoped query whose readable pages are all agent-scoped: override `mockedList` with `agent-identity` / `agent-knowledge` rows only, assert 400 and `/wiki is empty/i`, and assert `mockedHasKey`, `mockedSelect` and `mockedStream` were all never called -- this is the `#413` filter's own user-visible failure mode and the streaming path has no coverage of it (DW-670).

**Acceptance Criteria:**
- Given the 401 and invalid-format cases, when the route is mutated to call `callLLMStream` before its early return, then those cases fail — the "no LLM stream" claim is now enforced, not inferred from statement order.
- Given the artifact case, when `route.ts:165-171` is mutated to pass a literal `"prose"` instead of `queryFormat`, then that case fails — the `format:html` half of its title is load-bearing.
- Given the new all-agent-scoped case, when the `#413` filter at `route.ts:125-127` is removed, then that case fails with a 200 instead of the 400 — the empty-entries outcome is attributed to the filter, not to an empty fixture.
- Given the whole change is test-only, when the suite runs, then `git diff --name-only` lists no file under `src/app/` or `src/lib/` other than `src/lib/__tests__/query-stream-route.test.ts`.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 0
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - none

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/query-stream-route.test.ts` -- expected: all cases pass, 7 total (6 existing + the new all-agent-scoped case).
- `pnpm lint src/lib/__tests__/query-stream-route.test.ts` -- expected: no errors.
- `pnpm exec tsc --noEmit` -- expected: clean.
- `git diff --name-only` -- expected: exactly `src/lib/__tests__/query-stream-route.test.ts` plus this spec file.

**Manual checks (if no CLI):**
- Run each of the three mutations named in the Acceptance Criteria against `src/app/api/query/stream/route.ts` one at a time, confirm the intended case fails, and revert immediately — verify `git diff` is empty for that route before moving on. This proves each new assertion is load-bearing rather than decorative.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Closed three claim-vs-assertion gaps in `query-stream-route.test.ts`. The 401 and invalid-format 400 cases now pin `callLLMStream` as uncalled rather than inheriting the claim from route statement order (DW-668). The artifact case asserts the format that actually reached `buildQuerySystemPrompt` — argument index 3 of the real signature — so a route coercing every request to `"prose"` no longer passes its `format:html` title (DW-671). And a new case covers the `#413` filter's own user-visible failure mode: an unscoped query whose readable pages are all agent-scoped, where the filter empties `entries` and the route answers the "wiki is empty" 400 above the key gate (DW-670). Test-only: no production source was modified.

**Files changed.**
- `src/lib/__tests__/query-stream-route.test.ts` — `buildQuerySystemPrompt` imported and wrapped in `vi.mocked`; format-position assertion on the artifact case; `mockedStream` absence pinned on both early-exit cases; new all-agent-scoped 400 case pinning `hasLLMKey`, `selectPagesForQuery` and `callLLMStream` all unreached.
- `_bmad-output/implementation-artifacts/spec-dw-668-670-671-query-stream-assertion-coverage.md` — this spec (new).

**Review findings breakdown.** 0 patches, 0 deferred, 10 rejected. One layer (verification-gap) returned no findings at all. Rejected, with the reason each is not this story's problem:
- The `buildQuerySystemPrompt` double is sync while production is `async` (raised by three layers). Real but pre-existing same-shape mock residue, and DW-669's own precedent in this file argues against the fix: an async double with no case that can resolve it differently is decorative, and building such a case (asserting what `callLLMStream` received) is well beyond this intent.
- The inverse format mutation — a route coercing every request to `"html"` — is unpinned because no case asserts index 3 for the `"prose"` default. The intent names the coercion-to-prose mutation specifically, and that one is now caught (mutation-confirmed).
- The ledger still shows DW-668/670/671 `open`. Orchestrator-owned by explicit instruction to this run.
- Extending the invalid-format case to pin `getPrincipal` / `listReadableWikiPages`, and the early-exit cases to pin `buildQuerySystemPrompt` — nearby test pins no comment in the file claims.
- Uncovered `question is required` and `scope must be a string` 400 branches — pre-existing, unnamed by the intent, and not a broken door.
- An all-artifact readable set reaching the same 400. The stated consequence is false: dropping `isArtifactType` from the filter already fails the existing artifact case (mutation-confirmed last story).
- The all-agent-scoped fixture under a defined scope — already covered by the existing `agent:` scope case.
- Positional coupling of `mock.calls[0][3]` (the intent asked for exactly that, and `vi.mocked` types it from the real signature) and the comment-to-code ratio (this file's established idiom).

**Follow-up review recommendation.** `false`. Patched findings this pass: high 0, medium 0, low 0 — no patches at all, so no further loop.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/query-stream-route.test.ts` — 7/7 pass.
- `pnpm lint src/lib/__tests__/query-stream-route.test.ts` — clean (exit 0).
- `pnpm exec tsc --noEmit` — clean.
- Regression: `query-stream-deadline.test.ts` + `query.test.ts` — 125/125 pass; no spread into sibling suites.
- Mutation check (a): `await callLLMStream(...)` inserted above every early return — the 400 and 401 cases fail on their NEW `mockedStream` lines (`:240`, `:253`), not on the pre-existing `mockedSelect` line. Route restored; `git diff` empty for it.
- Mutation check (b): `queryFormat` replaced with a literal `"prose"` at `route.ts:165-171` — only the artifact case fails (`expected 'prose' to be 'html'`). Route restored; `git diff` empty for it.
- Mutation check (c): the `if (!scopeSlugs)` filter removed — the new case fails with `expected 200 to be 400`, alongside the two pre-existing filtering cases. Route restored; `git diff` empty for it.
- `git diff --name-only` — `src/lib/__tests__/query-stream-route.test.ts` only.

**Matrix audit.** All four I/O rows are covered by cases that ran and passed: the anonymous and invalid-format rows by the two early-exit cases (each now asserting both collaborators absent), the `format:"html"` row by the artifact case's index-3 assertion, and the all-agent-scoped row by the new 400 case.

**Residual risks.**
- The three mutation checks temporarily edit `src/app/api/query/stream/route.ts`; an interrupted run would leave a production route mutated. All three were verified reverted (`git diff --stat` empty for that file) immediately after each check.
- `mockedPrompt.mock.calls[0][3]` binds to argument order in `query.ts:180-186`. `vi.mocked` derives its types from the real signature, so a type change is caught by `tsc`, but a reorder that keeps a string at index 3 would silently assert a different argument. This is the assertion shape the intent asked for.
- The rejected sync-double observation is genuinely latent: drop the `await` at `route.ts:165` and production would hand `callLLMStream` a Promise as its system prompt, and nothing in this suite would see it. Left alone deliberately, per the reasoning above.
