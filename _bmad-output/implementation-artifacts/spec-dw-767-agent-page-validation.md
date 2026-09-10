---
title: 'DW-767: reject invalid agent page types before writing'
type: 'bugfix'
created: '2026-09-09'
status: 'in-review'
baseline_commit: '3ea23aaaa05991f9713714e5ed0b024be10f22c3'
---

## Intent and authorization

The owner authorized DW-767 after approving the next-step list. Invalid
`addPages` types currently write pages and fall into the social list. Reject
an invalid batch before any page or profile mutation, through the shared kernel.
The previous DW-725/749 spec remains historical and unchanged.

<intent-contract>
- Validate every supplied page type against identity/learnings/social before
  applying scalar/list changes or beginning publication. Reject malformed batch
  containers and missing/null type-bearing elements with ClientInputError.
- Preserve missing-agent behavior and existing ownership/authentication checks.
- REST returns 400; HTTP MCP returns its normal isError tool result. Keep the
  stdio schema and shared MCP handler contracts; do not widen general MCP enum
  validation or change unrelated update fields.
- Valid types, empty batches and existing lifecycle publication remain working.
- No production configuration, identifier, dependency, ledger or frozen-spec edits.
</intent-contract>

## Implementation and acceptance

`src/lib/agents.ts` validates the complete batch before changes; the real REST
route classifies the typed input error. The new agent-update-validation suite
runs REST, HTTP MCP dispatch and the shared MCP handler through real kernel and
temporary filesystem storage. A valid first page followed by an invalid type
must leave all pages, profile lists, name and timestamps untouched, with no
storage write invoked. Valid batches exercise publication and all three lists.
Existing agent/MCP route suites retain authorization and mutation coverage.

## Verification

Run focused agent/kernel/MCP suites, full tests, lint, typecheck and build.
Record final results and local review before publication. CI must pass at the
published head. Publication is reviewable work; follow-on merge/deployment is
separate from the specifically requested completion of DW-766.


## Implementation and local verification result

Implemented 15 lines of kernel preflight and typed REST classification. Local
review checked batch-wide refusal before scalar/list/page mutation, unchanged
ownership/missing-agent behavior, valid list assignment and bounded scope.
No further in-scope defect found; this was a local review, not an independent
agent review.

- Focused: **292 tests passed in four suites**, including 13 new real-door cases.
- Final combined baseline includes merged DW-766 at `1b8b67af`.
- Full suite: **407 files, 10,106 passed, one existing credential skip**;
  123.14 seconds. An earlier concurrent full run hit the existing five-second
  owner-session-actors timeout. Sequential verification passed without changing
  any timeout, test assertion or product behavior.
- Full lint passed with the three existing JSX diagnostics. Production build
  with synthetic public identity configuration and subsequent standalone
  TypeScript check passed.
- Negative control: restoring the old agent writer made all three invalid-batch
  door tests fail, including REST 200 instead of 400. The fix was restored.
- Real route/MCP → kernel → temporary filesystem coverage verifies publication
  and refusal. No external provider operation or real data was used.
- Whitespace checks passed; ledger SHA-256 remains
  `383e6c1110e550015797c5e3520c8a2115afbd54944d4de5c85a321323f20740`.

Published-head CI and merge disposition are recorded on the PR. Local success
is not deployment or production write-safety acceptance.
