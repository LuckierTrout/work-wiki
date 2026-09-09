---
title: 'Deferred work Phase 0: verify the executable backlog'
type: 'chore'
created: '2026-09-08'
status: 'done'
review_loop_iteration: 0
baseline_commit: '0e8f1166557c6159b7a9069d8865c7eebd440441'
context:
  - /private/tmp/work-wiki-deferred-phase-0/_bmad-output/planning-artifacts/plan-open-deferred-work-2026-09-08.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The ledger's 54 open rows are not a verified implementation backlog.

**Approach:** Produce a baseline-bound evidence record for every open row and a concrete execution handoff. Use supported sweep dry-run for inventory and BMAD build for read-only source/probe review; proposed dispositions are not orchestrator write-back.

## Boundaries & Constraints

**Always:** Cover all 38 issue candidates and 16 review placeholders exactly once. Separate reproduced behavior, source-supported claims, historical evidence and unresolved verification. Reuse applicable recorded decisions; identify contradictory contracts. Use synthetic temporary fixtures and existing installed tooling. Preserve original checkouts and architecture.

**Ask First:** Resolving ambiguous product contracts, launching a mutating sweep or changing its policy, bug implementation, dependency/configuration changes, real-data/provider operations, merge or deployment.

**Never:** Edit the deferred-work ledger, existing frozen specs, production code, protected files or identifiers. Resume stale runs, spoof sweep automation context, send messages externally, waive reviews automatically, or claim production/capture readiness. No new deferred rows or manufactured findings.

</frozen-after-approval>

## Code Map

- `AGENTS.md`: kernel ownership, node/dom/browser evidence and ledger rules. `vitest.config.ts`, `vitest.setup.ts`, `playwright.config.ts`: test entry points; remove owned temporary probes afterward.
- `_bmad-output/implementation-artifacts/deferred-work.md`: authoritative IDs, source specs, decisions and locations. Hash baseline bytes before execution. Context plan maps all rows to packets/review groups.
- Shared checkout `/Users/christianlee/App-Development/work-wiki/.bmad-loop/runs/`: `20260907-174715-9ac9` finished, closing DW-781 only; `20260904-014021-5dc1` interrupted, older inventory. Recheck PIDs; preserve artifacts.
- Installed package `/Users/christianlee/.local/share/uv/tools/bmad-loop/lib/python3.11/site-packages/bmad_loop/`: `cli.py:2236,2368` dry-run only inventories/renders; `sweep.py:701,1233` closes rows before decisions-only gate. No read-only triage execution mode. Worktree lacks machine-local policy; dry-run uses defaults, not shared adapter/budget settings.
- F1: `src/app/u/[handle]/raw/[slug]/page.tsx:26`, `src/app/api/raw/[slug]/route.ts:97`, `src/components/RawSourceBrowser.tsx:60`; tests `raw-route.test.ts:94`, `edit-raw-alias-forwarding.test.ts:193` under `src/lib/__tests__/`. `spec-dw-726-738-742-page-scoped-read-gates.md:229` intentionally denies agent-scoped API access even to owner: identify allowed-caller matrix before fixing.
- F2: `spec-dw-612-613-owner-identity-id-vs-handle.md:59` frozen scope conflicts with Code Map 82–104; test map 206. Ledger decisions 4964/4973 remain inputs. Do not blindly resume the historical in-progress spec.
- Q1: `spec-dw-753-e2e-lane-in-ci.md` historically in-review; `.github/workflows/ci.yml` lacks browser job. `src/app/layout.tsx:78` has E2E identity wiring; execute prerequisite tests. Check failure artifacts.
- PR #13 at `1ae77dd7d914530052c0181e36d1fdcdd42e8229`: separate proposed write-safety documents; PR #8 unrelated. Recheck identities. Abbreviated specs above reside in implementation-artifacts.

## Tasks & Acceptance

**Execution:**
- [x] `phase-0-evidence.json` under `_bmad-output/implementation-artifacts/`: standalone versioned audit, not scheduler `result.json`. Record baseline/ledger hash, run/PR observations and one row per open ID: kind, packet/group, source/spec/decision anchors, current claim, evidence type, exact probe command/result or concrete verification blocker, proposed disposition, dependency and next action. Include compact reproducible evidence.
- [x] `phase-0-backlog-verification.md` in the same directory: readable findings and counts; assess every issue against current source and use bounded runtime probes for reachable behavioral claims. Review placeholders against later code/review evidence; missing review evidence stays review-required, not waived. Distinguish hypothetical guards from current owner failures. Explain F1/F2/Q1 constraints and revised starting order.
- [x] In that report, give the later orchestrator an ID-complete handoff and exact pending authorization/policy requirements. Keep PR #13’s seven gates separate; no architecture adoption. Leave overall ledger reconciliation pending terminal orchestrator harvest.
- [x] Preserve the context plan byte-for-byte. Final changes: this spec, copied plan and two deliverables only; embed compact logs/probe recipes in them.

**Acceptance Criteria:**
- Given the baseline open set, when comparing audit rows, then all 54 IDs appear once with evidence and a next action, with no unclassified or invented IDs.
- Given proposed resolution, when reporting, then current code/commit or executed proof supports it; stale specs and skipped/historical tests cannot certify it.
- Given an unavailable runtime or ambiguous contract, when verification cannot finish, then record the specific blocker and required evidence without labeling the issue fixed or waiving it.
- Given completed evidence collection, when handing off, then ledger bytes remain unchanged and the report distinguishes this audit from mutating sweep execution and terminal write-back.

## Spec Change Log

## Verification

- `bmad-loop sweep --project /private/tmp/work-wiki-deferred-phase-0 --dry-run`: inventory only, observed 54 open / 731 non-open; never dispatch its printed invocation.
- Execute relevant focused tests/probes with installed tooling and synthetic data; record collection, outcomes and limitations.
- Check exact ID partition and JSON/report totals, link targets, ledger hash and temporary-probe cleanup; run `git diff --check` including new files and inspect scope.

### Phase 0 implementation evidence — 2026-09-08

- `phase-0-evidence.json` and `phase-0-backlog-verification.md` cover 54 unique IDs (38 issue candidates and 16 review placeholders), all 26 packets and seven review groups.
- Current evidence: 15 issue claims runtime-reproduced, 20 source-supported, 3 without current owner failure; 16 placeholders remain review-required. No ledger disposition or bug closure inferred.
- Existing focused checks: 22 files / 694 tests passed. Temporary selected probes: 15 assertions passed; 167 copied original tests skipped by name filter are not counted. Stable-id variation: 4 expected assertion failures / 27 passes reproduces DW-613. Browser prerequisite: 26 passed in 1.4m after resolving local tooling/loopback startup limitations.
- Validation: 117 saved source anchors match immutable baseline; ID partition, local links, ledger/plan hashes and seven temporary-probe removals pass. Final tracked/untracked change scope is the spec, unchanged copied plan and two deliverables only; ignored local dependencies and browser outputs are retained as worktree tooling, outside the commit.
- Audit complete; not a full regression/build/CI pass, independent historical-review acceptance, implementation, migration, merge, deployment or terminal orchestrator harvest. Exact commands, recipes, evidence limits and next actions are embedded in the deliverables.

### Phase 0 review-provenance patch — 2026-09-08

- Retained ten later review/retrospective artifact versions with baseline commit, SHA-256, Git blob, checked sections and seven group-level scope comparisons; each of the 16 placeholder rows references its checked records.
- The checked records do not establish supersession. Remaining review/session/decision evidence is explicitly unverified; checking it precedes commissioning a new review. No exhaustive absence or review waiver claimed; counts unchanged.
- Document-only provenance repair. Revalidated artifact hashes/excerpts, exact ID partition, local links, unchanged ledger/plan bytes and whitespace. No runtime reruns.

### Independent review disposition — 2026-09-08

- Three context-free review passes completed: edge-case and verification-gap reviewers returned no findings; the blind review found missing later-review provenance. That finding was corrected and verified against immutable artifacts.
- Final parent validation confirms all 54 open IDs, 117 source anchors, ten review-artifact versions, 35 checked review excerpts, all 16 placeholder mappings and unchanged counts. No additional runtime run was needed for the documentation correction.
- No story key is attached to this standalone Phase 0 spec; sprint-status synchronization does not apply. Completion means the approved audit deliverables are complete; ledger dispositions and remaining behavioral verification stay pending.

## Suggested Review Order

**Audit result**

- Start with the evidence categories and what can proceed.
  [phase-0-backlog-verification.md:7](phase-0-backlog-verification.md#L7)

**Decision boundaries**

- Resolve caller, identity and CI scope before their implementation packets.
  [phase-0-backlog-verification.md:38](phase-0-backlog-verification.md#L38)

**Review provenance**

- Check retained review scopes before commissioning another review.
  [phase-0-backlog-verification.md:99](phase-0-backlog-verification.md#L99)

**Execution handoff**

- Keep audit recommendations separate from orchestrator ledger changes.
  [phase-0-backlog-verification.md:136](phase-0-backlog-verification.md#L136)

**Supporting evidence**

- Inspect reproducible commands, source excerpts and immutable review records.
  [phase-0-evidence.json:1](phase-0-evidence.json#L1)

- Use the original plan for wave sequencing after the audit constraints.
  [plan-open-deferred-work-2026-09-08.md:70](../planning-artifacts/plan-open-deferred-work-2026-09-08.md#L70)
