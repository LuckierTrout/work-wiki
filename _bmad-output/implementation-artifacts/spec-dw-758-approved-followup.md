---
title: 'Search diagnostics reflect candidate coverage'
status: in-review
created: '2026-09-10'
baseline_commit: '390f573b20b672793a5bda559a9cf3fbc6b94b38'
---

## Approved intent

The owner approved this recommendation on 2026-09-10 as one of four deferred-work rulings.

Problem: A Vectorize window containing only incompatible models must not diagnose full-corpus drift or prescribe rebuilding.

Approach: Tag bounded query results, report window exhaustion under a separate warning identity, preserve full-corpus diagnostics and match selection.

## Scope

Local implementation, review and PR verification. Preserve runtime identifiers, production bindings, dependencies and existing frozen historical specs. No production migration, provisioning, deployment or manual deferred-work status edits.

## Acceptance

Drive search through the real R2 storage implementation with a bounded synthetic Vectorize response; prove later full-corpus drift remains audible. Cover the related-page consumer of the same query contract.

## Verification

- Focused storage/embedding suites: 392 passed. Final bounded-window regressions: 2 passed, covering search and related pages.
- Negative control: both bounded-window regressions fail with the original embeddings implementation and pass with the fix.
- Full suite: 410 files, 10,131 tests passed; one existing credential-dependent skip. The related-page regression was added afterward and executed separately without further behavior changes.
- Full lint and TypeScript checks passed; lint retains the three existing TSNonNullExpression diagnostics.

Production build, final lint, post-build TypeScript check and diff check passed. Review is local; public publication was explicitly approved by the owner on 2026-09-10; GitHub CI remains pending. Implementation is not deployment evidence.
