# DW-422 code review — 2026-09-10

Review mode: full. All four independent layers completed: blind-hunter, edge-case-hunter, verification-gap, acceptance-auditor. No failed layers. Decision needed: 0; patch: 4; defer: 1; dismissed: 0. The four actionable findings were subsequently fixed and verified; see the patch closure below.

Reviewed baseline: `239f43dda395f5ba318812b177b413fcd330558a`, plus the supplied uncommitted diff. Packet SHA-256: `bf1ab398eaa7b488111ea61f057f8e8cac86647cf9718dc3e9d3c852d5b27db7`. Every packet section matched the live worktree before review. This is a working-tree review, not committed-head release acceptance.

## Actionable findings

### 1. Creating Chat during first load hides existing conversations

- Source: edge-case-hunter. Severity: medium. Route: patch.
- Location: `src/components/workbench/useChatConversations.ts:155`.
- New Chat is enabled before the initial list resolves. Starting creation advances `listMutationSeq`, so the first list is discarded. No replacement reconciliation is scheduled, leaving only the newly created conversation in the sidebar until the next visibility cycle.
- The return-race tests start with an already populated list; they do not cover this initial-load sequence. A scratch mounted ChatCanvas regression reproduced the missing existing row after the delayed initial list settled.
- Preserve mutation safety while scheduling a current list reconciliation when an initial snapshot is invalidated. Keep the owner's new active conversation and composer intact.

### 2. Source Preview omits visibility gating for meeting status

- Source: blind-hunter. Severity: medium. Route: patch (missing adoption of this packet's passive-read contract).
- Locations: `src/components/workbench/PreviewColumn.tsx:1561`, `src/components/workbench/MarkMeetingControl.tsx:54`, `src/hooks/useSurfaceVisibility.ts:57`.
- A first hidden source-file Preview still mounts MarkMeetingControl. Its unconditional GET `/api/sources/meeting` starts off screen and accepts settlements without visibility checks. SurfacePresentation retains React elements, but does not prevent a child component's own state updates.
- The new hidden-first-Preview case uses a page selection, so it misses this source-file reader. A scratch mounted PreviewColumn case expected zero meeting-status reads and observed one.
- Apply effective visibility to this passive reader, reject obsolete settlements, and reconcile once on return without cancelling an explicit meeting-mark mutation.

### 3. Late successful Todos responses lack rail-level verification

- Source: verification-gap. Severity: low. Route: patch (verification).
- Location: `src/components/workbench/TodosCanvas.tsx:107`.
- The withdrawal test rejects a delayed request; it never resolves an obsolete successful response and supplies no pending-count callback. Removing the success-path guard can therefore publish an obsolete count to Workbench's visible rail without exercising that test's failure path.
- Add a composed regression asserting the retained rail count and items through withdrawal, obsolete success, and a delayed current reconciliation. This is a coverage gap, not a claim that the present success guard is broken.

### 4. Hidden Chat attachment completion still nudges the watcher

- Source: acceptance-auditor. Severity: low. Route: patch (missing adoption of the explicit no-hidden-nudges contract).
- Location: `src/components/workbench/ChatCanvas.tsx:443`.
- Start Attach, hide Chat via Settings, then settle Intake with `refresh: true`. The completion calls requestDataVersionCheck unconditionally. Visibility gates the presentation but not this caller-side nudge.
- The existing attachment test verifies the nudge only while visible; the new stream withdrawal test does not cover Attach. Confirmed by source/caller tracing; no new runtime reproduction was run for this finding.
- Defer and coalesce the nudge until visible while preserving the attachment operation and its result.

## Pre-existing finding

### 5. Skills return scan clears an uncertain toggle's explanation

- Source: blind-hunter. Severity: medium. Route: defer.
- Location: `src/components/workbench/SkillsCanvas.tsx:105`.
- Hide Skills while a toggle is pending, settle it with a 502/unknown outcome, then return. The normal scan updates enablement and clears the mutation error, so the owner cannot inspect the uncertain-write explanation after reconciliation.
- The scratch regression fails against both the current component and the component extracted from the baseline commit. This is not introduced by DW-422 and is not included in the patch set.
- Recorded here and in the spec only. The orchestrator-owned deferred-work ledger was not modified, as required by repository policy and the packet's frozen boundary.

## Verification and limits

- Fresh focused run: 8 existing DOM suites, 181/181 tests passed. Log: `/private/tmp/dw422-code-review/focused-tests.log`.
- Scratch behavioral regressions: 3 expected assertions failed, reproducing findings 1, 2 and 5. No collection/runtime errors in the final run. Source: `/private/tmp/dw422-code-review/reproductions.test.tsx`; log: `/private/tmp/dw422-code-review/reproductions.log`.
- Baseline Skills control: same failure using baseline SkillsCanvas; two unrelated cases filtered out. Log: `/private/tmp/dw422-code-review/baseline-skills.log`.
- Existing terminal full-suite log was inspected: 416 files, 10,199 passed, 1 skipped. This broad run was prior evidence, not rerun during this review.
- `git diff --check` passed before report writeback. No production source or tracked tests were modified. Temporary dependency link was removed after verification.
- No browser/VoiceOver/NVDA, deployment, merge or production verification was performed. Spec remains in-review pending disposition. No sprint story key was identified, so sprint tracking was not synced.


## Patch closure — 2026-09-10

All four actionable findings are fixed locally and checked off in the spec. The pre-existing Skills issue remains deferred. Concurrent edits supplied the Chat-list reconciliation and an additional hidden-revert revision-view fix; this pass preserved them, added settlement-order coverage, and included both in its final verification. It implemented the meeting-status visibility/error-preservation fix and the attachment nudge deferral, and added the full Workbench stale-success rail regression.

Fresh evidence after the fixes:

- Focused: 96/96 passed across five suites.
- Full suite: 417 files, 10,213 passed, one existing credential-dependent skip (161.05 seconds).
- Production build, subsequent TypeScript check, lint, and diff check passed. Lint retained only the existing TSNonNullExpression diagnostics.
- No code/config drift between verification start and finish; 1,052-file fingerprint `5731f4767abdecc61775e18d1c5ce9b578a07c7bf8a68b7ae5aa6540d385ba7a`.
- Logs: `/private/tmp/dw422-code-review/fixes-focused.log`, `fixes-full-test.log`, `fixes-build.log`, `fixes-tsc.log`, `fixes-lint.log` in the same directory.

The earlier scratch failures above are pre-fix evidence. The final regressions live in the repository and execute in the normal test run. The temporary dependency link was removed. Frozen intent, protected files and deferred-work ledger are unchanged. No commit, merge or deployment occurred. The spec remains `in-progress` because the pre-existing medium Skills finding is still deferred; no sprint key was available to sync. Browser layout and VoiceOver/NVDA speech were not tested.

## Release disposition — 2026-09-11

User authorized commit, publication and merge after DW-759. All in-scope fixes are complete; the pre-existing Skills finding remains a separate nonblocking follow-up. The spec is now implementation-complete (`done`). The source/config verification manifest was rechecked unchanged before commit. Integration with DW-759 and remote CI remain release gates, not claims covered by the original local run. No deployment is included; the ledger remains orchestrator-owned.
