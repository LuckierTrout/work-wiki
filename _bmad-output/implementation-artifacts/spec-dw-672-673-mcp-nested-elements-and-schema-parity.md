---
title: 'Object array elements pass the HTTP MCP gate, and the two doors'' schemas are pinned to each other'
type: 'bugfix'
created: '2026-09-03'
baseline_revision: '80f9a3486cda3785257fb4d65aa95109a9e84a91'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      `seed_agent` accepts a section `type` outside its declared `enum` at the
      HTTP door and half-seeds the agent: the page is written but bucketed into
      none of the profile's three page lists.
    evidence: |-
      Neither door's gate judges `enum` members by design (the Never clause,
      carried from DW-563), so `seed_agent … sections:[{slug,title,
      type:"bogus",content}]` passes the HTTP gate as a well-typed string. In
      `seedAgent` (`src/lib/agents.ts:995-1006`) the `switch (section.type)`
      that appends the slug to `identityPages` / `learningPages` /
      `socialPages` has no `default`, so the page is written to the wiki and
      then referenced by no list — the HTTP caller gets a success result and an
      agent profile that does not mention the page it just seeded. The stdio
      door refuses the same body at `z.enum(["identity","learnings","social"])`
      and the REST door at `src/app/api/agents/seed/route.ts` validates per
      index, so this answer is reachable through the HTTP MCP door alone.
      Pre-existing and outside this bundle: closing it is either a `default`
      arm in `seedAgent` or a decision to enforce `enum` somewhere, both of
      which need a message design this bundle's Never clause rules out.
    location: >-
      src/lib/agents.ts:995 (seedAgent section bucketing) + src/lib/mcp-http.ts
      seed_agent.sections.items.properties.type
    severity: low
---

<intent-contract>

## Intent

**Problem:** The HTTP door's argument gate reads `items.type` only for primitive elements, so an array element declared as an object reaches the handler unchecked — `seed_agent {agent_id, name, description, sections:[{slug:"s"}]}` answers `Cannot read properties of undefined (reading 'split')` thrown by `section.content.split` in `src/lib/agents.ts`, where the stdio door refuses the same body cleanly at `z.object({...})`; `handleSeedAgent` validates nothing between the wire and `agents.ts`, and `update_agent.addPages` has the same shape (DW-672). Separately, `MCP_TOOLS ↔ stdio registration parity` compares tool names, the `write`/`readOnlyHint` flag and required-name decidability but never the two doors' `required` lists or declared types, so a field the HTTP schema calls `required` while the stdio zod calls it `.optional()` — or a `number` against a `z.string()` — would refuse every real call to that tool at one door only (DW-673).

**Approach:** Let the existing gate recurse one structural step: an array whose `items` declares `type: "object"` is validated element by element against that `items` schema's own `required` list and property `type`s, using the same reading and the same refusal vocabulary with an indexed-and-dotted path. And pin the HTTP `inputSchema` declarations against the stdio zod shapes by asking the zod schemas questions through `safeParse` alone — required-ness, declared type, one-sided fields, and the object-array element contracts — with every legitimate asymmetry a closed enumeration that a minimality check keeps honest.

## Boundaries & Constraints

**Always:**
- The gate still reads only what the schemas already declare — `required` and each property's `type`, now at element level too — and only types it can decide (`DECIDABLE_TYPES`). No new schema fields, no per-tool special cases.
- Refusal wording grows by PATH only. New sentences: `Missing required field: sections[0].title`, ``Invalid request field `sections[0].slug`: expected string``, ``Invalid request field `sections[0]`: expected object``. Every sentence already on disk stays byte-identical — `Missing required field: urls`, ``Invalid request field `urls`: expected array``, ``Invalid request field `tags[0]`: expected string``, `Invalid request arguments: expected a JSON object`.
- Undeclared keys pass through untouched at every level; absent and `undefined` are unset while an explicit `null` is a value and is refused; the gate stays behind the unknown-tool and missing-principal checks and its refusal is still an `isError` tool result.
- The parity rows read the stdio side through the `entry.inputSchema.shape ?? entry.inputSchema` idiom already used at `src/lib/__tests__/mcp.test.ts:3192`, and ask only behavioural questions (`safeParse`) — never a zod class name, wrapper, or `_def` internal, so a zod major does not break them.
- Every legitimate HTTP↔stdio asymmetry is a named closed enumeration with a minimality check, the AGENTS.md house pattern: an entry that no longer corresponds to a real asymmetry must be removed or the suite fails.

**Block If:**
- A parity row finds a live disagreement outside the enumerated asymmetry families. Which door is wrong is a product decision, not a test decision — HALT rather than widen an enumeration to make the row green.
- Extending the gate would turn a currently-VALID call into a refusal beyond the one already decided here: because the gate has no per-tool cases, the generic reading necessarily reaches `dataview_query.filters` as well as the two agent tools the ledger names, so a numeric `filters[].value` moves from a silent non-match to a refusal. That one is accepted — the stdio door already answers it at `z.string().optional()`, which is the parity being closed. Any OTHER valid-to-refused move is a Block If.

**Never:**
- Do not validate `enum` members, string formats, ranges, or numeric bounds at either level. `autoFixRefusal` and `validateQuery` keep answering for those with better sentences. The parity rows may ASK whether the stdio schema accepts an enum member the HTTP schema advertises; they must not make the HTTP gate enforce `enum`.
- Do not recurse into a property declared `type: "object"` — only array `items`. `update_metadata.metadata` is an `additionalProperties: true` bag with no declared members, and widening past array elements is not what the ledger names.
- Do not touch the stdio zod schemas, `mcp.json`, the tool inventory, or any handler. `handleSeedAgent` stays a mapper; the door speaks for the shape.
- Do not touch `yopedia`, `service:mcp`, or any frozen identifier (AGENTS.md).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| The ledger's body | `seed_agent {agent_id:"a",name:"n",description:"d",sections:[{slug:"s"}]}` | refused at the door; `handleSeedAgent` never runs, `agents.ts` never throws | `isError`: `Error: Missing required field: sections[0].title` |
| Element member wrong type | `seed_agent … sections:[{slug:1,title:"t",type:"identity",content:"c"}]` | refused at the door | `isError`: ``Error: Invalid request field `sections[0].slug`: expected string`` |
| Element is not an object | `seed_agent … sections:["s"]` | refused at the door | `isError`: ``Error: Invalid request field `sections[0]`: expected object`` |
| Same shape on `update_agent` | `update_agent {addPages:[{slug:"s"}]}` | refused before `run`, so ahead of its own `Agent not found` | `isError`: `Error: Missing required field: addPages[0].title` |
| Second object array on disk | `dataview_query {filters:[{field:"tags",op:"contains",value:1}]}` | refused at the door | `isError`: ``Error: Invalid request field `filters[0].value`: expected string`` |
| Optional element member absent | `dataview_query {filters:[{field:"source_url",op:"exists"}]}` | reaches the handler and answers as before (`value` is optional) | No error expected |
| Well-shaped element | `seed_agent … sections:[{slug:"s",title:"T",type:"identity",content:"c"}]` | reaches `handleSeedAgent`; the agent is seeded | No error expected |
| Element `enum` still the handler's | `seed_agent … sections:[{slug:"s",title:"T",type:"bogus",content:"c"}]` | the gate does not speak (`type` is a string); whatever the handler answers stands | No gate refusal |
| Empty object array | `seed_agent … sections:[]` | unchanged — reaches the handler and succeeds | No error expected |
| Primitive elements unchanged | `create_page {slug:"s",content:"c",tags:[1]}` | same refusal as before, same wording | `isError`: ``Error: Invalid request field `tags[0]`: expected string`` |

</intent-contract>

## Code Map

- `src/lib/mcp-http.ts:230-286` — `validateToolArguments(inputSchema, args)`. Two loops over one `values` object: the `required` presence loop (l.245-248) and the `properties` type loop (l.255-284), both reading through the own-key helper `own()` (l.239-241). l.269-275 is the exact seam: after the top-level type check it returns unless `items.type` is in `PRIMITIVE_ITEM_TYPES`, and l.272-274's comment states that object elements pass through unchecked. That loop body is what has to become reusable for one nested level.
- `src/lib/mcp-http.ts:155-184` — `jsonType` (`"null"`/`"array"`/`typeof`), `DECIDABLE_TYPES` (string, number, boolean, object, array) and `PRIMITIVE_ITEM_TYPES` (string, number, boolean). Reuse as-is; an element member declared outside `DECIDABLE_TYPES` must keep being skipped, not failed.
- `src/lib/mcp-http.ts:190-227` — the gate's doc block. The paragraph headed `NESTED-OBJECT `required` IS NOT CHECKED, AND NOTHING ELSE CHECKS IT EITHER` (l.206-215) is the claim this change falsifies: it names the `sections:[{slug:"s"}]` crash and says closing it "is a separate change with its own message design". This change IS that change — rewrite the paragraph to state the path vocabulary and what still stays out (`enum`, declared-object properties).
- `src/lib/mcp-http.ts:1231-1250` — `dispatchMcp`'s `tools/call` arm: unknown-tool refusal, principal refusal, `const args = params.arguments === undefined ? {} : params.arguments`, then `validateToolArguments` thrown into the surrounding `catch` that renders `Error: <message>`. No change needed here; it is where every I/O row is driven from.
- `src/lib/mcp-http.ts:906-943` (`update_agent`, `addPages`), `946-979` (`seed_agent`, `sections`), `1043-1072` (`dataview_query`, `filters`) — the only three `items: { type: "object", properties, required }` declarations on disk. `sections`/`addPages` require `["slug","title","type","content"]` with a documentation-only `enum` on `type`; `filters` requires `["field","op"]` with `value` optional and an `enum` on `op`.
- `src/lib/agents.ts:970-979` — the crash the gate now prevents: `` `# ${section.title}\n\n${section.content}` `` then `section.content.split("\n")`. Read-only; do not add a guard here.
- `src/mcp.ts:990-1015` (`handleSeedAgent`) and `1037-1058` (`handleUpdateAgent`) — mappers that validate nothing, by design. Read-only.
- `src/mcp.ts:2391-2405` / `2466-2490` — the stdio `seed_agent` / `update_agent` registrations: `z.array(z.object({slug,title,type:z.enum([...]),content}))`, `.optional()` on `addPages`. `src/mcp.ts:2806-2815` is `dataview_query.filters`. These are the schemas the parity rows compare against; do not edit them.
- `src/lib/__tests__/mcp-http.test.ts:138-268` — the `MCP_TOOLS ↔ stdio registration parity` describe: name parity (l.139), required-name-is-a-property (l.183), decidable-types (l.208), `write` ↔ `readOnlyHint` (l.245). The new rows go here. l.221-228's comment calls `"object"` "the deliberate pass-through case: element-level `required` is out of this gate's scope" — no longer true, must be corrected.
- `src/lib/__tests__/mcp-http.test.ts:380-575` — `dispatchMcp — the argument gate`: the `call`/`text`/`refusal` helpers (l.383-405) every new row should reuse. `l.482-500` (`leaves array elements alone when items is an object schema`) is the row whose entire claim this change inverts — it asserts the gate did NOT speak about `sections`, and its comment says asserting the crash "would freeze a crash as the contract". Replace it with the rows that now pin the door's answer.
- `src/lib/__tests__/mcp-http.test.ts:2302-2349` — `dispatchMcp — seed_agent`: both rows use `sections: []`, so they keep passing untouched and are the empty-array evidence.
- `src/lib/__tests__/mcp.test.ts:3186-3211` — the `entry.inputSchema.shape ?? entry.inputSchema` idiom plus the `safeParse(undefined)` / `safeParse(7)` way of asking a zod field about optionality and type. Copy this idiom rather than inventing one.
- `src/lib/__tests__/dataview.test.ts:103-362` — every filter fixture calls `queryByFrontmatter` directly with string `value`s, so it is unaffected by the door change. Read-only evidence.
- Measured on disk at `80f9a348` (a throwaway probe ran the full comparison): there is **no live HTTP↔stdio disagreement**. The asymmetries that do exist are (a) fields the HTTP door supplies from the authenticated principal and therefore never advertises — `owner`, `author`, `triggeredBy`, `vaultId`, and `update_agent`'s `agent_id`; the same rule makes `list_vaults.owner`/`vault_pages.owner` declared-but-optional at the HTTP door while the stdio door requires them; (b) `ingest_text.sourceUrl` and `ingest_text.sourceType`, stdio-only and optional, which the HTTP door simply does not advertise (they still reach the handler as undeclared keys, so no caller is refused); (c) six fields where the HTTP schema says plain `type: "string"` and the stdio door narrows to a `z.enum` — `list_pages.sort`, `query_wiki.format`, `save_query_answer.format`, `lint_wiki.minSeverity`, `fix_lint_issue.type`, `dataview_query.sortOrder`. Those three families are the enumerations to write down.

## Tasks & Acceptance

**Execution:**
- `src/lib/mcp-http.ts` — extract the `required`-presence + declared-`type` reading into one helper that takes a properties/required pair, a values object and a path prefix, and have `validateToolArguments` call it at the top level (empty prefix, so existing sentences are unchanged) and once per element of an array whose `items.type === "object"` (prefix `` `${name}[${i}]` ``, and refuse a non-object element as ``expected object`` first). Path composition: `` `${prefix}.${member}` `` for members, bare name at the top level. Then rewrite the doc block's nested-object paragraph (l.206-215) and the `items` comment (l.272-274) so neither still says object elements are unchecked, and say what remains out of scope (`enum` members, declared-object properties).
- `src/lib/__tests__/mcp-http.test.ts` — in `dispatchMcp — the argument gate`, add a row per I/O Matrix scenario above (reusing the existing `call`/`refusal`/`text` helpers and `ALICE`), replacing the now-inverted `leaves array elements alone when items is an object schema` row at l.482-500 with the rows that pin the door's answer, and keeping the `create_page {tags:[1]}` row verbatim as the unchanged-primitive evidence.
- `src/lib/__tests__/mcp-http.test.ts` — in the parity describe, add the DW-673 rows: (1) every field only one door declares is either a principal-derived name or in the `ingest_text` unadvertised enumeration, and no field is HTTP-only; (2) every field both doors declare agrees on required-ness, waiving only a principal-derived name that is optional at the HTTP door and required at the stdio door; (3) for every shared field, the stdio schema rejects a sample of every decidable JSON type other than the HTTP-declared one, and the fields where it also rejects the own-type sample are exactly the enumerated `z.enum` narrowings; (4) for each of the three object-array fields, build a valid element from the HTTP declarations (first `enum` member where one is declared, else a type sample) and assert the stdio schema accepts `[element]`, rejects it with each HTTP-`required` member omitted, accepts it with each optional member omitted, rejects each member set to a wrong-typed value, and accepts every `enum` member the HTTP schema advertises for that member. Each enumeration gets a minimality assertion, and the l.221-228 comment is corrected.

**Acceptance Criteria:**
- Given every field declared by both doors for every tool in `MCP_TOOLS`, when the parity suite runs, then none disagrees on required-ness or on declared type, and every field only one door declares falls in an enumerated family — with a minimality assertion failing on any enumeration entry that no longer names a real asymmetry.
- Given `seed_agent.sections`, `update_agent.addPages` and `dataview_query.filters`, when the parity suite builds a valid element from each HTTP `items` declaration, then the matching stdio zod field accepts it, refuses it once per omitted `required` member, accepts it once per omitted optional member, refuses each member replaced by a wrong-typed value, and accepts every `enum` member the HTTP schema advertises.
- Given a `tools/call` whose object array element contradicts the `items` schema, when `dispatchMcp` handles it, then the handler is never invoked and the refusal names the failing member by indexed path in the doors' shared vocabulary.
- Given the whole existing `mcp-http.test.ts` and `mcp.test.ts` suites, when they run, then every row that passed at `80f9a348` still passes, with the only edits to existing rows being the replaced nested-element row and the two corrected comments.
- Given `pnpm test`, when it runs, then the full suite passes — including the brand scan and the prose-parity suites.

## Spec Change Log

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 4, low 6)
- defer: 1: (high 0, medium 0, low 1)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The `dataview_query` filter row's comment claimed a numeric `filters[].value` used to be a silent non-match; `smartCompare`'s `tryNumber(Number(x))` (`src/lib/dataview.ts`) means six operators plus scalar `contains` coerced it and answered correctly, and only array `contains` was the non-match. The comment now states the real consequence, the stdio door's long-standing refusal, and quoting as the remedy.
  - `[medium]` `[patch]` `declares every required name as a property` read top-level `properties` only, so a typo in an `items.required` list would refuse every well-formed call at the HTTP door now that element `required` is enforced — the row descends into `items.properties`.
  - `[medium]` `[patch]` `declares only types the argument gate can decide` had only its comment updated; an element member declared `integer` was silently dropped from the gate with every row green. The row descends too, verified by re-declaring `filters[].value` as `integer`.
  - `[medium]` `[patch]` Primitive array ELEMENT types were compared against nothing: `TYPE_SAMPLES.array` is `[]`, which every `z.array()` accepts. The type row now probes one-element arrays — which surfaced `lint_wiki.checks` (HTTP `items: {type:"string"}`, stdio `z.array(z.enum(ALL_CHECK_TYPES))`), enumerated as `ENUM_NARROWED_ELEMENTS` with its own minimality and member pin, the same family as the six top-level narrowings rather than a live disagreement.
  - `[low]` `[patch]` The gate doc block and `checkObject`'s docstring claimed "one structural step down"; the property loop re-enters the same branch, so the reading follows array `items` at whatever depth is declared. Prose corrected to say so and to name the deeper limb as unexercised; no depth bound added, since a limb no schema reaches is untestable dead code.
  - `[low]` `[patch]` The object-array element row reported every optional member as stdio-required once the constructed element was rejected — it now reports once and continues — its wrong-typed probe used one sample instead of every non-declared type, and an absent stdio field threw on `undefined.safeParse`.
  - `[low]` `[patch]` The narrowing row threw `Cannot read properties of undefined` for a renamed enumerated tool, and its docstring called the family "a plain HTTP `type: string`" although `fix_lint_issue.type` declares an HTTP `enum` — guarded, corrected, and every advertised member is now probed where the HTTP side declares them.
  - `[low]` `[patch]` The two exact-set assertions (`REQUIRED_ASYMMETRY_FIELDS`, `OBJECT_ARRAY_FIELDS`) were the only ones in the change with no diagnostic message.
  - `[low]` `[patch]` The header claimed every waiver family is a closed list; `PRINCIPAL_DERIVED_NAMES` is a name-wide rule. It now says so — justified by `attributed()`/`fileIntoVault` always overriding — with a member pin and a floor of 30 tool.field pairs (32 waived today).
  - `[low]` `[patch]` A registered `inputSchema` value that is not a zod schema threw instead of naming a parity failure; every stdio read goes through `probeOf`.

## Design Notes

One reading, applied at two depths — the second call is the first one's body with a path prefix:

```ts
// checkObject(properties, required, values, prefix): the two loops that are in
// validateToolArguments today, with `label(name)` = prefix ? `${prefix}.${name}` : name.
// Inside the property loop, where the gate currently gives up on object items:
if (itemType === "object" && jsonType(decl.items) === "object") {
  const items = decl.items as { properties?: unknown; required?: unknown };
  for (let i = 0; i < elements.length; i++) {
    const at = `${label(name)}[${i}]`;
    if (jsonType(elements[i]) !== "object") {
      return `Invalid request field \`${at}\`: expected object`;
    }
    const nested = checkObject(items, elements[i] as Record<string, unknown>, at);
    if (nested) return nested;
  }
}
```

Why exactly one structural step and not open recursion: array `items` is the only nesting the schemas on disk actually declare (three fields), and it is the one the ledger names. A property declared `type: "object"` is `update_metadata.metadata`, a deliberate `additionalProperties: true` bag — reading `properties` there would invite a future declared member to become a gate no one asked for.

Why the parity rows probe instead of introspecting: `entry.inputSchema` is a raw zod shape whose internals move between zod majors, but `safeParse` does not. "Is this field required" is `safeParse(undefined).success === false`; "does it agree with `type: "string"`" is "accepts `"x"`, rejects `1`/`true`/`[]`/`{}`". A `z.enum` rejects `"x"` too — that is a narrowing, not a disagreement, which is why the narrowed set is enumerated rather than tolerated silently.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/mcp-http.test.ts src/lib/__tests__/mcp.test.ts src/lib/__tests__/agents.test.ts src/lib/__tests__/dataview.test.ts src/lib/__tests__/mcp-annotations.test.ts src/lib/__tests__/retired-surfaces.test.ts` — expected: all pass.
- `pnpm exec tsc --noEmit` — expected: no errors.
- `pnpm exec eslint src/lib/mcp-http.ts src/lib/__tests__/mcp-http.test.ts` — expected: clean.
- `pnpm test` — expected: the full suite passes.
- `git diff --stat` — expected: exactly two files changed (`src/lib/mcp-http.ts`, `src/lib/__tests__/mcp-http.test.ts`); no change to `src/mcp.ts`, `src/lib/agents.ts`, or `mcp.json`.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** The HTTP MCP door's argument gate now reads object array elements. `validateToolArguments`'s two loops moved into `checkObject(declarations, values, prefix)`; the top level calls it with an empty prefix, so every sentence the door already answered is byte-identical, and each element of an array whose `items` declares `type: "object"` is read against that `items` schema's own `required` list and property `type`s with the prefix `` `<field>[<index>]` ``. `seed_agent {…, sections:[{slug:"s"}]}` — the ledger's body — is now `Missing required field: sections[0].title` instead of an uncaught `Cannot read properties of undefined` out of `src/lib/agents.ts`; a non-object element is ``Invalid request field `sections[0]`: expected object``, a mistyped member ``Invalid request field `sections[0].slug`: expected string``. `enum` members, formats and ranges stay with the handlers, and a property declared `type: "object"` is never followed. Separately, the `MCP_TOOLS ↔ stdio registration parity` describe grew five rows that pin the HTTP `inputSchema` declarations against the stdio zod shapes — one-sided fields, required-ness, declared type, the narrowings, and the object-array element contracts — asking the stdio side only behavioural `safeParse` questions, with every legitimate asymmetry a named enumeration carrying its own minimality check.

**Files changed**
- [../../src/lib/mcp-http.ts](../../src/lib/mcp-http.ts) — `checkObject` extracted from `validateToolArguments` and made self-calling for object array elements; the gate's doc block rewritten (nested elements, how far down, what stays out at every level) and the stale `items` pass-through comment replaced.
- [../../src/lib/__tests__/mcp-http.test.ts](../../src/lib/__tests__/mcp-http.test.ts) — 9 new `dispatchMcp — the argument gate` rows (one per I/O Matrix scenario, replacing the inverted `leaves array elements alone` row); 5 new parity rows plus 6 enumerations with minimality checks; the two existing shape rows extended to descend into `items.properties`; four comments corrected.

**Review findings.** 10 patches applied (4 medium, 6 low — see the triage log), 1 deferred (low: `seed_agent` accepts an out-of-`enum` section `type` at this door and half-seeds the agent), 6 rejected as noise or as out of scope on the ledger's own authority (a gate depth cap, an element-count cap, a guard at `src/lib/agents.ts:975`, an already-covered HTTP-only element member, "the parity rows sit at the declarations rather than at real calls" — which is the surface DW-673's `location` field names — and door-level rows for the other 37 tools). 0 intent gaps, 0 spec repairs.

**Follow-up review recommended: false.** Patched this pass: high 0, medium 4, low 6 → no `high` finding, so no further iteration.

**Verification.**
- `pnpm exec vitest run --project node` over `mcp-http`, `mcp`, `agents`, `dataview`, `mcp-annotations`, `retired-surfaces` — 669 passed, 6 files.
- `pnpm exec tsc --noEmit` — clean. `pnpm exec eslint src/lib/mcp-http.ts src/lib/__tests__/mcp-http.test.ts` — clean.
- `pnpm test` — 374 files, 9375 passed, 1 skipped, 0 failed (run twice: before and after the review patches).
- `git diff --stat` — exactly the two files; `src/mcp.ts`, `src/lib/agents.ts` and `mcp.json` untouched.
- Matrix audit: all 10 I/O rows have a covering row in `dispatchMcp — the argument gate`, and all 24 rows in that describe plus all 9 parity rows appear in the passing verbose output.
- Non-vacuity: the implementer mutation-tested each parity family and reverted every mutation — an element-`required` typo, `filters[].value` re-declared `integer`, a flipped primitive element type, a stale enumeration entry, and a dropped `vaultId` each turn the matching row red.

**Residual risks.**
- The element reading is depth-agnostic rather than depth-bounded, and nothing on disk nests past one level, so the deeper limb is unexercised. The doc block says this rather than claiming a bound.
- A numeric `dataview_query` `filters[].value` is now refused at this door where the relational and equality operators previously coerced it via `Number()` and answered. That is the parity the stdio door has always had, and the caller's remedy is to quote the number, but it is a behaviour change beyond the two tools the ledger names.
- `lint_wiki.checks` is `items: {type:"string"}` at the HTTP door and `z.array(z.enum(ALL_CHECK_TYPES))` at the stdio door — enumerated as a same-family narrowing, not closed. Advertising `enum: [...ALL_CHECK_TYPES]` on the HTTP side is a one-line product change if the asymmetry is unwanted.
- The parity rows compare declarations, not answers: nothing drives one body through both doors and diffs the results, so a gate that stopped reading `required` altogether would leave all nine parity rows green (the 24 argument-gate rows are what cover that).
