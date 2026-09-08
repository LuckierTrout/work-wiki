---
title: 'AD-15 production compatibility upgrade'
type: 'chore'
created: '2026-09-07'
status: 'done'
review_loop_iteration: 0
baseline_revision: '3ecb44c4ac92ef0440dc1c7ce61fe64bf310d436'
baseline_commit: '3ecb44c4ac92ef0440dc1c7ce61fe64bf310d436'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** PR #10 is merged, but the deployed release cannot advance under architecture AD-15 while Next, OpenNext, and React remain below its required versions.

**Approach:** Upgrade the coordinated dependencies without changing behavior; verify before authorized publication/deployment. Record the gated durable-lock rollout.

## Boundaries & Constraints

**Always:** Pin `next`/`eslint-config-next` to 15.5.23, `react`/`react-dom` to 19.1.4, and `@opennextjs/cloudflare` to 1.20.2. Regenerate the root lockfile with pnpm 9.15.9; preserve unrelated versions. Distinguish local proof, CI, merge, and live acceptance. Protect data and frozen identifiers.

**Ask First:** Required source/config fixes beyond these dependencies, failed gates requiring unrelated fixes, newer target versions, infrastructure replacement, destructive recovery, or an inability to establish safe rollout prerequisites.

**Never:** Upgrade to Next 16; broadly refresh dependencies; edit `.github/`, the deferred ledger, prior intent contracts, or production data. Do not suppress peer checks, weaken tests, or add the optional rclone peer without need. Never use elapsed time, lease expiry, an empty queue, or 100% new-version routing alone as proof that old executions finished.

</frozen-after-approval>

## Code Map

- `package.json:39,43,44,57,67` -- five version declarations; existing build scripts and pinned pnpm.
- `pnpm-lock.yaml` -- root importer and transitive peer snapshots; preserve the separate sandbox package/lockfile.
- Read-only `next.config.ts` and `open-next.config.ts` already configure this checkout; no major-version codemod is indicated.
- Architecture `ARCHITECTURE-SPINE.md:122` defines AD-15. Registry-verified peers: OpenNext accepts Next `>=15.5.21 <16`, Wrangler `^4.86.0`; rclone is optional. Clerk 7.4.2 accepts React `~19.1.4`.
- `.github/workflows/ci.yml` -- read-only Ubuntu/Node 22 application gates; separate sandbox job.
- `playwright.config.ts` -- one-worker browser suite against dedicated local dev storage; never build a deployment with its E2E environment armed.
- `README.md:176`, `src/lib/lock.ts:152` -- R2 durable-lock gate and two-stage rollout. Local filesystem tests do not exercise the production gate automatically.
- `src/app/api/tasks/run/route.ts:886,990`, `workers/task-consumer/index.ts:118,255` -- migration failures can become terminal 422/ACK on retries; queue pause alone does not stop cron scans. `DEPLOY.md:550` documents writes outside read-only coverage.
- `src/lib/__tests__/lock.test.ts:294` and `storage-r2.test.ts:472` -- migration refusal and CAS regressions; `task-consumer.test.ts` covers ACK/retry semantics.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- update exactly the five version declarations together using apply_patch.
- [x] `pnpm-lock.yaml` -- regenerate with the pinned manager; inspect transitive changes and run frozen-lockfile install without broad update flags.
- [x] This spec -- record resolved versions, peer compatibility, exact commands/results, independent review, and any blocked checks.
- [x] `docs/ad15-production-rollout.md` -- record the procedure below, code references, and pending/live evidence; no deployment during implementation.

**Acceptance Criteria:**
- Given a fresh frozen-lockfile install, when resolved versions are inspected, then all five targets match and their relevant peer ranges are satisfied without overrides.
- Given the upgraded tree, when local application, browser, and lock/queue regression gates run, then they pass without skipped new coverage or source behavior changes.
- Given the completed local workflow, when release readiness is reported, then CI and production remain pending until independently verified on the published artifact.
- Given missing drain evidence or unsafe queue state, when rollout readiness is assessed, then no production mutation is authorized by a guessed timeout or a readiness flag alone.

## Spec Change Log

- 2026-09-07: Implemented exactly the five root pins and added the rollout
  evidence record. No source/config behavior change, sandbox dependency change,
  protected-file edit, production mutation or change to frozen intent.
- Regenerated using `CI=true pnpm install --lockfile-only` with pnpm 9.15.9.
  Initial sandbox resolution failed with npm-registry `ENOTFOUND`; the network
  retry succeeded. Restored pnpm's incidental deduplication of the original
  `@emnapi/runtime@1.9.2`, `lru-cache@11.3.6`, and `semver@7.7.4` package
  records and dependency edges from the baseline using apply_patch, preserving
  unrelated versions. Subsequent frozen installation accepted the lockfile.
  Required transitive changes are Next's env/SWC/eslint-plugin packages and
  `@opennextjs/aws` 4.0.2 -> 4.1.0, plus the updated Next/React peer snapshots.
  Registry deprecation metadata was refreshed for two unchanged packages;
  no broad update flags or new overrides were used. Optional `rclone.js`
  remains uninstalled.

## Verification

- `pnpm install --frozen-lockfile`; `pnpm list next react react-dom eslint-config-next @opennextjs/cloudflare --depth 0` -- exact targets and reproducible lockfile.
- `pnpm exec tsc --noEmit`; `pnpm lint`; `pnpm test` -- green, with the existing credential-gated skip identified separately.
- `pnpm test:e2e` -- existing browser suite passes locally; validate its dedicated disposable data path before running.
- `pnpm build`; `pnpm build:cloudflare`; `pnpm exec wrangler deploy --dry-run --config wrangler.jsonc` -- green, without deployment or E2E flags.
- `git diff --check` and scope inspection -- only root manifest/lockfile, this spec, and the rollout record change.

### Local execution evidence (2026-09-07)

Environment: macOS, Node 26.8.1, pnpm 9.15.9. CI uses Ubuntu/Node 22 and remains
independent evidence pending publication.

| Command/check | Result |
| --- | --- |
| `node --version`; `pnpm --version` | v26.8.1; 9.15.9 |
| `CI=true pnpm install --frozen-lockfile` | Passed, including after preservation of unrelated transitive versions; resolution skipped and no peer warnings |
| `pnpm list next react react-dom eslint-config-next @opennextjs/cloudflare --depth 0` | 15.5.23 / 19.1.4 / 19.1.4 / 15.5.23 / 1.20.2 |
| Installed package manifest peer checks with `semver.satisfies` | All relevant Next/React/React DOM/Clerk/OpenNext/Wrangler/eslint/TypeScript ranges passed |
| `pnpm exec tsc --noEmit` | Passed on final dependency tree |
| `pnpm lint` | Passed on final dependency tree; three `TSNonNullExpression` jsx-ast-utils resolver notices, no lint error |
| `pnpm test` | Passed: 399 files; 9,990 passed, 1 existing live Tavily credential skip; 114.81s. Includes lock (20), R2 storage (74), task consumer (11) tests |
| `pnpm test:e2e` | Passed: all 26 browser tests, one worker, 2.5m; dev server exited before build |
| `pnpm build` | Passed; Next.js 15.5.23 |
| `pnpm build:cloudflare` | Passed; OpenNext Cloudflare 1.20.2 / AWS 4.1.0; Worker produced |
| `pnpm exec wrangler deploy --dry-run --config wrangler.jsonc` | Passed; exited with `--dry-run: exiting now.`; no deployment |
| `git diff --check` and final scope inspection | Passed; exactly root manifest/lockfile, this spec and rollout record changed |
| Independent local review | Three context-free reviews passed with zero findings: general defects, edge cases, verification gaps. Runtime concurrency limits required sequential reviewer startup; all completed before triage. |
| Published exact-head CI / merge / live acceptance | Pending; no production changes |

Installed OpenNext 1.20.2 declares Next `>=15.5.21 <16 || >=16.2.11` and
Wrangler `^4.86.0`; installed Wrangler stays 4.92.0. Its `rclone.js ^0.6.6`
peer is explicitly optional. Clerk 7.4.2's ranges include Next `^15.5.9`
and React/React DOM `~19.1.4`; React DOM requires React `^19.1.4`.

The browser runner's `e2e/.data` was verified as a gitignored, real directory
inside this checkout, not a symlink; `playwright.config.ts` points its storage
there and uses one worker on 127.0.0.1:4173. Its existing reset removes only
that disposable fixture store. No `YOPEDIA_E2E*` environment names were present
in the parent shell. Next's production environment loader also confirmed none
in environment files. Production builds run after the dev server exits.

The existing live Tavily test in `research-runtime.test.ts` is credential-gated
with `it.skipIf(!process.env.TAVILY_API_KEY)`; any skip is reported separately
from local regression coverage. Lock migration tests explicitly force the R2
gate because ordinary local filesystem operation bypasses it.

Local build caveats: no production Clerk publishable key or owner handle was
present in the production env loader's input. The existing Wrangler config
contains the owner handle, but production public build settings must still be
refreshed before the release rebuild. Successful local builds are not approved
deployment artifacts. The builds emitted Node deprecation/webpack cache notices
and OpenNext emitted an `equals-negative-zero` warning in generated bundled
code; all commands exited 0 without source/config fixes or suppressed checks.

Full local logs are outside the repository at `/private/tmp/ad15-vitest-final.log`,
`/private/tmp/ad15-lint.log`, `/private/tmp/ad15-e2e.log`,
`/private/tmp/ad15-next-build.log`, `/private/tmp/ad15-cloudflare-build.log`, and
`/private/tmp/ad15-wrangler-dry-run.log`. The earlier test run was interrupted
before the final frozen dependency reinstall; only the complete final run above
is acceptance evidence. All 46 unrelated direct version declarations and
resolved versions were compared with the baseline and preserved. Independent
review is the remaining local workflow gate; release continuation remains
separately pending.

## Authorized release continuation

After local review, publish a PR, require terminal exact-head CI, then merge under existing authorization. Rebuild with verified production public settings; capture Worker/config/queue state and rollback identity without exposing secrets.

Before stage 1, establish reversible queue-delivery pause, quiesce other mutation producers including cron, and establish authoritative accounting for old executions. Otherwise stop for operator coordination while production remains unchanged.

Deploy the new artifact with `WORKWIKI_DURABLE_LOCK_V2_READY` absent. Only after proof that all old requests/deliveries finished, deploy the same artifact with `=1`. Preserve runtime settings; never bulk-clear legacy leases. Restore paused activity and verify retries/DLQ, both domains, signed-out refusal, and owner-authenticated reads plus a reversible isolated write check. Report any unexecuted owner-session acceptance explicitly. The local workflow's `done` status is not completion of this release continuation.

## Suggested Review Order

**Coordinated compatibility pins**

- Start with the exact framework and React patch targets; behavior and major versions stay unchanged.
  [package.json:39](../../package.json#L39)

- The adapter and matching lint package move with the framework.
  [package.json:57](../../package.json#L57)

- Inspect resolved peer snapshots and preservation of unrelated versions.
  [pnpm-lock.yaml:66](../../pnpm-lock.yaml#L66)

**Production safety**

- Read the preconditions before either migration stage can begin.
  [ad15-production-rollout.md:22](../../docs/ad15-production-rollout.md#L22)

- Check deployment and rollback evidence requirements; local success is not drain proof.
  [ad15-production-rollout.md:63](../../docs/ad15-production-rollout.md#L63)
