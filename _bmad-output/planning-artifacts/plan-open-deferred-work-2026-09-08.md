# Plan to resolve open deferred work and write-safety prerequisites

Date: 2026-09-08. Status: proposed execution plan; no implementation, sweep,
ledger changes or release actions authorized by this document.

Baseline: `main` at `0e8f1166557c6159b7a9069d8865c7eebd440441`.
The [ledger](../implementation-artifacts/deferred-work.md) contains 54 open
entries: 38 issue entries and 16 review-budget-followup placeholders. These
counts match the current main ledger checked during planning; the underlying
38 defects have not all been reproduced against current code. Revalidate before
spending implementation effort. Do not equate an open row with a confirmed bug.

The write-safety handoff is separately tracked in
[PR #13](https://github.com/LuckierTrout/work-wiki/pull/13), commit `1ae77dd7`.
Its seven evidence gates are additional work, not new DW rows. Resolve ordinary
defects without waiting for the production migration; do not use a small bug fix
to adopt the proposed commit-authority architecture.

## Outcomes and completion criteria

1. Every one of the 54 ledger entries has an evidence-backed disposition through
   the owning workflow: confirmed and fixed, already resolved, explicitly
   accepted/waived, or blocked with an exact dependency and responsible role.
2. Every implemented fix has a focused regression and at least one execution of
   its real composition root. Review and required CI cover the final code SHA.
3. Each of the 16 review placeholders has a recorded review or explicit waiver;
   a placeholder alone is not a reason to rewrite completed code.
4. Each write-safety gate has authoritative evidence or an explicit blocked
   verdict. A completed investigation can conclude migration is still blocked;
   it cannot label an unproved capture safe.
5. Report local implementation, PR, merge and deployment separately. Production
   migration is complete only after its own approved capture, rollout, owner
   checks and recovery proof—not when the documentation or bug backlog is done.

## Phase 0 — establish the executable backlog

Use one fresh baseline after reconciling current main, open PRs and live loop
state. Inspect `bmad-loop list`, run state/journal/heartbeat and engine process
before starting or resuming anything. Do not create a second sweep in an active
checkout. Preserve the three existing untracked write-safety review artifacts.
Use an isolated worktree for manual work; merge it only while the shared sweep
is stopped/idle and its checkout is clean.

For every open entry, use the approved orchestrated triage process to record:

- Current source path and applicable frozen spec/recorded decision.
- A reachable reproduction, or concrete code/commit evidence it is already fixed.
- User consequence and smallest coherent implementation boundary.
- Required regression, composition-root check, approval and dependency.

Do not hand-edit `deferred-work.md`. Already-fixed rows are candidates for the
orchestrator's `already_resolved` disposition. A triage result is provisional
until terminal harvest/write-back. Preserve unresolved rows until that happens.
Do not convert a non-reproducible concern into a new source-string guard merely
to close its row. DW-522, DW-538 and DW-764 especially need reachability/current
consequence checked: their original descriptions include hypothetical future
drift or behavior that was correct when written.

Reuse existing decisions for DW-422, DW-612 and DW-613. DW-443 contains two
different dated decisions: use the later per-runtime proposal as the candidate,
but establish which contract governs the new packet before changing API shape.
DW-753's two decisions agree on enrolling Playwright in CI; verify its E2E
identity prerequisite has actually landed. Do not ask the owner to repeat an
existing applicable decision.

Exit: a reconciled list of real fixes, reviews, waivers and blocked decisions,
with each issue assigned once to the provisional packets below. Triage may
shrink or split packets; do not expand them into neighboring cleanup.

## Implementation waves

Order by exposure and lost-work risk, not the ledger's historical severity.
IDs are assigned exactly once below. Packets contain one goal and at most three
DWs; single-item packets are intentional when callers or contracts differ.
Run sequentially in the sweep. Independent work may use separate worktrees only
after checking it will not race on lifecycle, storage, identity or UI files.

### Wave 1 — access, identity and trustworthy errors

| Packet | DWs | Concrete outcome | Acceptance evidence |
| --- | --- | --- | --- |
| F1 Raw-source access | 771 | Apply the intended source access policy consistently to the human page, API and download link. | Anonymous, owner and agent-scoped requests through real page/API composition; forbidden source bytes never reach render output; authorized downloads work. |
| F2 Canonical owner identity | 612, 613 | Stable-id owners write to the canonical tenant; client affordances use the server's owner verdict. | Drifted handle, absent username, matching stable id and stale-handle impostor cases; write then read the same Wiki/artifact; mounted UI agrees with server authorization. |
| F3 Fetch egress boundary | 443 | Implement the resolved per-runtime DNS/egress contract across shared fetch callers. | Local controlled DNS/redirect/rebinding cases prove connect-time protection where supported; Workers egress limitation remains explicit until its separately approved control exists. A pre-fetch DNS check alone fails acceptance. |
| F4 Artifact failure privacy | 766 | Registry read/write failures during purpose saves produce safe typed errors and honest outcome messages. | Fault-injected route-to-storage execution, rollback outcome checked, no filesystem path/errno in owner response. |
| F5 Agent-owner resolution | 780 | Human handles containing `--` cannot silently select another tenant's prompt guidance. | Registered agent, ordinary human, punctuation prefix and ambiguous handle cases through ingest/merge guidance resolution; preserve legitimate agent IDs. |

F2 should precede owner-sensitive lifecycle and UI work. F3 requires a narrow
runtime decision and may remain blocked while the other packets proceed.
F5 must agree with F2's tenant contract without renaming frozen identities.

### Wave 2 — deletion, cancellation and crash recovery

| Packet | DWs | Concrete outcome | Acceptance evidence |
| --- | --- | --- | --- |
| D1 Bulk history deletion | 768, 770 | Delete owner-silo orphans correctly; distinguish storage failure from confirmed absence. | Real history route → lifecycle → temporary store; injected read failure retains job evidence and reports failure; silo-only deletion completes. |
| D2 Case-variant identity | 776, 783 | Resolve which physical spellings a logical delete owns; recover an already-written case variant without duplicate publication. | Case-sensitive store with competing variants; hard delete cannot resurrect an owned sibling; restart/idempotency retry checks existing bytes and completes one receipt or reports a real conflict. |
| D3 Source cascade consistency | 774, 784 | Source deletion accounts for relocated merge sources and does not silently cancel surviving work after an incomplete cascade. | Merge → relocate → cascade through real storage; failures at enumeration/write/delete boundaries preserve a truthful partial outcome and recoverable job state. |
| D4 Research cancellation | 773 | Cancelled research with malformed source-phase completion reaches the correct terminal disposition. | Persisted malformed state → reconcile/cancel → restart; no endless blocked loop, unintended publish or replay of unknown effects. |

D2 needs an explicit deletion/identity ruling before implementation; never guess
that every case sibling may be destroyed. D3 needs an approved reconciliation
boundary for source addresses and cancellation. Merely moving cancellation
after deletion is insufficient: a concurrent job could publish in the gap.
Keep both packets within existing lifecycle ownership, and document limits of
current nontransactional storage instead of claiming cross-store atomicity.

### Wave 3 — honest Chat and generated-output behavior

| Packet | DWs | Concrete outcome | Acceptance evidence |
| --- | --- | --- | --- |
| C1 Faithful turn settlement | 754, 755 | Truncated final SSE fails clearly; real tool refusal/cancellation survives browser settlement. | Fragmented stream → transport → pending-turn → rendered answer; preserve citations where required and do not broadly allow uncited factual answers. |
| C2 Conversation feedback | 756, 777 | CRUD refusals display errors; a later successful save clears the obsolete failure banner. | Mounted refusal/retry/success paths with no unhandled rejection or contradictory banners. |
| C3 Save-to-wiki completion | 775 | Long compile does not leave a timed-out request as the only account of a save. | Real save route with unavailable queue, bounded inline fallback and slow compile; durable accepted work is discoverable and retry does not duplicate it. Reuse the existing intake budget/receipt contract. |
| C4 HTML/slides truncation | 757 | Incomplete-generation warnings survive HTML/slides rendering and saving safely. | Non-stop finishes, complete and broken closing tags, renderer plus save path; warning visible without injecting text into executable markup. |

C3 depends on stable lifecycle behavior from Wave 2. C1 must align the sidecar
and browser wire contract; do not fix it by disabling citation checks globally.

### Wave 4 — visible surfaces, keyboard and scroll

| Packet | DWs | Concrete outcome | Acceptance evidence |
| --- | --- | --- | --- |
| U1 Withdrawn surfaces | 422, 538 | Hidden Preview/mode surfaces pause the agreed lifecycle and stay visually withdrawn; return performs one refresh. | Mounted hidden/visible transitions, no hidden announcements or redundant fetches, browser-computed display checks. Respect pending edits. |
| U2 Focus recovery | 522, 759 | Focus returns to a visible valid destination when navigation withdraws its region. | Settings pane Back/Forward plus dialog openers under hidden/visibility/inert conditions; jsdom behavior and real browser focus. Implement only reachable cases justified by triage. |
| U3 Narrow-sheet scroll | 760 | Opening/closing the mode sheet preserves the canvas's intended scroll position. | Real narrow viewport with docked Preview; induced browser clamp/reflow does not overwrite remembered offset. |

U1 → U2 → U3 reduces repeated edits to shared surface visibility behavior.
Run browser checks for CSS geometry and focus; mocked rectangles cannot certify
the cascade. Retain any applicable manual assistive-technology checks.

### Wave 5 — validation, API contracts and search accuracy

| Packet | DWs | Concrete outcome | Acceptance evidence |
| --- | --- | --- | --- |
| V1 Agent page validation | 767 | Invalid page types fail before any page or profile write across HTTP/MCP callers. | Real kernel invoked from each affected door; invalid nested type leaves storage and profile lists unchanged. |
| V2 XLSX relationships | 772 | A relationship pointing at a non-worksheet cannot suppress valid sheets or invent an empty workbook. | Real ZIP fixture → extraction entry point, malformed relationship plus valid fallback and legitimate workbook variants. |
| V3 Canonical miss hints | 769 | Agreed revision/lineage/preview doors return consistent canonical-slug hints. | Explicit contract decision, real miss/alias/permission cases and consumer behavior; hints must not disclose inaccessible page identities. |
| V4 Stored-review errors | 785 | Invalid stored research input is distinguished from caller-fixable request input. | Approved machine error token; route with malformed stored review plus valid request; unchanged retry is not presented as a remedy. |
| S1 Vector drift reporting | 758 | A limited Vectorize candidate window cannot falsely diagnose whole-corpus drift. | Fixture with stale nearest candidates and valid later vectors; retained unlabeled-vector semantics; report uncertainty/fallback unless complete provider evidence exists. |

V3 and V4 need narrow contract rulings because earlier scopes deliberately
excluded these changes. S1 must preserve the existing legacy-vector predicate;
do not silently drop unlabeled records to make a provider filter expressible.
Fetch current official/Context7 documentation during F3/S1 implementation.

### Wave 6 — verification infrastructure and maintenance

| Packet | DWs | Concrete outcome | Acceptance evidence |
| --- | --- | --- | --- |
| Q1 Browser CI | 753 | Existing Playwright suite runs in an isolated CI job with the approved E2E identity. | Exact-head CI actually collects/runs the browser tests, deterministic seeded state, retained failure artifacts and recorded duration; production builds cannot receive E2E identity settings. |
| Q2 Queue wiring coverage | 778 | A broken producer binding/queue mapping fails verification instead of silently dropping enqueue. | Producer configuration → runtime queue lookup/send → matching consumer contract; mutation of binding or destination causes a meaningful failure. Preserve frozen identifiers. |
| M1 Brand waiver accuracy | 761, 762 | Retired waivers and prefixed lookalikes cannot pass the brand scan. | Explicit positive frozen spellings plus negative prefix/retired-waiver cases; no widening or renaming identifiers. |
| M2 Planning/document accuracy | 763, 764, 765 | Correct the stale CLI plan and E2E statement; disposition the currently-correct lint-count concern based on actual maintenance need. | Compare prose with source and run relevant existing checks. Preserve frozen spec intent. SCHEMA is executable prompt input: isolate any justified change from unrelated prompt behavior. |
| M3 Accurate helper copy | 779, 782 | Skills distinguish unreachable/refused sidecar; inheritance copy describes provider and model independently. | Mounted origin/refusal cases and resolver-backed provider/model combinations. |

Start Q1 early, after verifying its identity prerequisite, so Waves 3–4 benefit
from CI. Its `.github/` edit must be expressly covered by the implementation
packet and applicable recorded authorization; a planning request does not edit
protected workflows. Q2 can accompany early intake verification but stays its
own goal. Do not let M2 turn a hypothetical count drift into an unnecessary new
source-string test. Update the local-only E2E wording when Q1 actually lands.

## Review-only track — all 16 placeholders

Review these against immutable completed code and later changes, separate from
the implementation sweep's normal skip policy for review-budget-followup rows.

| Review concern | DWs |
| --- | --- |
| Retired machinery and locale | 82, 119, 135 |
| Linking and identity | 90, 160 |
| Test environment and accessibility | 114, 154, 186 |
| Authorization and conflict handling | 124, 201 |
| Wiki profiles and artifact revisions | 146, 216 |
| Wiki rename/delete and creation atomicity | 151, 165 |
| Mode navigation and Wiki lens | 169, 173 |

First check whether later accepted reviews already cover the concern. If yes,
attach that evidence for orchestrator disposition. Otherwise perform one bounded
review per coherent concern. Zero findings is valid. If a review finds a current
defect, map it to an existing issue when appropriate; do not reopen everything
or manufacture findings to satisfy a quota. A waiver is an explicit owner
decision, not something inferred from elapsed time. Only the orchestrator writes
ledger disposition; review grouping above is not automatic implementation bundling.

## Write-safety track — investigate before committing to migration

Run source inventory and decision preparation alongside backlog triage. Ordinary
bug fixes can continue while external evidence remains unavailable. Use PR #13's
feasibility and conditional integration documents as the detailed handoff,
rebase their source/caller evidence after relevant fixes, and retain the existing
architecture until an explicit amendment is approved.

| Gate | Next concrete deliverable | Responsible role / dependency |
| --- | --- | --- |
| B1 Complete consistent source | Exact canonical/operational/projection inventory and supported capture frontier, including global R2/KV and input custody. | Engineer prepares source census; provider/operator supplies authoritative capture guarantees. |
| B2 Legacy admission/executions | Coverage of every ingress, old execution, child/background action and direct capability; supported cutoff and terminal accounting. | Engineer maps callers; operator/provider proves actual coverage. Do not substitute quiet logs or timeouts. |
| B3 Queue preservation | Actual queue/DLQ ages, retention, attempts, in-flight and ambiguous-send inventory; reversible preservation plan with headroom. | Operator/provider, under approved inspection. Pause does not stop expiry. |
| B4 Inputs/external outcomes | Verified original input digests and per-effect idempotency/query/reconciliation strategy. | Engineer specifies manifests; input custodians/providers resolve missing bytes and unknown sends. |
| B5 Isolation | Explicit old/new permission matrix, approved added resources and demonstrated denial of legacy access and effect authorization. | Architecture/operator; no credential or resource changes during planning. |
| B6 Capacity/recovery | Measured size/retention budget and nonproduction restart/forward-recovery rehearsal with retained original evidence. | Engineer/operator; synthetic proof first, real-data access separately authorized. |
| B7 Architecture/release | Explicit authority/storage amendments, complete caller coverage, accepted exact-artifact verification and AD-15 release packet. | Architecture/release owner after B1/B2 feasibility and the integration dependencies. |

The first decision is whether B1/B2 admit a supported lossless bootstrap at all.
Draft precise provider/operator questions locally; send nothing without explicit
authorization. Do not provision a destination or build the entire migration
hoping capture will become solvable later. If evidence cannot establish a safe
bootstrap, record blocked feasibility and stop production-dependent work.
An owner accepting data loss would be a different migration intent, not closure
of these lossless-capture gates.

After feasibility and architecture approval, use the handoff's P0–P8 sequence:
coverage/bootstrap → inactive authority/verifier → lifecycle and canonical owner
state → jobs/provider outcomes → queue/effects → reference readers/projections →
complete admission/capability fencing → full capture/activation/forward recovery.
Local implementation may be separately authorized before live provisioning;
activation requires all relevant gates closed and all writers/readers migrated.
Backlog fixes do not themselves prove this cutover safe.

## Execution and verification policy

- One approved implementation spec per coherent packet, with a frozen intent,
  explicit files/decisions, acceptance examples and baseline SHA. Reuse earlier
  decisions without changing their scope silently.
- Reproduce first, then patch and run focused behavioral tests plus the real
  composition root. Use `node` suites for kernel behavior, `dom` for mounted UI,
  and Playwright for actual layout/browser behavior. No remote effects in fixtures.
- Run required typecheck, lint, complete test/build and CI gates for the packet.
  Review the final code, fixing medium/low findings in-pass. Do not start another
  review loop merely because it can produce more findings; follow repository
  policy for patched high-consequence findings and final verification.
- Each PR describes the concrete owner consequence, change, validation and
  remaining limitations. No automatic merge/deploy follows this plan; obtain
  the applicable execution/release authorization once the result is reviewable.
- At most one new justified deferred row per implementation bundle, written by
  the owning workflow. Only real wrong answers, lost work or broken user paths
  outside the named scope qualify. Nearby comments, test pins and sibling residue
  are not automatic new backlog entries.
- After every merged wave, reconcile the ledger through terminal orchestrator
  write-back and update counts from evidence. Report confirmed fixes remaining,
  unresolved decisions, review dispositions, CI status and production blockers.

## Starting sequence and effort control

1. Reconcile active loop/PR state and reproduce the 38 candidates; inventory the
   16 review placeholders without automatically scheduling them as fixes.
2. Prepare F1, F2 and Q1 from existing decisions; begin F3's runtime-contract
   investigation and the B1/B2 provider-question packet in parallel conceptually,
   using separate worktrees only when authorized execution begins.
3. Finish Wave 1, then the shared lifecycle packets in Wave 2; proceed through
   Chat, visibility and API/search waves. Bring forward independent small fixes
   when a decision blocks another packet.
4. Complete remaining verification/maintenance and bounded review dispositions.
5. Reassess write-safety feasibility and authorize P0–P8 packets only as their
   prerequisites become concrete. Keep real maintenance/deployment in a separate
   approved release window.

There are 26 provisional implementation packets, seven bounded review concerns
and seven write-safety gates. This is a work breakdown, not a duration estimate:
triage may eliminate stale rows, and external provider guarantees have unknown
lead time. After Phase 0, estimate each retained packet from its reproduction
and test surface, then set a delivery schedule. Track completion by accepted
evidence, not raw row closure or tests that were never collected.
