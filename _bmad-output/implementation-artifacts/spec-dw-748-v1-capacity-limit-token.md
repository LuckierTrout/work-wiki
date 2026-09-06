---
title: 'A capacity token so a malformed body and a workspace at its cap are separable'
type: 'bugfix'
created: '2026-09-05'
baseline_revision: 'bca1df660f34b4986d3dc9328ac170ddd49a5f18'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      At the `deep_research` door a `cleanInput` verdict on the STORED review
      row still answers `invalid_input`, a token whose whole meaning is "the
      request is wrong" — for a value the caller never sent and cannot edit.
    evidence: |-
      `reviews/[reviewId]/route.ts` parses only `resolved`/`action` from the
      body and hands `createResearchProject` the review's own `item.title` and
      `item.summary || item.title`. So `cleanInput`'s "Research title is
      required" reaches the caller as `invalid_input` on a body that has
      nothing in it to fix — structurally the same dead-end retry DW-748
      removed for the workspace cap, one branch over. The ledger entry's reason
      names this case explicitly ("the offending value is the stored review row
      rather than anything the caller sent"), and the ledger's SECOND decision
      option covered it ("the project cap, and a stored-row verdict"); the
      human chose option 1, which names only the cap, so it is out of this
      bundle's scope by the intent's own authority rather than by oversight.
      This pass closed the misleading half: `api-reference.md` now states that
      the title and question come from the stored review row and that
      resending unchanged will not clear such a refusal. What remains is the
      TOKEN — an agent switch-casing on `error` alone still cannot tell this
      apart from a genuinely malformed body.
    location: >-
      src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:211
    severity: low
---

<intent-contract>

## Intent

**Problem:** `PATCH /api/v1/projects/{id}/reviews/{reviewId}` with `action: "deep_research"` answers 400 `invalid_input` for EVERY `ClientInputError` out of `createResearchProject`, and the dominant one is the `MAX_PROJECTS` cap — a refusal about workspace STATE, where the body was well-formed and no edit to it can ever clear the refusal. An agent that branches on `invalid_input` reads "fix your request and resend" and retries a request that can never succeed.

**Approach:** Give the store a distinguishable capacity error type, add a `limit_reached` token to the v1 refusal vocabulary beside the `too_many_paths` capacity refusal the façade already speaks, and branch the review door's caller-fault rung so the cap answers `limit_reached` while a genuinely malformed input keeps answering `invalid_input`. Document both at the doors that emit them, and pin that an agent branching on `limit_reached` must not retry unchanged.

## Boundaries & Constraints

**Always:** Every status code stays exactly what it is today — the cap is still 400, only the token changes. The `{ error: token, detail: sentence }` shape holds: the store's own sentence rides verbatim in `detail`, never dropped. The new capacity error stays a caller-fault to every door that classifies with `isClientInputError`, so `POST /api/research`'s 400 for the same cap is unchanged; it must NOT become a 500 anywhere. The read-only 403 stays first in the review door's catch, the `ResearchProjectBusyError` 503 rung stays after the caller-fault rungs, and the bare-message 500 stays last. `too_many_paths` keeps its published wire value verbatim.

**Block If:** Making the cap distinguishable would require changing the status or the `error` value any currently-passing test pins at a non-v1 door.

**Never:** Do not change the value of `too_many_paths` or `invalid_input` — both are published in `skills/work-wiki/api-reference.md` and are wire contract. Do not retype `cleanInput`'s blank-title/blank-question refusals or the review row's stored-`item.title` verdict — those keep answering `invalid_input`, which is the correct class for them; only the workspace cap moves. Do not add a capacity rung to the rescan door's catch — that door has no capacity refusal reaching it, and its `paths` 400 is a genuinely malformed body. Do not touch the 401 "Sign in required." or the read-only 403 sentences. Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Workspace at its project cap | `deep_research` while `createResearchProject` throws the `MAX_PROJECTS` refusal | 400 `{error:"limit_reached", detail:"This workspace already has the maximum of 100 research projects."}` | Typed 400, status unchanged |
| Malformed/unusable input at the same door | `createResearchProject` throws a plain `ClientInputError` (e.g. `"Research title is required"` off the stored review row) | 400 `{error:"invalid_input", detail:"Research title is required"}` — unchanged | Typed 400, status unchanged |
| Contended registry write | `createResearchProject` throws `ResearchProjectBusyError` | 503 `{error:"<store sentence>"}` — unchanged, no token | Unchanged rung, still ordered after the 400s |
| Server fault | `createResearchProject` throws `Error("EINVAL: …")` | 500 `{error:"EINVAL: …"}` — unchanged | Unchanged |
| Read-only refusal | `ReadOnlyError` thrown below the gate | 403 with the refusal sentence — unchanged, still checked FIRST | Unchanged |
| The same cap at the owner-facing door | `POST /api/research` while the store throws the cap | 400 with the store's sentence — unchanged | `isClientInputError` still answers true for the new class |
| Malformed `paths` on rescan | `POST …/sources/rescan` `{paths:"raw/sources/a.txt"}` | 400 `{error:"invalid_input", detail:"paths must be an array of strings."}` — unchanged | Unchanged |
| Over the rescan path cap | `paths` with 26 entries | 400 `{error:"too_many_paths", limit:25}` — value unchanged, now sourced from `v1-contract.ts` | Unchanged |
| Capacity error under a duplicated module graph | A `ResearchProjectCapacityError` from a SECOND copy of `research-projects.ts` | Still classified as capacity → `limit_reached` | Structural `name` check, not `instanceof` |

</intent-contract>

## Code Map

Line anchors verified against `bca1df66`.

- `src/lib/errors.ts:19-25` -- `ClientInputError`. `isClientInputError` at :50-52 is STRUCTURAL on `err.name === "ClientInputError"` (DW-578) — so a subclass that sets its own `name` currently answers `false` there, which would silently turn the cap into a 500 at `POST /api/research:165`, `/api/research/[id]`, `/api/tasks/run` and ~15 other doors. This is the load-bearing constraint of the whole change. Fix by BRANDING the base class with an inherited own-property so any subclass stays a caller-fault without enumerating names.
- `src/lib/errors.ts:26-52` -- the docblock explaining why the check is structural and why it narrows to `Error`, not to `ClientInputError`. Extend it; do not weaken either claim.
- `src/lib/research-projects.ts:22-140` -- the typed-error block: `ResearchProjectNotFoundError` (:47), `ResearchProjectConflictError` (:78), `ResearchProjectBusyError` (:136), each `extends Error` with `this.name` set. The new capacity class belongs here and follows this idiom, except that it `extends ClientInputError` so the existing 400 classification survives.
- `src/lib/research-projects.ts:897-903` -- inside `createResearchProject`'s `lockedMutation`: `if (filterResearchProjects(projects, null).length >= MAX_PROJECTS) throw new ClientInputError(...)`. The ONE throw site to retype. `MAX_PROJECTS` is at :266. Message text must stay byte-identical.
- `src/lib/research-projects.ts:367-373` -- `cleanInput`'s `ClientInputError`s. READ-ONLY: these stay `invalid_input`.
- `src/lib/v1-contract.ts:165-209` -- the refusal-token block. `V1_INVALID_INPUT_ERROR` (:209) is its last member; the `Limits.` banner starts at :211. Add the capacity tokens at the end of the refusal block. Client-safe module: no storage/LLM/Node imports may be added. `V1_EMPTY_QUERY_ERROR`'s docblock (:184-192) is the precedent for "a published wire value is not free to change".
- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:159-207` -- the catch ladder: read-only 403 (:162-164), the DW-478/DW-732 comment (:165-182), the `isClientInputError` 400 (:183-188), the `ResearchProjectBusyError` 503 (:204-206), the bare 500 (:207). Insert the capacity rung ABOVE the `isClientInputError` rung — capacity IS a client-input error by classification, so an order flip silently keeps the old token. Imports at :1-20.
- `src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts:57-93` -- the `paths` `if` block: `invalid_input` at :66-72 (READ-ONLY, malformed body) and the `too_many_paths` literal at :90. Only the literal is swapped for the contract constant; the value is unchanged. Its catch (:118-124) has no `ClientInputError` rung and gains none.
- `src/app/api/research/route.ts:164-170` -- `isClientInputError(error) ? 400 : ResearchProjectBusyError ? 503 : 500`. READ-ONLY, and the regression witness: it must still answer 400 for the cap.
- `src/lib/__tests__/errors.test.ts:272-289` -- `isClientInputError classifies structurally, not by identity`. The foreign-object row (:277-284) must keep passing; add a subclass row beside it.
- `src/lib/__tests__/research-projects.test.ts:409-431` -- `refuses at MAX_PROJECTS without evicting anything` asserts `rejects.toBeInstanceOf(ClientInputError)`, which a subclass still satisfies. Extend, do not replace.
- `src/lib/__tests__/research-route.test.ts:128-141` -- `400s the MAX_PROJECTS refusal`, driven by a MOCKED store rejecting with a raw `ClientInputError`, so it does not exercise the new class. It is the pin that must not weaken; add a sibling row that rejects with the capacity class.
- `src/lib/__tests__/epic8-v1-routes.test.ts:705-796` -- `deep_research classifies what the store throws`: four rows (400 caller-fault at :741, 503 at :756, 500 at :775, 403 at :786), `deepResearch()` helper at :717, `afterEach` resetting `research`/`getItem` at :731. The 400 row currently uses the cap sentence — it must become the capacity row, with a NEW row for a non-capacity `ClientInputError`. (The bundle's `:620` anchor is this block, pre-drift.)
- `src/lib/__tests__/epic8-v1-routes.test.ts:1073-1108` -- `400s a malformed paths value and 403s under read-only`, which already pins the rescan `invalid_input` token + detail. (The bundle's `:970` anchor.) Assert the constant rather than a literal; there is no existing row for the `too_many_paths` cap, so add one.
- `src/lib/__tests__/epic8-v1-routes.test.ts:122-133` -- the `v1-contract` import list to extend.
- `src/lib/__tests__/workbench-epic8.test.ts:125-133` -- pins the sidecar's mirrored constants by an explicit NAME list (four error tokens plus hosts/limits), so new contract exports need no sidecar mirror and break nothing. :933-948 checks `api-reference.md` for route paths only, so doc edits are additive-safe.
- `skills/work-wiki/api-reference.md:173-193` (`deep_research`, which already narrates the `invalid_input` 400 and the tokenless 503), `:229-256` (rescan, which already names `too_many_paths` and `invalid_input`), `:284-296` (the `Refusals, everywhere` table — door-specific tokens are NOT listed there, so do not add rows to it).

## Tasks & Acceptance

**Execution:**
1. `src/lib/errors.ts` -- brand `ClientInputError` with an inherited own-property marker and widen `isClientInputError` to accept it alongside the existing `name` check -- so a subclass stays a 400 at all ~20 doors that classify with it, without enumerating subclass names; extend the docblock to say why the brand exists and that the `name` row stays for foreign copies.
2. `src/lib/research-projects.ts` -- add `ResearchProjectCapacityError extends ClientInputError` (name set, doc comment saying it is workspace STATE, not the body, and that no edit to the request clears it) plus a structural `isResearchProjectCapacityError` predicate, and throw it at the `MAX_PROJECTS` guard with the message byte-identical -- one type the door can branch on, structural for the duplicated-graph reason `isClientInputError` documents.
3. `src/lib/v1-contract.ts` -- add `V1_TOO_MANY_PATHS_ERROR = "too_many_paths"` (the existing capacity refusal, hoisted verbatim so it has one owner) and `V1_LIMIT_REACHED_ERROR = "limit_reached"` beside it, with a doc comment separating the two capacity shapes from `invalid_input` and stating the retry rule -- the vocabulary is what an agent switch-cases on, so it belongs where the rest of it lives.
4. `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts` -- add the capacity rung above the `isClientInputError` rung, answering 400 `V1_LIMIT_REACHED_ERROR` with the sentence in `detail`, and update the catch comment to describe the ladder as capacity / caller-input / contention / server -- an agent must be able to tell "make room" from "fix the body".
5. `src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts` -- emit `V1_TOO_MANY_PATHS_ERROR` in place of the bare literal (value unchanged) and note in the adjacent comment that `limit_reached` is the workspace-state sibling this door does not reach -- so the two capacity tokens read as one family.
6. `src/lib/__tests__/errors.test.ts` -- add a row proving a `ClientInputError` SUBCLASS with its own `name` is still classified as a caller fault, and one proving a foreign-copy subclass (own-property brand, different `name`) is too -- the brand is the only thing keeping ~20 doors at 400.
7. `src/lib/__tests__/research-projects.test.ts` -- extend the cap row to assert the thrown value is a `ResearchProjectCapacityError` (and still a `ClientInputError`) with the message unchanged -- the type is the contract the door reads.
8. `src/lib/__tests__/research-route.test.ts` -- add a row rejecting with `ResearchProjectCapacityError` and asserting `POST /api/research` still answers 400 with the store's sentence -- the non-v1 door is where a broken brand would show up as a 500.
9. `src/lib/__tests__/epic8-v1-routes.test.ts` -- split the `deep_research` caller-fault row into a capacity row (400 `limit_reached` + detail) and a malformed-input row (400 `invalid_input` + detail), leave the 503/500/403 rows exactly as they are, assert the rescan `invalid_input` body against the constant, and add a row pinning the rescan `too_many_paths` 400 body -- the separability claim is only real if both branches are driven.
10. `skills/work-wiki/api-reference.md` -- name `limit_reached` in the `deep_research` paragraph beside the `invalid_input` sentence already there, and in the rescan bullet list say `too_many_paths` is the request-shaped cap while `limit_reached` is the workspace-state one; state in both places that an agent must not retry a `limit_reached` request unchanged -- the installed pack is what an agent actually reads.

**Acceptance Criteria:**
- Given a `deep_research` request refused because the workspace holds the maximum research projects, when an agent reads `error`, then it is `limit_reached` — a token that tells it the body is fine and retrying it unchanged cannot succeed — while a refusal about the input itself still reads `invalid_input`.
- Given every door that classifies faults with `isClientInputError`, when the store raises the capacity refusal, then the status each door answers is exactly what it answered before this change.
- Given `pnpm test` and `pnpm exec tsc --noEmit`, when both run, then they pass with no pre-existing assertion weakened or deleted.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` The new `invalid_input` bullet in `api-reference.md` told an agent to "fix it and resend" — but this door parses only `resolved`/`action` from the body and hands the store the STORED review row, so the offending value is one the caller never sent. Rewritten to say the store refused a value it was given, that the title and question come from the review itself, and that resending unchanged will not clear such a refusal either. The code comment above the rung was brought in line.
  - `[medium]` `[patch]` Both published capacity tokens were asserted only against the constants that produce them — a reviewer mutated `V1_TOO_MANY_PATHS_ERROR` and `V1_LIMIT_REACHED_ERROR` and the entire node project stayed green, so either wire value could change silently, and the rescan row's comment claimed the opposite. Added a doc/wire parity row to `workbench-epic8.test.ts` pinning both constants against their literal strings AND against `api-reference.md`; re-pointed the rescan row's comment at the shape it actually owns.
  - `[low]` `[patch]` `api-reference.md`'s `limit_reached` remedy said "or use a different project" — wrong, since the cap is per workspace owner and another `{id}` resolves within the same principal. Replaced with the accurate remedy, plus the fact that no `/api/v1` route can delete a research project, so it has to be cleared outside the API.
  - `[low]` `[patch]` The rung-order rationale was inverted in two comments ("a suite with only the capacity row would still pass under that swap"). Verified by running the swap: both capacity rows go red and the non-capacity row stays green. Corrected in `reviews/[reviewId]/route.ts` and `epic8-v1-routes.test.ts` — the capacity rows falsify the ordering, the live non-capacity row pins the separate claim that `invalid_input` did not move with the cap.
  - `[low]` `[patch]` `SKILL.md`'s "Limits, and what they mean" is the always-loaded retry guidance and named only the back-off cases. Added one line for the one refusal whose defining property is *do not retry unchanged*.

## Design Notes

**Why the brand, and not a name list.** `isClientInputError` matches on `name`, deliberately (DW-578), so `ResearchProjectCapacityError` — which must carry its own `name` to be distinguishable — would answer `false` and drop the cap onto the 500 fallthrough at `POST /api/research` and every other door in the `isClientInputError` list. Enumerating subclass names inside `errors.ts` puts the list in the wrong module and guarantees drift. An own-property brand set by the base constructor is inherited by every subclass, survives a duplicated module graph exactly as `name` does, and needs no maintenance:

```ts
export class ClientInputError extends Error {
  /** Structural brand: inherited by subclasses, so a subclass that carries its
   *  own `name` is still a caller fault at every door. */
  readonly clientInput = true;
  constructor(message: string) { super(message); this.name = "ClientInputError"; }
}
// isClientInputError: err instanceof Error &&
//   (err.name === "ClientInputError" || (err as { clientInput?: unknown }).clientInput === true)
```
The `name` row stays first and stays pinned: a foreign copy hand-built as `Object.assign(new Error(m), { name: "ClientInputError" })` carries no brand.

**Why the rescan door is not touched behaviourally.** Its `invalid_input` is a genuinely malformed body, and its capacity refusal (`too_many_paths`) is already a separate branch of the same `if` — so "a malformed body and a cap are separable" is already true there. What it lacked was a shared owner for the token; hoisting the literal into `v1-contract.ts` gives the new token something to sit beside without changing a published value. Adding a `ClientInputError` rung to that door's catch is explicitly out of scope: nothing reaches it with one.

**Why the capacity rung goes ABOVE the `isClientInputError` rung.** The capacity error IS a `ClientInputError` by classification — that is the point of the brand — so the generic rung would swallow it and the token would never change. Order is the whole mechanism here. (Corrected at review: this note first claimed a capacity-only suite would still pass under a rung swap. Running the swap disproves it — both capacity rows go red and the `invalid_input` row stays green. The capacity rows falsify the ordering; the live non-capacity row task 9 keeps beside them pins the separate claim that `invalid_input` did not move with the cap.)

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/errors.test.ts src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-route.test.ts src/lib/__tests__/epic8-v1-routes.test.ts src/lib/__tests__/workbench-epic8.test.ts` -- expected: all pass, including the untouched sidecar-parity and skill-pack rows.
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm test` -- expected: the whole two-project run passes.

**Manual checks (if no CLI):**
- Mutation check on the rung order: swap the capacity rung below the `isClientInputError` rung and confirm the new `limit_reached` row fails while the `invalid_input` row stays green; revert.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

The v1 façade can now tell "your body is wrong" from "this workspace is full". `createResearchProject`'s `MAX_PROJECTS` guard throws a distinguishable `ResearchProjectCapacityError` instead of an anonymous `ClientInputError`, and the `deep_research` door gained a capacity rung above its caller-fault rung that answers 400 `limit_reached` with the store's sentence verbatim in `detail`. `V1_LIMIT_REACHED_ERROR` joins the refusal vocabulary in `v1-contract.ts` beside `V1_TOO_MANY_PATHS_ERROR`, the rescan door's existing capacity token hoisted there verbatim so the two caps have one owner — the rescan door's wire output is byte-identical. Every status code is unchanged, and the cap is still a 400 at `POST /api/research` and the ~20 other doors that classify with `isClientInputError`, which is what the new structural brand on `ClientInputError` buys: a subclass carrying its own `name` stays a caller fault without `errors.ts` enumerating subclass names.

### Files changed

- `src/lib/errors.ts` — brands `ClientInputError` with an inherited own property; `isClientInputError` accepts it alongside the existing `name` row.
- `src/lib/research-projects.ts` — adds `ResearchProjectCapacityError` and the structural `isResearchProjectCapacityError`; retypes the one `MAX_PROJECTS` throw, message byte-identical.
- `src/lib/v1-contract.ts` — adds `V1_LIMIT_REACHED_ERROR` and hoists `V1_TOO_MANY_PATHS_ERROR`, documenting the two capacity shapes against `invalid_input`.
- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts` — the capacity rung, above the generic caller-fault rung; the catch comment now reads capacity / caller-input / contention / server.
- `src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts` — emits the hoisted constant; wire value unchanged.
- `skills/work-wiki/api-reference.md` — the `deep_research` two-400s split, the accurate `limit_reached` remedy, and the request-shaped vs workspace-state contrast on the rescan cap.
- `skills/work-wiki/SKILL.md` — one line naming `limit_reached` as the refusal not to retry unchanged.
- `src/lib/__tests__/errors.test.ts` — the subclass and foreign-copy-subclass rows that keep the brand honest.
- `src/lib/__tests__/research-projects.test.ts` — the cap row now pins the thrown type and the message, alongside its original `ClientInputError` claim.
- `src/lib/__tests__/research-route.test.ts` — the non-v1 door still answers 400 when the store throws the typed class.
- `src/lib/__tests__/epic8-v1-routes.test.ts` — capacity / foreign-copy-capacity / malformed-input rows at `deep_research`, and a `too_many_paths` row at rescan.
- `src/lib/__tests__/workbench-epic8.test.ts` — the doc/wire parity row for both published capacity tokens.

### Review findings breakdown

- Patches applied: 5 (medium 2, low 3) — a doc bullet that told an agent to fix a body it never sent; two published wire values asserted only against themselves; a wrong remedy sentence; an inverted rung-order rationale in two comments; and the always-loaded `SKILL.md` missing the no-retry rule.
- Items deferred: 1 (low) — the stored-row `cleanInput` verdict still answers `invalid_input`. See frontmatter `deferred`. Out of this bundle's scope by the intent's own authority: the ledger's second decision option named that case and the human chose option 1, which names only the cap.
- Items rejected: 8 (all low) — the R1 reading that the rescan door should emit the new token (its capacity refusal is already a separate published branch, and `limit_reached` there would either break a wire value or be dead code); a hypothetical subclass of the capacity class defeating its predicate; the generic `clientInput` key colliding with an unrelated error's field; a throwing getter on that key (the same exposure the existing `.name` read already accepts, after the same `instanceof Error` proof); an empty `message` shipping `detail: ""` (unchanged from every sibling branch); rescan's 403-before-cap branch ordering (pre-existing, untouched); the new test mass on `errors.ts` and `POST /api/research` being surfaces the intent never named (they are the only guards that catch a broken brand — proven by mutation); and no single run carrying a real store throw to a v1 response (the link is pinned in two falsifiable halves joined by a typechecked import).
- Follow-up review recommended: **false**. Patched by severity: high 0, medium 2, low 3. No patched finding was high severity.

### Verification performed

- `pnpm exec tsc --noEmit` — clean, exit 0.
- `pnpm exec vitest run --project node errors + research-projects + research-route + epic8-v1-routes + workbench-epic8` — 252 passed, 5 files.
- `pnpm test` — 398 files, 9980 passed, 1 skipped, exit 0.
- Mutation check on the rung order: swapping the capacity rung below the `isClientInputError` rung fails exactly the two capacity rows and leaves the `invalid_input` row green. Reverted; `git diff --stat` confirmed the file returned to its patched state.
- Mutation check on the structural predicate: replacing `isResearchProjectCapacityError`'s `name` check with `instanceof` fails exactly the foreign-copy row and nothing else. Reverted.
- Mutation check on the brand: deleting `clientInput` from `ClientInputError` fails exactly two rows — the `errors.test.ts` subclass row and the `POST /api/research` capacity row — which is the regression it exists to catch. Reverted.
- Mutation check on the published value: setting `V1_LIMIT_REACHED_ERROR` to `"limit_reachedX"` fails the new parity row while `epic8-v1-routes.test.ts` stays entirely green, reproducing the gap that row closes. Reverted.
- Every one of the nine I/O matrix rows is covered by a test that ran and passed; the duplicated-module-graph row needed a new test, which was added at the door rather than at the predicate.

### Residual risks

- `isClientInputError` is now satisfied by any `Error` carrying an own `clientInput === true`, not only by descendants of `ClientInputError`. That widening is deliberate — it is what survives a duplicated module graph, and it is what keeps ~20 doors at 400 — but it is a slightly wider gate than the `name`-only check, and the key is a generic word. No dependency or module in this tree sets it.
- The v1 route rows mock `createResearchProject`, so no single run carries a real `MAX_PROJECTS` refusal onto a v1 response. The chain is pinned in two halves — the store throws the typed class (`research-projects.test.ts`), the door maps that class to the token (`epic8-v1-routes.test.ts`) — joined by a typechecked import; that is this suite's established recipe, not a gap introduced here.
- The implementation agent reported one full-suite run that showed `1 failed | 397 passed` without capturing the test name; three subsequent full runs, plus the two I ran myself, were clean at 398/398. The prior spec in this line recorded a known intermittent wall-clock assertion in `workbench-intake` / `workbench-epic2-routes` (a one-millisecond budget boundary from DW-700), and a review layer independently observed a single flake in that same area during this pass. Unidentified, so not filed as deferred work: it is a flaky timing pin, not a door an owner can hit.
