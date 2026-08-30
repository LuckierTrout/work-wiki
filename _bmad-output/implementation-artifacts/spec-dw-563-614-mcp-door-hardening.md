---
title: 'One argument gate at the HTTP MCP door, one definition of the service prefix'
type: 'bugfix'
created: '2026-08-30'
baseline_revision: '72dabfb19883e0e1b212bd1f557fa52bdf44b103'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      Array elements declared as objects reach the handler unchecked, and
      `seed_agent` answers a malformed section with a TypeError the stdio door
      refuses cleanly at zod.
    evidence: |-
      The HTTP gate reads `items.type` only for primitive elements, by design.
      Two reviewers independently drove `seed_agent {agent_id, name,
      description, sections:[{slug:"s"}]}` through `dispatchMcp` and got
      `Error: Cannot read properties of undefined (reading 'split')`, thrown by
      `section.content.split` in `src/lib/agents.ts`. The stdio door refuses the
      same body at `z.object({...})`. `handleSeedAgent` validates nothing — it
      maps and delegates — so nothing between the wire and `agents.ts` speaks
      for the nested `required: ["slug","title","type","content"]` that the
      schema already declares. Pre-existing (the crash predates this change);
      surfaced because the gate's doc block had to state what it does not cover.
      Same shape for `update_agent.addPages`.
    location: >-
      src/lib/mcp-http.ts (validateToolArguments) + src/mcp.ts handleSeedAgent
    severity: medium
  - summary: >-
      The HTTP `inputSchema` declarations are now enforced at runtime, but
      nothing pins them against the stdio door's zod schemas they are supposed
      to mirror.
    evidence: |-
      `MCP_TOOLS ↔ stdio registration parity` compares tool names, the
      `write`/`readOnlyHint` flag, and (new) that every `required` name is a
      declared property with a decidable `type`. It does not compare the two
      doors' `required` lists or declared types. Before this change a drift
      there was cosmetic; now a field the HTTP schema calls `required` while the
      stdio zod calls it `.optional()`, or a `number` against a `z.string()`,
      refuses every real call to that tool at one door only. A hand comparison
      of ~11 fields found no live disagreement, so this is an unpinned risk
      rather than a present defect, and seven tools have no authenticated
      door-level row that would notice.
    location: >-
      src/lib/__tests__/mcp-http.test.ts (MCP_TOOLS ↔ stdio registration parity)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `dispatchMcp` hands `params.arguments` straight to `tool.run` with no runtime check, so ~nine sibling handlers spread-and-cast malformed `tools/call` input as if it were trusted — `batch_ingest_urls` with `urls: "https://x"` reaches `handleBatchIngest`, where a string is array-like enough to be reported back as `Malformed URLs at indices 0, 1, 2…`, and `urls: undefined` throws; the stdio door catches both at `z.array(z.string())`. Separately, `src/mcp.ts` mints `service:mcp` from three raw string literals instead of the shared `SERVICE_PRINCIPAL_ID_PREFIX` that exists to give that prefix one definition.

**Approach:** Validate `params.arguments` once in `dispatchMcp`, generically, against the `ToolDef.inputSchema` each tool already declares (`required` list plus each declared property's `type`), before `tool.run` is reached; and mint the stdio door's service principal id from the shared prefix.

## Boundaries & Constraints

**Always:**
- The gate reads only what the schemas already declare — `required`, each property's `type`, and (for arrays whose `items.type` is a primitive) the element type. No new schema fields, no per-tool special cases.
- Refusal wording follows the vocabulary the doors already share: `Missing required field: <name>` (`src/lib/lint-fix.ts`) and ``Invalid request field `<name>`: expected <type>`` (`src/app/api/lint/fix/route.ts`, `src/lib/mcp-http.ts:545`).
- Undeclared properties pass through untouched — neither rejected nor stripped. `vault_curate` is called with an undeclared `owner` today and must keep reaching `run`, which overrides it from the principal.
- Absent and `undefined` are "unset"; an explicit `null` is a value and is refused, exactly as `LINT_FIX_REQUEST`'s `z.string().optional()` answers it.
- The gate runs AFTER the existing unknown-tool and missing-principal checks, and its refusal surfaces the same way every other tool failure does: an `isError` tool result, not a JSON-RPC error.
- `service:mcp` keeps its exact current value at all three sites.

**Block If:**
- Applying the gate would change the answer of an existing `mcp-http.test.ts` row in a way the ledger entries do not ask for (i.e. a currently-valid call becomes a refusal).

**Never:**
- Do not validate `enum` members, string formats, ranges, or nested-object properties — `fix_lint_issue` enforces its own `enum` in `run` (`autoFixRefusal`) and keeps doing so.
- Do not reject or strip unknown keys.
- Do not touch the stdio door's zod schemas, `mcp.json`, or the tool inventory.
- Do not rename `service:mcp`, `yopedia`, or any frozen identifier (AGENTS.md).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid call | `batch_ingest_urls` `{urls:["https://a"]}` | reaches `handleBatchIngest` unchanged | No error expected |
| Wrong declared type | `batch_ingest_urls` `{urls:"https://x"}` | refused at the door; handler never runs | `isError` result: ``Error: Invalid request field `urls`: expected array`` |
| Missing required | `batch_ingest_urls` `{}` | refused at the door | `isError` result: `Error: Missing required field: urls` |
| Explicit null on a required field | `read_page` `{slug:null}` | refused at the door | `isError` result: ``Error: Invalid request field `slug`: expected string`` |
| Bad array element | `create_page` `{slug:"s",content:"c",tags:[1]}` | refused at the door | `isError` result: ``Error: Invalid request field `tags[0]`: expected string`` |
| Undeclared extra key | `vault_curate` `{slug,vault,owner:"evil"}` | reaches `run`; `owner` overridden by principal | No error expected |
| Absent optional | `fix_lint_issue` `{type:"orphan-page",slug:"absent-page"}` | reaches the dispatcher with `target`/`message` `undefined` | Handler's own `Page not found` |
| `arguments` not an object | `read_page`, `arguments: "slug"` | refused at the door | `isError` result: `Error: Invalid request arguments: expected a JSON object` |
| Unauthenticated + invalid args | any tool, no principal | auth refusal still wins | `Authentication required: …` |

</intent-contract>

## Code Map

- `src/lib/mcp-http.ts` — the door. `ToolDef` (l.128) declares `inputSchema: Record<string, unknown>`; `schema(props, required)` (l.137) builds `{type:"object", properties, required?}`; `MCP_TOOLS` (l.159–970) is the 40-tool table. `dispatchMcp`'s `tools/call` arm (l.1064–1092) finds the tool, refuses a missing principal, then `await tool.run(params.arguments ?? {}, principal)` inside a `try` whose `catch` renders `Error: <message>` as an `isError` tool result — that is where the gate goes, immediately after the principal check.
- `src/lib/mcp-http.ts:520-568` — `fix_lint_issue`'s `run`: the per-tool `optionalString` helper DW-455 added for `slug`/`target`/`message`, plus the comment block explaining why the transport could not do it generically. The generic gate subsumes it, message for message; the comment must stop claiming `tools/call` validates nothing.
- `src/lib/mcp-http.ts:500-505` — the `enum` comment on `fix_lint_issue.type` ("an `enum` here is documentation for the agent, not a gate"). Still true — the gate checks `type`, not `enum` — but it says "with no schema validation at all on this transport", which stops being true.
- `src/app/api/lint/fix/route.ts:36-42` — `fieldMessage`: the ``Invalid request field `x`: …`` wording to mirror.
- `src/lib/lint-fix.ts:57` — `Missing required field: <name>`, the other half of the shared vocabulary.
- `src/lib/__tests__/mcp-http.test.ts` — the door's suite. `MCP_TOOLS ↔ stdio registration parity` (l.138) is where a schema-shape invariant belongs; `call`/`errorText` helpers (l.746–760) are scoped inside the `fix_lint_issue` describe; the `type` gate comment (l.767–773) asserts in prose that `tools/call` does NO validation and must be corrected; the string-field rows (l.863–927) and the DW-457 rows (l.931–975) must keep passing verbatim.
- `src/mcp.ts:296,374,398` — the three `{ id: "service:mcp", handle: args.author ?? "system" }` literals (in `handleUpdatePage`, `handleUpdateMetadata`, `handleDeletePage`). Imports are relative (`./lib/...`).
- `src/lib/principal-id.ts` — `SERVICE_PRINCIPAL_ID_PREFIX` and the doc comment that already names `service:mcp` as one of the synthesized shapes. No imports; safe for both the stdio script and client bundles.
- `src/lib/auth.ts:204` — the other mint: `` `${SERVICE_PRINCIPAL_ID_PREFIX}${handle}` ``. Second caller that justifies a `servicePrincipalId()` helper.
- Read-only evidence: `src/lib/__tests__/owner-gate-parity.test.ts:164`, `owner-handle.test.ts:139,187`, `patch-metadata.test.ts:264` all spell `"service:mcp"` as a literal — they pin the VALUE from outside, so they must stay untouched and keep passing.

## Tasks & Acceptance

**Execution:**
- `src/lib/principal-id.ts` — add `servicePrincipalId(handle: string): string` returning `` `${SERVICE_PRINCIPAL_ID_PREFIX}${handle}` ``, documented as the one mint path paired with `isServicePrincipalId` — so the prefix has one definition and one construction site.
- `src/lib/auth.ts` — mint through `servicePrincipalId(handle)` at l.204 instead of interpolating the prefix inline; value unchanged.
- `src/mcp.ts` — import `servicePrincipalId`, define one module-level constant for the stdio door's system caller (`service:mcp`), and use it at l.296, l.374, l.398 — three literals become one named id.
- `src/lib/mcp-http.ts` — add a module-private `validateToolArguments(inputSchema, args): string | null` that returns a refusal sentence or `null`, and call it in `dispatchMcp`'s `tools/call` arm after the principal check and before `tool.run`, throwing the sentence so the existing `catch` renders it. Then delete `fix_lint_issue`'s now-redundant `optionalString` helper, reading the three strings directly, and correct the two comments (l.500-505, l.520-535) so neither still claims this transport validates nothing.
- `src/lib/__tests__/mcp-http.test.ts` — add a `dispatchMcp — the argument gate` describe covering every I/O Matrix row through `dispatchMcp` (the door, not the helper), add a schema-shape invariant to the parity describe (every name in a `required` list is a declared property), and update the `type` gate comment at l.767–773 to say where the generic gate now sits.

**Acceptance Criteria:**
- Given a `tools/call` for a tool whose declared type the arguments violate, when `dispatchMcp` handles it, then it answers an `isError` tool result naming the field and the expected type, and the tool's handler is never invoked.
- Given a `tools/call` missing a name from the tool's `required` list, when `dispatchMcp` handles it, then it answers `Missing required field: <name>` as an `isError` result without invoking the handler.
- Given `params.arguments` that is absent or `{}` for a tool with an empty `required` list (e.g. `list_agents`, `wiki_graph`), when `dispatchMcp` handles it, then the call still reaches the handler and succeeds as before.
- Given a `tools/call` with no principal and invalid arguments, when `dispatchMcp` handles it, then the answer is still the authentication refusal.
- Given every `ToolDef` in `MCP_TOOLS`, when the parity suite reads its `inputSchema`, then every name in `required` is present in `properties`.
- Given the whole existing `mcp-http.test.ts` and `mcp.test.ts` suites, when they run, then every row that passed at `72dabfb1` still passes.
- Given `src/mcp.ts`, when it is scanned for `"service:mcp"`, then no raw literal remains and the minted id is still exactly `service:mcp` (proved by the untouched `owner-gate-parity` / `patch-metadata` suites passing).

## Spec Change Log

- 2026-08-30 -- Implementation. Two rows of `mcp-http.test.ts`'s `fix_lint_issue > the type gate` `it.each` (l.799) had to move, because the generic gate answers them earlier and with a different sentence: `{type:["orphan-page"],slug:"p"}` is now ``Invalid request field `type`: expected string`` and `{slug:"p"}` is now `Missing required field: type`, where both previously read `Auto-fix not supported for this issue type` from `autoFixRefusal`. Neither is a currently-VALID call becoming a refusal, so the Block If does not fire -- both were already refusals, both are still refused, both still prove the dispatcher was never reached, and the new sentences name the offending field where the old ones did not. They were split into a sibling `it.each` asserting the door's wording, with the two rows the `enum`/prototype-chain gate still owns (`made-up-type`, `constructor`) left verbatim in the original block. The `describe`'s doc comment and the `string-field gate` doc comment (l.849) were also corrected: both asserted in prose that `dispatchMcp` validates nothing.

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 5, low 5)
- defer: 2: (high 0, medium 2, low 0)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` A declared `type` outside what the gate can decide (`integer`, a `["string","null"]` union) would have refused every value and made that tool permanently uncallable — added `DECIDABLE_TYPES`, skip anything outside it, and a parity row pinning that nothing on disk is in the skipped case.
  - `[medium]` `[patch]` `arguments: null` was coalesced to `{}` by `?? {}`, contradicting the gate's own "null is a value" rule one level down — only `undefined` is absent now, and a row pins the envelope refusal.
  - `[medium]` `[patch]` Two comments justified skipping object array elements with "`handleSeedAgent` speaks for its sections"; it validates nothing and the body crashes in `agents.ts`. Both comments now state the truth, and the gap is deferred rather than claimed closed.
  - `[medium]` `[patch]` No row exercised a declared `type: "number"` although the refusal of `limit: "10"` is a live behaviour change across many tools — added one, naming the stdio `z.number()` parity it buys.
  - `[medium]` `[patch]` Nothing observed the value `src/mcp.ts` mints: the cited owner-gate/patch-metadata suites build their own `"service:mcp"` literals and stay green if the door drifts. Exported `STDIO_SERVICE_PRINCIPAL_ID`, pinned it in `mcp.test.ts`, and corrected the comment that claimed those suites pinned it.
  - `[low]` `[patch]` The presence check read `values[name]` bare, so a `required` name colliding with an `Object.prototype` member would be satisfied by the prototype chain — own-key reads in both loops, the house rule `ownEntry` already follows.
  - `[low]` `[patch]` "Nine sibling handlers do `a as Parameters<…>`" was a count `grep -c` puts at 26 — reworded in both the source and test doc blocks without asserting a number.
  - `[low]` `[patch]` The `fix_lint_issue` cast comment claimed a narrowing "a gate already proved"; true only for arguments arriving through `dispatchMcp` — the comment now names that call path and the exported-`MCP_TOOLS` caveat.
  - `[low]` `[patch]` The undeclared-key row could not observe stripping (`vault_curate.run` never reads `a.owner`) — renamed and re-commented to claim only what it proves.
  - `[low]` `[patch]` The new `src/mcp.ts` doc block hardcoded `authz.ts:263`; prose line numbers go stale — module and predicate named instead.

## Design Notes

The gate is the schemas already on disk, read generically — not a new contract:

```ts
// jsonType(v): "array" for arrays, "object" for plain objects, typeof otherwise.
for (const name of required) if (args[name] === undefined) return `Missing required field: ${name}`;
for (const [name, decl] of Object.entries(properties)) {
  const v = args[name];
  if (v === undefined) continue;              // absent means absent
  if (declType && jsonType(v) !== declType) return `Invalid request field \`${name}\`: expected ${declType}`;
  // arrays whose items.type is a primitive: same message with `${name}[${i}]`
}
```

Why `type` + `required` + primitive array items and nothing more: that is exactly the parity the ledger names — the stdio door's `z.array(z.string())` catches both the string-for-array and the missing-key cases — while `enum`, nested-object `required`, and value ranges stay with the handlers that already answer for them with better sentences (`autoFixRefusal`, `validateQuery`, `handleSeedAgent`).

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/mcp-http.test.ts src/lib/__tests__/mcp.test.ts src/lib/__tests__/owner-gate-parity.test.ts src/lib/__tests__/owner-handle.test.ts src/lib/__tests__/patch-metadata.test.ts src/lib/__tests__/lint-fix-route.test.ts` — expected: all pass.
- `pnpm exec tsc --noEmit` — expected: no errors.
- `pnpm exec eslint src/lib/mcp-http.ts src/mcp.ts src/lib/principal-id.ts src/lib/auth.ts src/lib/__tests__/mcp-http.test.ts` — expected: clean.
- `pnpm test` — expected: the full suite passes (brand scan and prose-parity suites included).
- `grep -n '"service:mcp"' src/mcp.ts` — expected: no matches.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `dispatchMcp` now runs one generic gate over `params.arguments` before `tool.run`, reading the JSON Schema each `ToolDef` already declares — the `required` list, each top-level property's declared `type` (only types the gate can decide), and array elements when `items.type` is primitive. Undeclared keys pass through untouched; absent and `undefined` are unset while an explicit `null` is refused; the gate sits behind the unknown-tool and missing-principal checks and its refusal surfaces as an `isError` tool result in the doors' shared vocabulary. `fix_lint_issue`'s per-tool `optionalString` helper (DW-455) is gone, subsumed word for word. Separately, `service:mcp` is minted once from a new `servicePrincipalId()` helper instead of three raw literals.

**Files changed**
- [../../src/lib/mcp-http.ts](../../src/lib/mcp-http.ts) — `jsonType`, `DECIDABLE_TYPES`, `PRIMITIVE_ITEM_TYPES`, `validateToolArguments`; the gate call in `tools/call`; `fix_lint_issue.run` simplified; three comments corrected.
- [../../src/mcp.ts](../../src/mcp.ts) — exported `STDIO_SERVICE_PRINCIPAL_ID = servicePrincipalId("mcp")`, used at the three former literal sites.
- [../../src/lib/principal-id.ts](../../src/lib/principal-id.ts) — added `servicePrincipalId()`, the one mint path.
- [../../src/lib/auth.ts](../../src/lib/auth.ts) — `getServicePrincipal` mints through it; stale `owner.ts` cross-reference corrected to `authz.ts`.
- [../../src/lib/__tests__/mcp-http.test.ts](../../src/lib/__tests__/mcp-http.test.ts) — `dispatchMcp — the argument gate` (14 cases, one of them a two-row `it.each`), two parity invariants on the schemas, four doc comments corrected, two `fix_lint_issue` rows moved to a sibling `it.each` for the door's wording.
- [../../src/lib/__tests__/mcp.test.ts](../../src/lib/__tests__/mcp.test.ts) — two rows pinning what the stdio door mints.

**Review findings.** 10 patches applied (5 medium, 5 low — see the triage log), 2 deferred (both medium: nested-object array elements are unchecked at both this door and its handler; the HTTP schemas are now enforced but unpinned against the stdio zod contracts), 11 rejected as noise, 0 intent gaps, 0 spec repairs.

**Follow-up review recommended: true.** Patched this pass: high 0, medium 5, low 5 → 3 x 5 + 1 x 5 = 20, at or above the threshold of 5.

**Verification.**
- `pnpm exec vitest run --project node` over `mcp-http`, `mcp`, `owner-gate-parity`, `owner-handle`, `patch-metadata`, `lint-fix-route` — 474 passed.
- `pnpm exec tsc --noEmit` — clean. `pnpm exec eslint` over all six changed files — clean.
- `pnpm test` — 354 files, 8360 passed, 1 skipped, 0 failed (three consecutive green runs; see residual risks).
- `grep -n '"service:mcp"' src/mcp.ts` — no matches.
- Matrix audit: every I/O row has a covering row in `dispatchMcp — the argument gate` (or, for the absent-optional row, the existing `lets an ABSENT field through` case), and all of them ran in the passing output.

**Residual risks.**
- One `pnpm test` run out of four immediately after the review patches reported a single failing test; the summary line was captured but not the test name, and three subsequent full runs (including two with complete output captured) were green with the same working tree. Unidentified flake, not reproduced, not traced to this change — worth watching rather than acting on.
- The gate is live for all 40 tools, not only the spread-and-cast handlers: an external caller sending a declared-`number` field as a string (`limit: "10"`) or an explicit `null` for an optional field now gets a refusal where a handler previously coerced or ignored it. That is the stdio door's behaviour, which is the parity DW-563 asked for, but nothing outside this repo is pinned.
- `MCP_TOOLS` is exported, so a future direct `tool.run(...)` caller would bypass the gate; `dispatchMcp` is the only caller today and the comments now say so rather than claiming the narrowing unconditionally.
