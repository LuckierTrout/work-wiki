---
title: 'DW-323 — guide the merge door: pass owner + guidance cache into reconcilePage'
type: 'bugfix'
created: '2026-08-29'
baseline_revision: 'd426b4132d160cb017f8ef08be4283965da99344'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      An agent handle owning the survivor resolves guidance against the agent's own
      tenant silo rather than the human's, so an agent-owned page folds with no
      Workspace Purpose and no dictionary.
    evidence: |-
      `ownerToTenant` (src/lib/links.ts) lowercases and path-sanitizes but does not
      strip the `--` agent suffix, so `alice--yoyo` keys its own tenant. The
      same-owner guard 40 lines above the fold deliberately collapses that pair via
      `sameHumanOwner`/`humanOf` (src/lib/ingest.ts), so the two treat the same
      handle differently. The ingest door passes the raw handle too, so this is a
      codebase-wide convention question, not a merge-door bug: deciding it means
      deciding whether guidance is addressed by silo or by human, for every prompt
      site at once. Out of scope for DW-323, whose intent is the door asymmetry.
    location: >-
      src/lib/merge.ts (guidanceOwner resolution) and src/lib/ingest.ts:1760
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `src/lib/merge.ts:439` calls `reconcilePage(into.body, from.body)` with no `owner` and no guidance cache, so the `owner ? ... : ["", ""]` branch in `reconcilePage` (`src/lib/ingest.ts:1184-1191`) short-circuits and the merged prose gets neither the Workspace Purpose nor the Names & Terms dictionary — while an ingest-time reconcile of the exact same two bodies (`src/lib/ingest.ts:2179-2184`) gets both. One prompt, two standards, decided only by which door the bodies arrived through.

**Approach:** Apply the recorded 2026-08-21 decision: resolve the accountable owner at the merge door from `into.frontmatter.owner`, falling back to the acting principal (`actor`), and pass it plus a fresh `createGuidanceCache()` handle into `reconcilePage`. Pin the cross-owner choice with a test so a later reader cannot re-decide it silently.

## Boundaries & Constraints

**Always:**
- The guidance owner is the SURVIVOR's owner (`into.frontmatter.owner`) first, then `actor`. The merged prose lives on `into`, in `into`'s owner's workspace, so it is held to that workspace's Purpose and dictionary.
- Read the owner through the existing `asString` helper (`src/lib/merge.ts:75`) so a blank/non-string frontmatter `owner` degrades to the `actor` fallback rather than becoming an empty-string principal.
- When both are absent, pass `undefined` — today's exact no-guidance behaviour, unchanged.
- The cache handle is minted fresh at the call site, per merge. Never hoist it to module scope, a global, or across merges.
- Guidance stays fail-soft: the existing `try/catch` around `reconcilePage` (which degrades to appending bodies) must keep covering the call.

**Block If:** Nothing. The owner-resolution order and the cross-owner tie-break are both fixed by the recorded decision.

**Never:**
- Do not change `reconcilePage`'s signature, its guidance branch, or anything in `src/lib/ingest.ts`.
- Do not thread a new argument through `MergePagesArgs` or `mergePages` — everything needed is already in scope at the fold.
- Do not relax or re-order the same-owner guard, the artifact guard, or the public→private guard above the fold.
- Do not touch `createWorkspaceGuidanceCache` / `createGuidanceCache` themselves.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Same-owner merge, workspace guidance set | Both pages `owner: alice`; alice's active Wiki has a Purpose and a Names & Terms entry | The reconcile `callLLM` system prompt contains alice's `WORKSPACE PURPOSE` block and her `WORKSPACE NAMES & TERMS` block | No error expected |
| Cross-owner merge (`bypassOwnerCheck: true`) | `into` owned by `alice` (Purpose A), `from` owned by `bob` (Purpose B), `actor: "bob"` | System prompt carries alice's Purpose A and NOT bob's Purpose B — the survivor's owner wins | No error expected |
| Survivor frontmatter has no usable `owner` | `into.frontmatter.owner` absent/blank, `actor: "alice"` | Falls back to `actor`; alice's guidance appears in the system prompt | No error expected |
| No owner at all | `into.frontmatter.owner` absent/blank and `actor` undefined | `reconcilePage` receives `undefined`; system prompt is the bare `RECONCILE_SYSTEM_PROMPT` (no guidance blocks) | No error expected |
| Guidance resolution fails | Registry/profile unreadable for the resolved owner | `buildWorkspaceGuidance` already fail-softs to `""`; merge completes with an unguided prompt | Warned by `workspace-guidance`, merge unaffected |

</intent-contract>

## Code Map

- `src/lib/merge.ts:439` -- THE change site. Inside `mergePagesWhileSourceLocked`, in the `if (!receipt)` fold block, guarded by `hasLLMKey()` and wrapped in `try/catch`. `into`/`from` are `pageSnapshot`s (`content`/`frontmatter`/`body`/`title`); `actor` is the destructured `MergePagesArgs.actor` (`string | undefined`).
- `src/lib/merge.ts:75` -- `asString(v: unknown): string | undefined` — returns `undefined` for non-strings AND for whitespace-only strings. Reuse it; do not hand-roll.
- `src/lib/merge.ts:23-47` -- import block. `tenantForOwner` already comes from `./wiki` here. `reconcilePage` already comes from `./ingest`; `createGuidanceCache` must be added from `./guidance-cache` (NOT from `./ingest`, and NOT `createWorkspaceGuidanceCache` from `./workspace-guidance` — the parameter's type is the composite `GuidanceCache`).
- `src/lib/merge.ts:1-21` -- module doc header; its first bullet describes `reconcilePage` as behaving "exactly like accumulate-and-reconcile on re-ingest". That claim only becomes true with this change — extend the bullet to name the owner resolution.
- `src/lib/merge.ts:455-465` (pre-change numbering ~441-448) -- the existing `catch` around the fold: on ANY throw it sets `mergedBody = into.body + "\n\n" + from.body` and logs `reconcile failed ...; appending bodies`. That concatenation is then written into `MergeOperationReceipt.mergedContent` (`src/lib/merge.ts:~515`), which is the merge's linearization point — a Retry replays the receipt and NEVER re-folds, and `from` is deleted regardless. So anything newly able to throw before `callLLM` durably ships an unfolded, double-titled survivor.
- `src/lib/merge.ts:49-63` -- `MergePagesArgs`. `actor?: string`, `bypassOwnerCheck?: boolean`. READ-ONLY: no new field.
- `src/lib/ingest.ts:1179-1203` -- `reconcilePage(existingBody, newBody, owner?, cache?)`. READ-ONLY. The `owner ? Promise.all([buildWorkspaceGuidance(owner, cache?.workspace), buildNamesTermsGuidance(owner, cache?.namesTerms)]) : ["", ""]` branch is the asymmetry being closed.
- `src/lib/ingest.ts:2179-2184` -- the ingest-door call, the parity reference: `reconcilePage(existing.body, wikiContent, owner, guidanceCache)`.
- `src/lib/names-terms.ts:170-177` -- `readEntries` ENOENT-degrades to `[]` but **RETHROWS every other error**, including the `JSON.parse` SyntaxError from a corrupt `tenants/<tenant>/names-terms.json`. `listNamesTerms` (`:291-320`) deliberately propagates it and memoizes only SUCCESSFUL reads. This is the asymmetry that makes the naive change unsafe — see Design Notes.
- `src/lib/names-terms.ts:291` -- `listNamesTerms(owner, cache?: NamesTermsCache)`. A public export whose `cache` parameter exists precisely so one operation can share a single dictionary read. This is the door the merge fold uses to probe readability without a second read.
- `src/lib/guidance-cache.ts` -- `createGuidanceCache(): GuidanceCache` (composite of `workspace` + `namesTerms` memos). Its header documents the handle as CALLER-OWNED and PER-OPERATION. READ-ONLY.
- `src/lib/workspace-guidance.ts:129-146` -- `buildWorkspaceGuidance(owner, cache?)`, memo keyed by `ownerToTenant(owner)`, fail-soft to `""`. READ-ONLY, but explains why casing variants are safe.
- `src/lib/names-terms.ts:476-481` -- `buildNamesTermsGuidance(owner, cache?)` → `renderNamesTermsGuidance(...)`, whose block starts with the literal `WORKSPACE NAMES & TERMS`. READ-ONLY.
- `src/lib/workspace-profile.ts:325-344` -- `renderWorkspaceGuidance` emits a block starting with the literal `WORKSPACE PURPOSE` and a `Purpose:\n<text>` line. The assertion anchors for the tests.
- `src/lib/__tests__/merge.test.ts:1-112` -- the suite to extend. It already mocks `../llm` (`hasLLMKey` → true, `callLLM` → a fixed folded body), sets `DATA_DIR`/`WIKI_DIR`/`RAW_DIR` to a temp dir in `beforeEach` (so the wiki registry and profile are real bytes), and has `seedPage(slug, { title, owner, ... })` taking an `owner` (default `"alice"`). `mockedCallLLM.mock.calls[0][0]` is the reconcile system prompt.
- `src/lib/__tests__/ingest.test.ts:3884-3940, 4003-4007` -- the working recipe for seeding guidance in a test: `createWiki(OWNER, {...})` from `../wikis`, `saveWorkspaceProfile(OWNER, wiki.id, {...})` from `../workspace-profile`, `createNamesTerm(OWNER, { kind, canonical, aliases })` from `../names-terms`. Copy this shape.
- `src/lib/__tests__/read-only-door-coverage.test.ts:71` -- lists `reconcilePage` as a writer-reaching export of `@/lib/ingest`. READ-ONLY: unchanged by this work (no export surface changes), but confirms the merge module is already an accepted caller.


## Tasks & Acceptance

**Execution:**
- `src/lib/merge.ts` -- add `import { createGuidanceCache } from "./guidance-cache";` and `import { listNamesTerms } from "./names-terms";` -- the composite handle `reconcilePage`'s 4th parameter expects, plus the fail-soft probe below.
- `src/lib/merge.ts` -- at the fold (line ~439), resolve `asString(into.frontmatter.owner) ?? asString(actor)` into a MUTABLE `guidanceOwner` — BOTH sides go through `asString`, so a blank `actor` cannot reach `ownerToTenant`, which would collapse it onto the DEFAULT tenant and hand the default silo's guidance to a fold that named no principal, mint one `createGuidanceCache()` handle, and — when `guidanceOwner` is set — `await buildNamesTermsGuidance(guidanceOwner, cache.namesTerms)` inside its own `try`. Probe `buildNamesTermsGuidance`, NOT `listNamesTerms`: the dictionary can throw at EITHER layer — `readEntries` rethrows a `JSON.parse` SyntaxError, and `renderNamesTermsGuidance` separately dereferences `entry.aliases` on entries nothing filters (`resolveSortedEntries` only skips FREEZING a null/non-object element), so a file that PARSES but holds a `null` or a field-less entry throws only at RENDER. Probing the read layer alone misses that second class. On success the memo means `reconcilePage` does not re-read the dictionary; the second render is a pure function over cached entries. On failure, log and set `guidanceOwner = undefined` so the fold still happens, unguided. Then call `reconcilePage(into.body, from.body, guidanceOwner, cache)`. -- closes the door asymmetry WITHOUT letting a damaged dictionary abort the fold. See Design Notes: this exact failure was shipped by the first implementation pass and confirmed by probe.
- `src/lib/merge.ts` -- comment the call site with (a) why the survivor's owner is the accountable one, (b) why the dictionary is probed first and why the Purpose is dropped along with it, and (c) that the handle's lifetime is this one merge.
- `src/lib/merge.ts` -- extend the module doc header's `reconcilePage` bullet to record that the fold now carries the survivor owner's Workspace Purpose and Names & Terms. Claim PRESENCE parity only: the ingest door passes the ACTING principal (`src/lib/ingest.ts:1760`, `options?.owner?.trim() || actor`) while the merge door passes the SURVIVOR's owner, so the two doors still differ on WHICH principal supplies the standard. Do not write "exactly like" or "one standard whichever door" without that qualification.
- `src/lib/__tests__/merge.test.ts` -- add a `describe` block asserting against the system prompt captured from `mockedCallLLM`. Seed guidance with the `createWiki` + `saveWorkspaceProfile` + `createNamesTerm` recipe from `src/lib/__tests__/ingest.test.ts:3884-3940`. Requirements the first pass got wrong and that MUST hold this time:
  - Every dictionary assertion uses a canonical term and alias appearing NOWHERE in any Workspace Purpose string in the block, so `toContain(term)` cannot be satisfied by the Purpose text.
  - The ownerless-page helper reads the page back and asserts `frontmatter.owner === undefined`, so the tests depending on an ownerless survivor cannot go green for the wrong reason if the write path ever starts stamping an owner.
  - The no-owner test also asserts POSITIVELY that a stable substring of the base reconcile prompt is present, so it distinguishes "no guidance" from "no prompt".
  - The cross-owner test seeds BOTH principals a distinct dictionary term as well as a distinct Purpose, and asserts the absorbed owner's term does not reach the fold.
  - A CORRUPT-dictionary case (`getStorage().writeFile("tenants/<tenant>/names-terms.json", "{not json")` — no spy needed): assert `callLLM` was called exactly once, the survivor carries the folded body and NOT the raw concatenation of the two source bodies, and the prompt carries no `WORKSPACE NAMES & TERMS` block.
  - A case proving the handle is not vacuous: under one merge with a readable dictionary, `tenants/<tenant>/names-terms.json` is read exactly once (count `storage.readFile` calls the way `src/lib/__tests__/ingest.test.ts` does).
  - Every test whose name claims this change's behaviour must FAIL when `guidanceOwner` is forced to `undefined`. Verify that by mutation before reporting done, and say so in the report.
- `src/lib/__tests__/merge.test.ts` -- restore any spy, env var, or lock state the new block installs, and leave the file's existing suites untouched.

**Acceptance Criteria:**
- Given `into` is owned by `alice` whose active Wiki carries a Workspace Purpose and a Names & Terms entry, when `mergePages` folds with an LLM key present, then the system prompt passed to `callLLM` contains a `WORKSPACE PURPOSE` block naming alice's purpose text and a `WORKSPACE NAMES & TERMS` block naming her canonical term and its alias.
- Given `into` is owned by `alice` and `from` by `bob`, both with distinct Workspace Purposes and distinct dictionary terms, when `mergePages` runs with `actor: "bob"` and `bypassOwnerCheck: true`, then the system prompt contains alice's purpose and term and contains neither of bob's.
- Given the survivor's owner has a CORRUPT `names-terms.json`, when `mergePages` runs with an LLM key present, then the model is still called exactly once and the survivor's body is the LLM fold — never the raw `into.body` + `from.body` concatenation — and the prompt carries no dictionary block.
- Given the survivor's owner has an unreadable workspace PROFILE, when `mergePages` runs, then the model is still called exactly once and the survivor carries the folded body.
- Given a merge whose survivor owner has a readable dictionary, when `mergePages` folds, then that dictionary file is read exactly once for the whole merge.
- Given `into.frontmatter.owner` is absent and `actor` is set, when `mergePages` runs, then the acting principal's guidance reaches the prompt.
- Given neither `into.frontmatter.owner` nor `actor` is set, when `mergePages` runs, then the prompt is the base reconcile prompt with no guidance blocks.
- Given the survivor owner's dictionary PARSES but holds a malformed entry (a `null`, or an entry with no `aliases`), when `mergePages` runs, then the model is still called exactly once and the survivor's body is the LLM fold — the probe must cover the render layer, not just the read layer.
- Given the survivor's owner has a Workspace Purpose but NO dictionary file at all, when `mergePages` runs, then the owner is NOT dropped: the prompt still carries the `WORKSPACE PURPOSE` block and carries no dictionary block.
- Given an ownerless survivor and a whitespace-only `actor`, when `mergePages` runs, then no guidance reaches the prompt — in particular not the DEFAULT tenant's, even when the default tenant has a Purpose and a dictionary on disk.
- Given two merges run in sequence with a different Workspace Purpose saved between them, when the second folds, then its prompt carries the NEW purpose — the handle is per-merge, never shared.
- Given `hasLLMKey()` is false, when `mergePages` runs, then no reconcile LLM call is made and the bodies are appended — unchanged from today.
- Given the whole change, when `pnpm exec vitest run --project node src/lib/__tests__/merge.test.ts` and `pnpm exec tsc --noEmit` run, then both pass with no new failures.

## Spec Change Log

### 2026-08-29 — Review pass 1 (bad_spec loopback)

**Triggering finding (high):** Attaching an owner to the merge door's `reconcilePage` call made the fold newly dependent on TWO stores being readable, and only one of them fails soft. `buildWorkspaceGuidance` catches and returns `""` (`src/lib/workspace-guidance.ts:86-94`), but `buildNamesTermsGuidance` → `listNamesTerms` → `readEntries` (`src/lib/names-terms.ts:170-177`) ENOENT-degrades to `[]` and RETHROWS everything else, including a `JSON.parse` SyntaxError from a corrupt dictionary. `reconcilePage` awaits both in one unguarded `Promise.all` BEFORE `callLLM`, so the rejection escaped into merge.ts's existing `catch`, which appends the raw bodies — and that concatenation is written into `MergeOperationReceipt.mergedContent`, the merge's linearization point, so a Retry replays it and never re-folds while `from` stays deleted.

**Confirmed by probe, not inference.** With `tenants/alice/names-terms.json` set to `{not json`: on the first pass's code, `callLLM` calls = 0 and the survivor body was `"# Agent Harness\n\nContent about Agent Harness.\n\n# Harness AI Agents\n\nContent about Harness AI Agents."`. On the pre-change baseline (same corrupt file), `callLLM` calls = 1 and the survivor body was the fold. A regression introduced by this story, not a pre-existing condition.

**What was amended (all outside `<intent-contract>`):**
- Code Map now records the `readEntries` rethrow-vs-fail-soft asymmetry, `listNamesTerms`'s cache door, and the durability of `MergeOperationReceipt.mergedContent`. Their absence is why the first pass could not see the hazard.
- Tasks now require the fail-soft dictionary probe before the fold, and the header comment now must claim PRESENCE parity only (the ingest door passes the ACTING principal, the merge door the SURVIVOR's owner — the doors still differ on attribution, and the first pass's header overclaimed "exactly like ... one standard whichever door").
- Tasks and Acceptance now require tests the first pass lacked or wrote non-discriminatingly: a corrupt-dictionary fold, a one-read assertion for the handle, a positive base-prompt assertion in the no-owner case, dictionary terms disjoint from the Purpose text, a dictionary in the cross-owner case, an asserted premise for the ownerless helper, and a mutation check.

**Known-bad state avoided:** a merge run against a corrupt or transiently unreadable `names-terms.json` silently shipping an unfolded, double-titled survivor page, baked permanently into the merge receipt, with the absorbed page already deleted.

**KEEP (must survive re-derivation):**
- `const guidanceOwner = asString(into.frontmatter.owner) ?? actor;` — the resolution order itself was correct and is what the recorded decision mandates. `asString` correctly rejects `""` and whitespace so a blank frontmatter owner falls through to `actor`.
- Keeping the change entirely inside `mergePagesWhileSourceLocked`: no `reconcilePage` signature change, no `MergePagesArgs` field, no edit to `ingest.ts`, no touch to the artifact / same-owner / public→private guards.
- The dense call-site comment explaining WHY the survivor's owner governs (the prose lives in that owner's workspace; the actor under `bypassOwnerCheck` may be a service principal). Reuse its substance.
- The test block's structure and its `seedGuidance` / ownerless-page helpers, the `reconcileSystemPrompt()` accessor, and the `_resetLocks()` bracketing — all sound. Strengthen the assertions; do not restart from scratch.
- The cross-owner test's shape (alice survivor, bob absorbed, `actor: "bob"`, `bypassOwnerCheck: true`) — it was verified load-bearing by mutation and is the test the ledger's decision explicitly asked for.

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 2: (high 1, medium 1, low 0)
- patch: 0
- defer: 1: (high 0, medium 1, low 0)
- reject: 12: (high 0, medium 3, low 9)
- addressed_findings:
  - `[high]` `[bad_spec]` Attaching an owner made the fold depend on `buildNamesTermsGuidance`, which rejects on a corrupt/unreadable `names-terms.json` while its workspace sibling fail-softs; the rejection escaped into merge.ts's existing `catch` and baked a raw body concatenation into the durable merge receipt. Confirmed by probe (0 LLM calls post-change vs 1 pre-change on the same corrupt file). Spec amended (Code Map, Tasks, Acceptance, Design Notes) to require a fail-soft dictionary probe under the shared handle; code reverted for re-derivation.
  - `[medium]` `[bad_spec]` Test block was partly non-discriminating: the dictionary assertion was satisfied by the Purpose text (`"Project Lighthouse"` occurred in both), two of five tests passed against the pre-change code, the ownerless-page helper never asserted its own premise, the cross-owner case never covered the dictionary, and the module header overclaimed door parity ("exactly like ... one standard whichever door") when the ingest door passes the ACTING principal and the merge door the SURVIVOR's owner. Spec amended with explicit per-test requirements and a mutation check; code reverted for re-derivation.

### 2026-08-29 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 1, medium 1, low 4)
- defer: 0
- reject: 17: (high 0, medium 4, low 13)
- addressed_findings:
  - `[high]` `[patch]` The pre-fold probe targeted `listNamesTerms`, one layer too shallow. A dictionary that PARSES but holds a malformed entry (`[null]`, or an entry with no `aliases`) resolves fine there — `resolveSortedEntries` only skips FREEZING such an element, it does not filter it — and throws later in `renderNamesTermsGuidance` inside `reconcilePage`'s `Promise.all`, so the exact regression the probe exists to prevent still shipped. Confirmed by probe: both shapes gave 0 LLM calls and a raw-concatenation survivor. Fixed by probing `buildNamesTermsGuidance` (read + sort + render — exactly what the fold consumes). Mutation-verified: reverting the probe target fails the two new malformed-entry tests.
  - `[medium]` `[patch]` `actor` was not run through `asString`, so a whitespace-only actor stayed truthy and `ownerToTenant` collapsed it onto `DEFAULT_TENANT` — the default silo's Purpose and dictionary would have governed a fold that named no principal. Fixed to `asString(into.frontmatter.owner) ?? asString(actor)`. Mutation-verified against a test that seeds real guidance under the default tenant.
  - `[low]` `[patch]` Corrupt-dictionary test covered only the JSON-parse shape; parameterized over `"{not json"`, `"[null]"`, and a field-less entry.
  - `[low]` `[patch]` No test covered the common production shape of a Purpose with NO dictionary (ENOENT), where the probe must leave the owner alone; added.
  - `[low]` `[patch]` No test pinned the whitespace-actor hazard; added, seeding the default tenant's own guidance so it cannot pass vacuously.
  - `[low]` `[patch]` Nothing pinned the intent's "fresh cache per merge" claim; added a test that saves a new Purpose between two merges and asserts the second fold sees it.


## Design Notes

**Why the survivor's owner, not the actor.** `mergePages` deletes `from` and keeps `into`; the reconciled prose is written to `into` and lives on in `into`'s owner's wiki. The actor is whoever pressed the button — under `bypassOwnerCheck` that can be a service principal (`src/mcp.ts` passes `actor: "system"`) or another human — and their workspace conventions have no claim on a page they do not own. `actor` remains the fallback because it is the only principal in scope when the survivor's frontmatter has no usable `owner`, and it is already what the same-owner guard compares against.

**Why the dictionary is probed before the fold.** Guidance is an ADDITION to a prompt: losing it must degrade the prompt, never the operation. `buildWorkspaceGuidance` already honours that with an internal `catch`; `buildNamesTermsGuidance` deliberately does not, and `reconcilePage` resolves both together before calling the model. Reading the dictionary first under the same handle costs nothing on the happy path — `listNamesTerms` memoizes the successful read, so `reconcilePage` reuses it rather than reading twice — and on failure it converts an aborted fold into an unguided one. Dropping the Purpose along with the dictionary is a deliberately coarse degrade: the alternative is composing the prompt in `merge.ts`, which would duplicate `reconcilePage`. The probe is also what stops the cache handle from being vacuous — one merge makes exactly one `reconcilePage` call, so without the probe the handle would memoize nothing.

Shape of the change:

```ts
// The merged prose is written to the SURVIVOR and lives on in its owner's
// workspace, so that owner's Purpose and dictionary govern the fold — not the
// actor's, who under `bypassOwnerCheck` may be a service principal. `actor` is
// the fallback: the only principal in scope when `into` names no owner.
let guidanceOwner = asString(into.frontmatter.owner) ?? asString(actor);
const guidance = createGuidanceCache();
if (guidanceOwner) {
  try {
    // `buildNamesTermsGuidance` REJECTS on a damaged dictionary (its workspace
    // sibling fail-softs to ""), and `reconcilePage` awaits both before it
    // calls the model, and can throw at the READ layer or the RENDER layer
    // — so without this the outer `catch` would bake a raw
    // concatenation into the merge receipt forever. Reading here shares the
    // memo on success and drops guidance (not the fold) on failure.
    await buildNamesTermsGuidance(guidanceOwner, guidance.namesTerms);
  } catch (err) {
    logger.warn("merge", `names & terms unreadable for "${guidanceOwner}"; folding unguided`, err);
    guidanceOwner = undefined;
  }
}
const reconciled = await reconcilePage(into.body, from.body, guidanceOwner, guidance);
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/merge.test.ts` -- expected: all tests pass, including the new guidance block.
- `pnpm exec vitest run --project node src/lib/__tests__/ingest.test.ts src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/names-terms.test.ts` -- expected: pass, proving the ingest door, the writer-export inventory, and the dictionary store are untouched.
- `pnpm exec tsc --noEmit` -- expected: no new type errors.
- `pnpm exec eslint src/lib/merge.ts src/lib/__tests__/merge.test.ts` -- expected: clean.
- Mutation check (do not commit): force `guidanceOwner = undefined` at the call site and re-run the new block -- expected: every test whose name claims this change's behaviour FAILS. Restore afterwards and re-run to green.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

The merge door now carries workspace guidance into the reconcile fold, closing DW-323's door asymmetry. `mergePagesWhileSourceLocked` resolves `guidanceOwner = asString(into.frontmatter.owner) ?? asString(actor)` — the SURVIVOR's owner first, because the merged prose is written to `into` and lives on in that owner's wiki — mints one per-merge `createGuidanceCache()` handle, probes `buildNamesTermsGuidance` under that handle so a damaged dictionary degrades the prompt instead of aborting the fold, and passes owner + handle into `reconcilePage`.

### Files changed

- `src/lib/merge.ts` — owner resolution, per-merge guidance handle, fail-soft dictionary probe, and the guided `reconcilePage` call; module doc header extended to record PRESENCE parity with the ingest door and to state plainly that the two doors still differ on WHICH principal supplies the standard.
- `src/lib/__tests__/merge.test.ts` — new 12-test `describe` block over the composed reconcile system prompt, the durable survivor body, and per-path `storage.readFile` counts.
- `_bmad-output/implementation-artifacts/spec-dw-323-merge-door-workspace-guidance.md` — this spec.

### Review findings breakdown

- Pass 1: 2 bad_spec (1 high, 1 medium) → code reverted, spec amended outside `<intent-contract>`, implementation re-derived. 1 deferred. 12 rejected.
- Pass 2: 6 patches applied (1 high, 1 medium, 4 low). 0 bad_spec, 0 intent_gap. 0 deferred. 17 rejected.
- Deferred (1, medium): agent handles resolve guidance against the agent's own tenant silo rather than the human's, while the same-owner guard collapses them — a codebase-wide convention question, recorded in frontmatter `deferred`.

### Follow-up review recommendation

`true`. Patched findings this pass: high 1, medium 1, low 4. Score `3 × 1 + 1 × 4 = 7` (≥ 5), and a high-severity finding was patched — either condition alone sets it.

### Verification performed

- `pnpm exec vitest run --project node src/lib/__tests__/merge.test.ts` — 46/46 pass.
- `pnpm exec vitest run --project node src/lib/__tests__/ingest.test.ts src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/names-terms.test.ts` — 267/267 pass.
- `pnpm exec tsc --noEmit` — clean. `pnpm exec eslint src/lib/merge.ts src/lib/__tests__/merge.test.ts` — clean.
- Mutation checks run by the orchestrator, each reverted and re-run to green:
  - 3rd argument forced to `undefined` → 5 of the behaviour-claiming tests fail.
  - Probe line deleted → the corrupt-dictionary test fails with `expected "spy" to be called 1 times, but got 0 times`.
  - Probe reverted to `listNamesTerms` → the two malformed-entry tests fail.
  - `asString(actor)` reverted to `actor` → the whitespace-actor test fails.
- Every row of the I/O & Edge-Case Matrix is covered by a named test that ran and passed.

### Residual risks

- The degrade is deliberately coarse: an unreadable dictionary drops the Workspace Purpose too. Keeping one without the other would mean composing the reconcile prompt in `merge.ts`, duplicating `reconcilePage`.
- `renderNamesTermsGuidance` still dereferences `entry.aliases` on entries `resolveSortedEntries` does not filter, so a malformed dictionary entry can still throw at every OTHER guidance site (`chat.ts`, `query.ts`, `source-monitors.ts`, and the three `Promise.all` pairs in `ingest.ts`). This change makes the merge door safe against it; hardening the render layer itself is out of DW-323's scope.
- The doors still differ on attribution: ingest passes the ACTING principal, merge the SURVIVOR's owner. That is what the recorded 2026-08-21 decision directed, and the module header now says so explicitly rather than claiming full parity.
