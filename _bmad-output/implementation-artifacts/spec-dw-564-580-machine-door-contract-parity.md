---
title: 'One field name and one 4xx vocabulary across the machine doors'
type: 'bugfix'
created: '2026-08-30'
baseline_revision: '72dabfb19883e0e1b212bd1f557fa52bdf44b103'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** The three lint-fix doors disagree about one field's name: `LINT_FIX_REQUEST` (`src/app/api/lint/fix/route.ts:29-34`) calls it `targetSlug`, while both MCP doors (`src/mcp.ts` registered schema, `src/lib/mcp-http.ts:510`) call it `target` — so the body an agent learned at one door is silently target-less at the other, and each door's "Invalid request field `…`" message names a different field for the same value. Separately, the v1 façade answers 4xx with machine tokens (`unknown_action`, `not_found`, `too_many_paths`) everywhere except two spots that emit English sentences an agent cannot switch-case on: the `deep_research` 400 (`src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:167`) and the rescan `paths` 400 (`src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts:57-60`).

**Approach:** Accept BOTH names in `LINT_FIX_REQUEST` and resolve them `targetSlug ?? target`, exactly the precedent `src/app/api/lint/workbench-fix/route.ts:27-32` already sets — so `target`, the name both MCP doors advertise, becomes portable to the REST door while the in-product client's `targetSlug` keeps working. Add one token, `V1_INVALID_INPUT_ERROR`, to `src/lib/v1-contract.ts` beside the existing refusals and emit it at both prose 400s, carrying the sentence in `detail` — the secondary field `reviews/route.ts:126` and `web-search/route.ts:56` already use.

## Boundaries & Constraints

**Always:** `targetSlug` stays the winner when both names arrive, and both stay `z.string().optional()` — an explicit `null` is still a 400 at every door, the divergence DW-455 closed. The v1 400 bodies keep their prose verbatim, moved to `detail`, never dropped: the token tells an agent what class of failure it is, the sentence tells the owner which input. Only the 400 branch of the reviews catch changes; the 500 branch and the read-only 403 above it keep their current bodies. Any comment describing a changed contract is updated in the same edit.

**Block If:** Making the REST door accept `target` would change the status any door answers for a body that names NEITHER field, or for one that names `targetSlug` alone.

**Never:** Do not add `targetSlug` to either MCP door's advertised `inputSchema` — one canonical wire name (`target`) plus one legacy alias at the door that already shipped it is the fix; a second alias in both directions is four spellings. Do not rename `fixLintIssue`'s `targetSlug` parameter or the "Missing required fields: slug and targetSlug" sentence it throws (`src/lib/lint-fix.ts:151-156`) — that is library vocabulary, not a wire field. Do not touch the 401 "Sign in required." or the read-only 403 sentences anywhere in `/api/v1`; both are shared refusals the ledger entry explicitly leaves alone. Do not change any status code a passing test pins. Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| MCP-shaped body at the REST door | `POST /api/lint/fix` `{type:"broken-link",slug:"a",target:"b"}` | 200; `fixLintIssue` called with `"b"` as its `targetSlug` argument | No error expected |
| Legacy name still wins | `{type:"broken-link",slug:"a",targetSlug:"b",target:"c"}` | 200; `fixLintIssue` receives `"b"` | No error expected |
| Neither name | `{type:"broken-link",slug:"a"}` | Reaches the dispatcher with `undefined`; unchanged 400 "Missing required fields: slug and targetSlug" | `FixValidationError` → 400 |
| Wrong type on the alias | `{type:"broken-link",slug:"a",target:5}` | 400 ``Invalid request field `target`: …`` | Schema refusal, dispatcher never called |
| Explicit null on the alias | `{type:"broken-link",slug:"a",target:null}` | 400 naming `target` | Schema refusal, dispatcher never called |
| Caller-fault store refusal on `deep_research` | `createResearchProject` throws `ClientInputError("…maximum of 100 research projects.")` | 400 `{error:"invalid_input",detail:"…maximum of 100 research projects."}` | Typed 400, unchanged status |
| Server-fault store failure on `deep_research` | `createResearchProject` throws plain `Error("EINVAL: …")` | 500 `{error:"EINVAL: …"}` — unchanged | 500 body untouched |
| Read-only reaches the same catch | `ReadOnlyError` thrown below the gate | 403 with the refusal sentence — unchanged, still checked first | Unchanged |
| Non-array `paths` on rescan | `POST …/sources/rescan` `{paths:"wiki/a.md"}` | 400 `{error:"invalid_input",detail:"paths must be an array of strings."}` | Typed 400, unchanged status |

</intent-contract>

## Code Map

- `src/app/api/lint/fix/route.ts` -- `LINT_FIX_REQUEST` at :29-34 is the schema to widen; `fieldMessage` at :36-43 already names whichever field tripped, so it needs no change. Destructure + `fixLintIssue` call at :150-163. The JSDoc `Supported issue types:` bullet list at :48-58 is READ BACK by `src/lib/__tests__/prose-inventory-parity.test.ts:446-472`, which bounds the block at the first blank line and takes only the leading backticked token of each `- \`type\`:` bullet — so a backticked `target` inside a bullet's description is safe, but a blank line must not be introduced inside the list.
- `src/app/api/lint/workbench-fix/route.ts:27-32` -- the alias precedent to copy: `typeof body.targetSlug === "string" ? … : typeof body.target === "string" ? … : undefined`.
- `src/lib/mcp-http.ts:488-568` -- the HTTP MCP door. Declares `target` (:510) and its `optionalString` gate (:544-551). READ-ONLY for this change.
- `src/mcp.ts:1234-1242` (`handleFixLintIssue`, forwards `args.target` into `fixLintIssue`'s `targetSlug`) and :2520-2545 (the stdio registered schema, declares `target`). READ-ONLY for this change.
- `src/hooks/useLint.ts:175-190` -- the in-product client; sends `targetSlug`. Proves the legacy name must keep working.
- `src/lib/v1-contract.ts:160-180` -- the refusal-token block ending at `V1_UNKNOWN_ACTION_ERROR`; add the new token there. Client-safe module — no storage/LLM/Node imports may be added.
- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:157-169` -- the catch. Line 167's ternary is the 400/500 split; only the 400 body changes.
- `src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts:52-60` -- the second prose 400, sitting three branches above the token 400 `too_many_paths` at :74-77.
- `src/app/api/v1/projects/[wikiId]/reviews/route.ts:126` and `src/app/api/v1/web-search/route.ts:56` -- the `{ error: token, detail: sentence }` precedent. READ-ONLY.
- `src/lib/__tests__/lint-fix-route.test.ts` -- door suite; `fixLintIssue` is spied-not-stubbed via the factory at :20-23, so `spiedFixLintIssue` records the resolved target argument. `postFix` helper at :56.
- `src/lib/__tests__/epic8-v1-routes.test.ts:560-620` -- the `deep_research classifies what the store throws` block; its `it.each` at :592-605 asserts `toEqual({ error: fault.message })` and MUST be updated for the 400 row only. Note its `afterEach` resets `research`/`getItem`.
- `src/lib/__tests__/workbench-epic8.test.ts:142-150` -- pins the sidecar's mirrored constants by NAME (a fixed list), so a new contract export does not break it.

## Tasks & Acceptance

**Execution:**
1. `src/lib/v1-contract.ts` -- add `export const V1_INVALID_INPUT_ERROR = "invalid_input";` to the refusal block with a doc comment saying it means "the caller's input, not the server" and that the offending sentence rides in `detail` -- one owner for the token both routes emit.
2. `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts` -- emit `{ error: V1_INVALID_INPUT_ERROR, detail: getErrorMessage(error) }` on the 400 branch, leaving the 500 branch's body alone; update the DW-478 comment above it to say the token is the machine half and `detail` the human half -- an agent switch-casing on `error` gets a token here as it does everywhere else in the façade.
3. `src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts` -- move `"paths must be an array of strings."` into `detail` under the same token -- the sibling refusal three branches down already answers `too_many_paths`; these two disagreed inside one `if` block.
4. `src/app/api/lint/fix/route.ts` -- add `target: z.string().optional()` to `LINT_FIX_REQUEST`, resolve `targetSlug ?? target` at the `fixLintIssue` call, and extend the schema's own doc comment plus the `Request body:` prose BELOW the bullet list (never inside it) to state that `target` is the MCP doors' spelling and `targetSlug` wins when both arrive.
5. `src/lib/__tests__/lint-fix-route.test.ts` -- add a describe block covering the first five I/O rows, asserting on `spiedFixLintIssue`'s recorded third argument for the accept cases and on the 400 body naming `target` for the refusal cases -- the spy is the only way to see WHICH name the door resolved.
6. `src/lib/__tests__/epic8-v1-routes.test.ts` -- update the `it.each` 400 row to expect `{ error: V1_INVALID_INPUT_ERROR, detail: fault.message }`, leave the 500 row and the read-only row asserting exactly what they assert now, and add a rescan row pinning the `paths` 400's token + detail.

**Acceptance Criteria:**
- Given the stdio MCP door's advertised `fix_lint_issue` argument names, when that same object is POSTed as the body of `/api/lint/fix`, then the REST door accepts it and the fix receives the target — no door-specific rewriting.
- Given the two 400s this pass touches — the reviews catch's caller-fault branch and the rescan `paths` refusal — when an agent reads `error`, then it is a machine token from `v1-contract.ts` and the English explanation is in `detail`.
- Given `pnpm test`, when the full suite runs, then it passes with no pre-existing assertion weakened or deleted.

## Spec Change Log

## Review Triage Log

## Design Notes

The rescan `paths` 400 is in scope because the ledger entry's own reason asks for "one focused pass over v1 error bodies" and names the defect class, not a single line. Nothing pins that string (`grep "paths must be an array"` finds only the route), so the move is free.

It is NOT the only other prose 4xx in the façade — an earlier draft of this note said so and was wrong. `V1_EMPTY_QUERY_ERROR` (`src/lib/v1-contract.ts:186`) is the sentence `"query is required"`, emitted as the whole `error` by `search/route.ts:62` and `web-search/route.ts:49`, and hand-copied as a bare literal by `retrieve/route.ts:39`. That one is deliberately left alone: it is an EXPORTED constant whose value is already documented in `skills/work-wiki/api-reference.md:142`, so changing it is a wire-contract change to three doors and an installed skill pack rather than the free move rescan was. It is deferred, and `api-reference.md`'s refusal preamble names it as one of the three sentence-valued refusals so the doc does not overclaim.

The alias goes one way on purpose. Both MCP doors already advertise `target`; teaching the REST door that name makes ONE spelling work at all three doors, which is what portability means here. Teaching the MCP doors `targetSlug` as well would give the same value four accepted spellings across three doors and put an undeclared key in a schema agents read as the contract.

```ts
// src/app/api/lint/fix/route.ts — the resolve, mirroring workbench-fix.
const { type, slug, targetSlug, target, message } = parsed.data;
const resolvedTarget = targetSlug ?? target;
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/lint-fix-route.test.ts src/lib/__tests__/epic8-v1-routes.test.ts src/lib/__tests__/prose-inventory-parity.test.ts src/lib/__tests__/mcp-http.test.ts` -- expected: all pass, including the untouched MCP door rows.
- `pnpm test` -- expected: the whole two-project run passes.
- `pnpm exec tsc --noEmit` -- expected: clean (the new `target` field and contract export typecheck).
