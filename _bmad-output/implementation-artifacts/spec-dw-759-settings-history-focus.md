---
title: 'DW-759: Preserve keyboard continuity across Settings history transitions'
type: 'bugfix'
created: '2026-09-11'
status: 'done'
review_loop_iteration: 0
baseline_commit: '239f43dda395f5ba318812b177b413fcd330558a'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Browser Back closing Settings drops focus to the document body when the keyboard was on a Settings navigation row. The current popstate sample covers only the canvas; other regions that the same transition withdraws have the same loss.

**Approach:** Before applying a Settings history transition, determine whether focus belongs to a region that transition will hide or remove. Use the existing canvas focus mechanism to land the keyboard on the revealed surface, preserving persistent controls and modal priority. The user authorized this repair with “ok begin” after the audit and proposed repair scope.

## Boundaries & Constraints

**Always:**
- Work only in `/private/tmp/work-wiki-dw-759`, a separate clean branch from the audited baseline. Preserve all existing DW-422 work in its sibling checkout.
- Rescue the canvas on either Settings edge, SettingsNav on closing, and the tree panel, Sources left surface, Activity, either Preview implementation, and Preview resize handle on opening.
- Sample focus before applying the surface. Keep category-only and mode-only history traversals silent with respect to focus.
- Preserve persistent rail, WikiSwitcher/header, and tree separator focus. Scope region lookup to this Workbench.
- Reuse the existing focus nonce, live-modal guard, and preventScroll behavior. A restored dialog remains the focus destination.
- Exercise the actual mounted Workbench and authenticated browser history using existing fixtures; jsdom alone cannot prove browser withdrawal behavior.

**Ask First:** Changes to product navigation semantics beyond the focus repair described here.

**Never:** Change ledger entries, completed frozen specs, DW-538 CSS, hidden-pane lifecycle, mounting policy, mutation behavior, history entries, query encoding, routing, Settings rail-close behavior, or protected `llm-wiki.md`, `.github/`, `.yoyo/yoyo.toml`. Do not commit, push, merge, or deploy in this packet.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Settings navigation departure | Focused category row; Back through category then closed Settings | First Back preserves row focus; second lands on revealed canvas | No new error path |
| Canvas departure | Focus in current canvas; either Settings edge | Revealed canvas receives focus | Existing modal guard takes precedence |
| Other departing regions | Opening Settings by Back or Forward with focus in tree, Sources, Activity, Preview, or Preview separator | Settings canvas receives focus | Missing region is harmless |
| Persistent controls | Rail, WikiSwitcher/header, or tree separator focused during Settings transition | Same control remains focused | No broad refocus |
| No Settings edge | Only category or mode changes | Existing focus behavior remains unchanged | No new error path |
| Restored modal | Back closes Settings while an underlying Create Wiki dialog survives | Focus remains inside the revealed modal | Hidden modals do not block opening Settings |

</frozen-after-approval>

## Code Map

- `src/components/workbench/Workbench.tsx` — popstate listener near 933–1000 owns the pre-transition decision; shellRef scopes queries. Existing nonce effect near 1715–1755 preserves live-modal priority and scroll. Update stale comments describing canvas-only policy.
- Existing departing selectors: `#wb-canvas`, `.wb-set-nav`, `.wb-tree-panel`, `.wb-left-surface`, `.wb-activity`, `#wb-preview-column`, `.wb-split-handle--preview`. Prefer existing constants for IDs. The left aside itself contains a persistent header and must not be treated wholesale as departing.
- `src/lib/workbench-split.ts:447` — Preview separator follows previewOpen and unmounts for Settings; tree separator persists. Read-only evidence.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` — real shell fixture, stable mocked router, paneRow, LOADED data and traverse helper waiting for actual jsdom popstate; extend existing category pick case and direction/control cases.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` — mounted Create Wiki restoration near 1270; extend to departure from SettingsNav. Reuse existing fixtures.
- `src/lib/__tests__/workbench-chrome.test.ts:195-215` — update existing source ordering guard to match new sample; retain its named browser regression, do not add redundant source scans.
- `e2e/fixtures/owner.ts`, `e2e/fixtures/wiki.ts`, `playwright.config.ts` — authenticated owner fixture and isolated store. New spec should establish and clean its tenant; browser port 4173. Dependencies may be temporarily symlinked from the base repo. Remove that link before finalization.
- Prior DW-512/513 intent remains immutable; this separate packet expands its intentionally narrow focus policy. Audit evidence remains in the DW-422 sibling's audit-dw-538-759.md.

## Tasks & Acceptance

**Execution:**
- [x] `src/components/workbench/Workbench.tsx` — implement pre-transition departing-region sample and update policy comments.
- [x] `src/components/workbench/__tests__/workbench-mode-url.test.tsx`, `settings-canvas-persistence.test.tsx`, `src/lib/__tests__/workbench-chrome.test.ts` — cover matrix and adjust existing ordering guard; demonstrate new regression fails before the fix.
- [x] `e2e/workbench-settings-focus.spec.ts` — verify real browser Back/Forward, departing and persistent controls, and modal priority using existing owner/store fixtures.
- [x] This spec — record actual verification results and any limits outside the frozen block.

**Acceptance Criteria:**
- Given the owner has focus in a departing Settings-related region, when browser history changes the Settings surface, then focus lands on the visible canvas or its active modal.
- Given a persistent focused control or category-only traversal, when navigation occurs, then keyboard position is preserved.
- Given the completed patch, when focused mounted tests, browser regressions, build, TypeScript, lint and the full test suite run, then required checks pass without weakening existing expectations.

## Spec Change Log

## Verification

- Run focused mounted suites plus the existing chrome scan; new bug case must first fail against baseline.
- Run `pnpm exec playwright test e2e/workbench-settings-focus.spec.ts` with the authenticated dedicated server; capture actual Back/Forward focus and no browser runtime errors attributable to the change.
- Run `pnpm test`, `pnpm build`, `pnpm exec tsc --noEmit`, `pnpm lint`, and `git diff --check`; record exact pass/skip counts and environment limits.

### Execution results — 2026-09-11

- Implemented the pre-transition sample in the actual Workbench popstate handler. Canvas is sampled on either Settings edge; SettingsNav on closing; tree, Sources left surface, Activity, both Preview implementations (their shared existing id), and Preview separator on opening. Queries are scoped to `shellRef`. Persistent rail, WikiSwitcher/header and tree separator are excluded. The existing nonce, live-modal guard and `preventScroll` focus effect are unchanged.
- Baseline failure demonstrated before changing production code: the extended category-pick case retained the row on category Back, then failed on closing Back with `document.activeElement` equal to `<body>` instead of the revealed canvas. Focused baseline result: 1 failed, 32 skipped; evidence `/private/tmp/dw759-baseline-test.log`.
- Final focused mounted suites and existing chrome ordering guard: **3 files passed, 137 tests passed**. Covers both history directions for regions withdrawn on opening Settings, persistent controls, outside-shell exclusion, category-only and mode-only behavior, and SettingsNav departure restoring the Create Wiki dialog. Final rerun was after the last policy-comment and ordering-guard edits; evidence `/private/tmp/dw759-focused.log`.
- Authenticated Chromium browser run: **20 passed, 0 skipped**, in 1.0 minute. Actual Back/Forward verifies focus landing, withdrawal of the original focused DOM node, persistent controls, category-only/mode-only continuity and modal priority. Every case asserts zero browser `pageerror` events. WorkspacePreview cases mount the real Chat and output chip using fixture responses for sidecar health, stored conversation, and output file bytes; they do not claim a live Agent/provider run. Evidence `/private/tmp/dw759-browser.log`.
- Full `pnpm test`: **414 files passed; 10,188 passed, 1 skipped** (123.83 seconds). The existing conditional live Tavily search is skipped without `TAVILY_API_KEY`. The final mounted WorkspacePreview cases were present before this run; only policy comments and the existing source-order guard changed afterward, and all three focused suites were rerun on those final bytes. Evidence `/private/tmp/dw759-full-test.log`.
- `pnpm build`, `pnpm exec tsc --noEmit`, final `pnpm lint`, and `git diff --check`: **passed**. Build/lint emit nonfatal jsx-ast-utils `TSNonNullExpression` diagnostics; build also emits Node module-registration deprecation and webpack cache-size warnings. None caused a failed check. Evidence `/private/tmp/dw759-build.log`, `/private/tmp/dw759-tsc.log`, `/private/tmp/dw759-lint.log`.
- Environment repair: Turbopack rejected the permitted temporary dependency symlink because it pointed outside its root. Removed that link and installed dependencies locally with the existing lockfile (`pnpm install --offline --ignore-scripts --frozen-lockfile`); no config or lockfile change, and no top-level dependency symlink remains. Early browser failures were corrected test fixtures (pinning the original canvas DOM node and supplying sidecar availability); all final browser assertions passed without weakening focus expectations.
- Verification sequencing note: full Vitest and lint were already started alongside an intermediate browser run before the coordinator supplied its sequential-check requirement. Subsequent final browser, build, TypeScript, focused tests and lint ran sequentially. No build ran against a live test server.
- No ledger entries, frozen intent, protected files, history semantics, CSS, hidden-pane lifecycle or mounting policy were changed. No commit, push, merge or deploy was performed. Scope complete; browser evidence is Chromium on the authenticated local harness, not production or assistive-technology certification.

### Independent review — 2026-09-11

Three context-free review layers reviewed the complete six-file patch against the recorded baseline. Blind review: no actionable findings. Edge-case review: no findings. Verification-gap review: no gaps. No patch or scope loopback was required. Source/test bytes matched the review manifest at finalization.

A read-only `git apply --check` confirmed the tracked patch applies cleanly to the existing DW-422 worktree. This establishes textual compatibility only; the two packets have not been combined or jointly tested. DW-422's 1052-file verification manifest remains unchanged, as do both ledgers (SHA-256 `0d89fe29ff6138cd66060f768a9b7c6cc532a8918491b61d694941e0f4113b9a`).

Status `done` means implementation and local verification/review are complete. On 2026-09-11 the user authorized a local commit ("Commit please and lets move"), superseding the earlier no-commit boundary for this packet. Push, merge, deployment, and ledger reconciliation are not included in this commit.

## Suggested Review Order

**Focus policy**

- Sample departing regions before navigation; preserve persistent controls and the existing focus mechanism.
  [Workbench.tsx:963](../../src/components/workbench/Workbench.tsx#L963)

**Behavioral evidence**

- Check both history directions and the controls that must retain focus.
  [workbench-mode-url.test.tsx:619](../../src/components/workbench/__tests__/workbench-mode-url.test.tsx#L619)

- Confirm restored modal priority when Settings navigation loses its focused row.
  [settings-canvas-persistence.test.tsx:1292](../../src/components/workbench/__tests__/settings-canvas-persistence.test.tsx#L1292)

- Verify authenticated browser focus, actual withdrawal, and both Preview implementations.
  [workbench-settings-focus.spec.ts:41](../../e2e/workbench-settings-focus.spec.ts#L41)

**Supporting guard**

- Keep focus sampling and region membership ahead of applying the surface.
  [workbench-chrome.test.ts:209](../../src/lib/__tests__/workbench-chrome.test.ts#L209)

