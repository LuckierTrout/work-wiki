---
title: 'DW-753: browser CI with first-failure evidence'
type: 'chore'
created: '2026-09-09'
status: 'done'
delivery_status: 'local-complete-github-validation-pending'
approval_status: 'approved-local-implementation'
review_loop_iteration: 0
baseline_commit: 'b9a1d5ca7d4b021411be37a014078809b7c8190e'
context:
  - /private/tmp/work-wiki-browser-ci/AGENTS.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Existing Chromium checks catch browser layout, focus and authenticated-route failures but do not run in CI. Zero retries currently prevent first-retry traces from being recorded.

**Approach:** Add an isolated Browser E2E job and retain first-attempt failure traces and screenshots. Implement and verify locally under this approval; actual GitHub enrollment and upload acceptance follow separately authorized publication.

## Boundaries & Constraints

**Always:** Chromium only, one worker, zero retries, fullyParallel false, list reporter. Preserve the dedicated fresh store, existing fixture resets and Playwright dev-server identity/environment. Add only the approved job to the protected workflow; preserve existing jobs, triggers, permissions and concurrency. Retain failure artifacts for seven days. Record local versus GitHub evidence separately.

**Ask First:** Publishing, merge, deployment, expanded workflow edits or behavior changes beyond this packet.

**Never:** Dependency or frozen-identifier changes, ledger edits, historical spec edits, production credentials/data, retries, extra browsers, production build identity bypass, job/workflow-level E2E identity. Do not upload e2e/.data, .env files or browser storage profiles.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected behavior | Error handling |
| --- | --- | --- | --- |
| Browser composition | Existing suite, fresh local store | All cases execute on Chromium with one worker and no retry | Failure remains nonzero |
| First-attempt failure | Controlled synthetic assertion failure | Valid trace ZIP and screenshot retained | Preserve original failure, no retry |
| Production identity | E2E identity absent or misused | Existing refusal tests pass; no workflow identity injection | Fail closed |

</frozen-after-approval>

## Code Map

- `.github/workflows/ci.yml`: existing Application and Sandbox Worker jobs; copy checkout v6, pnpm setup v6 with 9.15.9, Node setup v7 with Node 22. Add independent `e2e` job, name Browser E2E, ubuntu-latest, 30-minute timeout, root lockfile cache, frozen install, Chromium system dependencies, `pnpm test:e2e` step with id `browser_tests`.
- `playwright.config.ts`: only replace trace `on-first-retry` with `retain-on-failure`, add screenshot `only-on-failure`. Preserve every other setting including webServer.
- `src/lib/__tests__/e2e-identity.test.ts`: existing refusal/misuse tests. `source-scan.ts` is the required walker if a scan is needed. No new dependency for YAML parsing; inspect installed helpers first.
- `vitest.config.ts`: its “pnpm test and nothing else” CI comment must describe only the Vitest invocation; no behavioral edits.
- `AGENTS.md`: existing browser checks local-only sentence changes only after actual successful GitHub execution, under the publication follow-up.
- Historical `spec-dw-753-e2e-lane-in-ci.md` remains read-only. This approval supersedes only its unchanged-Playwright-config restriction for the two recording settings.

## Tasks & Acceptance

**Execution (local approval):**
- [x] `.github/workflows/ci.yml` — add the described job. After browser failure, upload `test-results/` using `actions/upload-artifact@v7.0.1`, name `browser-e2e-failure-${{ github.run_attempt }}`, retention-days 7, if-no-files-found warn. Condition exactly `${{ failure() && steps.browser_tests.outcome == 'failure' }}`; no environment block.
- [x] `playwright.config.ts` — apply the two recording settings.
- [x] `vitest.config.ts` — narrow the comment to the Vitest command.
- [x] `src/lib/__tests__/browser-ci.test.ts` — focused operational guards against losing the browser command, leaking identity into production jobs, or broken artifact wiring. Avoid prose-only tests; use existing helpers where possible.
- [x] This spec — record actual commands, counts, duration, matrix coverage and all three review dispositions. Preserve ledger and historical contracts.

**Acceptance Criteria (local approval):**
- Given the changed configuration, when running the real browser suite, then every existing case passes with zero retries/skips and the count and duration are recorded.
- Given a controlled first-attempt assertion failure with the actual recording settings, when running Chromium, then a valid trace and screenshot exist; record this as local artifact proof only.
- Given the final local patch, when focused tests, full Vitest, typecheck, lint and production build run, then all required checks pass and unrelated settings remain unchanged.

**Publication follow-up (separate authorization):**
Actual final-head Browser E2E, Application and Sandbox Worker jobs must pass before claiming CI enrollment. During authorized PR validation, verify an uploaded failure artifact using a temporary synthetic failing fixture; restore it before the final green head. Then update AGENTS.md's local-only sentence and record exact-head GitHub evidence. These remain open until publication is authorized; local completion cannot certify them.

## Spec Change Log

## Approval record

User explicitly approved the prepared packet on 2026-09-09, including protected workflow edits, trace/screenshot settings and seven-day retention. Normalized into the BMAD template without expanding that scope. Publishing, merge and deployment remain separate.

## Design Notes

The list reporter does not produce an HTML report: upload test-results only. Recording starts on the first attempt; passing traces are discarded. Upload is best-effort: startup failures may only have logs, missing files warn, and forced runner termination may prevent upload.

## Verification

Run focused browser-CI and identity tests, `pnpm test`, `pnpm lint`, `pnpm build`, standalone `pnpm exec tsc --noEmit` after build, `pnpm test:e2e`, and `git diff --check`. Use synthetic public build configuration without loading credentials. Real local servers/browsers may require sandbox escalation. No remote operations during implementation. Review and local commit follow locally; do not mark overall CI enrollment done before publication evidence.

## Preparation evidence

- Current main baseline: `b9a1d5ca`; installed and lockfile-resolved Playwright Test: **1.62.1**.
- Unchanged existing `pnpm test:e2e`: **26 passed**, zero retries, one worker, **1.4 minutes** on current main. Log: `/private/tmp/browser-ci-main-prerequisite.log`.
- An isolated temporary config and synthetic in-memory page deliberately failed one assertion with zero retries. It produced exactly one valid trace archive and one valid PNG screenshot. Log: `/private/tmp/browser-ci-artifact-probe.log`; artifacts: `/private/tmp/browser-ci-artifact-probe-hf9_0xtv/results/`. This validates local artifact creation, not GitHub upload.
- Dependencies were copied from the already-installed local tree. No manifest, lockfile, workflow, app code or existing Playwright configuration was changed during preparation.
- Official documentation checked through Context7: [Playwright recording options](https://github.com/microsoft/playwright/blob/main/docs/src/test-use-options-js.md), [trace retention behavior](https://github.com/microsoft/playwright/blob/main/packages/playwright/src/worker/testTracing.ts), [artifact action inputs](https://github.com/actions/upload-artifact/blob/main/README.md). Official [upload-artifact v7.0.1 release](https://github.com/actions/upload-artifact/releases/tag/v7.0.1) checked through GitHub API.


## Local implementation evidence — 2026-09-09

The local patch adds only the independent Browser E2E job, changes the two
Playwright recording settings, narrows the Vitest comment, and adds four
operational guard tests. The guards parse the real workflow using `js-yaml`
resolved through its existing direct dependency owner `@eslint/eslintrc`; no
manifest or lockfile changed. They verify command execution, workflow identity
isolation, first-failure recording/output location, and artifact wiring.

Commands and results:

- `pnpm exec vitest run --project node src/lib/__tests__/browser-ci.test.ts src/lib/__tests__/e2e-identity.test.ts`: **15 passed**, two files, **677 ms**. Log: `/private/tmp/browser-ci-focused.log`.
- `pnpm test` with local loopback/IPC access: **404 files passed; 10,058 tests passed, one skipped; 135.28 seconds**. The existing skip is `runs one live Tavily search when a key is present` in `research-runtime.test.ts`; no provider credentials were loaded. Log: `/private/tmp/browser-ci-vitest-final.log`.
- `pnpm lint`: exit 0. The existing `jsx-ast-utils` TSNonNullExpression diagnostics appeared three times. Log: `/private/tmp/browser-ci-lint.log`.
- `env -u YOPEDIA_E2E -u YOPEDIA_E2E_SECRET NEXT_PUBLIC_OWNER_HANDLE=e2e-owner NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ZWUyZS1sb2NhbC1ub3QtZm9yLXByb2Q NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/ pnpm build`: exit 0, compiled in **39.9 seconds**, generated all **122 static pages**. This is a production build using synthetic public configuration, no E2E identity, and no credential files. Log: `/private/tmp/browser-ci-build.log`.
- `pnpm exec tsc --noEmit`, run after the production build completed: exit 0. Log: `/private/tmp/browser-ci-typecheck.log`.
- `pnpm test:e2e`: **26 passed, zero retries, zero skips, one Chromium worker, 1.5 minutes**, exit 0. Log: `/private/tmp/browser-ci-e2e-final.log`. All three existing files ran: retired routes (9), browser layout (7), and owner/signed-out journeys (10).
- `git diff --check`: exit 0. Structural YAML comparison against baseline HEAD confirmed that removing only the new `e2e` job yields the unchanged existing workflow. The Playwright diff contains only `trace` and `screenshot`; its fresh store, server environment, identity and fixtures remain unchanged.

The initial sandboxed Vitest attempt could not bind loopback (`listen EPERM`)
and was stopped; it is not passing evidence. The initial sandboxed browser
probe timed out before the page fixture initialized; it is not assertion-failure
artifact proof. Both were rerun with the local OS access required by these checks.

### Controlled first-attempt failure

Command: `pnpm test:e2e --config /private/tmp/browser-ci-final-probe-12uc08tn/probe.config.ts`.
The temporary configuration imports the actual changed repository Playwright
configuration and changes only the test directory, output directory, and removes
the unneeded web server. Its one test asserts `testInfo.retry === 0`, renders a
synthetic public in-memory page, and deliberately fails a title assertion.
Result: **one deliberate failure, zero retries, exit 1, 482 ms test duration**.

Exactly one trace ZIP and one 1280×720 PNG were retained beneath
`/private/tmp/browser-ci-final-probe-12uc08tn/results/`. Python `zipfile.testzip()`
verified all ten ZIP members and confirmed trace-event content exists; every PNG
chunk CRC and its dimensions were checked. Log:
`/private/tmp/browser-ci-final-probe-verified.log`. The synthetic fixture and
artifacts remain outside the repository. This proves local artifact creation
only; no files were uploaded to GitHub.

### Matrix coverage

| Scenario | Executed evidence | Outcome |
| --- | --- | --- |
| Existing browser composition, fresh store | Full 26-case Chromium suite with the actual config | Pass; one worker, zero retries/skips, 1.5 minutes |
| First-attempt assertion failure | Isolated synthetic page using imported recording settings | Expected exit 1; valid trace ZIP and PNG retained |
| Identity absent or misused | All 11 existing identity tests plus workflow identity guard; production build without E2E identity | Pass; no workflow/job identity injection |
| Failure artifact destination and retention | Parsed workflow tests for exact condition, browser step id, path, seven days and warning behavior | Local configuration pass; actual GitHub upload remains unverified |

### Review and publication boundary

Implementation self-check found the patch within the approved local scope.
All three review passes are complete; their dispositions and the context waiver are recorded below.
Actual GitHub enrollment, final-head job execution and upload acceptance remain
unverified pending separate publication authorization. `AGENTS.md` retains the
current local-only sentence for that reason. No ledger, historical spec, frozen
identifier, dependency, production credential or production data was changed.


### Independent review disposition — 2026-09-09

- Blind Hunter: fresh context, complete tracked/untracked diff, **no findings**.
- Edge Case Hunter: fresh context, same complete diff, **no findings**.
- Verification Gap: fresh-agent launch initially failed with `agent thread limit reached`.
  The user explicitly approved reusing an existing reviewer for this pass. The
  reused Edge Case reviewer read the complete substituted verification prompt
  and returned **no verification gaps found**. This pass was not fresh-context;
  the waiver applies only to this review. Exact prompt archive:
  `/private/tmp/browser-ci-review-verification-gap.md`.
- No review findings required code changes. Existing successful verification
  remains applicable to the final code. Status `done` denotes local implementation
  and review only; GitHub execution/upload acceptance remains pending.
- The original delegated protected-file patch was rejected by automatic review
  because the child lacked the approval context. The root applied the exact
  approved local configuration successfully; no protected-file action remains
  blocked. Publication remains separately gated by the approved intent.

## Suggested Review Order

**Browser CI execution**

- Runs Chromium independently while preserving existing production validation jobs.
  [ci.yml:64](../../.github/workflows/ci.yml#L64)

**Failure evidence**

- Uploads failed browser results with seven-day retention.
  [ci.yml:94](../../.github/workflows/ci.yml#L94)

- Records first-attempt failures without adding retries.
  [playwright.config.ts:24](../../playwright.config.ts#L24)

**Supporting verification**

- Guards browser execution, identity isolation, and artifact wiring.
  [browser-ci.test.ts:48](../../src/lib/__tests__/browser-ci.test.ts#L48)

- Clarifies that the shared Vitest invocation covers both test projects.
  [vitest.config.ts:71](../../vitest.config.ts#L71)

