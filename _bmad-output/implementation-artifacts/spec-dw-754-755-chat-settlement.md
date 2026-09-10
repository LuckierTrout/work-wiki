---
title: 'DW-754/755: complete Chat streams and preserve tool refusals'
type: 'bugfix'
created: '2026-09-10'
status: 'in-review'
baseline_commit: '0d52a3c7d2719c9ad3104c56c51602f56214d965'
---

## Intent and authorization

The owner authorized the Chat settlement packet in the four-step next-work
list. A truncated terminal payload must fail as an incomplete turn. A denied
shell command or cancelled Skill form must retain the sidecar's refusal text
through browser settlement, persistence and reload.

<intent-contract>
- Parse a present data field even when its JSON object is truncated; ignore
  unusable frames and report the existing incomplete-turn sentence at EOF.
- Preserve complete trailing frames without a blank delimiter, existing event
  names and the historical payload-less known-event parser contract.
- Align browser sanitization with the sidecar's existing tool/output exception.
  Ordinary uncited wiki answers still require coverage; invented markers are
  removed from both ordinary answers and tool outcomes.
- Preserve wire identifiers, authentication, approval gates and storage format.
- No real shell/provider effects, deployment, dependency, ledger or historical
  frozen-contract edits.
</intent-contract>

## Implementation and acceptance

The SSE reader captures the whole present payload and requires a JSON object.
The browser sanitizer accepts an explicit tool-outcome option, selected by
settlement from existing tool/output metadata. Defaults remain unchanged.

The new composition suite runs actual sidecar refusal handling, sanitization,
SSE encoding, byte-fragmented browser decoding, settlement and temporary
filesystem persistence/readback. It also covers malformed terminals, Unicode
chunks, complete final frames and citation enforcement. No external provider
or approved shell command is invoked.

## Verification

Focused suites: 63 tests passed across transport, settlement, citations, store
and the new composition suite. Full verification and local review results will
be recorded before publication. CI must pass on the published head; merge and
deployment status are distinct from implementation completion.

## Final local evidence

- Full suite: 409 files passed, 10,125 tests passed and one existing credential
  skip; 125.38 seconds. The final typed refusal fixture separately passed all
  11 composition cases.
- Full lint, production build with synthetic public identity configuration,
  standalone TypeScript check and whitespace checks passed. Lint emits the
  three existing JSX diagnostics.
- Negative control: restoring the old transport and settlement code caused
  nine of the 11 new cases to fail. Fixed sources were restored afterwards.
- Local review checked EOF handling, unchanged no-data behavior, citation
  stripping, tool-only opt-in and durable refusal readback. No additional
  in-scope defect found. This was local review, not independent agent review.
- The ledger remains unchanged in this implementation branch. Published-head
  CI and merge disposition are recorded on the PR.
