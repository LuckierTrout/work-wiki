---
title: 'Case-variant page deletion and receipt-missing recovery'
status: in-review
baseline_commit: 12c2912e
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

Pending final verification. Real local Miniflare R2/KV tests drive the lifecycle through equivalent/conflicting/foreign-owner copies, interrupted enumeration/deletion, restart, publication and receipt faults, identity mismatch and receipt deduplication. The local runtime alone enables the existing durable-lock readiness flag for synthetic resources; production gates are unchanged.

Public publication, exact-head CI, merge and orchestrator ledger closure require the new-packet publication approval identified during DW-768/770 finalization.
