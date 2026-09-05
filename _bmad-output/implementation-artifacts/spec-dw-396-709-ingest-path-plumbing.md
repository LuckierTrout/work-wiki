---
title: 'DW-396 / DW-709: compile-enforce the ingest queue payload and address guidance by human owner at the remaining prompt sites'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `humanOwnerOf` reduces on the first `--` without checking that the prefix
      names a registered agent owner, so a human handle that itself contains
      `--` resolves its Workspace Purpose and Names & Terms from a different
      person's tenant.
    evidence: |-
      `humanOwnerOf` (`src/lib/agent-handle.ts:91`) returns everything before
      the first `--` whenever that segment is non-blank. Principal handles come
      from a Clerk username, an X handle, or a raw Clerk id
      (`src/lib/auth.ts:136-148`); X handles cannot contain `-` and Clerk ids do
      not, but nothing in the repo constrains a Clerk username, so a user
      `jean--luc` reads tenant `jean`'s Purpose and dictionary. A
      punctuation-only prefix (`.--yoyo`, `/--yoyo`) passes the blank check too
      and then collapses to the DEFAULT tenant through `ownerToTenant`, handing
      the default silo's guidance to an unrelated handle. The ambiguity is
      pre-existing at the labelling level (`isAgentHandle` treats any `--` as an
      agent) and was introduced for guidance by DW-543 at the merge and ingest
      doors; DW-709 did not widen the class, only the number of sites where its
      consequence is reachable. Consequence is a wrong answer, not a leak of
      stored pages: guidance is prompt text, and every storage/attribution path
      still uses the raw handle.
    location: >-
      src/lib/agent-handle.ts:91
    severity: low
baseline_revision: 'bb347287aaf9ad685dcfc16163ce0db0cc5ac869'
---

<intent-contract>

## Intent

**Problem:** Two ingest-path plumbing assumptions are held up only by convention. (DW-396) `IngestOptions.guidanceCache` is a live, non-serializable pair of `Map`s; the only thing keeping it off a queue message is that every route hand-writes its `enqueueTask` literal, plus one runtime assertion in a test — TypeScript does not excess-property-check spreads, so `enqueueTask({ kind: "ingest", ...ingestOptions })` compiles and fails at structured-clone time. (DW-709) DW-543 reduced the guidance principal to the human owner at the merge and ingest doors only, so an agent-owned page (`alice--yoyo`) still runs its follow-on action extraction, structured-knowledge extraction, monitor redraft, digest rendering and action-item canonicalization against the agent's own empty tenant instead of alice's Purpose and dictionary.

**Approach:** Give the `kind: "ingest"` variant of `Task` a `guidanceCache?: never` so spreading a live handle onto a queue payload is a compile error, and pin that with a `@ts-expect-error` test beside the existing runtime assertion. Then apply the already-promoted pure `humanOwnerOf` at each of the six remaining guidance-resolution sites — and only there — leaving every storage/attribution use of the same handle raw.

## Boundaries & Constraints

**Always:**
- The reduction is applied ONLY where the handle addresses GUIDANCE (`buildWorkspaceGuidance`, `buildNamesTermsGuidance`, `listNamesTerms` feeding a prompt or a `canonicalizeNamesTerm`/`applyNamesTermsToGeneratedText` call). Every storage/addressing/attribution use of the same handle in those functions (`tenant()`, `ownerTenant()`, `lockKey()`, `readItems`, `proposeActionItems`, `getSourceMonitor`, `getMonitorDigest`, the page-owner guard, the written `owner` field) keeps the RAW handle.
- Reduce ONCE per function, into a named local (e.g. `guidanceOwner`), and use it for every guidance consumer in that function so the site reads as one decision.
- `humanOwnerOf` is imported from `./agent-handle` — do not re-derive, re-implement, or slugify it at the call sites.
- Guidance stays an ADDITION to a prompt: no new throw path, no change to existing degrade-to-unguided behavior, no change to any function signature.
- `guidanceCache?: never` documents WHY in place (a live handle must not cross the queue; a queued task is a different request and resolves guidance fresh).

**Block If:** No blocking decisions expected — both ledger entries name the fix and the sites.

**Never:**
- Do not touch the guidance sites DW-709 explicitly leaves out: `src/lib/chat.ts`, `src/lib/query.ts`, `src/lib/lint.ts`, `src/lib/lint-checks.ts`, `src/lib/agent-runtime.ts` (already safe — its `input.owner` is the agent's human owner by construction), and the `POST /api/names-terms` write path.
- Do not change `ownerToTenant`/`tenantForOwner`, `sameHumanOwner`, `humanOwnerOf` itself, or anything in `src/lib/ingest.ts` / `src/lib/merge.ts` that DW-543 already settled.
- Do not remove the existing runtime assertion in `ingest-routes.test.ts` — the compile guard joins it, it does not replace it.
- Do not restructure the `Task` union, add a queue kind, or change `parseTask`'s runtime normalization.
- Do not "fix" the DW-543 spec's Never clause listing these files; DW-709 is that spec's own recorded follow-on and supersedes it for these six sites.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Queue payload spread | `const t: Task = { kind: "ingest", url, ...ingestOptions }` where the options carry `guidanceCache` | Compile error (`@ts-expect-error` in the pinning test) | N/A — compile time |
| Hand-written queue literal | `enqueueTask({ kind: "ingest", url, owner, author })` | Unchanged — still compiles and enqueues | No error expected |
| Agent-owned action extraction | `extractActionsFromPage("alice--yoyo", slug)`, alice has a Purpose + dictionary | System prompt carries alice's WORKSPACE PURPOSE and NAMES & TERMS; proposals still stored under `alice--yoyo` | No error expected |
| Agent-owned knowledge extraction | `extractStructuredKnowledge("alice--yoyo", slug)` on a page whose frontmatter owner is `alice--yoyo` | Prompt carries alice's guidance; the page-owner guard and the storage read still use the raw handle | Unchanged owner-guard throw |
| Agent-owned monitor redraft | monitor owned by `alice--yoyo`, default `draftUpdate` | Redraft system prompt carries alice's Purpose + dictionary; monitor stays in the agent's silo | No error expected |
| Agent-owned action item | `proposeActionItems("alice--yoyo", [{ assignee: "Ali" }])`, alice's dictionary maps `Ali` → `Alice Chen` | Assignee canonicalized to `Alice Chen`; item readable only via `listActionItems("alice--yoyo")` | No error expected |
| Plain human handle | any of the above with `alice` | Byte-identical to today | No error expected |
| Unreducible handle | owner `yoyo`, `system`, or `--yoyo` | Passes through whole (existing `humanOwnerOf` contract) — same tenant as today | No error expected |

</intent-contract>

## Code Map

- `src/lib/tasks.ts:71-160` -- the `kind: "ingest"` `Task` variant; add `guidanceCache?: never` here. `parseTask` (:461+) already rebuilds the payload field-by-field, so the consumer side needs nothing.
- `src/lib/ingest.ts:1471-1548` -- `IngestOptions`; `guidanceCache?: GuidanceCache` at :1530. Only `sourceType` (:1482) and `guidanceCache` are structurally incompatible with the ingest `Task`, so a spread test must use `Omit<IngestOptions, "sourceType">` to isolate the guard.
- `src/lib/guidance-cache.ts:46,54` -- `GuidanceCache` / `createGuidanceCache()`; a light module, safe to import from `tasks.test.ts`.
- `src/app/api/ingest/batch/route.ts:130-152` -- the reference hand-written literal, kept separate from `ingestOptions`; must still compile unchanged.
- `src/lib/__tests__/ingest-routes.test.ts:694-710` -- the existing runtime "keeps the handle out of the queued task payload" assertion; add a one-line pointer to the new compile guard.
- `src/lib/__tests__/tasks.test.ts` -- no module mocks beyond `@opennextjs/cloudflare`; home for the `@ts-expect-error` pin.
- `src/lib/agent-handle.ts:91` -- `humanOwnerOf` (pure, unslugified, passes an unreducible handle through whole).
- `src/lib/action-extractor.ts:42-46` -- `listNamesTerms(owner)` + `buildWorkspaceGuidance(owner)`; `proposeActionItems(owner, …)` at :45 must stay raw.
- `src/lib/structured-knowledge.ts:314-338` -- `tenant(owner)` storage read + owner guard (raw), then `listNamesTerms`/`buildWorkspaceGuidance` at :335,:337 (reduce).
- `src/lib/source-monitors.ts:378-395` -- `defaultDraftUpdate`; `buildWorkspaceGuidance`/`buildNamesTermsGuidance` on `input.monitor.owner` at :387-388. Injectable via `runSourceMonitor`'s `dependencies.draftUpdate` (:427), so the default path needs an `ai`-mocked test file.
- `src/lib/monitor-digests.ts:429-441` -- `listNamesTerms(owner)` at :437 feeding `applyNamesTermsToGeneratedText`; `ownerTenant(owner)`, `getMonitorDigest(owner, …)`, `digestEntries(owner, …)` and `digest.owner` stay raw.
- `src/lib/action-items.ts:95-104,178-182` -- `listNamesTerms(owner)` in `proposeActionItems` and `updateActionItem`; `lockKey(owner)` / `readItems(owner)` stay raw.
- `src/lib/__tests__/ingest.test.ts:5105-5155` -- the DW-543 agent-owned-guidance test to model the new ones on (seed via `createWiki` + `writeWikiArtifact(owner, id, "purpose.md", …)` from `../wikis` and `createNamesTerm` from `../names-terms`; `wikiArtifactPath` from `../wiki-paths`).
- `src/lib/__tests__/structured-knowledge.test.ts:1-60` -- already mocks `ai` + `../llm` and runs on a real tmp `DATA_DIR`; extend it.
- `src/lib/__tests__/action-items.test.ts`, `src/lib/__tests__/monitor-digests.test.ts`, `src/lib/__tests__/source-monitors.test.ts` -- real-filesystem tmpdir setups to model new tests on.

## Tasks & Acceptance

**Execution:**
- `src/lib/tasks.ts` -- add `guidanceCache?: never` to the `kind: "ingest"` variant with a comment naming DW-396 and why a live handle must not cross the queue -- makes the convention compile-enforced.
- `src/lib/__tests__/tasks.test.ts` -- add a test that a spread of `Omit<IngestOptions, "sourceType">` carrying a real `createGuidanceCache()` onto an ingest `Task` is a compile error (`@ts-expect-error`), and that the same literal without the handle still compiles -- pins the guard in both directions.
- `src/lib/__tests__/ingest-routes.test.ts` -- add a one-line comment on the existing runtime assertion pointing at the compile guard -- keeps the two halves findable together.
- `src/lib/action-extractor.ts` -- resolve `const guidanceOwner = humanOwnerOf(owner)` and use it for `listNamesTerms` and `buildWorkspaceGuidance` only -- DW-709.
- `src/lib/structured-knowledge.ts` -- same reduction for the two guidance calls, leaving the `tenant(owner)` read and owner guard raw -- DW-709.
- `src/lib/source-monitors.ts` -- reduce `input.monitor.owner` for the two guidance calls in `defaultDraftUpdate` -- DW-709.
- `src/lib/monitor-digests.ts` -- reduce `owner` for the `listNamesTerms` dictionary read only -- DW-709.
- `src/lib/action-items.ts` -- reduce `owner` for the `listNamesTerms` reads in `proposeActionItems` and `updateActionItem`, leaving `lockKey`/`readItems` raw -- DW-709.
- `src/lib/__tests__/action-extractor.test.ts` (new) -- mock `ai`/`../llm`/LLM-key, seed alice's Purpose + dictionary, extract from a page as `alice--yoyo`, assert the system prompt carries both and the proposals land in the agent's own silo.
- `src/lib/__tests__/structured-knowledge.test.ts` -- add the agent-owned-page equivalent, asserting the owner guard still compares raw tenants.
- `src/lib/__tests__/source-monitors-guidance.test.ts` (new) -- mock `ai`/`../llm`, run `runSourceMonitor` for an `alice--yoyo`-owned monitor through the DEFAULT `draftUpdate`, assert the redraft prompt carries alice's Purpose + dictionary.
- `src/lib/__tests__/monitor-digests.test.ts` -- add a digest built for `alice--yoyo` whose entry text is canonicalized against alice's dictionary.
- `src/lib/__tests__/action-items.test.ts` -- add agent-handle tests for `proposeActionItems` and `updateActionItem` assignee canonicalization plus silo isolation.

**Acceptance Criteria:**
- Given the ingest `Task` variant, when a payload literal spreads an options object carrying `guidanceCache`, then `tsc --noEmit` reports an error (and the `@ts-expect-error` pin passes).
- Given the existing hand-written `enqueueTask({ kind: "ingest", … })` literals in the batch, tasks/run and agent ingest routes, when the project type-checks, then they compile unchanged.
- Given a handle with no reducible human prefix (`yoyo`, `system`, `--yoyo`), when any of the six guidance sites resolves guidance, then it addresses exactly the tenant it addresses today.
- Given `pnpm vitest run`, when the suite runs, then there are no regressions beyond the pre-existing baseline.

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 0, low 5)
- defer: 1: (high 0, medium 0, low 1)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[low]` `[patch]` The DW-709 structured-knowledge test asserted only prompt text; added the data-visible assertion that the persisted record name is canonicalized to `Project Lighthouse` through `canonicalRecordName` → `canonicalizeNamesTerm`.
  - `[low]` `[patch]` The `alice` refusal case in that suite rejects on a storage ENOENT before reaching the owner guard; corrected its comment to say it evidences the RAW read, and handed the guard pin to the `alice--scout` case that asserts the exact message.
  - `[low]` `[patch]` `tasks.test.ts` pinned the runtime leak (`toHaveProperty("guidanceCache")`) as expected behavior, so a future runtime strip would fail as a fake regression; replaced with `expect(send).toHaveBeenCalledTimes(1)`.
  - `[low]` `[patch]` The `guidanceCache?: never` doc block overclaimed the old convention; three sites already spread a shared object into an ingest `Task` (`api/agents/[id]/ingest/route.ts`, `source-rescan.ts`, `extract-dispatch.ts`), so the sentence now says the convention was narrower and the guard more load-bearing.
  - `[low]` `[patch]` `IngestOptions.guidanceCache`'s own JSDoc still described the retired convention; it now names the compile-time guard and DW-396.

## Design Notes

The two halves share one idea: a rule that today lives in a comment or a convention becomes something the compiler or a test enforces. Keep the reduction visibly one-line-per-site; do not thread a reduced owner through call signatures, because the callers' handles are also their storage keys and a reduced parameter would silently repoint writes.

```ts
// action-extractor.ts — the shape at every site
const guidanceOwner = humanOwnerOf(owner);            // guidance: which HUMAN?
const dictionary = await listNamesTerms(guidanceOwner);
const workspaceGuidance = await buildWorkspaceGuidance(guidanceOwner);
…
return proposeActionItems(owner, …);                  // storage: which SILO?
```

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: no errors (the `@ts-expect-error` is satisfied, nothing else regresses)
- `pnpm vitest run src/lib/__tests__/tasks.test.ts src/lib/__tests__/ingest-routes.test.ts src/lib/__tests__/action-items.test.ts src/lib/__tests__/action-extractor.test.ts src/lib/__tests__/structured-knowledge.test.ts src/lib/__tests__/monitor-digests.test.ts src/lib/__tests__/source-monitors.test.ts src/lib/__tests__/source-monitors-guidance.test.ts` -- expected: all pass
- `pnpm lint` -- expected: no new errors
- `pnpm vitest run` -- expected: no regressions beyond the pre-existing baseline

## Auto Run Result

Status: done
Blocking condition: none

### Summary

Both plumbing assumptions are now enforced rather than assumed.

**DW-396.** The `kind: "ingest"` variant of `Task` declares `guidanceCache?: never`. TypeScript does not excess-property-check a spread, but it does check a KNOWN property that a spread supplies, so `enqueueTask({ kind: "ingest", url, ...ingestOptions })` — the exact shape that used to compile and then die in `structuredClone` — is now a compile error, while every hand-written literal (which simply omits the field) is untouched. `ingestUrl`'s call signature and `IngestOptions` itself are unchanged. The pin runs in both directions: `tasks.test.ts` carries an `@ts-expect-error` on the offending spread (deleting the `never` field turns it into `TS2578 Unused '@ts-expect-error'`), and the pre-existing runtime assertion in `ingest-routes.test.ts` is kept alongside it, not replaced, because the guard is compile-time only.

**DW-709.** DW-543 reduced the guidance principal to the human owner at the merge and ingest doors; the six remaining agent-reachable prompt sites now do the same. Each resolves one `const guidanceOwner = humanOwnerOf(owner)` and hands it ONLY to `buildWorkspaceGuidance` / `buildNamesTermsGuidance` / the `listNamesTerms` read that feeds a prompt or a canonicalization. Every storage, lock, attribution and authorization use of the same handle stays RAW — `lockKey`, `readItems`, `proposeActionItems`, `tenant()`, `ownerTenant()`, `getSourceMonitor`, `getMonitorDigest`, `digestEntries`, the written `digest.owner`, and `extractStructuredKnowledge`'s page-owner guard — so an agent's action items, digests, monitors and pages stay exactly where they are written today. The sites DW-709 names as not agent-reachable (`chat.ts`, `query.ts`, `lint.ts`, `lint-checks.ts`, `agent-runtime.ts`) and the `POST /api/names-terms` write path were left alone, per the intent.

### Files changed

- `src/lib/tasks.ts` -- `guidanceCache?: never` on the ingest `Task` variant, with the rationale and both pins named in place.
- `src/lib/ingest.ts` -- comment only: `IngestOptions.guidanceCache`'s JSDoc now points at the compile guard instead of the retired convention.
- `src/lib/action-extractor.ts` -- reduces for `listNamesTerms` + `buildWorkspaceGuidance`; `proposeActionItems` keeps the raw handle.
- `src/lib/structured-knowledge.ts` -- reduces for the two guidance calls; the tenant read and owner guard keep the raw handle.
- `src/lib/source-monitors.ts` -- reduces `input.monitor.owner` for the two guidance calls in `defaultDraftUpdate`.
- `src/lib/monitor-digests.ts` -- reduces for the dictionary that canonicalizes generated entry prose only.
- `src/lib/action-items.ts` -- reduces for the dictionary reads in `proposeActionItems` and `updateActionItem`.
- `src/lib/__tests__/tasks.test.ts` -- the `@ts-expect-error` compile pin, the same spread compiling once the handle is gone, and the hand-written route literal shape.
- `src/lib/__tests__/ingest-routes.test.ts` -- pointer comment linking the kept runtime assertion to its compile-time half.
- `src/lib/__tests__/action-extractor.test.ts` (new) -- agent-owned extraction: prompt, canonicalized assignee, agent silo, plain-human parity, unreducible handles, degrade-to-unguided.
- `src/lib/__tests__/source-monitors-guidance.test.ts` (new) -- the DEFAULT `draftUpdate` path, which every case in `source-monitors.test.ts` injects away.
- `src/lib/__tests__/structured-knowledge.test.ts`, `monitor-digests.test.ts`, `action-items.test.ts` -- agent-owned guidance cases asserting the data-visible canonicalization plus silo isolation.

### Review findings breakdown

- Patches applied: 5 (high 0, medium 0, low 5) -- see the Review Triage Log entry for each.
- Items deferred: 1 (low) -- `humanOwnerOf` reduces on the first `--` without checking the prefix names a registered agent owner.
- Items rejected: 10 -- chiefly: the DW-396 reading (the intent explicitly offers `guidanceCache?: never` as an alternative to typing the payload builders); route-level tests for the guard (repo-wide `tsc --noEmit` already covers every real call site); the duplicate handle-splitter in `agents.ts#agentOwnerHandle` (DW-543 recorded that duplication as deliberate); the unreduced `/api/names-terms` write path and the non-agent-reachable prompt sites (both named as out of scope by DW-709 itself); a runtime strip in `enqueueTask` (the intent asks for compile enforcement, and the runtime assertion is retained); a one-off unreproducible test-ordering flake in an auditor's ad-hoc run, not reproduced in the full suite or five targeted repeats.
- Follow-up review recommendation: patched findings by severity -- high 0, medium 0, low 5. Score: no high-severity patch, so `followup_review_recommended: false`.

### Verification performed

- `pnpm exec tsc --noEmit` -- clean, exit 0 (so the `@ts-expect-error` is genuinely consumed; a reviewer confirmed empirically that removing the `never` field produces `TS2578` at the pinned line).
- `pnpm vitest run` over the eight targeted files -- 124 passed.
- `pnpm lint` -- clean; only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, unchanged from baseline.
- `pnpm vitest run` (full) -- 394 files, 9882 passed, 1 skipped, 0 failed.
- Mutation check: reverse-applying the five production hunks fails 7 tests, at least one per changed site (`action-items` fails separately for `proposeActionItems` and `updateActionItem`), so the new tests observe the reduction rather than restate it.
- Matrix audit: every I/O row has a covering test that ran and passed -- compile-error and hand-written-literal rows in `tasks.test.ts`; the four agent-owned rows in `action-extractor`, `structured-knowledge`, `source-monitors-guidance` and `action-items`; plain-human and unreducible-handle rows in `action-extractor`, `source-monitors-guidance` and `action-items`.

### Residual risks

- The guard is compile-time only and depends on the spread source being statically typed: a payload built as `Record<string, unknown>`, an `any`, or an `as Task` cast still compiles and would still fail in `structuredClone`. The retained runtime assertion in `ingest-routes.test.ts` is the second half for exactly that reason.
- The five reduced sites do not fail-soft on an unreadable dictionary: `listNamesTerms` ENOENT-degrades to `[]` but rethrows an unparseable `names-terms.json` or a non-ENOENT storage error, and unlike `merge.ts` these sites have no probe. That gap is pre-existing and already applies to every human handle; the reduction only makes agent handles share it, so it was not widened here.
- An agent-owned structured-knowledge graph whose records were named while the agent's tenant had no dictionary can now canonicalize new records differently from old ones, splitting an alias into two nodes. This is the same accepted consequence DW-543 shipped at the ingest door, and the same thing that happens whenever an owner edits their dictionary.
