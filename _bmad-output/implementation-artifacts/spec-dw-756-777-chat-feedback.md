---
title: 'DW-756/777: show Chat CRUD failures and clear stale save errors'
type: 'bugfix'
created: '2026-09-10'
status: 'in-review'
baseline_commit: '0d52a3c7d2719c9ad3104c56c51602f56214d965'
---

## Intent and authorization

The owner authorized this Chat feedback packet in the four-step next-work
list. Refused create, delete and rename operations must show the existing
error surface, and a successful save retry must clear the prior failure banner.

<intent-contract>
- Catch failures at the three ChatCanvas CRUD event handlers and display the
  returned error. Preserve the conversation and draft when mutation is refused.
- Clear the previous CRUD error when retry begins; report a failed fallback
  conversation read after deletion without undoing a successful deletion.
- Clear ChatWorkspace's previous save error before a new save attempt, keeping
  the existing saved banner and unknown-write-outcome wording.
- Preserve read-only gates, authentication, API contracts and successful CRUD.
- No deployment, dependency, ledger or historical frozen-contract edits.
</intent-contract>

## Implementation and acceptance

The three handlers catch rejected mutations. The conversation hook reports
fallback-load rejection, and saveAnswer resets the stale error state.

A mounted ChatCanvas composition test traverses the real hook, request helper,
REST routes, owner gate and temporary filesystem store. An injected signed-out
session produces actual route refusals for each mutation; retry restores the
session and exercises successful storage changes. A separate case covers a
failed fallback read after deletion. The mounted ChatWorkspace suite exercises
a failed save followed by success. Browser transport and session identity are
test fixtures; no external network or identity provider is contacted.

## Verification

Focused DOM suites: 13 tests passed across the real-route composition test,
existing conversation CRUD coverage and save outcomes. Full verification and
local review will be recorded before publication. CI must pass on the published
head; merge and deployment status are distinct from implementation completion.

## Final local evidence

- Full suite: 409 files passed, 10,119 tests passed and one existing credential
  skip; 122.37 seconds. Focused DOM coverage passed all 13 cases.
- Full lint, production build with synthetic public identity configuration,
  standalone TypeScript check and whitespace checks passed. Lint emits the
  three existing JSX diagnostics.
- Negative control: restoring the old handlers caused five new regression
  failures and four unhandled rejections. After restoring the fixed sources,
  all eight tests in the affected suites passed again without those rejections.
- Local review checked refusal preservation, retry error clearing, read-only
  guards, fallback-read failure after successful deletion and real store
  outcomes. No additional in-scope defect found. This was local review, not
  independent agent review.
- The ledger remains unchanged in this implementation branch. Published-head
  CI and merge disposition are recorded on the PR.
