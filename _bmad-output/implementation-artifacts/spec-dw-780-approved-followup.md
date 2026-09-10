---
title: 'Guidance uses verified agent ownership'
status: in-review
created: '2026-09-10'
baseline_commit: '390f573b20b672793a5bda559a9cf3fbc6b94b38'
---

## Approved intent

The owner approved this recommendation on 2026-09-10 as one of four deferred-work rulings.

Problem: A human handle containing -- must not borrow another tenant's Workspace Purpose or Names & Terms.

Approach: Resolve the complete agent registry record and validate its authoritative owner against the composite id. Preserve unregistered human handles whole. Reject malformed principals or contradictory records before guidance reads. Keep legacy owner-class authorization comparison unchanged.

## Scope

Local implementation, review and PR verification. Preserve runtime identifiers, production bindings, dependencies and existing frozen historical specs. No production migration, provisioning, deployment or manual deferred-work status edits.

## Acceptance

Drive source-monitor redrafting and action creation with real temporary registry and guidance files. Cover ambiguous human handles, raw owner metadata, malformed and stale records; preserve registered-agent guidance across ingest, merge and extraction.

## Verification

- Real source-monitor composition distinguishes a complete human handle from a registered agent and uses the raw authoritative owner metadata. Real action creation rejects malformed ownership without writing an item.
- Negative control: both prompt-composition regressions fail when resolution is reverted to the original delimiter-only helper.
- Final identity/owner-module focused suites: 42 passed. Source-monitor composition and identity cases also passed together.
- A final full run found the repository's owner-module comparison rule; the collision refusal now lives in owner.ts. An unrelated Settings provider-switch case failed once and passed unchanged in isolation (15 cases); the final full rerun uses four workers to reduce contention. The complete final rerun (`pnpm exec vitest run --maxWorkers=4`) passed: 411 files, 10,146 tests; one existing credential-dependent skip.

Production build, final lint, post-build TypeScript check and diff check passed. Review is local; publication and GitHub CI remain pending public-sharing permission. Implementation is not deployment evidence.

