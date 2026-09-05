---
title: 'DW-725 + DW-749: typed-error and enum guards'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
baseline_revision: 'ea26a9f47b7ae305e28b5d3ed0747ac52e75a197'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized, multiple-goals]
deferred:
  - summary: >-
      `updateAgent`'s `addPages` bucketing has DW-749's hole in a worse form: an
      out-of-enum `type` is filed under `socialPages` by the ternary's final
      `else`, after the page is already written.
    evidence: |-
      `src/lib/agents.ts:845-853` buckets with
      `page.type === "identity" ? … : page.type === "learnings" ? … : existing.socialPages`,
      AFTER `writeWikiPageWithSideEffects` at :826-842. `UpdateAgentPage` is the same
      `{slug,title,type,content}` shape as `SeedAgentSection` and lands in the same three
      `AgentProfile` lists. Two doors reach it unvalidated, not one: the HTTP MCP gate
      declares the same `enum` at `src/lib/mcp-http.ts:986` but does not judge `enum`
      members by design (DW-563), `handleUpdateAgent` (`src/mcp.ts:1041-1055`) passes
      `addPages` through, and `PUT /api/agents/[id]` validates eight other fields then
      calls `updateAgent(id, body)` with no `addPages` check at all
      (`src/app/api/agents/[id]/route.ts:156-257`) — weaker than `POST /api/agents/seed`,
      whose per-index check this bundle's sentence copies. Only the stdio door refuses,
      at `src/mcp.ts:2482`. Consequence is worse than the seed hole this bundle closed:
      seedAgent left a written page in NO list, updateAgent files it under a list the
      caller never asked for, and `resolveAgentPages` (`src/lib/agents.ts:480,489`) then
      ships it into every `agent_context` bootstrap as social wisdom. No test anywhere
      sends a non-enum `type` through this arm — every `addPages` row in
      `agents.test.ts` (:905-931, :933-957, :961-980, :1569-1600) uses a valid type, and
      `agents-id-route.test.ts` never mentions `addPages`. Out of scope here: the bundle
      intent and DW-749 both name `seedAgent`'s section switch alone.
    location: >-
      src/lib/agents.ts:845
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two guards trust a shape they cannot enforce. `isInfrastructureFault` (`src/lib/errors.ts:110`) still leads with `error instanceof StoreFaultError` — the identity check DW-578 already removed from `isClientInputError` three functions above it — so a `StoreFaultError` from a second copy of the module carries no errno `code`, answers `false`, and `src/app/api/tasks/run/route.ts:953` drops a retryable fault onto the `/not found/i` 422 below it. `seedAgent`'s section-bucketing `switch` (`src/lib/agents.ts:996-1006`) has no `default` arm, so a section `type` outside the declared enum — reachable through the HTTP MCP door alone, whose gate does not judge `enum` members by design — writes the wiki page and then buckets its slug into none of the profile's three page lists.

**Approach:** Make `isInfrastructureFault`'s typed branch structural on `err.name`, exactly as its sibling `isClientInputError` is. In `seedAgent`, hoist the bucketing `switch` into a pass over all sections that runs BEFORE the write loop, and give it a `default` arm that throws a `ClientInputError` naming the three valid types — so the whole seed is refused before any page is written, and the three doors agree on the outcome.

## Boundaries & Constraints

**Always:**
- `instanceof Error` stays proven BEFORE any property (`name`, `code`) is read on a caught value — the classifier runs in a route catch block where the value is arbitrary and a getter can throw.
- `seedAgent`'s refusal sentence matches the REST door's verbatim: `` Section at index <i> has invalid 'type' — must be one of: identity, learnings, social `` (note the en dash, matching `src/app/api/agents/seed/route.ts:88-95`).
- The refusal is thrown before the write loop starts, so a bogus type at index 2 leaves index 0 and 1 unwritten too.
- Every existing assertion in `src/lib/__tests__/errors.test.ts`, `agents.test.ts`, and `mcp-http.test.ts` keeps passing unchanged.

**Block If:**
- Closing either guard would require changing `validateToolArguments`'s documented no-`enum`-judgement scope in `src/lib/mcp-http.ts` (it must not).
- Making the bucketing pre-loop would change what a MULTI-section seed persists on a mid-loop WRITE failure (it must not: nothing is registered in either case).

**Never:**
- Do not teach the HTTP MCP gate (`validateToolArguments`) to judge `enum`, string formats, ranges, or numeric bounds — its Never clause from DW-563 stands.
- Do not touch the stdio door's `z.enum` (`src/mcp.ts:2402`) or the REST door's per-index validation (`src/app/api/agents/seed/route.ts:88`) — both already refuse this body correctly.
- Do not touch `updateAgent`'s `addPages` ternary (`src/lib/agents.ts:845-850`) — a different call site the ledger does not name.
- Do not widen `isInfrastructureFault`'s errno probe (no `cause` unwrapping, no `_` in the code class) — DW-685 recorded both limits as deliberate.
- Do not add an unreachable `default` arm alongside a separate pre-check: one reachable guard, not two.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Foreign-copy store fault | `Object.assign(new Error("boom"), { name: "StoreFaultError" })`, not an instance of the imported class | `isInfrastructureFault` → `true` | No error expected |
| Own-copy store fault | `new StoreFaultError("…")` | `isInfrastructureFault` → `true` (unchanged) | No error expected |
| Hostile non-Error | `{ get name() { throw … } }` and `{ get code() { throw … } }` | `isInfrastructureFault` → `false`, no throw | Classifier never reads the getter |
| Client-input error | `new ClientInputError("Invalid slug: 'a b'")` | `isInfrastructureFault` → `false` (unchanged) | No error expected |
| Foreign-copy fault at the task door | `POST /api/tasks/run` for a `run-research` task whose runner rejects with a foreign-copy `StoreFaultError` worded `"…file not found on this volume."` | `500` (transient → bounded queue retry), NOT the `/not found/i` 422 | Route body carries the fault's own message |
| Bogus section type, sole section | `seedAgent({ sections: [{ type: "bogus", slug: "x", … }] })` | Rejects; no wiki page `x`; no agent profile registered | `ClientInputError`, message names index 0 and the three types |
| Bogus section type, second of two | `sections: [{type:"identity",slug:"a"}, {type:"bogus",slug:"b"}]` | Rejects; NEITHER `a` nor `b` written | Same sentence, index 1 |
| Bogus type at the HTTP MCP door | `tools/call seed_agent` with `sections:[{…,type:"bogus",…}]` | `isError` result whose text is `Error: Section at index 0 has invalid 'type' — …` | Gate stays silent; the handler answers |
| Valid mixed sections | one each of `identity`/`learnings`/`social` | All three pages written, each slug in its own list | No error expected |

</intent-contract>

## Code Map

- `src/lib/errors.ts:104-118` -- `isInfrastructureFault`; line 110 is the `error instanceof StoreFaultError` arm to replace. Its doc block (lines 68-103) already explains the two deliberate errno limits — extend it with the DW-725 reasoning, don't rewrite it.
- `src/lib/errors.ts:28-50` -- `isClientInputError`, the precedent: `err instanceof Error && err.name === "ClientInputError"`, plus the doc block spelling out why (duplicated module graph; `instanceof Error` proven before `name`). Mirror its shape and cite it.
- `src/lib/read-only.ts:479-481` -- `isReadOnlyError`, the same two-clause structural shape.
- `src/app/api/tasks/run/route.ts:940-956` -- the call site the fault classification protects: the infrastructure 500 sits AHEAD of the `/not found/i` 422 poison row. Read-only for this spec; no change.
- `src/lib/agents.ts:866-878` -- `SeedAgentSection` (`type: "identity" | "learnings" | "social"`) and `SeedAgentOptions`.
- `src/lib/agents.ts:906-1006` -- `seedAgent`: validation preamble (906-914), the accumulator arrays `identityPages`/`learningPages`/`socialPages` (920-922), `hubSlug` (925), the write loop (927-1006), and the bucketing `switch` at 995-1006 to hoist. `registerAgent(profile)` at ~1035 is the only reader of the three arrays.
- `src/lib/agents.ts:14` -- existing `import { isEnoent } from "./errors";` — add `ClientInputError` here.
- `src/app/api/agents/seed/route.ts:7,88-95` -- `VALID_SECTION_TYPES` and the REST refusal sentence to match verbatim. Read-only; it already refuses.
- `src/mcp.ts:2402` -- stdio `z.enum(["identity","learnings","social"])`. Read-only; already refuses.
- `src/mcp.ts:990-1016` -- `handleSeedAgent`: maps and delegates, validates nothing. The HTTP door's path into `seedAgent`.
- `src/lib/mcp-http.ts:229-236` -- the gate's Never clause naming `seed_agent … type:"bogus"` as out of scope. Read-only; must stay true.
- `src/lib/mcp-http.ts:1311-1318` -- the dispatch `catch` that renders any thrown error as `Error: <message>` with `isError: true`. This is why no new message plumbing is needed.
- `src/lib/__tests__/errors.test.ts:159-231` -- `isInfrastructureFault` block; `243-282` -- the `isClientInputError` structural block whose foreign-realm row is the template for the new one.
- `src/lib/__tests__/agents.test.ts:528-742` -- `seedAgent` describe block; `698-724` is the `validates required fields` row to extend beside.
- `src/lib/__tests__/mcp-http.test.ts:1307-1323` -- the existing negative row "does not judge an element's `enum` member". Its assertions are negative (`not.toContain`), so they survive; add the positive handler-refusal row beside it.
- `src/lib/__tests__/tasks-route.test.ts:851-890` -- the `describe("a run-research task whose project store refuses")` block, with its `run()` helper, `RESEARCH_TASK` fixture and `mockedRunResearch`. The existing rows already pin own-copy `StoreFaultError` → 500; the foreign-copy row belongs beside them.

## Tasks & Acceptance

**Execution:**
- `src/lib/errors.ts` -- replace `isInfrastructureFault`'s `error instanceof StoreFaultError` first line with an `err.name === "StoreFaultError"` arm placed after the existing `instanceof Error` proof, and extend the doc block with the DW-725 reasoning (cite `isClientInputError` as the sibling) -- a foreign-copy `StoreFaultError` must not fall through to the 422 poison row.
- `src/lib/agents.ts` -- import `ClientInputError`; hoist the section-bucketing `switch` out of the write loop into a pass over `options.sections` placed before the loop, and add a `default` arm that throws `ClientInputError` with the REST door's sentence and the section's index -- refuses the whole seed before any page is written and makes the three doors agree.
- `src/lib/__tests__/errors.test.ts` -- add rows to the `isInfrastructureFault` block for the foreign-copy `StoreFaultError` (with a `not.toBeInstanceOf(StoreFaultError)` assertion beside it) and for a hostile `name` getter on a non-Error -- pins the structural claim the way DW-578 pinned the sibling.
- `src/lib/__tests__/agents.test.ts` -- add `seedAgent` rows for the sole-bogus-section case and the bogus-at-index-1 case, asserting the message AND that no wiki page was written for either slug -- the "before any page is written" half is the part a message-only assertion would miss.
- `src/lib/__tests__/mcp-http.test.ts` -- add a row beside the existing enum-negative one asserting the HTTP door returns `isError` with the handler's sentence for a bogus-type body -- the decision's "pin the bogus-type body at the HTTP door".
- `src/lib/__tests__/tasks-route.test.ts` -- add a row to the store-refusal block for a FOREIGN-COPY `StoreFaultError` worded like a miss, asserting `500` -- the route's status is the surface DW-725 names as harmed; a classifier-only assertion would not see the 422 poison.

**Acceptance Criteria:**
- Given a `run-research` task whose runner rejects with a foreign-copy `StoreFaultError` whose message reads "not found", when `POST /api/tasks/run` handles it, then the response is `500` (bounded retry) rather than the `/not found/i` 422 poison.
- Given a `StoreFaultError`-shaped error from a second copy of `src/lib/errors.ts`, when `isInfrastructureFault` classifies it, then it answers `true` even though `instanceof StoreFaultError` is `false`.
- Given `src/lib/mcp-http.ts`'s `validateToolArguments` and its doc block, when this change lands, then neither is modified and the gate still admits `type: "bogus"` silently.
- Given a `seed_agent` call at the HTTP MCP door carrying a section `type` outside the enum, when it is dispatched, then the response is an `isError` tool result naming the three valid types, and `getAgent` finds no profile and `readWikiPage` finds no page for any slug in that call.

## Design Notes

Hoisting the `switch` — rather than adding a `default` arm where it stands — is what makes the two halves of the recorded decision compatible. The `switch` currently runs at the END of each iteration, ten lines after `writeWikiPageWithSideEffects`, so a `default` arm there would refuse only AFTER the page it rejects was already written. Moving the whole bucketing pass ahead of the write loop keeps it one guard (reachable, testable, no dead limb) and satisfies "before any page is written":

```ts
// Bucket every slug BEFORE any page is written, so a section type outside the
// declared enum refuses the WHOLE seed rather than leaving a written page in
// no list (DW-749). The HTTP MCP gate does not judge `enum` members by design,
// so this is the only door-side refusal on that path.
options.sections.forEach((section, i) => {
  switch (section.type) {
    case "identity": identityPages.push(section.slug); break;
    case "learnings": learningPages.push(section.slug); break;
    case "social": socialPages.push(section.slug); break;
    default:
      throw new ClientInputError(
        `Section at index ${i} has invalid 'type' — must be one of: identity, learnings, social`,
      );
  }
});
```

Nothing between the old and new positions reads the three arrays — `registerAgent(profile)` after the loop is their only consumer, and `hubSlug`/`relatedSectionLinks` read `options.sections` directly — so on a mid-loop WRITE failure the observable outcome is unchanged: the throw escapes before `registerAgent`, and no profile is persisted either way.

For `isInfrastructureFault`, dropping `instanceof` entirely (rather than keeping both arms) is the sibling's shape: an own-copy `StoreFaultError` sets `this.name = "StoreFaultError"` in its constructor, nothing in the repo subclasses it, and a kept `instanceof` arm would be the exact line DW-578's precedent says is unreliable.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/errors.test.ts src/lib/__tests__/agents.test.ts src/lib/__tests__/mcp-http.test.ts src/lib/__tests__/seed-route.test.ts src/lib/__tests__/mcp.test.ts src/lib/__tests__/tasks-route.test.ts` -- expected: all pass, including the new rows.
- `pnpm exec tsc --noEmit` -- expected: no errors (the `default` arm must not break the union's narrowing).
- `pnpm lint` -- expected: clean.
- `pnpm vitest run` -- expected: no regression anywhere else in the suite.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Two guards that trusted a shape they could not enforce. `isInfrastructureFault`'s typed branch is now structural (`error.name === "StoreFaultError"`) instead of an identity check, placed after the `instanceof Error` proof — the same shape DW-578 gave the sibling `isClientInputError`, so a `StoreFaultError` from a second module copy no longer falls through to `false` and onto `POST /api/tasks/run`'s `/not found/i` 422. `seedAgent`'s section-bucketing `switch` was hoisted out of the tail of the write loop into an indexed pass ahead of it, with a `default` arm throwing `ClientInputError` carrying `POST /api/agents/seed`'s sentence verbatim — so an out-of-enum `type` arriving through the HTTP MCP door (the only door whose gate does not judge `enum` members) refuses the whole seed before any page is written, instead of writing a page bucketed into no list.

**Files changed.**
- `src/lib/errors.ts` -- `isInfrastructureFault` typed branch made structural; docblock extended with the DW-725 reasoning. Both errno limits untouched.
- `src/lib/agents.ts` -- imported `ClientInputError`; bucketing pass hoisted ahead of the write loop with a `default` refusal arm.
- `src/lib/__tests__/errors.test.ts` -- foreign-copy `StoreFaultError` row; hostile/plain `name` on a non-Error.
- `src/lib/__tests__/agents.test.ts` -- sole-bogus and bogus-at-index-1 rows (message, type, no page, no profile); mid-loop write-failure preservation row.
- `src/lib/__tests__/mcp-http.test.ts` -- positive HTTP-door row beside the pre-existing enum-negative one, covering both the index-1 and sole index-0 bodies.
- `src/lib/__tests__/tasks-route.test.ts` -- foreign-copy store fault worded like a miss answers 500, not the 422 poison.
- `src/lib/__tests__/seed-route.test.ts` -- cross-file sentence-parity row.

**Review findings breakdown.** 4 patches applied (all low), 1 item deferred (low), 6 rejected. Rejected: the REST door's message-matching catch cannot classify the new `ClientInputError` (unreachable today — the route pre-validates `type` per index, and touching that route is barred by the intent); the reviewer's claim that no ledger/spec record exists (information asymmetry — the spec record is this file, and the ledger is orchestrator-owned); empty-string `slug`/`title`/`content` diverging across the same three doors (adjacent residue the bundle did not name); a throwing `name` getter on a real `Error` (identical exposure to the established sibling, whose guard is documented as scoped to non-Errors on purpose); losing `StoreFaultError` subclasses by dropping `instanceof` (none exists; the constructor sets `name`; the two readings agree on every reachable input); duplicate slugs across two sections (pre-existing, unchanged by the hoist).

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 0, low 4. Score: no high-severity patch, so no further loop.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/{errors,agents,mcp-http,seed-route,mcp,tasks-route}.test.ts` -- 6 files, 656 tests passed.
- `pnpm exec tsc --noEmit` -- clean.
- `pnpm lint` -- clean (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, unrelated to these files).
- `pnpm vitest run` (full) -- 386 files, 9693 passed, 1 skipped, 0 failed.
- Matrix audit: all nine I/O rows are covered by a test that ran and passed in the output above.

**Residual risks.**
- The foreign-copy rows fabricate `Object.assign(new Error(...), { name: "StoreFaultError" })` rather than loading a second copy of `errors.ts`, so the pinned claim is "an Error *named* `StoreFaultError` classifies", not "a foreign module copy classifies". This is the same surrogate DW-578 accepted for the sibling; the real duplicated-graph failure stays unreproducible in test.
- `isInfrastructureFault` is also read at `src/app/api/monitors/route.ts:59`, `src/app/api/system/evaluations/route.ts:63` and `src/app/api/review/proposals/route.ts:84`. The change strictly widens what they classify as a retryable 500 — consistent with the intent's direction, but the intent named only `tasks/run` and no row exercises the new arm at those three doors.
- The refusal sentence is duplicated across `src/lib/agents.ts` and `src/app/api/agents/seed/route.ts` rather than shared through a constant. A constant would have to live in or be imported by the route, which the intent placed out of scope; the new parity row is the drift guard instead.
