---
title: 'DW-422: Pause hidden pane activity and reconcile on return'
type: 'bugfix'
created: '2026-09-10'
status: 'done'
baseline_commit: '239f43dda395f5ba318812b177b413fcd330558a'
review_loop_iteration: 0
baseline_revision: '239f43dda395f5ba318812b177b413fcd330558a'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Hidden Preview keeps fetching and announcing. Mode panes admit late passive responses, and Chat initialization reads start off screen.

**Approach:** Apply the approved visibility gate to passive reads, version checks and announcements; reconcile on return while preserving owner work.

## Boundaries & Constraints

**Always:** Honor ancestor visibility. Preserve drafts, selection, scroll, dialogs and save/revert/Chat operations. Scope outcomes to their original target. Retain permissions, errors, repeat announcements and editor deferral. Coalesce hidden changes into one read per passive resource on return; later independent commits may refresh normally.

**Ask First:** Changes to server contracts, persistence, mutation semantics or which user operations continue during withdrawal.

**Never:** Unmount to pause; replay Search, semantic Lint, generation or mutations on return; change the global dataVersion bus; restyle panes; include DW-538/760; modify frozen identifiers, protected configuration, existing intent contracts or the orchestrator-owned ledger. Publishing, merging and deployment are outside this packet.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Hidden changes | Several version bumps during Settings | No passive reads, nudges or live-region writes; one current refresh on return | Preserve last-good data |
| Late read | Read started before withdrawal settles while hidden | Ignore obsolete settlement, including cancellation-ignoring transports | No hidden error or stale overwrite |
| Editing | Dirty draft across hide/show and bumps | Same draft/editor; refresh after edit ends | Preserve conflict handling |
| Mutation settles | Save/revert finishes while hidden | Settle bookkeeping; defer history read, nudge and announcement | Preserve failure/retry outcome |
| Target changes | Pending outcome belongs to previous row/wiki | Do not announce/apply it to new target | Current target loads normally |
| First hidden mount | Preview or mode has never shown | Delay passive initialization until visible | Normal first-load error handling |
| Explicit work | Chat stream, Search or Lint underway | Preserve operation; do not restart on return | Retain result for visible presentation |

</frozen-after-approval>

## Code Map

- `src/hooks/useSurfaceVisibility.ts`: provider and default-visible consumer; compose ancestor visibility.
- `src/components/workbench/PreviewColumn.tsx`: `PreviewPane` fetch effect (~595), save/revert nudges, history reads and announcements.
- `src/lib/workbench-data-version.ts`: `previewFetchPlan` preserves shown selection and edit deferral; shared watcher bus stays unchanged.
- `src/components/workbench/ModeCanvas.tsx`: mounted panes and `active` inputs. `Workbench.tsx` supplies hidden props.
- Mode readers: `TodosCanvas.tsx`, `GraphCanvas.tsx`, `ReviewCanvas.tsx`, `ResearchCanvas.tsx`, `SkillsCanvas.tsx` in the same directory. Existing active gates need late-result protection.
- `ChatCanvas.tsx` and `useChatConversations.ts` there: separate passive resumption from conversation selection. `SearchCanvas.tsx`/`LintCanvas.tsx` own explicit operations.

## Tasks & Acceptance

**Execution:**
- [x] `src/hooks/useSurfaceVisibility.ts`, `src/components/workbench/ModeCanvas.tsx` — publish consistent effective visibility for each pane, preserving standalone default-visible behavior.
- [x] `src/lib/workbench-data-version.ts`, `src/components/workbench/PreviewColumn.tsx` — gate reads before reset, invalidate late reads, coalesce deferred history reads/nudges/announcements without duplicate resumption.
- [x] `src/components/workbench/{TodosCanvas,GraphCanvas,ReviewCanvas,ResearchCanvas,SkillsCanvas}.tsx` — retain active/polling gates and reject obsolete passive settlements.
- [x] `src/components/workbench/{ChatCanvas,SearchCanvas,LintCanvas}.tsx`, `src/components/workbench/useChatConversations.ts` — separate passive initialization/resumption from explicit operation lifetime; defer hidden presentation without resetting sessions or replaying work.
- [x] `src/components/workbench/__tests__/{preview-announcements,settings-canvas-persistence,preview-revision-history,preview-dirty-guard}.test.tsx` — execute Preview matrix through real Workbench and controlled responses.
- [x] `src/components/workbench/__tests__/mode-canvas-withdrawn.test.tsx` — test mode withdrawal, polling, late reads and Chat preservation. Add provider cases to `src/hooks/__tests__/useSurfaceVisibility.test.tsx` and plan cases to `src/lib/__tests__/workbench-data-version.test.ts`.

**Acceptance Criteria:**
- Given Workbench navigation, when Settings hides a pane across version changes, then reads/announcements pause and current data reconciles once on return.
- Given pending work, when visibility changes repeatedly, then stale reads cannot replace current data and explicit operations survive without replay.
- Given standalone components, when no provider exists, then default-visible behavior remains intact.

## Spec Change Log

## Design Notes

Older DW-422 specs bundle other work and remain historical context. Passive read cancellation is allowed; mutation/stream cancellation is not. Mounted tests prove live-region text; VoiceOver/NVDA speech remains manual.

## Verification

- Run focused node plan/provider and mounted Preview/mode suites, including a real Workbench composition case and cancellation-ignoring responses.
- Run `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm build` and `git diff --check`; record actual results and existing skips.
- Perform the documented live-region VoiceOver/NVDA check where available; explicitly retain any unexecuted platform limitation.


## Implementation Evidence — 2026-09-10

Implemented in the isolated checkout based on `239f43dda395f5ba318812b177b413fcd330558a`; not committed, published, merged or deployed. Frozen intent, protected configuration, frozen identifiers and deferred-work ledger were not edited.

- Visibility providers compose ancestor visibility. Every mounted mode publishes effective visibility. `SurfacePresentation` retains the last visible subtree while owner operations settle, preserving mounted nodes and deferring hidden live-region DOM updates.
- Preview gates before selection resets, rejects obsolete body/history responses, preserves dirty editing, and scopes mutation outcomes to their originating selection. Deferred mutation version checks use the mutation-start version. A local return barrier releases one Preview/history reconciliation when that served version advances; an already-served hidden advance needs no extra check. Preview's existing local `REQUEST_TIMEOUT_MS` (15 seconds) bounds waiting if no watcher answer arrives. The global bus is unchanged.
- Mode passive readers preserve their active/polling gates and reject obsolete settlements. Chat initializes when visible and reconciles only its conversation list on return; active conversation, composer, stream and explicit operations remain alive. Search and Lint present retained results on return without replay and reject outcomes from a superseded wiki.

### Executed matrix

| Matrix row | Mounted or pure evidence |
| --- | --- |
| Hidden version changes and cancellation-ignoring body response | `preview-announcements.test.tsx`: real Workbench Settings visit, multiple hidden bumps, ignored late body, one return read, later independent commit |
| Dirty editor | `settings-canvas-persistence.test.tsx`: same editor node/draft across hidden bumps; `preview-dirty-guard.test.tsx`: zero additional reads through return until the owner leaves the editor, then one current read |
| Hidden save/revert outcomes | `preview-revision-history.test.tsx` hidden mutation group: save success/refusal and retryable draft; revert success/unknown outcome; no hidden nudge/history/live-region changes; version-answer coalescing; already-served hidden version; later independent commit; preserved restore announcement even when the return read is unreachable |
| Late history / target switch / first hidden mount | `preview-revision-history.test.tsx`: ignored cancellation-ignoring listing, one return listing; same mounted Preview delays first initialization and drops a previous row's revert after a hidden target change |
| Passive mode readers and polling | `mode-canvas-withdrawn.test.tsx`: Todos/Graph/Review/Research late reads, Skills abort-ignoring JSON response, Research polling withdrawal and return |
| Explicit work | `mode-canvas-withdrawn.test.tsx`: retained Search and semantic Lint results with one request; Chat composer/session preservation. `chat-live-stream.test.tsx`: real ModeCanvas withdraws an active stream, leaves its signal live, persists its result while hidden, presents it on return without retrieval replay or active-conversation reload |
| Provider and pure plan contracts | `useSurfaceVisibility.test.tsx`: default visible, ancestor composition, same live-region DOM. `workbench-data-version.test.ts`: hidden plan preserves shown selection before reset |

### Verification results and limits

- Latest changed Preview suites: **119/119 passed** (`/private/tmp/dw422-preview-final.log`). Other focused mode/provider/plan and compatibility suites passed, including **95/95** for updated source wiring and mode URL/remount assertions (`/private/tmp/dw422-contract-final.log`).
- Full `pnpm test` with approved runtime permissions: **416 files passed; 10,194 passed, 1 skipped**, 128.29 seconds (`/private/tmp/dw422-full-test-network.log`). The skip is the existing live Tavily check without `TAVILY_API_KEY` in `research-runtime.test.ts`. The final unreachable-return announcement correction and one added case landed while this broad run was underway; the 119-test Preview rerun above verifies that correction. A final exact-code broad rerun belongs to workflow review/finalization.
- `pnpm exec tsc --noEmit`: passed on the final implementation (`/private/tmp/dw422-tsc-terminal.log`). Run sequentially after build because Next regenerates `.next/types` during its build.
- `pnpm lint`: passed with no new warnings or errors (`/private/tmp/dw422-lint-terminal.log`); existing `jsx-ast-utils` TSNonNullExpression diagnostics remain.
- `pnpm build`: passed with approved network access (`/private/tmp/dw422-build-final.log`), before the final small unreachable-return announcement correction. Sandbox-only build failed DNS lookup of configured Google fonts; the sandbox-only full test run was stopped after real subprocess/loopback/workerd failures, then rerun with required permissions. No tests were weakened to accommodate those restrictions.
- `git diff --check`: passed.
- VoiceOver/NVDA speech procedure remains **unexecuted**; mounted tests verify live-region DOM strings, not assistive-technology speech. No browser layout or production/deployment claim is made.
- Dependencies are temporarily linked to the existing root `node_modules` for verification; the untracked link is not source and must not be staged. The local version-barrier timeout expiry is covered by the focused review regression recorded below.


### Focused review corrections — 2026-09-10

- Fixed the substantiated Chat list race: passive list initialization/resumption captures a mutation generation and rejects obsolete success/error/detail settlements before writing state. Explicit create, rename, delete, settings and frame writes invalidate the generation at both start and settlement, so a snapshot cannot undo their newer row state. A created row is deduplicated against any snapshot that already included it.
- Added mounted `chat-conversation-crud.test.tsx` cases for a return list refresh racing create, rename and delete; all preserve the explicit outcome after the stale snapshot settles.
- Added real Workbench `preview-revision-history.test.tsx` coverage for the existing **15-second** local version barrier: no early reads, one Preview/history reconciliation on expiry, no timer replay, and normal refresh on a later version change.
- Did not apply the proposed pending-revision-collapse patch. The requested owner sequence is not reachable in the current UI: `viewingThis = viewLoading && viewing`, and the current View/Hide control has `disabled={viewingThis}`. A real mounted click while pending is suppressed. No control was enabled or changed to manufacture reachability; the speculative cleanup-only patch and its invalid regression were removed.
- Focused affected suites passed **73/73** across Chat CRUD, live Chat streaming, withdrawn modes and Preview revision history (`/private/tmp/dw422-review-fixes-focused.log`). TypeScript and lint also passed (`/private/tmp/dw422-review-fixes-tsc.log`, `/private/tmp/dw422-review-fixes-lint.log`); lint retains only the existing tool diagnostics. `git diff --check` passed.
- Workflow remains `in-review`. Required edge/verification review launchers hit the agent thread limit; those review packets and final exact-code broad verification remain outstanding. No commit or push was performed.


### Terminal local verification and review handoff — 2026-09-10

All checks below ran sequentially after the Chat review fix and timer regression, with no concurrent source edits:

- `pnpm test`: **416 files passed; 10,199 tests passed, 1 existing credential-dependent skip**, 125.52 seconds (`/private/tmp/dw422-terminal-test.log`).
- `pnpm build`, `pnpm exec tsc --noEmit`, `pnpm lint`, `git diff --check`: all exited zero (`/private/tmp/dw422-terminal-{build,tsc,lint,diff}.log`). Existing lint-tool diagnostics remain; no new warnings/errors.
- Approved intent checksum matches the approved draft; orchestrator-owned ledger is unchanged. Temporary dependency symlink removed after verification.
- Blind review completed: the Chat snapshot race was classified medium/patch and fixed with executed regressions; the pending-revision-collapse claim was rejected as unreachable through the existing disabled control.
- Edge-case and verification-gap reviewers could not launch: both returned `agent thread limit reached`. Per rendered bmad-build step 04, complete standalone prompts containing the final diff are saved beside this spec as `review-dw-422-edge-case-hunter.md` and `review-dw-422-verification-gap.md`. Run each in a separate fresh session and return the findings before workflow finalization.
- Status intentionally remains `in-review`; nothing is committed, published, merged or deployed. VoiceOver/NVDA speech remains unexecuted. Earlier statements that exact-code broad verification was outstanding are superseded by this terminal record; the two independent reviews remain outstanding.


### Review Findings — 2026-09-10

Independent bmad-code-review completed all four layers against the supplied snapshot. Full evidence: `review-dw-422-code-review-result.md`. The patch findings are now fixed and verified; see the closure record below. The pre-existing Skills finding remains deferred.

- [x] [Review][Patch] Reconcile the initial Chat list when New Chat invalidates its first snapshot [src/components/workbench/useChatConversations.ts:155] — medium; fixed by visibility-gated reconciliation after pending writes settle; initial success/error, both settlement orders, hidden return and draft preservation are covered by mounted regressions.
- [x] [Review][Patch] Apply hidden-pane visibility to the source Preview meeting-status reader [src/components/workbench/PreviewColumn.tsx:1561; src/components/workbench/MarkMeetingControl.tsx:54] — medium; a first hidden source Preview still starts a passive GET; reproduced.
- [x] [Review][Patch] Verify obsolete successful Todos reads cannot update the visible rail count [src/components/workbench/TodosCanvas.tsx:107] — low; current withdrawal coverage exercises only rejection and omits the count consumer.
- [x] [Review][Patch] Defer a hidden Chat attachment's data-version nudge until return [src/components/workbench/ChatCanvas.tsx:443] — low; explicit attachment completion still nudges while hidden.
- [x] [Review][Defer] Skills return scan clears an uncertain toggle's explanation [src/components/workbench/SkillsCanvas.tsx:105] — medium; deferred, pre-existing; the same scratch regression fails with the baseline component. The orchestrator-owned ledger was intentionally not modified.


### Review Findings — independent edge-case pass, 2026-09-10

The requested standalone Edge Case Hunter completed against the saved packet. Both findings were reproduced in isolated mounted probes; 72 existing focused tests passed. Details: `review-dw-422-edge-case-result.md`; raw layer output: `review-dw-422-edge-case-result.json`. The initial Chat-list race confirms the existing unchecked Chat action item above; it is not duplicated. No fixes or status changes were applied.

- [x] [Review][Patch] Clear deferred revision-view work when a hidden revert succeeds [src/components/workbench/PreviewColumn.tsx:1336] — medium; success now clears queued/in-flight view work, invalidates its token and resets its busy state. Mounted regressions cover the old read settling while hidden and after return, through enabled View, Revert, confirm and Settings controls.


### Review patch verification — 2026-09-10

The four approved code-review action items are fixed locally. Concurrent work in this checkout supplied the initial Chat-list reconciliation and the additional hidden-revert revision-view fix; both were preserved and verified in the final run. This session added first-list settlement-order coverage, fixed the meeting-status visibility path and deferred attachment nudges, and added a real Workbench Todos rail regression.

- Chat's invalidated initial snapshot reconciles without replacing the newly active conversation or composer. Coverage includes both list/write settlement orders, stale success/error, and withdrawal.
- Source Preview delays meeting-status initialization until visible, ignores obsolete reads, and preserves explicit mark outcomes without hidden presentation changes or write replay. Mutation failures are separate from passive-read errors.
- The full Workbench test proves a successful obsolete Todos response cannot change the visible rail count or retained items while the next reconciliation is pending.
- Chat attachment completion coalesces hidden data-version nudges into one nudge on return; Intake operations and their result notes survive without replay.
- The separately applied hidden-revert fix clears queued and in-flight revision views; the final Preview suite includes its executed regressions. The earlier disabled-View/Hide finding remains rejected; this is the distinct enabled-Revert sequence documented by the independent review.

Verification was sequential against unchanged code/configuration (1,052 files; fingerprint `5731f4767abdecc61775e18d1c5ce9b578a07c7bf8a68b7ae5aa6540d385ba7a`):

- Focused: **5 files, 96 tests passed** — `/private/tmp/dw422-code-review/fixes-focused.log`.
- Full `pnpm test`: **417 files, 10,213 passed, 1 existing credential-dependent skip**, 161.05 seconds — `/private/tmp/dw422-code-review/fixes-full-test.log`.
- `pnpm build`, then `pnpm exec tsc --noEmit`, then `pnpm lint`: all exited zero — `/private/tmp/dw422-code-review/fixes-{build,tsc,lint}.log`. Lint retains only the existing TSNonNullExpression tool diagnostics.
- Frozen intent matches the original packet; `git diff --check` passed; protected files, global data-version bus and the orchestrator-owned ledger are unchanged. The temporary node_modules link was removed after verification.

All in-scope patch findings are checked off. The spec is `in-progress` under the code-review status rule because its pre-existing medium Skills finding remains unresolved/deferred; it was not part of the approved fix set. No sprint key was identified, so sprint tracking was not changed. These are local results: no commit, push, merge, deploy or production acceptance. VoiceOver/NVDA speech remains unexecuted.


### Approved edge-case fixes — 2026-09-10

The user approved applying the two standalone edge-case findings. Both are now fixed locally; their action items above are checked. The other review findings remain separate, and the overall packet stays `in-review`.

- Chat rejects invalidated list success/error settlements and schedules reconciliation through its existing visibility-gated effect. If writes are still pending, the final write settlement releases one refresh. The active conversation and composer are preserved; no conversation-detail reload is introduced. Mounted coverage includes both initial list/create settlement orders, failed stale reads, withdrawal, preserved drafts, and existing create/rename/delete snapshot races.
- Successful revision revert clears deferred and in-flight revision views, invalidates their request token and resets view loading before closing the historical view. Mounted Workbench regressions cover the old read settling while hidden or after return; neither reopens history, and the restore announcement remains intact.

Verification of these changes:

- Scoped mounted run: **81 passed, 1 explicitly excluded** (the concurrently added attachment-nudge test belongs to another review finding), across four files. `/private/tmp/dw422-edge-fixes-scoped.log`.
- Full `pnpm test`: **414 files passed, 3 failed; 10,206 tests passed, 7 failed, 1 existing skip**, 223.26 seconds. Six failures cover the other session's new meeting-status and attachment cases. The seventh is a 5-second timeout in `merge.test.ts` with subsequent cleanup failure; rerunning that entire unchanged suite alone passed **59/59**. This does not make the full run green. Logs: `/private/tmp/dw422-edge-fixes-full-test.log`, `/private/tmp/dw422-edge-fixes-merge-rerun.log`.
- `pnpm lint` and `git diff --check`: passed. Lint retains existing TSNonNullExpression tool diagnostics. `/private/tmp/dw422-edge-fixes-lint.log`.
- The shared-checkout build compiled, then failed on missing generated `.next/server/next-font-manifest.json`. A fresh copy at `/private/tmp/dw422-edge-build-k5a8gk2o` passed `pnpm build` and the subsequent `pnpm exec tsc --noEmit`. Logs: `/private/tmp/dw422-edge-fixes-clean-build.log`, `/private/tmp/dw422-edge-fixes-clean-tsc.log`. The original checkout also passed TypeScript before that build attempt.
- Both changed implementation files and their affected test files retained identical hashes throughout terminal verification and match the successful clean build copy. Hash record: `/private/tmp/dw422-edge-fixes-hashes.json`.
- Concurrent additions from another session were preserved. A temporary dependency symlink remains in the shared worktree for ongoing verification; it is not source and must not be staged. No protected files, frozen intent or ledger entries were edited. No commit, push, merge or deployment was performed. VoiceOver/NVDA speech remains unexecuted.

## Release disposition — 2026-09-11

The user authorized committing and shipping DW-422 after DW-759, followed by orchestrated ledger reconciliation. This supersedes the implementation packet's publication/merge boundary for release work; deployment is not included. All in-scope findings are fixed and the 1052-file verification manifest still matches the source/config bytes before this commit. The final passing verification and four-layer review recorded above are the authoritative local evidence; earlier partial records describe superseded runs.

Implementation status is `done`. The pre-existing Skills uncertain-toggle explanation finding is a separate nonblocking follow-up, remains explicitly documented, and is not silently claimed fixed. The ledger stays unchanged for the orchestrator. Release validation against merged DW-759 will be recorded separately before this branch is merged.

### Combined release verification — 2026-09-11

DW-759 merged through PR #34 at `afcebfcac26b47a440e4877e49c2e69c49e1dd41`, after all three exact-head CI jobs passed. This branch incorporates that merge at `548dfc17f85b5550d8c3e68261474ae2385f95bf`; bringing in the merge changed ancestry only, not the already-tested combined file tree.

- Combined full suite: 417 files; 10,231 passed, one existing credential-dependent skip (130.68 seconds). Log: `/private/tmp/dw422-release-full-test.log`.
- Combined focus browser suite: 19/20 passed initially; all focus assertions completed, but the back-opening WorkspacePreview case captured an initial SiteChrome hydration mismatch in the pageerror guard. Three unchanged repeats of that case passed, including its pageerror guard. The failure is retained in `/private/tmp/dw422-release-browser.log`, with repeats in `/private/tmp/dw422-release-browser-repeat.log`; no expectation was suppressed. Full browser CI on the PR remains required before merge.
- Combined production build, separate TypeScript check, lint, and diff check passed. Logs: `/private/tmp/dw422-release-build.log`, `dw422-release-tsc.log`, `dw422-release-lint.log` in `/private/tmp`. Existing nonfatal lint diagnostics remain.
- The recorded pre-existing Skills follow-up is not fixed by this release. Ledger and production deployment remain untouched at publication time.
