---
title: 'DW-781: Restore production build at the backup client boundary'
type: 'bugfix'
created: '2026-09-07'
status: 'done'
baseline_revision: '4e99511538f435826bde0033a414a58af8ed70e6'
baseline_commit: '4e99511538f435826bde0033a414a58af8ed70e6'
review_loop_iteration: 0
followup_review_recommended: false
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** SystemHealthDesk imports backupTruncationLabel from the server backup module, pulling storage and Node builtins into browser compilation. Production builds fail (DW-781).

**Approach:** Move the formatter and reason type to a dependency-free module shared by server and UI. Preserve existing exports and labels; verify compilation and rendered backup rows.

## Boundaries & Constraints

**Always:**
- Keep one formatter shared by UI and operation detail; preserve server export compatibility.
- Preserve labels, manifest shapes, stored bytes and backup behavior.
- Keep storage server-side and client BackupSummary imports type-only.
- Verify the changed tree; previous tests do not certify it.

**Ask First:** Dependency upgrades, unrelated compiler repairs, deployment changes, or changes to backup semantics needed to continue.

**Never:** Edit deferred-work.md, existing frozen contracts, protected files or runtime identifiers. No storage polyfills, error suppression, bundler changes, unrelated helper moves, snapshot restoration, deployment, push or merge.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Whole backup | No truncated flag | Formatter returns null; health row shows no partial label | Unchanged |
| File-count ceiling | truncated true, file-count | partial — stopped at the file-count limit | Unchanged |
| Byte ceiling | truncated true, total-bytes | partial — stopped at the total-bytes limit | Unchanged |
| Oversize object skipped | truncated true, file-size | partial — skipped a file over the file-size limit | Unchanged |
| Legacy/future reason | truncated true, absent or unknown reason | partial — stopped at a safety limit | Never silently represent it as whole |

</frozen-after-approval>

## Code Map

- `src/components/SystemHealthDesk.tsx:6,260` — offending import and label consumer. Its load effect requests health, backups and evaluations.
- `src/lib/backups.ts:24,345,503` — reason type, server consumer and pure formatter. Other backup APIs stay here.
- `src/lib/__tests__/backups.test.ts:692-723` — all matrix branches already covered; earlier tests exercise real temporary storage. Preserve these tests.
- `vitest.config.ts` — mounted suites must be .test.tsx under __tests__; no configuration changes.
- `Dockerfile:20` — runs pnpm build. The network-enabled 2026-09-06 baseline failed on Node builtins through SystemHealthDesk; tests and dev-server E2E passed.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/backup-display.ts` — new dependency-free formatter and reason type; explain the browser boundary.
- [x] `src/lib/backups.ts` — import and re-export the extracted symbols; remove duplicate definitions; preserve storage mechanics.
- [x] `src/components/SystemHealthDesk.tsx` — switch formatter import; keep BackupSummary type-only.
- [x] `src/components/__tests__/system-health-desk.test.tsx` — mount the real component with deterministic responses to its three load requests. Exercise matrix rows without mocking the formatter or executing real writes.
- [x] `src/lib/__tests__/backups.test.ts` — run unchanged for compatibility.
- [x] This spec — record verification and review disposition.

**Acceptance Criteria:**
- Given build inputs and font-fetch access, when pnpm build runs, then production compilation succeeds.
- Given server consumers, when existing backup tests run, then exports, operation details and storage behavior remain compatible.
- Given backup summaries, when the real desk loads, then rendered rows preserve the matrix distinctions.
- Given the completed diff, when inspected, then storage mechanics, dependencies, deployment configuration and ledger are unchanged.

## Spec Change Log

- 2026-09-07: Extracted the formatter and reason type into the dependency-free browser/server display module. Preserved the server exports and added one mounted test covering six response rows (whole, three known limits, absent reason, future reason). Frozen intent unchanged.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/backups.test.ts src/components/__tests__/system-health-desk.test.tsx` — focused tests pass.
- `pnpm exec tsc --noEmit` and `pnpm lint` — exit zero.
- `pnpm test` — both projects pass; report skips.
- `pnpm build` — succeeds; distinguish environmental failures from compiler failures.
- `pnpm build:cloudflare` — attempt after production success; record separately, with no deployment or dependency workaround.
- `git diff --check` — clean diff; preserve unrelated changes.

The production build verifies the import boundary; mounted tests verify UI behavior. Neither proves deployment. No Docker image is claimed unless separately built.

### Execution evidence — 2026-09-07

- Focused Vitest command: exit 0, 2 suites and 26 tests passed (25 unchanged backup tests plus 1 mounted matrix test).
- `pnpm exec tsc --noEmit`: exit 0.
- `pnpm lint`: exit 0; emitted three `TSNonNullExpression` prop-resolution diagnostics.
- `pnpm build`: exit 0, production compilation and static page generation succeeded. Log: `/private/tmp/dw781-build.log`.
- `pnpm build:cloudflare`: exit 0, OpenNext generated `.open-next/worker.js`. Warning about a bundled dependency's comparison with negative zero; no workaround applied. Log: `/private/tmp/dw781-cloudflare.log`.
- Initial sandbox `pnpm test`: exit 1, 390 suites passed and 9 failed; 9,938 tests passed, 50 failed, 1 skipped, with 5 errors. Failures included denied loopback and IPC binds (`EPERM`) and resulting timeouts. Preserved log: `/private/tmp/dw781-vitest.log`.
- Permission-enabled `pnpm test`: exit 0, all 399 suites passed across both projects; 9,988 tests passed and 1 skipped, in 118.45 seconds. The skip is the existing live Tavily test in `research-runtime.test.ts`, gated on `TAVILY_API_KEY`. Log: `/private/tmp/dw781-vitest-permission-enabled.log`.
- `git diff --check`: exit 0 after the completed source and spec edits.
- Diff inspection: only the formatter/type extraction, client imports, mounted test, and this spec changed. Storage mechanics, manifests, dependencies, deployment configuration, original backup tests, and deferred-work ledger remain unchanged.

Review disposition: implementation and required verification complete. Independent blind, edge-case and verification-gap reviews examined the complete tracked/untracked diff; all returned no findings. No follow-up review recommended. No deployment, Docker image build, push, or merge performed. The orchestrator-owned deferred-work ledger remains unchanged.

## Suggested Review Order

**Browser/server boundary**

- Client code imports only the pure formatter at runtime.
  [SystemHealthDesk.tsx:6](../../src/components/SystemHealthDesk.tsx#L6)

- One dependency-free formatter preserves every complete and partial backup label.
  [backup-display.ts:18](../../src/lib/backup-display.ts#L18)

- Server imports and re-exports preserve existing consumers without changing backup storage.
  [backups.ts:7](../../src/lib/backups.ts#L7)

**Consumer verification**

- Mounted health-desk rows exercise all known, absent and future reason cases.
  [system-health-desk.test.tsx:12](../../src/components/__tests__/system-health-desk.test.tsx#L12)
