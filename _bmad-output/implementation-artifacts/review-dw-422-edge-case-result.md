# DW-422 independent edge-case review — 2026-09-10

Scope: the saved `review-dw-422-edge-case-hunter.md` packet only, SHA-256 `03a02c3ce71a1949e069e5dbe1c900d39fd5ccebf46d4cdcd2c08923e2eba2ab`. Its 25-file unified diff is parseable (+1,030 / -112). Every code/test postimage blob matched the worktree before validation. One independent Edge Case Hunter completed; no other layers were launched in this review session.

## Confirmed findings

1. **Medium / patch — Initial Chat list is discarded without reconciliation.** `src/components/workbench/useChatConversations.ts:154-155`. Open Chat with its first list GET pending; click the enabled New Chat button; allow creation to succeed; then settle the initial list with existing conversations. The mutation generation rejects the snapshot wholesale, but nothing schedules a replacement while the pane remains visible. Only the new conversation is shown; existing conversations are inaccessible from the sidebar until a hide/show cycle. Schedule a current list reconciliation after invalidation without reloading or replacing the active conversation. This confirms the already-recorded Chat action item; it does not create a duplicate.

2. **Medium / patch — Successful hidden revert resurrects a deferred revision view.** `src/components/workbench/PreviewColumn.tsx:1336-1337` (success handling at 1310-1311). Open History, start a revision View read, and use the still-enabled Revert control. Confirm the revert and enter Settings before either request settles. A successful hidden revert clears `viewingTimestamp` and `viewContent`, but leaves the queued view in `deferredView`. Return after the version advances: the resume effect reads that revision again and reopens its historical bytes. Invalidate queued/in-flight revision-view state when the revert succeeds. This uses the enabled Revert control; it does not depend on clicking the disabled pending View/Hide button described in the prior rejected finding.

## Validation

- Existing focused suites: **4 files, 72 tests passed** (visibility provider, Chat CRUD, mode withdrawal, Preview revisions).
- Both findings independently reproduced with expected-behavior assertions in a copied source snapshot: **2 failing probes**, each failing at the user-visible result. The other 59 tests in those copied suites were intentionally filtered out.
- Probe source and log: `/private/tmp/dw422-edge-probe-neabfeer/src/__tests__/initialization.test.tsx`, `/private/tmp/dw422-edge-probe-neabfeer/src/components/workbench/__tests__/preview-revision-history.test.tsx`, `/private/tmp/dw422-edge-probe-neabfeer/result.log`.
- The probes use the real mounted ChatCanvas and Workbench with controlled transport responses. They do not prove real browser layout or screen-reader speech.
- No production code or tracked tests were changed by this review. No fixes, status transition, commit, merge or deployment was performed. Existing shared review artifacts and the orchestrator-owned ledger were preserved.


### Approved edge-case fixes — 2026-09-10

The user approved applying the two standalone edge-case findings. Both are now fixed locally; their action items in the implementation spec are checked. The other review findings remain separate, and the overall packet stays `in-review`.

- Chat rejects invalidated list success/error settlements and schedules reconciliation through its existing visibility-gated effect. If writes are still pending, the final write settlement releases one refresh. The active conversation and composer are preserved; no conversation-detail reload is introduced. Mounted coverage includes both initial list/create settlement orders, failed stale reads, withdrawal, preserved drafts, and existing create/rename/delete snapshot races.
- Successful revision revert clears deferred and in-flight revision views, invalidates their request token and resets view loading before closing the historical view. Mounted Workbench regressions cover the old read settling while hidden or after return; neither reopens history, and the restore announcement remains intact.

Verification of these changes:

- Scoped mounted run: **81 passed, 1 explicitly excluded** (the concurrently added attachment-nudge test belongs to another review finding), across four files. `/private/tmp/dw422-edge-fixes-scoped.log`.
- Full `pnpm test`: **414 files passed, 3 failed; 10,206 tests passed, 7 failed, 1 existing skip**, 223.26 seconds. Six failures cover the other session's new meeting-status and attachment cases. The seventh is a 5-second timeout in `merge.test.ts` with subsequent cleanup failure; rerunning that entire unchanged suite alone passed **59/59**. This does not make the full run green. Logs: `/private/tmp/dw422-edge-fixes-full-test.log`, `/private/tmp/dw422-edge-fixes-merge-rerun.log`.
- `pnpm lint` and `git diff --check`: passed. Lint retains existing TSNonNullExpression tool diagnostics. `/private/tmp/dw422-edge-fixes-lint.log`.
- The shared-checkout build compiled, then failed on missing generated `.next/server/next-font-manifest.json`. A fresh copy at `/private/tmp/dw422-edge-build-k5a8gk2o` passed `pnpm build` and the subsequent `pnpm exec tsc --noEmit`. Logs: `/private/tmp/dw422-edge-fixes-clean-build.log`, `/private/tmp/dw422-edge-fixes-clean-tsc.log`. The original checkout also passed TypeScript before that build attempt.
- Both changed implementation files and their affected test files retained identical hashes throughout terminal verification and match the successful clean build copy. Hash record: `/private/tmp/dw422-edge-fixes-hashes.json`.
- Concurrent additions from another session were preserved. A temporary dependency symlink remains in the shared worktree for ongoing verification; it is not source and must not be staged. No protected files, frozen intent or ledger entries were edited. No commit, push, merge or deployment was performed. VoiceOver/NVDA speech remains unexecuted.
