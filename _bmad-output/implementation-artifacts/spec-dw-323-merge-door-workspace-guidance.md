---
title: 'DW-323: guide the merge door with the survivor owner''s workspace guidance'
type: 'bugfix'
created: '2026-08-22'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      An empty or whitespace-only reconcile response makes `mergePages` replace the
      survivor's body with the ABSORBED page's body, then hard-delete the absorbed
      page — silent data loss with no revision to recover from.
    evidence: |-
      `reconcilePage` fails soft to the NEW body on an empty model response
      (src/lib/ingest.ts:1176 — `if (!out || out.trim() === "") return { body: newBody, ... }`).
      At the ingest door `newBody` is the freshly synthesized article, so that
      fallback is correct. At the merge door `newBody` is `from.body`, so the
      survivor's existing prose is overwritten wholesale by the page being
      absorbed, and step 5 then hard-deletes `from` along with its revision
      history. The `catch` in `mergePages` does not fire — the call RESOLVED.
      Pre-existing: predates DW-323, which only added the guidance arguments.
    location: >-
      src/lib/merge.ts:302
    severity: medium
baseline_revision: 'd99bb49ee48e801299341cce39ca68f6aa98c0b2'
---

<intent-contract>

## Intent

**Problem:** `mergePages` calls `reconcilePage(into.body, from.body)` with no `owner` and no guidance cache (`src/lib/merge.ts:236`), so the owner-guidance branch inside `reconcilePage` (`src/lib/ingest.ts:1163`) is skipped entirely — the same reconcile prompt that carries Workspace Purpose and Names & Terms at the ingest door carries neither at the manual-merge door. Identical bodies are held to a different standard depending on which door folded them.

**Approach:** Resolve the accountable owner at the merge site — the SURVIVOR's `into.frontmatter.owner`, falling back to the acting principal (`actor`) — and pass it, plus a fresh per-merge guidance cache, into `reconcilePage`. Pin the owner choice with a cross-owner merge test so a later edit cannot silently swap to `from`'s owner.

## Boundaries & Constraints

**Always:**
- Guidance owner is `into.frontmatter.owner` when it is a non-empty string; otherwise `actor`; otherwise `undefined` (guidance stays off, exactly as today).
- The cache handle is minted inside `mergePages`, per merge operation — no module-level, process-global, or TTL cache (the `guidance-cache.ts` contract).
- Guidance stays fail-soft: the existing `try/catch` around `reconcilePage` that degrades to appended bodies must keep that behaviour.
- `reconcilePage`'s signature is unchanged — both new arguments already exist as optional trailing parameters.
- The rebrand freeze in AGENTS.md applies: no runtime identifier renames.

**Block If:**
- Closing the asymmetry would require changing `reconcilePage`'s signature or `buildWorkspaceGuidance`/`buildNamesTermsGuidance` semantics.

**Never:**
- Do not thread a caller-supplied cache through `MergePagesArgs` — no caller batches merges today, and a new public parameter with no second caller is speculative surface.
- Do not change the same-human-owner guard, the visibility guard, the provenance union, backlink re-pointing, or the delete.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Same-owner merge, owner has a Purpose | `into` and `from` both owned by `alice`; alice's active Wiki profile has a purpose | The reconcile system prompt contains `WORKSPACE PURPOSE` and alice's purpose text | No error expected |
| Cross-owner merge (trusted caller) | `into` owned by `alice`, `from` owned by `bob`, `bypassOwnerCheck: true`, `actor: "system"`; both owners have distinct purposes and Names & Terms entries | The prompt carries ALICE's purpose and ALICE's dictionary entry; bob's appear nowhere in it | No error expected |
| Survivor frontmatter has no `owner` | `into.frontmatter.owner` absent, `actor: "alice"` | Guidance resolves for `alice` (the acting principal) | No error expected |
| No owner resolvable | `into.frontmatter.owner` absent and `actor` undefined | `reconcilePage` receives `undefined` owner; prompt carries no guidance block — today's behaviour | No error expected |
| Guidance read fails | Damaged registry / unreadable profile for the resolved owner | `buildWorkspaceGuidance` fail-softs to `""`; merge completes with an unguided prompt | Warn only, merge succeeds |
| Reconcile throws | LLM error during the guided call | Existing `catch` logs and appends the two bodies; merge still completes | Warned, degraded fold |

</intent-contract>

## Code Map

- `src/lib/merge.ts` -- THE CHANGE. `mergePages` at `:185`; the unguided call is `reconcilePage(into.body, from.body)` at `:236`, inside `if (hasLLMKey())` with a `try/catch` that degrades to `` `${into.body}\n\n${from.body}` ``. `into` is read fresh at `:196`. Local helper `asString` at `:67` is the existing frontmatter-string coercion — reuse it for `into.frontmatter.owner`. Imports from `./ingest` are already grouped at `:27-33`.
- `src/lib/ingest.ts` -- READ-ONLY. `reconcilePage(existingBody, newBody, owner?, cache?)` at `:1157`; the guidance branch is `:1163-1170` (`owner ? Promise.all([buildWorkspaceGuidance(owner, cache?.workspace), buildNamesTermsGuidance(owner, cache?.namesTerms)]) : ["", ""]`), appended to `RECONCILE_SYSTEM_PROMPT`. The ingest-side call that already passes both is `:1934`.
- `src/lib/guidance-cache.ts` -- READ-ONLY. `createGuidanceCache()` at `:62` returns the composite `{ workspace, namesTerms }`. Its header documents the caller-owned, per-operation lifetime and enumerates today's three scopes — the merge door becomes the fourth, so that list needs one more bullet. NOTE: the DW-323 decision text says `createWorkspaceGuidanceCache()`, which predates DW-322/324 splitting the memo into this composite; `createGuidanceCache()` is the current spelling of the same thing and is what `reconcilePage` accepts.
- `src/lib/workspace-guidance.ts` -- READ-ONLY. `buildWorkspaceGuidance(owner, cache?)` at `:110`; fail-soft `catch` returns `""`. Its header says "Only `ingest.ts` needs it today" — now stale.
- `src/lib/names-terms.ts` -- READ-ONLY. `buildNamesTermsGuidance(owner, cache?)` at `:426`; renders `WORKSPACE NAMES & TERMS`.
- `src/lib/workspace-profile.ts` -- READ-ONLY. `renderWorkspaceGuidance` at `:325` emits the literal `WORKSPACE PURPOSE` header and `Purpose:\n<text>` — the strings the test asserts on.
- `src/lib/__tests__/merge.test.ts` -- THE TEST. Module-mocks `../llm` at `:7` (`hasLLMKey` true, `callLLM` returns a fixed fold), so `mockedCallLLM.mock.calls[0][0]` IS the reconcile system prompt — `reconcilePage` is the only `callLLM` in `mergePages`. `seedPage(slug, {title, owner, ...})` at `:41` writes through `writeWikiPageWithSideEffects`. `beforeEach` at `:81` points `DATA_DIR`/`WIKI_DIR`/`RAW_DIR` at a tmpdir, so the wiki registry and profile are real bytes.
- `src/lib/__tests__/ingest.test.ts:3735-3790` -- REUSE PATTERN for the fixture: `createWiki(OWNER, {...})` + `saveWorkspaceProfile(OWNER, wiki.id, {...})` + `createNamesTerm(OWNER, {...})`, with `_resetLocks()` in `beforeEach`.
- `src/mcp.ts:416-429` -- READ-ONLY evidence that a cross-owner merge is reachable: `handleMergePages` passes `bypassOwnerCheck: true` with `actor: args.author ?? "system"`. `src/lib/mcp-http.ts:547` passes `bypassOwnerCheck: false`.
- `src/lib/__tests__/read-only-door-coverage.test.ts:71` -- READ-ONLY. Lists `reconcilePage` and `mergePages` as writer-reaching exports; unaffected by an argument-only change.
- `AGENTS.md` -- READ-ONLY. Frozen-identifier policy; no identifier renames here.

## Tasks & Acceptance

**Execution:**
- `src/lib/merge.ts` -- import `createGuidanceCache` from `./guidance-cache`; in `mergePages` step 1, compute `const guidanceOwner = asString(into.frontmatter.owner) ?? actor;` and call `reconcilePage(into.body, from.body, guidanceOwner, createGuidanceCache())`. Comment WHY the survivor's owner is the accountable one (the survivor is the page that keeps existing under that owner's Purpose and dictionary) and why the handle is minted here (one merge = one operation) -- closes the DW-323 asymmetry at its single call site.
- `src/lib/guidance-cache.ts` -- add the merge door to the "Scope today" enumeration in the module header (one bullet: one handle per `mergePages`, covering its single reconcile call, minted so the merge's guidance scope is stated rather than implied) -- the header is the contract for where handles are minted, and a stale enumeration is the drift this repo keeps re-fixing.
- `src/lib/workspace-guidance.ts` -- correct the module-header sentence that claims only `ingest.ts` needs the cache handle -- the statement is now false.
- `src/lib/__tests__/merge.test.ts` -- add a `describe` covering the I/O matrix rows: same-owner merge carries the purpose; cross-owner merge (`bypassOwnerCheck: true`, `actor: "system"`, distinct purposes AND Names & Terms per owner) carries the SURVIVOR's guidance and none of the absorbed owner's; `into` without an `owner` falls back to `actor`. Assert against `mockedCallLLM.mock.calls[0][0]` -- pins which owner's guidance a cross-owner merge uses.

**Acceptance Criteria:**
- Given `hasLLMKey()` is false, when `mergePages` runs, then no guidance is resolved and the bodies are appended exactly as before.
- Given a merge whose guidance resolution throws, when `mergePages` runs, then the merge still completes with an unguided prompt and a warning, never a thrown merge.
- Given the existing suites, when `pnpm test` runs, then every pre-existing case in `merge.test.ts`, `ingest.test.ts`, `workspace-guidance.test.ts` and `read-only-door-coverage.test.ts` passes unedited.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 1: (high 0, medium 1, low 0)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[medium]` `[patch]` The two guidance halves fail differently and only one was safe in the fold's critical path: `buildWorkspaceGuidance` swallows read errors, but `listNamesTerms` rethrows a non-ENOENT storage error, which would have surfaced as a failed reconcile and cost the LLM fold entirely — a regression this door cannot absorb, since it hard-deletes `from`. `mergePages` now probes the dictionary once under the merge's own handle before the fold; on success the reconcile reads that memo (one read, not two), on failure an empty dictionary is pinned in the handle so the Purpose half still reaches the prompt and the fold still happens. Covered by a new EIO-on-`names-terms.json` test, mutation-verified (disabling the probe drops `callLLM` to 0 calls).
  - `[medium]` `[patch]` The "falls back to the acting principal" test could not distinguish `into.owner ?? actor` from `into.owner ?? from.owner` — the absorbed page was owned by the same `alice` acting. The absorbed page is now owned by a guidance-bearing `bob` and the test asserts his Purpose is absent.
  - `[low]` `[patch]` Survivor-owner-beats-ACTOR precedence was only pinned against an actor (`system`) with no guidance. `system` now has a seeded Purpose the cross-owner test asserts is absent.
  - `[low]` `[patch]` `reconcileSystemPrompt()` read `mock.calls[0][0]` on the strength of a comment; it now asserts `toHaveBeenCalledTimes(1)`, so a second LLM call in the merge path fails loudly instead of silently shifting which prompt every assertion inspects.
  - `[low]` `[patch]` No test proved guidance is APPENDED to `RECONCILE_SYSTEM_PROMPT` rather than replacing it; every prompt assertion now also pins a stable marker sentence from the base prompt.
  - `[low]` `[patch]` The dictionary assertions were satisfied by the Purpose text alone (`ALICE_PURPOSE` contains "Project Lighthouse", which was also her dictionary canonical), and her seeded alias was never asserted. Her entry is now "Meridian Rollout"/"Meridian", words that appear in no Purpose in the fixture.
  - `[low]` `[patch]` Docs stopped short of where a reader looks: the `merge.ts` module header's `reconcilePage` bullet, `MergePagesArgs.actor` (now also the fallback guidance principal), and `bypassOwnerCheck` (a trusted cross-owner merge now pushes the survivor owner's profile text into a prompt folding another owner's prose) are all updated, and the call-site comment now states two things it previously implied: that merge keys guidance on the survivor's stored owner while ingest keys on the acting principal, and that the principal is passed RAW, so an agent handle keys its own silo — deliberate parity with the ingest door, not an oversight of the guard's `sameHumanOwner` collapse.

## Design Notes

The owner choice is the whole decision, so state it where a reader will hit it:

```ts
// DW-323: the merge door folds prose with the SAME reconcile prompt the ingest
// door uses, so it must carry the same owner guidance. The accountable owner is
// the SURVIVOR's — `into` is the page that keeps existing, under that owner's
// Workspace Purpose and Names & Terms — falling back to the acting principal
// when the survivor's frontmatter names none. A cross-owner merge (trusted
// callers only, `bypassOwnerCheck`) therefore folds under `into`'s guidance,
// never the absorbed page's. One handle per merge: a merge is one operation.
const guidanceOwner = asString(into.frontmatter.owner) ?? actor;
```

The handle memoizes nothing today — `mergePages` makes exactly one guidance-consuming call. It is minted anyway because the alternative (`undefined`) leaves the merge's guidance scope unstated, and because `reconcilePage`'s cache parameter is the seam a second call would use.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/merge.test.ts src/lib/__tests__/ingest.test.ts src/lib/__tests__/workspace-guidance.test.ts src/lib/__tests__/names-terms.test.ts src/lib/__tests__/read-only-door-coverage.test.ts` -- expected: all pass, new cases included
- `pnpm lint` -- expected: no new errors
- `npx tsc --noEmit -p tsconfig.json` -- expected: no new errors


## Auto Run Result

Status: done

### Implemented change

`mergePages` now folds the two bodies under owner guidance, closing the DW-323 asymmetry with the ingest door. The accountable owner is the SURVIVOR's (`into.frontmatter.owner`), falling back to the acting principal, and it is passed to `reconcilePage` together with a fresh per-merge `GuidanceCache`. A manual merge therefore carries the same Workspace Purpose and Names & Terms the ingest-time reconcile of the same two bodies carries. Review added one behavioural guard on top: the dictionary is probed under the merge's own handle first, so a non-ENOENT read error degrades the prompt instead of costing the LLM fold.

### Files changed

- `src/lib/merge.ts` -- resolve `guidanceOwner`, mint one `GuidanceCache` per merge, probe the Names & Terms dictionary fail-soft, and pass owner + handle into `reconcilePage`; module-header, `actor` and `bypassOwnerCheck` docs updated.
- `src/lib/guidance-cache.ts` -- module header: the scope enumeration is now four doors and records what the merge handle actually carries.
- `src/lib/workspace-guidance.ts` -- module header: corrected the now-false "Only `ingest.ts` needs it today".
- `src/lib/__tests__/merge.test.ts` -- new `describe` with 7 cases pinning which owner's guidance reaches the reconcile prompt, the fallback chain, both guidance-read failure modes, the no-principal floor, and the append-on-throw degrade.

### Review findings breakdown

- Patches applied: 7 (medium 2, low 5) -- see the Review Triage Log entry above.
- Items deferred: 1 (medium) -- the empty-response fallback in `reconcilePage` replaces the survivor's body with the absorbed page's at the merge door; recorded in frontmatter `deferred`.
- Items rejected: 9 (low) -- chiefly: thread a caller-supplied handle through `MergePagesArgs` (excluded by the intent, which asks for a fresh handle minted in `merge.ts`, and no caller batches merges); drop the handle because it is unobservable (the intent requires it, and it is now load-bearing for the dictionary probe); collapse the guidance principal to `humanOf(...)` (would make this the only door that does, breaking the parity DW-323 is about); bound the prompt size; cover empty-Purpose/empty-dictionary combinations; alleged doc drift in `names-terms.ts` and `guidance-cache.ts`'s closing paragraph (both re-read and still accurate).

### Follow-up review recommendation

`true`. Patched findings this pass: high 0, medium 2, low 5. Score = 3x2 + 1x5 = 11, which is >= 5.

### Verification performed

- `npx vitest run src/lib/__tests__/merge.test.ts src/lib/__tests__/ingest.test.ts src/lib/__tests__/workspace-guidance.test.ts src/lib/__tests__/names-terms.test.ts src/lib/__tests__/read-only-door-coverage.test.ts` -- 288 passed, 5 files, no pre-existing case edited.
- `npx vitest run` (full suite) -- 275 files, 6301 tests, all passing.
- `npx tsc --noEmit -p tsconfig.json` -- clean.
- `npx eslint` on the four changed files -- clean. (`pnpm lint` is not runnable in this checkout: pnpm reports "packages field missing or empty"; the same ESLint config was run directly.)
- Mutation checks: removing both new `reconcilePage` arguments fails 4 tests; keying on `from.frontmatter.owner` fails 2; inverting the fallback to `actor ?? into.frontmatter.owner` fails the cross-owner test; disabling the dictionary probe fails the new dictionary-failure test with 0 `callLLM` calls.
- I/O matrix audit: all six rows are covered by cases that ran and passed in the run above, plus one extra case for the dictionary-read failure mode the matrix's "guidance read fails" row did not distinguish.

### Residual risks

- The `GuidanceCache` handle memoizes across exactly two reads today (the probe and the reconcile), so its per-operation scope is stated rather than stress-tested; a second guidance-consuming call in a merge would be its first real exercise.
- The new tests drive real registry / profile / dictionary reads on a tmpdir through `createWiki` + `saveWorkspaceProfile` + `createNamesTerm`. Because `buildWorkspaceGuidance` fail-softs to `""`, any transient fixture read failure turns the positive prompt assertions red without the code under test being wrong. The full suite was green across the runs above, but the failure mode is inherent to asserting a call-site change through an integration fixture.
- Guidance keys on the raw principal, so a page owned by an agent handle (`alice--bot`) resolves no Wiki and therefore folds unguided, even though the merge's own guard treats the merge as that human's. This matches the ingest door exactly and is now documented at the call site, but no test covers an agent handle on either side.
