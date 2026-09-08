---
title: 'Restore Application CI test portability'
type: 'bugfix'
created: '2026-09-07'
status: 'done'
review_loop_iteration: 0
baseline_revision: '227da903f3ad69b764578ce92efaa263d8ed78ce'
baseline_commit: '227da903f3ad69b764578ce92efaa263d8ed78ce'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Application CI run 34166661612 fails 18 tests in five suites: 16 inherit an owner configuration inconsistent with their mocked principal, one assumes a macOS executable spelling exists on Linux, and one races real timer scheduling. The failed test step prevents production-build verification.

**Approach:** Make those fixtures explicit and portable while preserving the real authentication, executable-validation, and request-deadline contracts. Keep this a test-only repair of the existing Application lane.

## Boundaries & Constraints

**Always:** Exercise real route/gate and shell-classifier code. Restore environment and clock overrides even after assertion failure. Preserve owner rejection and exact remaining-budget assertions. Follow AGENTS.md test conventions.

**Ask First:** Production changes, dependency upgrades, protected workflow changes, additional failure families, publication/push, merge, or deployment.

**Never:** Bypass auth, mock the owner gate, accept nonexistent executables, weaken deadlines, skip failing tests, increase timeouts as a substitute for determinism, change global test setup, edit the deferred ledger, or recover unrelated sweep attempts. Do not claim GitHub CI passed from local results.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Owner route fixtures | Inherited foreign handle and stable ID; explicit test owner | Existing success/validation assertions execute | No spurious 401 |
| Non-owner | Principal differs from configured owner | Existing Conversation/Save rejection remains | 401; no persistence |
| Executable identity | Real executable fixture with mixed-case filename | Canonical path key | Missing/non-executable fixture has empty key |
| Intake elapsed work | Controlled clock advances during fetch | Exact original budget minus elapsed work | Exhausted budget clamps to zero |

</frozen-after-approval>

## Code Map

- `src/lib/__tests__/chat-routes.test.ts:54` -- mocks alice without owner setup; configured-owner describe at :231 has manual env restoration to consolidate.
- `src/lib/__tests__/chat-save-route.test.ts:57` -- same inherited-owner defect in two save cases.
- `src/lib/__tests__/workbench-epic3.test.ts:90` -- scope owner fixtures to the Search auth describe; retain unauthenticated assertions.
- `src/lib/__tests__/epic8-chat-agent.test.ts:689` -- shell classification case assumes `/usr/bin/Python3`; existing temp directory and fs imports support real executable fixtures.
- `src/lib/__tests__/workbench-intake.test.ts:1031` -- real 60 ms sleep underpins a strict budget assertion; replace elapsed-time premise, not the route.
- Read-only: `src/lib/owner-route.ts:11`, `src/lib/owner.ts:115` enforce owner identity; stable ID takes precedence over handle. `sidecar/shell.mjs:376` canonicalizes executable snapshots and refuses missing/non-executable files. Intake `route.ts:110,:659` captures the original deadline and subtracts current time.
- Read-only: `.github/workflows/ci.yml` uses Ubuntu/Node 22 and a configured owner; typecheck/lint passed, builds and dry-run were skipped after tests failed. Architecture AD-8 requires private owner-auth boundaries.

## Tasks & Acceptance

**Execution:**
- [x] In the three owner-route test files above, stub fixture handle and unset inherited stable owner ID; restore after each case. Consolidate the existing negative-case override without weakening its assertions.
- [x] In `src/lib/__tests__/epic8-chat-agent.test.ts`, replace the system-path assumption with a temp executable of known spelling and permissions; assert canonical identity and rejection of missing/non-executable fixtures using the real classifier.
- [x] In `src/lib/__tests__/workbench-intake.test.ts`, control `Date.now()` locally and advance it in the fetch mock. Assert exact remaining and exhausted budgets; restore the spy in a guaranteed cleanup path while keeping real asynchronous scheduling.
- [x] Verify all matrix rows, run the application gates, and record exact local versus remote evidence here.

**Acceptance Criteria:**
- Given conflicting inherited owner settings, when the five repaired suites run, then all tests pass without changing production code or global configuration.
- Given Linux/Node 22 and macOS, when executable identity is tested, then outcomes depend on test-created files, not host Python installation or case-folding.
- Given a route that incorrectly refreshes its deadline after fetch, when the deterministic timing regression runs, then it fails; verify in a reversible isolated mutation check.
- Given the completed patch, when verification is reported, then commands, failures, skipped checks, and remote-CI status are explicit; unexecuted CI is not release proof.

## Spec Change Log

## Verification

- Run the five named suites with `pnpm exec vitest run --project node` under both ordinary and conflicting inherited owner settings. Include owner-gate regression suites; repeat the controlled-clock cases.
- `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm build:cloudflare`, and `pnpm exec wrangler deploy --dry-run --config wrangler.jsonc` must pass or have an explicit blocker; dry-run is not deployment.
- `git diff --check`; inspect that only the five tests and this spec changed.
- After publication approval, inspect terminal GitHub Application results on the full canonical pushed SHA. Until then, label remote verification pending.

### Local evidence — 2026-09-07

Verified the uncommitted five-test patch on baseline `227da903f3ad69b764578ce92efaa263d8ed78ce`; this document is the only other changed file. Production sources, global test setup, dependencies, protected workflows, and the deferred ledger are unchanged.

The owner fixtures use `vi.stubEnv` for `NEXT_PUBLIC_OWNER_HANDLE=alice` and an unset `YOPEDIA_OWNER_USER_ID`, with `afterEach` restoration. Search fixtures are scoped to their auth describe. The existing non-owner Conversation/Save assertions still return 401 and forbid persistence. Executable identity uses a real `FixtureTool` file at mode 0755, independent `realpathSync` expected identity, a mode-0644 file, and a missing file; fixture cleanup uses `finally`. Intake uses a locally restored `Date.now` spy, real promises, and exact 16,940-ms and zero-ms expectations for 60-ms and 17,001-ms elapsed fetch work.

The focused command was:

```sh
pnpm exec vitest run --project node src/lib/__tests__/chat-routes.test.ts src/lib/__tests__/chat-save-route.test.ts src/lib/__tests__/workbench-epic3.test.ts src/lib/__tests__/epic8-chat-agent.test.ts src/lib/__tests__/workbench-intake.test.ts src/lib/__tests__/owner-gate-parity.test.ts src/lib/__tests__/owner-handle.test.ts src/lib/__tests__/owner-single-reader.test.ts src/lib/__tests__/owner-page-route.test.ts
```

| Local check | Result |
| --- | --- |
| Focused command, ordinary environment, macOS Node 26.8.1 | 9 suites / 239 tests passed. Log: `/tmp/ci-portability-focused-tests.log`. |
| Same command prefixed with `NEXT_PUBLIC_OWNER_HANDLE=foreign-owner YOPEDIA_OWNER_USER_ID=user-foreign` | 9 suites / 239 tests passed. Log: `/tmp/ci-portability-conflicting-tests.log`. |
| Same conflicting environment, macOS Node 22.16.0 | 9 suites / 239 tests passed, invoking `/Users/christianlee/.nvm/versions/node/v22.16.0/bin/node node_modules/vitest/vitest.mjs run --project node` with the same nine paths. Log: `/tmp/ci-portability-node22-tests.log`. |
| `pnpm exec tsc --noEmit` | Exit 0. Log: `/tmp/ci-portability-tsc.log`. |
| `pnpm lint` | Exit 0; three jsx-ast-utils `TSNonNullExpression` notices. Log: `/tmp/ci-portability-lint.log`. |
| `pnpm test` | Exit 0: 399 suites, 9,990 passed / 1 skipped, 120.45 s. Existing credential-gated `research-runtime.test.ts` Tavily case skipped because `TAVILY_API_KEY` is absent; no skips added. Log: `/tmp/ci-portability-all-tests.log`. |
| `pnpm build` | Exit 0; Node 26 `module.register()` deprecation warning. Log: `/tmp/ci-portability-build.log`. |
| `pnpm build:cloudflare` | Exit 0; OpenNext emitted the Worker bundle. Generated bundle warning about comparison with negative zero. Log: `/tmp/ci-portability-cloudflare.log`. |
| `pnpm exec wrangler deploy --dry-run --config wrangler.jsonc` | Exit 0, `--dry-run: exiting now`; same generated negative-zero warning. Log: `/tmp/ci-portability-dry-run.log`. No deployment. |
| `git diff --check` and scope inspection | Passed; only the five named tests and this spec changed. |

The first sandboxed focused runs encountered `listen EPERM` on existing loopback sidecar tests (ordinary run: 237 passed / 2 failed, three listen errors); the retries above passed with local listeners permitted outside the sandbox. An initial Node-22-through-pnpm attempt failed before collecting tests because the pnpm shim could not find its versioned CLI (`spawnSync .../pnpm ENOENT`); the direct Node 22 invocation above passed. Neither environment issue was worked around by changing tests or timeouts.

### Determinism and platform evidence

- Repeated `pnpm exec vitest run --project node src/lib/__tests__/workbench-intake.test.ts -t 'hands the inline compile exactly'` five times: both cases passed each time. Logs: `/tmp/ci-portability-clock-{1,2,3,4,5}.log`. The other 90 cases are filtered by this focused command, not newly skipped tests.
- Isolated mutation check in `/tmp/ci-portability-mutation.ZbC98I`: copied the test/import tree, then inserted `input.answerBy = Date.now() + INTAKE_ANSWER_BUDGET_MS` at `storeAndQueue` entry in that copy only. The focused command failed both cases: received 17,000 instead of 16,940 and 0. Removing that mutation made both pass; `cmp` verified the restored copied route matches the unchanged checkout route. Logs: `/tmp/ci-portability-mutation.log` and `/tmp/ci-portability-mutation-restored.log`.
- Linux Node 22.22.3: `/tmp/ci-portability-shell-probe.mjs` reproduced the four executable assertions using the real `shell.mjs` and `workspace.mjs`, mounted read-only in existing local image `yopedia-sandbox-runner-sandbox:142c9d58`. The disposable container used `--platform linux/amd64 --network none --read-only --tmpfs /tmp:rw,exec`; canonical mixed-case identity, new-executable approval classification, missing-file rejection, and non-executable rejection all passed. An initial probe with Docker's default noexec tmpfs correctly refused the supposedly executable file; enabling execution for the fixture temp mount resolved the environment mismatch. No dependencies or image were upgraded. This is a Linux classifier probe, not a full Linux Application-lane run.

### Remote status

Remote verification is **pending**. Implementation verification ran before the local finalization commit. No push, PR publication, GitHub rerun, merge, or deployment was performed. The spec's reported failed run `34166661612` remains historical context, not a result for this patch. Terminal GitHub Application verification must follow publication approval on the full pushed SHA; local tests and dry-run output are not release proof.

### Independent review

Three context-free reviewers inspected the full five-file diff and this spec, including verification evidence: general defect review, edge-case review, and verification-gap review. All returned zero findings. No review patches or deferred-work entries were required. The final matrix audit confirmed all four rows have executed passing tests; the general suite, conflicting-owner run, Linux classifier probe, and isolated deadline mutation supply the corresponding evidence above. `done` records local build-workflow completion, not remote CI or production acceptance.

## Suggested Review Order

**Owner fixtures without bypassing authentication**

- Explicit owner settings isolate success cases from the CI environment.
  [chat-routes.test.ts:54](../../src/lib/__tests__/chat-routes.test.ts#L54)

- A distinct configured owner still produces rejection and forbids persistence.
  [chat-routes.test.ts:237](../../src/lib/__tests__/chat-routes.test.ts#L237)

- Save fixtures use the same scoped environment lifecycle.
  [chat-save-route.test.ts:57](../../src/lib/__tests__/chat-save-route.test.ts#L57)

- Search-only hooks preserve unrelated sidecar tests and unauthenticated coverage.
  [workbench-epic3.test.ts:91](../../src/lib/__tests__/workbench-epic3.test.ts#L91)

**Deterministic platform and timing evidence**

- Real fixture files replace the host-specific Python assumption without relaxing executable validation.
  [epic8-chat-agent.test.ts:687](../../src/lib/__tests__/epic8-chat-agent.test.ts#L687)

- Controlled elapsed work checks exact remaining and exhausted budgets; cleanup restores the clock.
  [workbench-intake.test.ts:1032](../../src/lib/__tests__/workbench-intake.test.ts#L1032)
