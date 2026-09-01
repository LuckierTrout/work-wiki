---
status: done
---

# BMad Build Auto Result

Status: done
Blocking condition: none

## Bundle

`.bmad-loop/runs/20260820-220331-0f16/bundles/c3-mcp-http-argument-validation/intent.md`
(declared `dw_ids: DW-446`)

## Outcome: no code change needed — the intent is already implemented and covered

The bundle is stale on both of its readings.

**1. The declared ledger id does not match the intent.** The verbatim entry the
bundle carries is DW-446, *"Inline parts still consume attachment-count slots and
aggregate-budget bytes…"* — an email-ingest entry, `status: done 2026-08-29`,
resolved by sweep bundle `dw-email-inline-part-eligibility`. It has nothing to do
with MCP-HTTP argument validation.

**2. The entry the prose intent actually describes is DW-455, also done.**
`### DW-455: fix_lint_issue on the HTTP MCP transport gates type but still
forwards slug, target and message to the handler with no check…` —
`status: done 2026-08-29`, resolved by sweep bundle `dw-mcp-rest-door-parity`.
The sibling-tool half of the intent (`update_metadata`, and the revision tool the
intent calls `restore_revision`) was then generalized by DW-563 —
`status: done 2026-08-30`, sweep bundle `dw-mcp-door-hardening`, commit
`868d2009db0103734159db88dd7e075f560ba7cb`.

## Verification against the current tree

- `validateToolArguments` (src/lib/mcp-http.ts:230) validates `required` names,
  declared `type`s, and primitive array elements against each tool's own
  `inputSchema`.
- `dispatchMcp` calls it at src/lib/mcp-http.ts:1235, **before** `tool.run`, after
  the unknown-tool and missing-principal refusals. `params.arguments ?? {}` is
  gone: `params.arguments === undefined ? {} : params.arguments`, so an explicit
  `arguments: null` is refused rather than coalesced.
- The gate's vocabulary is the REST door's: `Missing required field: <name>` and
  ``Invalid request field `<name>`: expected <type>`` — the `fieldMessage`
  mirroring the intent asked for.
- `fix_lint_issue` (src/lib/mcp-http.ts:625) no longer spreads a bare cast; it
  passes `type`/`slug`/`target`/`message` explicitly, with `autoFixRefusal`
  retained for `enum`-member refusal (which the generic gate deliberately does
  not read).
- Because the gate is schema-driven it covers the two siblings by construction:
  `update_metadata` (:584, `slug` string + `metadata` object, both required) and
  `revert_revision` (:763 — the real name for the intent's `restore_revision`;
  `slug` string + `timestamp` **number**).
- The intent's concrete example, `{"type":"orphan-page","slug":7}`, is refused at
  the door as ``Invalid request field `slug`: expected string``, and never reaches
  `handleFixLintIssue`.

## Tests

`src/lib/__tests__/mcp-http.test.ts` already covers every claim: the
`dispatchMcp — the argument gate` block (:376) pins missing-required, wrong
declared type (including the `number` case), explicit-null field, null envelope,
non-object arguments, array-element index naming, undeclared-key pass-through,
and gate ordering behind auth and unknown-tool; the `string-field gate` block
(:1174) pins object/numeric/array `slug`, numeric `target`, object `message`,
field-name-before-type-gate ordering, and the absent-is-not-null control.

`npx vitest run src/lib/__tests__/mcp-http.test.ts` → **149 passed**, 0 failed.

## Ledger

Not edited, per the dispatch instruction — the orchestrator records resolution.
No new deferred-work entry filed: no unnamed wrong answer, data loss, or broken
door was found. The one known scope boundary (element-level `required` inside
object arrays) is already stated in the `validateToolArguments` doc block and
asserted as a deliberate negative at src/lib/__tests__/mcp-http.test.ts:478.
