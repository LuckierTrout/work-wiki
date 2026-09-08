---
title: 'DW-543: address workspace guidance to the human behind an agent handle'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Workspace guidance is still resolved from the raw handle at every prompt
      site outside the merge and ingest doors, so an agent-owned page's action
      and structured-knowledge extraction still reads the agent's own empty
      tenant instead of its human's Purpose and dictionary.
    evidence: |-
      DW-543 scoped the fix to the two doors its `location:` field names, but
      the decision's `reason:` frames the convention as settling guidance
      addressing "for every prompt site at once". A concrete agent-reachable
      path remains: `src/app/api/agents/[id]/ingest/route.ts` sets
      `owner = asOwner ? agentRecord.owner : id` (the agent id) and records it
      as the job/task owner; `src/app/api/tasks/run/route.ts` then derives
      `actionOwner = task.triggeredBy || task.owner || task.author` and hands
      that agent id to `extractActionsFromPage`
      (`src/lib/action-extractor.ts:44`) and `extractStructuredKnowledge`
      (`src/lib/structured-knowledge.ts:310`), each of which calls
      `buildWorkspaceGuidance(owner)` / `listNamesTerms(owner)` unreduced. So
      the same agent-owned page whose ingest prompt now carries alice's
      standards has its follow-on extraction run unguided. Same shape at
      `src/lib/source-monitors.ts:387-388` (`monitor.owner`),
      `src/lib/monitor-digests.ts:437` and `src/lib/action-items.ts:102,180`.
      Not agent-reachable today, and therefore lower priority:
      `src/lib/chat.ts:815-816`, `src/lib/query.ts:238-239`,
      `src/lib/lint.ts:140`, `src/lib/lint-checks.ts:25`.
      `src/lib/agent-runtime.ts:154` is already safe — its `input.owner` is the
      agent's human OWNER by construction. The write path
      (`src/app/api/names-terms/route.ts`) is also unreduced, so a term written
      under an agent-shaped principal would land in a silo nothing now reads.
    location: >-
      src/lib/action-extractor.ts:44 and src/lib/structured-knowledge.ts:310
    severity: low
baseline_revision: '6288b854c707bd6c2498f86bc7b769b5b9bb1255'
---

<intent-contract>

## Intent

**Problem:** At the merge and ingest doors, workspace guidance (the active Wiki's Workspace Purpose + the Names & Terms dictionary) is resolved from the RAW owner handle. `ownerToTenant` does not strip the `--<agent>` suffix, so an agent handle like `alice--yoyo` keys its own empty tenant silo: an agent-owned page folds/ingests with no Workspace Purpose and no dictionary, even though the same-owner guard 40 lines away deliberately collapses `alice--yoyo` onto `alice` via `sameHumanOwner`.

**Approach:** Per the recorded 2026-08-29 decision, guidance is addressed **by human owner**. Promote the handle→human reduction out of its private `ingest.ts` home into the pure `agent-handle.ts` module, and apply it at the two guidance resolution points named by the decision — `merge.ts`'s `guidanceOwner` and the ingest door's owner resolution in `ingest()`. Storage/silo/attribution addressing (`ownerToTenant`, frontmatter `owner`, the concept resolver's same-silo guard, the ingest LLM lock key) is left exactly as it is, and the distinction between the two is named in the modules that hold each function.

## Boundaries & Constraints

**Always:**
- The promoted function is PURE and handle-level: it returns the human SEGMENT of the handle, **unslugified**, and lets `ownerToTenant`/`tenantForOwner` do the storage addressing downstream. Slugifying inside it would repoint guidance for ordinary human handles (`alice_smith` → `alice-smith`, non-CJK unicode handles → `""`), which today resolve correctly.
- `sameHumanOwner`'s observable behavior is preserved: it keeps comparing `slugify(human)` on both sides.
- Every guidance/dictionary consumer inside one `ingest()` call uses the SAME resolved guidance owner, so the shared `GuidanceCache` (tenant-keyed) stays one read and the concept canonicalization reads the same dictionary the prompt carries.
- Guidance stays an ADDITION to a prompt: no new throw path, no change to the existing degrade-to-unguided behavior.

**Block If:** No blocking decisions expected — the ledger decision is explicit.

**Never:**
- Do not change `ownerToTenant`, the frontmatter `owner` written to pages, the ingest dedup/private-page guards, the concept resolver's same-silo scoping, or the `ingest-llm:` durable lock key.
- Do not touch the other prompt sites (`chat.ts`, `query.ts`, `source-monitors.ts`, `agent-runtime.ts`, `lint*.ts`, `action-extractor.ts`, `structured-knowledge.ts`) — each already receives a human handle (`agent-runtime` passes the agent's OWNER), and the decision scopes the change to the merge and ingest doors.
- Do not de-duplicate the other private handle-splitters (`source-cascade.ts`, `agents.ts#agentOwnerHandle`, `vault.ts`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Agent-owned survivor | `alice` has a Wiki Purpose + dictionary; survivor page owner `alice--yoyo`; merge actor `alice--yoyo` | Reconcile system prompt carries alice's WORKSPACE PURPOSE and WORKSPACE NAMES & TERMS | No error expected |
| Agent-handle ingest | `ingest(..., {owner: "alice--yoyo", author: "alice--yoyo"})` | Synthesis/reduce prompts carry alice's Purpose + dictionary; written page frontmatter `owner` stays `alice--yoyo` | No error expected |
| Plain human handle | owner `alice` | Unchanged from today — same tenant, same guidance, same single cached read | No error expected |
| Ownerless survivor | survivor frontmatter has no `owner`; actor `bob--yoyo` | Falls back to the actor, reduced to `bob` | No error expected |
| No human prefix | handle `--yoyo` (degenerate/legacy) | Reduction is not possible; the whole handle passes through unchanged rather than collapsing to `""` | No error expected |

</intent-contract>

## Code Map

- `src/lib/agent-handle.ts` -- pure, client-safe home of the `<owner>--<name>` convention (`isAgentHandle`, `DEFAULT_AGENT_NAME`). New home for the promoted reduction. No imports today — keep it import-free.
- `src/lib/links.ts:130` -- `ownerToTenant`: STORAGE addressing (lowercase + path-sanitize, `DEFAULT_TENANT` fallback). Deliberately unchanged; add the cross-reference naming the distinction.
- `src/lib/ingest.ts:1447` -- private `humanOf` (the thing being promoted); `:1458` `sameHumanOwner` is its only caller.
- `src/lib/ingest.ts:1819` -- `const owner = options?.owner?.trim() || actor` — the ingest door's owner resolution. `owner` is ALSO used for dedup guards (`:1841`, `:1998`), the concept resolver's silo scoping (`:1947`), bookkeeping (`:1865`, `:2340`) and frontmatter (`:2032`, `:2113`) — those must keep the raw handle.
- `src/lib/ingest.ts` guidance consumers to re-point: `runTwoStepSynthesis` call at `:1905` → `synthesizeBody` → `buildIngestSystemPrompt` (`:1326`) and the REDUCE step (`:1757`); the direct `listNamesTerms` concept canonicalization at `:1923`; `reconcilePage` at `:2241` (its own guidance pair at `:1229`).
- `src/lib/ingest.ts:1659` -- `withDurableLock(\`ingest-llm:${input.owner}\`)` inside `runTwoStepSynthesis`: the lock key must keep the RAW handle, so that function needs the two owners separately.
- `src/lib/merge.ts:466` -- `let guidanceOwner = asString(into.frontmatter.owner) ?? asString(actor)`, consumed by the `buildNamesTermsGuidance` probe (`:507`) and `reconcilePage` (`:528`). `asString` (`:85`) never yields `""`.
- `src/lib/__tests__/merge.test.ts:1139` -- `describe("mergePages guides the fold with the survivor owner's workspace standards")`: reusable `seedGuidance`, `seedMergePair`, `reconcileSystemPrompt`, disjoint-vocabulary constants.
- `src/lib/__tests__/ingest.test.ts:4425` -- `describe("ingest resolves workspace guidance once per document")`: reusable wiki/purpose/dictionary fixture, `systemPrompts()`, `countReads()`, `LONG_CONTENT`.
- `src/lib/__tests__/agent-handle.test.ts` -- pure unit tests for the module.

## Tasks & Acceptance

**Execution:**
- `src/lib/agent-handle.ts` -- add exported `humanOwnerOf(handle: string): string` returning everything before the FIRST `--`, and the whole handle when there is no non-empty human prefix (`indexOf("--") <= 0`). Document that it answers "which HUMAN is this?" while `ownerToTenant` answers "which STORAGE SILO is this?" -- gives both doors one pure, client-safe reduction instead of a private copy.
- `src/lib/links.ts` -- extend the `ownerToTenant` doc comment to state it is storage addressing only and does NOT strip the agent suffix, pointing at `humanOwnerOf` for guidance addressing -- names the distinction where the storage function lives, as the decision directs.
- `src/lib/ingest.ts` -- delete the private `humanOf`; express `sameHumanOwner` as `slugify(humanOwnerOf(a)) === slugify(humanOwnerOf(b))` -- promotion without changing the guard.
- `src/lib/ingest.ts` -- in `ingest()`, resolve a `guidanceOwner` from `owner` via `humanOwnerOf` next to the existing `owner` line, with a comment naming why the two differ; pass it (not `owner`) to `runTwoStepSynthesis`, the concept-canonicalizing `listNamesTerms`, and `reconcilePage`. Add a separate `guidanceOwner` field to `runTwoStepSynthesis`'s input so the `ingest-llm:` lock key keeps the raw handle, and rename the guidance-only parameters of `synthesizeBody`, `buildIngestSystemPrompt` and `reconcilePage` to `guidanceOwner` -- one guidance owner per document keeps the shared cache at one read.
- `src/lib/merge.ts` -- reduce the resolved guidance principal through `humanOwnerOf` before the dictionary probe and `reconcilePage`, extending the existing DW-323 comment with the by-human rule -- the survivor's agent handle must read its human's standards.
- `src/lib/__tests__/agent-handle.test.ts` -- unit-test `humanOwnerOf`: agent handle, plain handle, no-human-prefix handle, handle with a second `--`.
- `src/lib/__tests__/merge.test.ts` -- add a case to the guidance describe: seed guidance for `alice`, survivor owned by `alice--yoyo`, and assert the reconcile prompt carries alice's Purpose AND dictionary term/alias.
- `src/lib/__tests__/ingest.test.ts` -- add a case to the guidance describe: ingest as `alice--yoyo` and assert alice's Purpose and dictionary reach the prompts, the dictionary file is read once, and the written page's frontmatter `owner` is still `alice--yoyo`.

**Acceptance Criteria:**
- Given a survivor page owned by an agent handle whose human has a Workspace Purpose and dictionary, when `mergePages` folds into it, then the reconcile system prompt contains the human's Purpose and dictionary block.
- Given an ingest whose `owner` is an agent handle, when the page is written, then its frontmatter `owner`, its silo and its dedup guards are unchanged from the raw-handle behavior while the prompts carry the human's guidance.
- Given a plain human owner handle, when either door runs, then the resolved guidance and the number of guidance file reads are identical to before this change.

## Design Notes

Why the promoted function does NOT slugify (the old `humanOf` did):

```ts
// humanOf (private, comparison key)      humanOwnerOf (promoted, addressing input)
slugify("alice_smith")  === "alice-smith" // ≠ ownerToTenant("alice_smith") = "alice_smith"
slugify("алиса")        === ""            // ≠ ownerToTenant("алиса")       = "алиса"
```

Feeding a slugified handle to `buildWorkspaceGuidance`/`listNamesTerms` would silently repoint (or erase) guidance for handles that resolve correctly today. Keeping the reduction handle-level and letting `ownerToTenant` finish the job means the ONLY behavior change is stripping the `--<agent>` suffix. `sameHumanOwner` keeps its slugify at the comparison site, where a comparison key is what is wanted.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/agent-handle.test.ts src/lib/__tests__/merge.test.ts src/lib/__tests__/ingest.test.ts src/lib/__tests__/links.test.ts` -- expected: all pass, including the three new cases.
- `pnpm test` -- expected: full suite green (no regression in the read-only-door, source-cascade, or authz suites that also reason about owner equivalence).
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Workspace guidance — the active Wiki's Workspace Purpose and the owner's Names & Terms dictionary — is now addressed BY HUMAN at the two doors DW-543 names, while storage addressing is untouched. A handle→human reduction was promoted out of its private `ingest.ts` home into the pure, client-safe `agent-handle.ts` as `humanOwnerOf`, and applied at `merge.ts`'s `guidanceOwner` resolution and at `ingest()`'s owner resolution, from which it is threaded to every guidance consumer in that call (synthesis, the map/reduce REDUCE step, the concept-canonicalizing dictionary read, and reconcile-on-merge). A survivor or an ingest owned by `alice--yoyo` now folds with alice's Purpose and dictionary instead of its own empty tenant.

**Files changed.**
- `src/lib/agent-handle.ts` — new exported `humanOwnerOf`: the human segment before the first `--`, unslugified, passing the whole handle through when there is no usable (non-blank) human prefix or no recoverable human at all.
- `src/lib/links.ts` — `ownerToTenant` doc names the distinction: storage addressing only, deliberately keeps the agent suffix, points at `humanOwnerOf`.
- `src/lib/ingest.ts` — private `humanOf` deleted; `sameHumanOwner` rebuilt on `humanOwnerOf` via a private `ownerClassKey` that preserves its historical equivalence classes exactly; `ingest()` resolves a `guidanceOwner` once and hands it to all four guidance consumers; `runTwoStepSynthesis` carries `owner` (the `ingest-llm:` lock key) and `guidanceOwner` separately; guidance-only parameters of `reconcilePage`, `buildIngestSystemPrompt` and `synthesizeBody` renamed.
- `src/lib/merge.ts` — the winning guidance principal (survivor owner, else actor) is reduced through `humanOwnerOf` before the dictionary probe and the fold.
- `src/lib/wikis.ts` — doc-only: the multi-tenant migration note no longer describes `buildIngestSystemPrompt`'s parameter as possibly an agent handle.
- `src/lib/__tests__/agent-handle.test.ts` — 7 unit cases for `humanOwnerOf`.
- `src/lib/__tests__/ingest.test.ts` — first direct unit tests for `sameHumanOwner` (it had none), plus two agent-handle door cases: a first ingest (prompts, read counts, canonicalized slug/title, unchanged frontmatter `owner`) and a converging second ingest (the reconcile fold).
- `src/lib/__tests__/merge.test.ts` — an agent-owned survivor case and an agent-actor fallback case.

**Review findings breakdown.** 5 patches applied (4 medium, 1 low); 1 item deferred (low); 11 rejected. No intent gaps and no spec defects.

**Follow-up review recommendation: true.** Patched counts: high 0, medium 4, low 1. Score = 3 x 4 + 1 x 1 = 13, which is >= 5.

**Verification performed.**
- `pnpm exec vitest run --project node` over agent-handle / merge / ingest / links: 4 files, 364 tests, all passed.
- `pnpm exec tsc --noEmit`: exit 0, no output.
- `pnpm lint`: exit 0 (only the three pre-existing `jsx-ast-utils` TSNonNullExpression library notices).
- `pnpm test`: 8804 passed, 1 skipped, 1 failed — `storage-fs.test.ts > reapStrandedScratchFiles > stops at STRANDED_SCRATCH_CANDIDATE_CAP`. Confirmed pre-existing and unrelated: with this change stashed, the pristine baseline failed 2 tests on the same run, and the file passes 95/95 in isolation. It plants `STRANDED_SCRATCH_CANDIDATE_CAP + 3` files and does three full reap passes against a 5s default timeout, so it is sensitive to disk/CPU contention under a full-suite run. It imports nothing this change touches.
- Non-vacuity checked by reverting each re-pointed production line individually and confirming the corresponding new assertion fails; `sameHumanOwner`'s preserved classes were checked differentially against the deleted `humanOf` over 584 constructed handles with zero mismatches.

**Residual risks.**
- The reduction lives at the two doors, not inside the prompt builders, so `reconcilePage` and `buildIngestSystemPrompt` — both exported — still resolve whatever principal a future caller passes. Their parameters are now named `guidanceOwner` and documented to say the caller reduces first.
- Guidance at every other prompt site is still raw-handle addressed; recorded in frontmatter `deferred` with the agent-reachable path.
- `sameHumanOwner("--alice", "--bob")` remains true (all human-less handles share one class). That is pre-existing, deliberately unchanged here, and now pinned by a characterization test so a future change to it is visible in a diff.
