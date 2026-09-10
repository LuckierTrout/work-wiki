# Four approved deferred-work decisions — 2026-09-10

The owner approved all four recommendations in this session. These supersede the earlier triage option wording where noted; they do not amend historical frozen specs or authorize deployment.

1. **DW-522 — close as currently non-actionable.** No reachable dialog-focus failure has been demonstrated. Preserve D4's navigation-focus ruling. Reopen only with a concrete reproducer; no speculative visibility hardening. This is a scope decision, not evidence that the visibility predicate covers every CSS mechanism.
2. **DW-758 — report bounded search coverage honestly.** Distinguish Vectorize candidate-window exhaustion from full-corpus drift. No rebuild advice or consumption of the drift warning throttle on window-only evidence. Preserve ranking and compatibility behavior; no metadata-index migration or real data changes. Earlier triage claims about an impossible metadata filter are not relied upon.
3. **DW-780 — verify the complete agent identity.** Use the full registered identity and authoritative owner metadata. Checking only a registered prefix is insufficient for a human such as `jean--luc`. Preserve full human handles; fail closed on invalid or contradictory ownership. Storage, attribution and existing authorization equivalence remain separate from guidance resolution.
4. **DW-782 — correct help, preserve routing.** A saved Ingest model overrides an inherited provider's model; an explicit provider with no model uses its default. Describe Workbench Chat separately because the local sidecar has its own resolver. The earlier triage claim that both fields inherit independently is inaccurate and is not the approved implementation contract.

The installed orchestrator's `apply_pre_answer` decision writer recorded these rulings and closed DW-522. DW-758, DW-780 and DW-782 remain open until their code is merged and reconciled. No ledger rows were hand-edited.
