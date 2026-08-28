---
title: 'Read-only kernel guards for the research, Names & Terms and email-ingest stores'
type: 'bugfix'
created: '2026-08-28'
status: 'done'
baseline_revision: '9312ba420b3bd738a6bd52aede3261627c00db41'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: "The `dom` vitest project is red at BASELINE — 13 files / 229 tests fail with `TypeError: Cannot read properties of undefined (reading 'clear')` on `window.localStorage`. Unrelated to this change and out of this bundle's scope, but it means `pnpm test` (both projects) cannot pass on this tree."
    evidence: "`pnpm exec vitest run --project dom` reports 13 failed files / 229 failed tests both WITH this change and with the whole change stashed (`git stash push -u -- src _bmad-output`), at HEAD 9312ba420b3bd738a6bd52aede3261627c00db41. The `node` project is 277 files / 6843 pass / 0 fail with this change."
    location: "vitest dom project setup"
    severity: medium
  - summary: >-
      The research, Names & Terms and email-ingest route catches now classify a
      mid-request-flip `ReadOnlyError` as 400 or 500 instead of 403.
    evidence: |-
      Gating the kernel writers created a path these catches never saw before.
      `POST /api/names-terms` (route.ts:48-53) and `PUT /api/names-terms/[id]`
      ([id]/route.ts:39-46) map any thrown error to 400/409, so a refusal would
      be answered as a client-input error carrying the read-only sentence;
      `DELETE /api/names-terms/[id]`, `PUT /api/email/settings` and
      `POST /api/research` map it to 500. Reachable only if YOPEDIA_READONLY
      changes between the route's isReadOnly() gate and the kernel call, so the
      write is still refused and the copy is still right — only the status is
      wrong. The repo already has the fix shape at
      `src/app/api/ingest/reingest/route.ts:90` ("Backstop for a flag that
      flipped mid-request"). Same class: the Review-accept door
      (`src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts`) gates
      early with `reviewQueue` but its `isReadOnlyError` catch now surfaces
      `researchCreate`, so one door can state two sentences.
    location: >-
      src/app/api/names-terms/route.ts:48
    severity: low
  - summary: >-
      The research CAS primitives stay writable by a direct library caller, so
      DW-385's guarantee has a named hole at `PATCH /api/research/[id]`'s writer.
    evidence: |-
      `applyResearchProjectMutation`, `mutateResearchProject`,
      `updateResearchProjectIf` and `updateResearchProject` are deliberately
      ungated because several `research-runtime`/`research-completion` callers
      read a `null` return as "lost the CAS race" and compensate; a throw would
      strand a run. But `updateResearchProjectIf` is also what
      `src/app/api/research/[id]:58` calls to edit an owner's title, question
      and queries, so a CLI/MCP/agent-runtime caller can still patch a project's
      fields on a read-only deployment. Closing it needs a non-throwing refusal
      path for the fail-soft callers — a larger change than a gate. Recorded in
      the `applyResearchProjectMutation` docstring.
    location: >-
      src/lib/research-projects.ts:228
    severity: medium
  - summary: >-
      `reconcileResearchProjects` would relabel a read-only refusal as a damaged
      project.
    evidence: |-
      `src/lib/research-runtime.ts:578,648,662` call the newly gated
      `deleteResearchProject` inside a per-project try whose catch logs
      "reconcile skipped damaged project <id>". A `ReadOnlyError` arriving there
      is logged as data damage. Unreachable today — `GET /api/research` skips
      reconciliation when read-only and `POST /api/tasks/run` refuses — so no
      gate or catch was added, but the log line would mislead an operator if a
      future caller drives reconcile on a read-only deployment.
    location: >-
      src/lib/research-runtime.ts:578
    severity: low
---

<intent-contract>

## Intent

**Problem:** DW-314 moved the read-only refusal into the wiki KERNEL precisely because a route gate cannot reach a CLI, MCP or agent-runtime caller. Three stores were left behind: `createResearchProject`, `deleteResearchProject`, `createNamesTerm`/`updateNamesTerm`/`deleteNamesTerm` and `saveEmailIngestConfig` carry HTTP gates only, so a direct library call writes them on a read-only deployment (DW-385).

**Approach:** Open each of those six writers with `assertWritable(READ_ONLY_REFUSAL.<existing sentence>)`, ahead of any lock or fence, and pin with a no-route suite that a direct library call throws `ReadOnlyError` and leaves the stored bytes identical. Amend the four route comments that today assert their store "reaches no kernel writer and refuses nothing of its own".

## Boundaries & Constraints

**Always:**
- Reuse the `READ_ONLY_REFUSAL` sentences that already exist: `researchCreate` for create, `researchMutate` for delete, `namesTerms` for all three dictionary writers, `emailSettings` for the email config. No new keys — the parity suite already pins these four against their route literals.
- The gate is the writer's FIRST statement, ahead of `withFileLock` / `withResearchProjectLifecycleFence`, matching the "gate before the lock" rule `read-only-kernel-gate.test.ts` pins for `wikis.ts`.
- Every route keeps its early `isReadOnly()` gate; the kernel gate is added BESIDE it, never instead of it.
- A comment that states a now-false fact is amended in place, not left standing.

**Block If:**
- Gating a writer turns an existing suite red in a way that shows a live READ path writes on a read-only deployment (a real behavioural dependency, not a dead branch).

**Never:**
- Do not gate the research CAS primitives `applyResearchProjectMutation`, `mutateResearchProject`, `updateResearchProjectIf` or `updateResearchProject`. They are an in-flight run's own progress recorders, reached only from `research-runtime`/`research-completion` behind doors that already refuse, and `GET /api/research` already skips reconciliation entirely when read-only. Several of their callers read a `null` return as "lost race"; a throw there would change fail-soft compensation into a stranded run.
- Do not add `isReadOnlyError → 403` classification branches to routes (DW-316's bundle), read-only affordances to client components (DW-386), or new `READ_ONLY_REFUSAL` keys (DW-387).
- Do not widen `read-only-door-coverage.test.ts`'s `KERNEL_WRITERS` registry (DW-388's bundle) — it is a hand-named list scoped to the four page/artifact writers and stays green either way.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Direct library write, read-only | `YOPEDIA_READONLY=1`; call `createResearchProject`, `deleteResearchProject`, `createNamesTerm`, `updateNamesTerm`, `deleteNamesTerm` or `saveEmailIngestConfig` | Throws `ReadOnlyError` with that door's `READ_ONLY_REFUSAL` sentence; the data dir is byte-identical afterwards | `err.name === "ReadOnlyError"`, so `isReadOnlyError` matches across module copies |
| Direct library write, writable | `YOPEDIA_READONLY` unset | Creates, updates and deletes exactly as before | No error expected |
| Delete under read-only | `YOPEDIA_READONLY=1`, `deleteResearchProject` | Refuses before `withResearchProjectLifecycleFence`, so no lease is taken and no slot is read | Refusal, not a lock timeout |
| Read paths under read-only | `YOPEDIA_READONLY=1`; `listResearchProjects`, `listNamesTerms`, `loadEmailIngestConfig`, `expandQueryWithNamesTerms` | Unchanged — reads never touch a gate | No error expected |

</intent-contract>

## Code Map

- `src/lib/read-only.ts:94-238` -- `READ_ONLY_REFUSAL`. `researchCreate` (:190), `researchMutate` (:199), `namesTerms` (:213), `emailSettings` (:220) already exist with the right wording; only the module docstring at :24-69 needs a sentence recording that these three stores now gate in the kernel too.
- `src/lib/research-projects.ts:303` `createResearchProject` -- opens with `cleanInput(input)` then `lockedMutation`. `:500` `deleteResearchProject` -- opens with `withResearchProjectLifecycleFence` (a `withDurableLock`, which writes a lease file under `locks-v2/` on the R2 provider), so the gate must precede it. `:228` `applyResearchProjectMutation` is the single CAS byte-writer and stays OPEN by decision above.
- `src/lib/names-terms.ts:321/:345/:367` -- `createNamesTerm`/`updateNamesTerm`/`deleteNamesTerm`, each `withFileLock(lockKey(owner), …)`. `:179` `writeEntries` is the one private byte writer they share; the three entry points gate ahead of the lock instead, mirroring `wikis.ts`.
- `src/lib/email-ingest.ts:106` `saveEmailIngestConfig` -- the store's only writer (`putIndex`). Module imports only `./storage` today.
- `src/app/api/research/route.ts:65-72` -- the POST comment asserts `createResearchProject` "reaches none [no kernel writer]"; now false. `src/app/api/names-terms/route.ts:30-35` ("the store this reaches is not a kernel writer and refuses nothing of its own"), `src/app/api/email/settings/route.ts:53-58` ("reaches no kernel writer and so refuses nothing of its own") -- same. `src/app/api/research/[id]/route.ts:85-90` (DELETE → `retireResearchProject` → `deleteResearchProject`) has no such claim and needs no edit.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` -- the no-route suite and its idioms to reuse: `snapshot()` (:91), `expectRefusal()` (:141), the `ENV_KEYS`/`_resetStorage`/`_resetLocks` harness (:47-82), and the source-order case "the read-only gate precedes the wiki lock" (:520).
- `src/lib/__tests__/read-only-door-coverage.test.ts:34-111` -- `KERNEL_WRITERS`/`WRITER_MODULES` are hand-named and exclude these three modules, so the scan is unaffected. Confirms no registry edit is owed here.
- `src/lib/__tests__/names-terms-routes.test.ts:120-140`, `email-settings-route.test.ts:95-125`, `research-route.test.ts:85-120` -- existing route-level 403 suites; they set `YOPEDIA_READONLY` and must stay green unmodified (the routes gate before the kernel, so nothing reaches the new throw).

## Tasks & Acceptance

**Execution:**
1. `src/lib/research-projects.ts` -- import `assertWritable`/`READ_ONLY_REFUSAL` from `./read-only`; open `createResearchProject` with `assertWritable(READ_ONLY_REFUSAL.researchCreate)` and `deleteResearchProject` with `assertWritable(READ_ONLY_REFUSAL.researchMutate)`, both as the first statement; add a short comment on `applyResearchProjectMutation` recording why the CAS primitives are deliberately left open.
2. `src/lib/names-terms.ts` -- same import; open `createNamesTerm`, `updateNamesTerm` and `deleteNamesTerm` with `assertWritable(READ_ONLY_REFUSAL.namesTerms)` ahead of `withFileLock`, so a refused call does not queue behind the tenant's in-flight dictionary work.
3. `src/lib/email-ingest.ts` -- same import; open `saveEmailIngestConfig` with `assertWritable(READ_ONLY_REFUSAL.emailSettings)`.
4. `src/lib/read-only.ts` -- amend the module docstring to record that the research, Names & Terms and email-ingest stores now carry the refusal in the kernel as well as at their doors (DW-385), so the "four kernel writers" narrative does not read as the complete list.
5. `src/app/api/research/route.ts`, `src/app/api/names-terms/route.ts`, `src/app/api/email/settings/route.ts` -- amend the three read-only gate comments: the gate stays for the reason it was added (refuse before the parse, so a malformed body cannot pre-empt the refusal), but it is no longer the only refusal behind the door.
6. `src/lib/__tests__/read-only-store-gate.test.ts` (new, node project) -- for each of the six writers: with `YOPEDIA_READONLY=1`, assert `isReadOnlyError`, the exact sentence, and a byte-identical data-dir snapshot; plus a writable control case that each writer still works, and a source-order case asserting `assertWritable` precedes `withFileLock`/`withResearchProjectLifecycleFence` in each writer's own body.

**Acceptance Criteria:**
- Given a `src/lib` caller with no route in front and `YOPEDIA_READONLY=1`, when it calls any of the six gated writers, then it receives a `ReadOnlyError` and the store file is unchanged on disk.
- Given the same call with the flag unset, when it runs, then the store is written exactly as before this change.
- Given `pnpm test` and `pnpm lint`, when both run, then both pass with no pre-existing suite loosened or rewritten to accommodate the new throw.

## Spec Change Log

## Review Triage Log

### 2026-08-28 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 1, low 7)
- defer: 3: (high 0, medium 1, low 2)
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[medium]` `[patch]` `retireResearchProject` tombstoned the project through the ungated CAS mutator and only then reached the gated `deleteResearchProject`, so a no-route caller on a read-only deployment left a `cancelled` / "Deleted." row behind plus an error. Gated the entry point in `src/lib/research-runtime.ts` and added a refusal + byte-snapshot case; confirmed the case fails without the gate.
  - `[low]` `[patch]` The delete case's "no lease was taken" claim was vacuous — `withDurableLock` short-circuits off R2, so no lease is written either way on the fs provider. The case now calls `_setDurableLocksForTests(true)` and a control asserts the fence really writes under `locks-v2/`.
  - `[low]` `[patch]` The three new gate comments asserted a CLI/MCP/agent-runtime caller set that does not exist in this repo. Rewritten to `read-only.ts`'s honest DW-266/DW-314 form: today the routes are the only callers, the gate is for the caller added next.
  - `[low]` `[patch]` Three test docstrings still said the store "reaches no kernel writer and refuses nothing of its own". Amended in `names-terms-routes.test.ts`, `research-route.test.ts`, `email-settings-route.test.ts`; no assertion touched.
  - `[low]` `[patch]` The `applyResearchProjectMutation` exemption note claimed the CAS wrappers are reached only from the runtime; `PATCH /api/research/[id]` calls `updateResearchProjectIf`. Corrected, and the residual gap is now named in the docstring.
  - `[low]` `[patch]` `snapshot()`'s `walk` swallowed every `readdir` failure, so a broken walk would have made every byte-identity assertion pass vacuously. Catch narrowed to ENOENT, plus a `seededSnapshot()` helper that asserts non-empty.
  - `[low]` `[patch]` `saveEmailIngestConfig` was tested only as an overwrite; added the first-ever-save refusal case, so a gate that fired only when a config already existed cannot pass.
  - `[low]` `[patch]` The CAS exemption was pinned only by the absence of a substring. Added a behavioural control that `updateResearchProjectIf` still writes with the flag set, plus the missing close-bound guard; verified that gating indirectly inside `lockedMutation` fails the behavioural case while the textual one stays green.

## Design Notes

**Why sentences are reused, not added.** `read-only-copy-parity.test.ts:269-272` already pins `researchCreate`, `namesTerms` and `emailSettings` against the literal each route serves. Gating the kernel with the same constant means route and writer state one sentence for one deployment state — the property `read-only.ts` exists to hold — and adds nothing new for the parity suite to keep in step.

**Why the gate precedes the lock.** The byte snapshots cannot see this: a gate inside `withFileLock` refuses just as loudly and leaves the same bytes, while having queued the refusal behind every in-flight write for the tenant. For `deleteResearchProject` it is stronger than style — `withResearchProjectLifecycleFence` is a `withDurableLock`, which takes a CAS lease (a written object on R2) before the callback runs.

```ts
export async function createNamesTerm(owner, input) {
  assertWritable(READ_ONLY_REFUSAL.namesTerms);
  return withFileLock(lockKey(owner), async () => { /* unchanged */ });
}
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-store-gate.test.ts` -- expected: pass, every case present.
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/names-terms-routes.test.ts src/lib/__tests__/email-settings-route.test.ts src/lib/__tests__/research-route.test.ts` -- expected: pass, unmodified.
- `pnpm exec vitest run --project node` -- expected: full pass (277 files, 6843 tests).
- `pnpm lint` and `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm exec vitest run --project dom` -- expected: UNCHANGED from baseline. The dom project is red before this change (13 files / 229 tests, `window.localStorage` undefined) and this change touches no `.test.tsx`; compare against a stashed tree rather than expecting green. Recorded in frontmatter `deferred`.

## Auto Run Result

Status: done
Bundle: `read-only-kernel-guards` (DW-385), run `20260828-155008-5277`.

**Implemented.** Seven writers across four modules now open with `assertWritable`, so a caller with no route in front is refused on a read-only deployment — DW-314's argument applied to the three stores it left out. Sentences are reused, not invented: `researchCreate`, `researchMutate`, `namesTerms`, `emailSettings` are the same constants the routes already serve, so one deployment state still reads as one sentence whichever way the caller arrived. Every route keeps its early `isReadOnly()` gate; the kernel gate is beside it, not instead of it. The research CAS primitives are deliberately left open and the cost of that is named in code and in `deferred` below.

**Files changed**
- `src/lib/research-projects.ts` -- gate `createResearchProject` (`researchCreate`) and `deleteResearchProject` (`researchMutate`, ahead of the durable-lock fence); docstring on `applyResearchProjectMutation` recording why the CAS primitives stay open and what that costs.
- `src/lib/research-runtime.ts` -- gate `retireResearchProject` (`researchMutate`) as its first statement, so the tombstone it writes before the delete cannot land on a refused deployment.
- `src/lib/names-terms.ts` -- gate `createNamesTerm`/`updateNamesTerm`/`deleteNamesTerm` (`namesTerms`) ahead of `withFileLock`.
- `src/lib/email-ingest.ts` -- gate `saveEmailIngestConfig` (`emailSettings`), the store's only writer.
- `src/lib/read-only.ts` -- module docstring: "the four kernel writers" is DW-188's starting set, not the whole list.
- `src/app/api/research/route.ts`, `src/app/api/names-terms/route.ts`, `src/app/api/email/settings/route.ts` -- comment-only: the HTTP gate now exists for ORDER (refuse before the body parse), not because nothing behind it refuses.
- `src/lib/__tests__/read-only-store-gate.test.ts` (new, 16 cases) -- the no-route suite: seven refusals with whole-tree byte snapshots, read paths unaffected, writable controls, source-order pins, and a behavioural control that the exempt CAS primitives still write.
- `src/lib/__tests__/names-terms-routes.test.ts`, `research-route.test.ts`, `email-settings-route.test.ts` -- comment-only: docstrings amended where they stated the now-false fact.

**Review findings:** 8 patched (1 medium, 7 low), 3 deferred, 4 rejected, 0 intent gaps, 0 spec repairs.

**Follow-up review recommended: true.** Patched counts: high 0, medium 1, low 7. Score = 3x1 + 7 = 10, at or above the threshold of 5.

**Verification**
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-store-gate.test.ts` -- 16/16 pass.
- `pnpm exec vitest run --project node` -- 277 files, 6848 pass / 1 skipped / 0 fail.
- `pnpm lint` -- exit 0. `pnpm exec tsc --noEmit` -- exit 0.
- `pnpm exec vitest run --project dom` -- 13 files / 229 tests fail, IDENTICAL to baseline with the whole change stashed. Pre-existing `window.localStorage` breakage, unrelated to this change (which touches no `.test.tsx`); recorded in `deferred`.
- Mutation checks run during the patch pass: removing the `retireResearchProject` gate, moving `assertWritable` inside the delete fence, and gating the CAS primitives indirectly inside `lockedMutation` each turn the intended case red.

**Residual risks**
- The three deferred entries above: the mid-request-flip status classification, the CAS-primitive hole at `PATCH /api/research/[id]`'s writer, and reconcile's "damaged project" log line.
- `read-only-door-coverage.test.ts` still registers only the four page/artifact kernel writers, so a FUTURE route importing `createNamesTerm`, `createResearchProject` or `saveEmailIngestConfig` with neither treatment stays invisible to that scan. Already open in the ledger as DW-388; not widened here.
