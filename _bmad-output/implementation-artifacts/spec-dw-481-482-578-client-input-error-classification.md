---
title: 'Classify caller faults by name, not by message regex or instanceof'
type: 'refactor'
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

**Problem:** Caller-fault classification is decided two unreliable ways. Twenty-three sites decide it with `error instanceof ClientInputError`, the exact mechanism `src/lib/read-only.ts:20-22` documents as unable to survive a duplicated module graph — the 400 silently becomes a 500 in production and no test can see it. Four routes (`src/app/api/monitors/route.ts:53`, `src/app/api/monitors/[id]/route.ts:35`, `src/app/api/system/evaluations/route.ts:58`, `src/app/api/review/proposals/route.ts:78`) instead decide it with a `/required|invalid|…/i` message regex, so a storage `EINVAL: invalid argument` is reported as the caller's mistake and retried forever. Separately, since DW-297 a corrupt research registry throws a plain `Error` that `src/app/api/tasks/run/route.ts:932` calls transient, so a `run-research` task re-delivers three times to the DLQ instead of poisoning on a fault no retry can fix.

**Approach:** Add `isClientInputError(err)` beside the class in `src/lib/errors.ts`, matching on `err.name` exactly as `isReadOnlyError` does, and convert every `instanceof ClientInputError` site to it. Add a `StoredStateError` type there too for "a stored file is not what it should be" and throw it from `parseRegistry`, giving `tasks/run` an explicit store-fault row that poisons at 422 on first delivery. Re-type the caller-fault throws the four regex routes actually reach as `ClientInputError` and delete the regexes, so classification is by type alone.

## Boundaries & Constraints

**Always:** `isClientInputError` and `isStoredStateError` match on `name`, never `instanceof`, and return `false` for non-`Error` values rather than throwing. A `StoredStateError` stays a 500 at every HTTP door (it is a server fault, not the caller's) — its only new consequence is the `tasks/run` poison row. A re-typed throw keeps its exact message; only the constructor changes. Where a shared validator's refusal is re-typed at a feature boundary, the original error rides along as `cause`. Behaviour comments in touched files must be updated to match the new code.

**Block If:** Re-typing a throw in `source-monitors.ts`, `retrieval-evals.ts` or `memory-proposals.ts` would change the status any route OTHER than the four named above answers — those routes are out of scope and must keep their current status for every input.

**Never:** Do not change `validateSlug` (`src/lib/wiki.ts:183`) or `validateUrlSafety` (`src/lib/url-safety.ts:101`) themselves — 55+ call sites classify their refusals differently, and re-typing them repo-wide is a separate change; wrap them at the feature boundary instead. Do not re-type `ResearchLeaseError` or any other lease/runtime fault as a store fault — a busy lease is genuinely transient and must keep retrying. Do not convert throws on paths the four in-scope routes cannot reach (the monitor RUN path, proposal apply/revise). Do not change any status code a passing test currently pins. Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Foreign-copy client fault | A `ClientInputError`-shaped error from a SECOND module copy (`instanceof` false, `name` equal) | `isClientInputError` returns `true`; the route answers 400 | Classified by type |
| Message impostor | Plain `Error("EINVAL: invalid argument, open '…'")` from storage | `isClientInputError` returns `false`; monitors/evaluations/proposals routes answer 500 | Server fault, retryable |
| Non-Error thrown value | `null`, `undefined`, `"ClientInputError"`, `{ name: "ClientInputError" }` | Both predicates return `false` | No throw from the predicate |
| Monitor create, blank name | `POST /api/monitors` with `name: "   "` | 400, message unchanged ("Monitor name is required") | `ClientInputError` |
| Monitor create, unsafe URL | `POST /api/monitors` with `url: "http://127.0.0.1/"` | 400, `validateUrlSafety`'s message unchanged | `ClientInputError` wrapping the original as `cause` |
| Eval save, no cases yet | `POST /api/system/evaluations` `{action:"run"}` with zero cases | 400 ("Add at least one retrieval evaluation case first") | `ClientInputError` |
| Proposal create, no-op edit | `POST /api/review/proposals` whose content equals the page | 400 ("The proposal does not change the page") | `ClientInputError` |
| Corrupt registry, task door | `run-research` task; registry JSON is an object | 422 on the FIRST delivery — poisoned, not retried | `StoredStateError` |
| Corrupt registry, HTTP door | `GET /api/research` with the same registry | 500, message unchanged | `StoredStateError` is not a client fault |
| Transient task failure | `run-research` rejects with a plain `Error("provider timeout")` | 500 — still retried | Unchanged control case |

</intent-contract>

## Code Map

- `src/lib/errors.ts:21` -- `ClientInputError`; the new `isClientInputError` and `StoredStateError`/`isStoredStateError` go here. Zero-dependency module, safe for every importer.
- `src/lib/read-only.ts:367-379` -- `isReadOnlyError`, the exact predicate shape and doc-comment rationale to mirror.
- `src/lib/__tests__/read-only-kernel-gate.test.ts:728-777` -- the four-case "classifies structurally, not by identity" pin (foreign copy / real one / message impostor / non-Error) to mirror for the new predicates.
- 23 `instanceof ClientInputError` sites to convert: `src/app/api/{ingest/route.ts:239, ingest/document/route.ts:193, ingest/image/route.ts:209, ingest/pdf/route.ts:193, research/route.ts:156, research/[id]/route.ts:99,121, research/[id]/run/route.ts:109, tasks/run/route.ts:884,922, v1/projects/[wikiId]/reviews/[reviewId]/route.ts:167, wikis/route.ts:97, wikis/[id]/route.ts:52,91, wikis/current/route.ts:52, wikis/[id]/template/route.ts:55, workbench/intake/route.ts:115, workbench/artifact/route.ts:87, workbench/artifact/revisions/route.ts:184, workspace-profile/route.ts:210}` and `src/lib/document-extract.ts:442,929,970`. `research/[id]/run/route.ts:109` sits in a chain with four OTHER classes — convert only the `ClientInputError` arm.
- `src/lib/research-projects.ts:322-347` -- `parseRegistry`; its three throws become `StoredStateError`. The doc comment above it currently says "The throw is a plain `Error` on purpose" — rewrite that paragraph.
- `src/app/api/tasks/run/route.ts:916-932` -- the classifier tail: `/not found/i` → 422, `ClientInputError` → 422, ingest-exhausted → 422, else 500. The store-fault row goes beside the `ClientInputError` row (no staged-key cleanup — a store fault stages nothing).
- `src/lib/source-monitors.ts:104` (`monitorPath` id check), `:123-126` (`cleanThreshold`), `:228-235` (`createSourceMonitor` validators + name/cadence), `:239-241` (owner cap), `:277-291` (`updateSourceMonitor` name/cadence/state) -- the throws the two monitor routes reach. `:405,423,424,447` are the RUN path; leave them.
- `src/lib/retrieval-evals.ts:98` (label/question), `:99` (`validateSlug` loop), `:146` (no cases) -- everything `POST /api/system/evaluations` reaches.
- `src/lib/memory-proposals.ts:171` (`validateSlug`), `:176-194` -- everything `createMemoryChangeProposal` reaches. `:306,349-366,402-415` are revise/apply; leave them.
- `src/lib/__tests__/source-scan.ts:100` -- `walkFiles(dir, { include, skipDirs })`, basename-matched, `__tests__`/`node_modules` excluded; the shared walker the new repo-wide scan must use (AGENTS.md forbids hand-rolling one, and requires a member pin plus a count floor).
- `src/lib/__tests__/research-route.test.ts` -- the recipe for a route-classification suite (mock `@/lib/auth` + the store module, import the handler directly, assert status by thrown type).
- `src/lib/__tests__/tasks-route.test.ts:~118` -- the `run(body, headers)` helper and mock block; `@/lib/research-runtime` is NOT yet mocked and the route imports only `runResearchProject` from it.
- `src/lib/__tests__/errors.test.ts` -- current `getErrorMessage`/`isEnoent` suite; the predicate pins belong here.

## Tasks & Acceptance

**Execution:**
- `src/lib/errors.ts` -- give `ClientInputError` an optional `ErrorOptions` second parameter (so a wrapped refusal keeps its `cause`); add `isClientInputError`; add `StoredStateError` + `isStoredStateError`. Each predicate carries the `isReadOnlyError`-style comment naming the duplicated-module-graph failure -- one owner for both checks, reachable from every layer.
- `src/lib/research-projects.ts` -- throw `StoredStateError` from `parseRegistry`'s three refusals (keeping the `SyntaxError` `cause`), and rewrite the "plain `Error` on purpose" paragraph to state the new type, that it is still a 500 at HTTP doors, and that the task door now poisons on it -- the fault is repairable but not retryable.
- `src/app/api/tasks/run/route.ts` -- convert both `instanceof` sites to `isClientInputError`; add a store-fault row returning 422 before the trailing 500, with a comment naming the DLQ round-trip it removes.
- `src/app/api/{ingest,ingest/document,ingest/image,ingest/pdf,research,research/[id],research/[id]/run,v1/projects/[wikiId]/reviews/[reviewId],wikis,wikis/[id],wikis/current,wikis/[id]/template,workbench/intake,workbench/artifact,workbench/artifact/revisions,workspace-profile}/route.ts` -- convert every `instanceof ClientInputError` to `isClientInputError(...)` and fix the imports -- mechanical, no status changes.
- `src/lib/document-extract.ts` -- convert the three `instanceof ClientInputError` sites (`:970` keeps its message test alongside the predicate) -- same reason, and this module is reachable from the sidecar.
- `src/lib/source-monitors.ts` -- re-type the caller-fault throws the two monitor routes reach as `ClientInputError`, wrapping `validateUrlSafety`/`validateSlug` at `createSourceMonitor` with the original as `cause` -- the shared validators serve 55+ call sites and cannot be re-typed globally here.
- `src/lib/retrieval-evals.ts` -- re-type the label/question refusal, the `validateSlug` loop (wrapped) and the "add at least one case" refusal.
- `src/lib/memory-proposals.ts` -- re-type the `createMemoryChangeProposal` refusals and wrap its `validateSlug`.
- `src/app/api/monitors/route.ts`, `src/app/api/monitors/[id]/route.ts`, `src/app/api/system/evaluations/route.ts`, `src/app/api/review/proposals/route.ts` -- replace each status regex with `isClientInputError(error) ? 400 : 500`; the `[id]` route is included because it shares `updateSourceMonitor`/`cleanThreshold` with the POST door, so leaving its regex would strand a dead matcher over now-typed throws.
- `src/lib/__tests__/errors.test.ts` -- pin both predicates on the four cases (foreign copy, real one, message impostor, non-Error), and add a `walkFiles` scan asserting no `instanceof ClientInputError` survives under `src/` outside `errors.ts`, with a member pin plus a count floor per AGENTS.md.
- `src/lib/__tests__/client-input-classification-routes.test.ts` (new, `node` project) -- pin the four re-typed routes: a `ClientInputError` is 400, a plain `Error` whose message says "invalid"/"required" is 500.
- `src/lib/__tests__/tasks-route.test.ts` -- mock `@/lib/research-runtime` and pin the `run-research` store fault at 422 on the first delivery, with a plain-`Error` control still at 500.

**Acceptance Criteria:**
- Given a `ClientInputError` produced by a second copy of `errors.ts` (so `instanceof` is false), when any converted route catches it, then it answers 400 rather than 500.
- Given `src/` on disk, when the scan in `errors.test.ts` runs, then no file outside `src/lib/errors.ts` contains `instanceof ClientInputError`, and the scan reports it walked at least a floor number of files including a named real file per subtree.
- Given a corrupt research registry, when a `run-research` task is delivered for the first time, then `POST /api/tasks/run` answers 422 and the queue does not re-deliver it.
- Given the same corrupt registry, when `GET /api/research` is called, then it still answers 500 with an unchanged message.
- Given `pnpm test`, when the full suite runs after the change, then every previously passing assertion still passes.

## Design Notes

`isClientInputError` is the same three-line shape as `isReadOnlyError`, for the same reason and with the same failure it defends against:

```ts
export function isClientInputError(err: unknown): boolean {
  return err instanceof Error && err.name === "ClientInputError";
}
```

The boundary wrap keeps the shared validators untouched while the door still classifies by type:

```ts
try {
  validateUrlSafety(input.url);
  validateSlug(input.targetSlug);
} catch (error) {
  // These validators serve 55+ call sites whose doors classify differently, so
  // they stay plain. Here the input is unambiguously the caller's.
  throw new ClientInputError(getErrorMessage(error), { cause: error });
}
```

`StoredStateError` is deliberately NOT a `ClientInputError`: a wrong-shaped stored file is the server's fault and must stay a 500 at every HTTP door. What it buys is the one classification `tasks/run` was missing — a fault that is repairable but not retryable, so the queue should stop rather than spend three deliveries reaching the DLQ.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/errors.test.ts src/lib/__tests__/client-input-classification-routes.test.ts src/lib/__tests__/tasks-route.test.ts` -- expected: all pass, including the new predicate, scan, route and poison pins.
- `pnpm exec vitest run --project node src/lib/__tests__/research-route.test.ts src/lib/__tests__/research-run-route.test.ts src/lib/__tests__/research-projects.test.ts src/lib/__tests__/source-monitors.test.ts src/lib/__tests__/retrieval-evals.test.ts src/lib/__tests__/memory-proposals.test.ts src/lib/__tests__/wikis-routes.test.ts src/lib/__tests__/ingest-routes.test.ts src/lib/__tests__/workspace-profile-routes.test.ts src/lib/__tests__/epic8-v1-routes.test.ts` -- expected: unchanged, all pass.
- `pnpm test` -- expected: full suite green.
- `pnpm lint` -- expected: clean.
