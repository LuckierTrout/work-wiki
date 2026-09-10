---
title: 'Model settings help describes existing routing'
status: in-review
created: '2026-09-10'
baseline_commit: '390f573b20b672793a5bda559a9cf3fbc6b94b38'
---

## Approved intent

The owner approved this recommendation on 2026-09-10 as one of four deferred-work rulings.

Problem: The workload help promises inheritance which saved model overrides and sidecar routing do not honor.

Approach: Explain Ingest provider/model precedence and describe Workbench Chat's separate sidecar selection. Keep resolver and saved settings behavior unchanged.

## Scope

Local implementation, review and PR verification. Preserve runtime identifiers, production bindings, dependencies and existing frozen historical specs. No production migration, provisioning, deployment or manual deferred-work status edits.

## Acceptance

Mount Settings and verify accessible help and option labels. Exercise the real kernel resolver and sidecar generation with synthetic transport responses for saved-model, explicit-provider/default-model and fully unset cases.

## Verification

- Mounted Settings suites: 48 passed, including accessible hints during read-only and saving states.
- Real kernel routing and sidecar generation tests verify model-only overrides, provider defaults, sidecar precedence and environment discovery with synthetic transport responses; all 9 final cases passed, including Custom with no default model.
- Full suite: 411 files, 10,139 tests passed; one existing credential-dependent skip. The final copy qualification and Custom/default assertion passed separately afterward; all 48 mounted Settings cases also passed again.
- Full lint and TypeScript checks passed; lint retains the three existing TSNonNullExpression diagnostics.

Production build, final lint, post-build TypeScript check and diff check passed. Review is local; public publication was explicitly approved by the owner on 2026-09-10; GitHub CI remains pending. Implementation is not deployment evidence.
