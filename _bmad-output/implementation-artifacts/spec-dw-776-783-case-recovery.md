---
title: 'Case-variant page deletion and receipt-missing recovery'
status: done
baseline_commit: 4a64156d6e7b2f31268f53c120ea47d2e92bf62c
---

## Intent

Implement DW-776 and DW-783 under approved decision D2 in `deferred-six-decisions-2026-09-09.md`. Equivalent owned physical spellings form one logical page for deletion. Conflicting bytes, contradictory ownership or incomplete inventory must refuse before destructive page/revision actions. Resume an accepted operation from exact matching variant bytes without creating another spelling.

## Boundaries

Use the existing case-sensitive slug and case-insensitive `.md` extension contract, existing tenant resolution, storage port and lifecycle locks. No cross-tenant search, real-data mutation, cloud provisioning, protected configuration, identifier changes, architecture adoption or ledger edits. This does not establish transactional cross-object writes or legacy-worker drain.

## Implementation

- Strict physical-name enumeration in the authorized tenant and flat compatibility roots. A listed object that cannot be read makes the inventory incomplete. Enumeration preserves physical names on case-folding hosts.
- Before deleting revisions or page bytes, require all copies to match the selected page and require its physical scope to agree with its owner. Delete compatibility copies first; propagate failure with index/job evidence retained. A retry enumerates remaining copies, including after restart.
- Persist a create-only accepted-request identity alongside the lifecycle receipt, keyed by operation ID, before publication. Reject changed request semantics. Receipt-missing recovery reuses exact matching owned copies and repairs missing roots without minting a second spelling within an occupied root.
- Existing variant-only bytes without a recorded accepted identity remain a conflict on every attempt; retry must not manufacture provenance. Such legacy ambiguity requires trusted operation evidence. Existing canonical recovery remains compatible. Identity records are retained; no garbage collection is introduced.

## Verification

Final product code `e862ba6b52df8e50e0f96f1d6f5849f6b0344bcb`: full suite 414 files passed, 10,170 tests passed and one existing skip, 145.32 seconds. Production build with synthetic public identity, standalone TypeScript, full lint and diff checks pass. Lint retains the three existing TSNonNullExpression diagnostics. Earlier exploratory runs do not substitute for this committed-code verification.

Nine real local Miniflare R2/KV cases drive the lifecycle through equivalent/conflicting/foreign-owner copies, interrupted enumeration/deletion, restart, publication and receipt faults, identity mismatch and receipt deduplication. The local runtime alone enables the existing durable-lock readiness flag for synthetic resources; production gates are unchanged.

The owner explicitly approved public publication of this packet on 2026-09-10. Publication, exact-head CI and merge are complete; the orchestrator reconciles the corresponding ledger entries.

## Merge evidence

[PR #32](https://github.com/LuckierTrout/work-wiki/pull/32) merged on 2026-09-10 as `dd1a0f7a4fdf1b86ea8b710cd9b779cba5bd61e5`. Application, Browser E2E and Sandbox Worker checks all passed on exact head `487557937ba7703ba032635107426d531ee76043` in [CI run 34515962936](https://github.com/LuckierTrout/work-wiki/actions/runs/34515962936). No production deployment is claimed.
