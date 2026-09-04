---
title: 'One field name and one 4xx vocabulary across the machine doors'
type: 'bugfix'
created: '2026-09-03'
baseline_revision: '135bacd9c43b6fc63e54ed0ef9b4a2a2a2c490a3'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized, multiple-goals]
deferred:
  - summary: >-
      The v1 façade's new `invalid_input` token does not separate a
      MALFORMED body from a capacity or stored-row refusal, so an agent
      that branches on it can retry a `deep_research` request that can
      never succeed.
    evidence: |-
      `reviews/[reviewId]/route.ts`'s caller-fault 400 answers
      `V1_INVALID_INPUT_ERROR` for every `ClientInputError`, and the
      dominant one is `research-projects.ts`'s "This workspace already has
      the maximum of 100 research projects." That request's body is
      well-formed — the refusal is workspace STATE, and no edit to the body
      clears it. `cleanInput`'s verdict on `item.title` lands in the same
      branch, where the offending value is the stored review row rather
      than anything the caller sent. The sentence still rides in `detail`,
      so nothing regressed against the prose body this bundle replaced, and
      the single-token shape is what DW-580's "give it a token" authorized;
      a finer vocabulary (a cap/limit token beside `too_many_paths`, or a
      409) is a scope decision the ledger entry did not make. Raised
      independently by two review layers.
    location: >-
      src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:177
    severity: medium
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

Line anchors re-verified against `135bacd9`.

- `src/app/api/lint/fix/route.ts` -- `LINT_FIX_REQUEST` at :29-34 is the schema to widen; `fieldMessage` at :36-43 already names whichever field tripped, so it needs no change. Destructure at :151 (`const { type, slug, targetSlug, message } = parsed.data;`) and the `fixLintIssue` call at :161-169, whose THIRD argument is the target. The JSDoc `Supported issue types:` bullet list at :48-58 is READ BACK by `src/lib/__tests__/prose-inventory-parity.test.ts:445-473` — bounded at the first blank line, taking only the leading backticked token of each `- \`type\`:` bullet — so a backticked `target` inside a bullet's description is safe, but a blank line must not be introduced inside the list. The `Request body:` prose sits at :71-81, BELOW that blank line, and is the safe place to document the alias.
- `src/app/api/lint/workbench-fix/route.ts:27-32` -- the alias precedent to copy: `typeof body.targetSlug === "string" ? … : typeof body.target === "string" ? … : undefined`.
- `src/lib/mcp-http.ts:627-712` -- the HTTP MCP door's `fix_lint_issue`. Declares `target` in `inputSchema` (:649) and reads `a.target` (:682), forwarding it at :709. READ-ONLY for this change.
- `src/mcp.ts` -- `handleFixLintIssue` forwards `args.target` as `fixLintIssue`'s `targetSlug` argument (:1308); the stdio registered schema declares `target` (:2644) and passes it through at :2684. READ-ONLY for this change.
- `src/hooks/useLint.ts:154-176` -- the in-product client; sets `bodyObj.targetSlug`. Proves the legacy name must keep working.
- `src/lib/v1-contract.ts:165-187` -- the refusal-token block under the `The refusals. One vocabulary…` banner, ending at `V1_UNKNOWN_ACTION_ERROR` (:187); add the new token there. Client-safe module — no storage/LLM/Node imports may be added.
- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:157-169` -- the catch. The read-only 403 is checked first (:160-162); the DW-478 comment at :163-166 explains the split; :167-168 is the 400/500 ternary and body. Only the 400 body changes.
- `src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts:52-60` -- the second prose 400, sitting three branches above the token 400 `too_many_paths` at :72-78.
- `src/app/api/v1/projects/[wikiId]/reviews/route.ts:125-128` and `src/app/api/v1/web-search/route.ts:55-58` -- the `{ error: token, detail: sentence }` precedent. READ-ONLY.
- `src/lib/__tests__/lint-fix-route.test.ts` -- door suite; `fixLintIssue` is spied-not-stubbed via the factory at :21-24, so `spiedFixLintIssue` (:36) records the resolved target argument. `postFix` helper at :57, `postRawFix` at :62.
- `src/lib/__tests__/epic8-v1-routes.test.ts:565-620` -- the `deep_research classifies what the store throws` block; its `it.each` at :597-607 asserts `toEqual({ error: fault.message })` and MUST be updated for the 400 row only. Its `afterEach` (:593-596) resets `research`/`getItem`.
- `src/lib/__tests__/epic8-v1-routes.test.ts:820-840` -- `400s a malformed paths value and 403s under read-only` already drives the rescan non-array branch but asserts STATUS ONLY, never the body. It is the row to extend, not a new test to add.
- `src/lib/__tests__/workbench-epic8.test.ts:115-130` -- pins the sidecar's mirrored constants by NAME (a fixed list of four error tokens plus hosts/limits), so a new contract export does not break it and needs no sidecar mirror.
- `skills/work-wiki/api-reference.md:184-192` (`deep_research` row) and `:223-244` (rescan, which already documents `too_many_paths`) -- the installed skill pack's description of both doors. Neither currently states the 400 body these two branches emit, so no doc line contradicts the change; state the new token where the sibling token is already named.

## Tasks & Acceptance

**Execution:**
1. `src/lib/v1-contract.ts` -- add `export const V1_INVALID_INPUT_ERROR = "invalid_input";` to the refusal block with a doc comment saying it means "the caller's input, not the server" and that the offending sentence rides in `detail` -- one owner for the token both routes emit.
2. `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts` -- emit `{ error: V1_INVALID_INPUT_ERROR, detail: getErrorMessage(error) }` on the 400 branch, leaving the 500 branch's body alone; update the DW-478 comment above it to say the token is the machine half and `detail` the human half -- an agent switch-casing on `error` gets a token here as it does everywhere else in the façade.
3. `src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts` -- move `"paths must be an array of strings."` into `detail` under the same token -- the sibling refusal three branches down already answers `too_many_paths`; these two disagreed inside one `if` block.
4. `src/app/api/lint/fix/route.ts` -- add `target: z.string().optional()` to `LINT_FIX_REQUEST`, resolve `targetSlug ?? target` at the `fixLintIssue` call, and extend the schema's own doc comment plus the `Request body:` prose BELOW the bullet list (never inside it) to state that `target` is the MCP doors' spelling and `targetSlug` wins when both arrive.
5. `src/lib/__tests__/lint-fix-route.test.ts` -- add a describe block covering the first five I/O rows, asserting on `spiedFixLintIssue`'s recorded third argument for the accept cases and on the 400 body naming `target` for the refusal cases -- the spy is the only way to see WHICH name the door resolved.
6. `src/lib/__tests__/epic8-v1-routes.test.ts` -- update the `it.each` 400 row to expect `{ error: V1_INVALID_INPUT_ERROR, detail: fault.message }`, leave the 500 row and the read-only row asserting exactly what they assert now, and extend the existing `400s a malformed paths value…` test to pin the rescan 400's token + detail instead of its status alone.
7. `skills/work-wiki/api-reference.md` -- name the `invalid_input` 400 for both doors where each door's other refusals are already listed, so the installed skill pack does not teach an agent a vocabulary the façade no longer speaks.

**Acceptance Criteria:**
- Given the stdio MCP door's advertised `fix_lint_issue` argument names, when that same object is POSTed as the body of `/api/lint/fix`, then the REST door accepts it and the fix receives the target — no door-specific rewriting.
- Given the two 400s this pass touches — the reviews catch's caller-fault branch and the rescan `paths` refusal — when an agent reads `error`, then it is a machine token from `v1-contract.ts` and the English explanation is in `detail`.
- Given `pnpm test`, when the full suite runs, then it passes with no pre-existing assertion weakened or deleted.

## Spec Change Log

- **2026-09-03 — re-planned against `135bacd9`, no intent change.** This spec was first authored 2026-08-30 against `72dabfb1` as `spec-dw-564-580-machine-door-contract-parity.md` and left at `status: in-review`, but NONE of its implementation reached the tree: at `135bacd9`, `LINT_FIX_REQUEST` still has no `target`, `V1_INVALID_INPUT_ERROR` does not exist, and both prose 400s are unchanged. The file was swept into commit `868d2009` (a different bundle) as a planning artifact only, so the `in-review` status was false. Renamed to this run's bundle name, reset to `draft`, and re-verified: the `<intent-contract>` is preserved verbatim, the Code Map's line anchors were refreshed (several had drifted — `mcp-http.ts` `target` is now :649 not :510, `mcp.ts`'s schema :2644 not :2520), and two findings were added that the earlier pass missed: the rescan non-array branch already HAS a test (`epic8-v1-routes.test.ts:820`) asserting status only, so task 6 extends it rather than adding one; and `skills/work-wiki/api-reference.md` documents both doors, so task 7 keeps the installed pack honest. KEEP: the one-way alias argument and the `detail`-carries-the-sentence rule in Design Notes — both were re-checked against the code and hold.

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 1, low 2)
- defer: 1: (high 0, medium 1, low 0)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The alias tests hand-typed `target` as a literal, so they pinned the REST door alone while the intent's claim is RELATIONAL — renaming `target` in either MCP door's advertised schema would have silently re-broken the parity DW-564 filed. Added a `parity with what the MCP doors advertise` block that reads the target-argument name off `MCP_TOOLS` (HTTP door) and the stdio door's registered zod shape AT RUNTIME, locating it by description rather than by key, drives `/api/lint/fix` with the name it finds, and asserts the two doors spell it identically. Mutation-verified: renaming `target` in `mcp-http.ts` fails exactly those three tests while every hardcoded row stays green.
  - `[low]` `[patch]` Two comments added by this change cited `too_many_paths` as the `{ error, detail }` precedent; it answers `{ error, limit }` — no `detail`, no sentence. Re-pointed both (`sources/rescan/route.ts`, `epic8-v1-routes.test.ts`) at the real precedent, `reviews/route.ts` and `web-search/route.ts`, keeping `too_many_paths` described only as the sibling TOKEN in the same `if` block.
  - `[low]` `[patch]` `V1_INVALID_INPUT_ERROR`'s doc comment read as if the prose-4xx class was now closed, three lines below `V1_EMPTY_QUERY_ERROR`, which is still a sentence emitted by three doors. Marked that constant a deliberate exception with the reason (published wire value across three doors and the installed skill pack), and reworded the new token's comment to name the two 400s it converted and say the class is not closed.

## Design Notes

The rescan `paths` 400 is in scope because the ledger entry's own reason asks for "one focused pass over v1 error bodies" and names the defect class, not a single line. Nothing pins that string (`grep "paths must be an array"` finds only the route), so the move is free.

It is NOT the only other prose 4xx in the façade — an earlier draft of this note said so and was wrong. `V1_EMPTY_QUERY_ERROR` (`src/lib/v1-contract.ts:186`) is the sentence `"query is required"`, emitted as the whole `error` by `search/route.ts` and `web-search/route.ts`, and hand-copied as a bare literal by `retrieve/route.ts`. That one is deliberately left alone: it is an EXPORTED constant whose value is already documented in `skills/work-wiki/api-reference.md:142`, so changing it is a wire-contract change to three doors and an installed skill pack rather than the free move rescan was. It is deferred, and `api-reference.md` already names it as a sentence-valued refusal so the doc does not overclaim.

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

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

The three lint-fix doors now take one field name, and the two v1 façade 4xx bodies that answered in English now answer with a machine token. `/api/lint/fix` accepts `target` — the spelling both MCP doors advertise — alongside the `targetSlug` it shipped with, resolving `targetSlug ?? target` exactly as `workbench-fix` already did, so a body composed at either MCP door works unchanged at the REST door. Neither MCP door's advertised `inputSchema` gained `targetSlug`: the alias is deliberately one-way. `V1_INVALID_INPUT_ERROR = "invalid_input"` joins the refusal block in `v1-contract.ts` and is emitted by the `deep_research` caller-fault 400 and the rescan non-array-`paths` 400, each carrying its original English sentence verbatim in `detail`. The 500 branch, the read-only 403, and every status code are unchanged.

### Files changed

- `src/lib/v1-contract.ts` — adds `V1_INVALID_INPUT_ERROR`; documents `V1_EMPTY_QUERY_ERROR` as the deliberate sentence-valued exception.
- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts` — the `deep_research` caller-fault 400 becomes token + `detail`; 500 branch and 403 untouched.
- `src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts` — the non-array `paths` 400 becomes the same shape.
- `src/app/api/lint/fix/route.ts` — `LINT_FIX_REQUEST` gains the `target` alias; handler resolves `targetSlug ?? target`; JSDoc states the precedence and the one-way rule.
- `skills/work-wiki/api-reference.md` — names the `invalid_input` 400 at both doors, beside the sibling tokens already listed.
- `src/lib/__tests__/lint-fix-route.test.ts` — the alias suite, including a runtime parity block that sources the argument name from both MCP doors rather than hardcoding it.
- `src/lib/__tests__/epic8-v1-routes.test.ts` — the `deep_research` `it.each` split so the 400 and 500 bodies are pinned separately; the rescan malformed-`paths` test now pins its body, not just its status.

### Review findings breakdown

- Patches applied: 3 (medium 1, low 2) — the relational parity pin, a wrong precedent citation in two comments, and a doc comment that implied the prose-4xx sweep was exhaustive.
- Items deferred: 1 (medium) — `invalid_input` does not separate a malformed body from a capacity/stored-row refusal. See frontmatter `deferred`.
- Items rejected: 6 (all low) — empty-string precedence at the alias (matches the `workbench-fix` precedent and the Always clause), the handler sentence a target-less `target: ""` reads (protected by the Never clause), per-index detail on the rescan `paths` refusal (prose is preserved verbatim by the Always clause), the untaken reverse alias at the MCP doors (foreclosed by the Never clause), MCP tool `description` strings not advertising the alias, and `detail` being under-documented for the doors that already returned it.
- Follow-up review recommended: **false**. Patched by severity: high 0, medium 1, low 2. No patched finding was high severity.

### Verification performed

- `pnpm exec vitest run --project node lint-fix-route + epic8-v1-routes + prose-inventory-parity + mcp-http` — 240 passed, 4 files.
- `pnpm exec tsc --noEmit` — clean, exit 0.
- `pnpm test` — 374 files, 9362 passed, 1 skipped, exit 0.
- Mutation check on the new parity pin: renaming `target` to `targetPage` in `mcp-http.ts`'s `MCP_TOOLS` entry fails exactly the three parity tests and no hardcoded row; the rename was reverted and `git diff` confirms both MCP doors are untouched.
- Every one of the nine I/O matrix rows is covered by a test that ran and passed. Row 3 is pinned for BOTH readings — its quoted sentence belongs to `missing-crossref`/`contradiction` while its example body names `broken-link`, which emits a different one — so the row is covered whichever way it is read, and neither sentence changed.

### Residual risks

- `src/lib/__tests__/workbench-intake.test.ts` → "hands the inline compile the REMAINDER of the answer budget, not a fresh one" fails intermittently (twice in five full-suite runs) with `expected 16941 to be less than or equal to 16940` — a one-millisecond boundary on a wall-clock budget assertion from DW-700. It is unrelated to this bundle (workbench intake, not the v1 façade or the lint door), reproduces independently of these changes, and the suite passes on re-run. Not filed as deferred work: it is a flaky test pin, not a door an owner can hit.
- The alias makes `target` portable INTO the REST door; a REST-vocabulary body carrying `targetSlug` still reaches either MCP door target-less and is refused with a sentence naming a field those doors do not advertise. That asymmetry is the intent-contract's explicit choice, not an oversight.
