---
title: 'Enroll the Playwright e2e lane in CI (DW-753)'
type: 'chore'
created: '2026-09-05'
status: 'in-review'
baseline_revision: 'd3a6ecf2b47ebcab13062cea596cb965dd9e053f'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** The browser half of the two-halves CSS rule (AGENTS.md's DW-185 bullet) runs in no automated lane — `.github/workflows/ci.yml` runs `tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm build:cloudflare` and two wrangler dry runs, and never `pnpm test:e2e`, so a cascade, geometry or hit-test regression is caught only when someone remembers to run Playwright locally (AGENTS.md:116 still records the lane as "Not in CI; run it locally").

**Approach:** Add a third job to `ci.yml` that installs Chromium and runs `pnpm test:e2e` — `playwright.config.ts`'s `webServer` already boots the dev server with the E2E identity armed, so the job adds no server plumbing of its own — update the AGENTS.md bullet so it no longer calls the lane local-only, and pin the ci.yml↔AGENTS.md parity with a node-suite guard so the new claim cannot rot the way the old one did.

## Boundaries & Constraints

**Always:** Match the existing jobs' setup exactly — `actions/checkout@v6`, `pnpm/action-setup@v6` at `9.15.9`, `actions/setup-node@v7` at Node `22` with `cache: pnpm` and `cache-dependency-path: pnpm-lock.yaml`, then `pnpm install --frozen-lockfile`. The job runs the root package only (no `--dir` target), so `src/lib/__tests__/pnpm-workspace-root.test.ts`'s workflow scrape keeps deriving the same nested-package set. Leave `playwright.config.ts` unchanged: its `webServer` block is what arms `YOPEDIA_E2E`, pins the Deep Research credentials empty, and wipes `e2e/.data` before boot.

**Block If:** The e2e suite does not pass on the current tree — enrolling a red lane is not the ask.

**Never:** Do not set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (or `CLERK_SECRET_KEY`) in the new job's `env:`. `playwright.config.ts` falls back to pinned `pk_test_`/`sk_test_` values with `??`, which only fires on `undefined`; an unconfigured `${{ vars.… }}` renders as an EMPTY STRING and would defeat the fallback. Do not change `retries`, `workers`, `fullyParallel`, or the reporter. Do not touch the `application` or `sandbox` jobs. Do not add browsers beyond Chromium.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lane enrolled | `ci.yml` as shipped | A job exists whose steps install Playwright browsers AND run `pnpm test:e2e` | Guard test fails naming the missing step |
| Clerk key leak-through | A job `env:` block naming `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in the e2e job | Guard test fails: the empty-string `??` trap | Failure message states the trap |
| Doc parity | `AGENTS.md` Playwright bullet | Does not describe `pnpm test:e2e` as absent from CI / local-only | Guard test fails naming AGENTS.md and the stale phrase |
| Anti-vacuity | Guard cannot find the workflow or the bullet | Test throws naming the file it needed | Not silently skipped |

</intent-contract>

## Code Map

- `.github/workflows/ci.yml` -- two jobs today, `application` and `sandbox`; workflow-level `permissions: contents: read` and `concurrency` already apply to any job added. `application` sets `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ${{ vars.… }}` — the exact shape the new job must NOT copy.
- `playwright.config.ts` -- `webServer.command` = `rm -rf e2e/.data && pnpm exec next dev --turbopack --hostname 127.0.0.1 -p 4173`, `reuseExistingServer: false`, `timeout: 120_000`; `webServer.env` arms `YOPEDIA_E2E=1`, the HMAC secret, owner id/handle, `DATA_DIR=e2e/.data`, and pins the Deep Research credentials empty. No `projects` key ⇒ the default project is Chromium, so `playwright install chromium` is sufficient. `forbidOnly: !!process.env.CI`, `retries: 0`, `workers: 1`.
- `e2e/env.ts` -- `E2E_PORT = 4173`, secret/owner constants shared by config and fixtures.
- `e2e/` -- `retired-routes.spec.ts`, `workbench-layout.spec.ts` (the DW-185 browser half), `workbench-owner.spec.ts`; 26 tests, all green on this tree in 1.4m locally.
- `AGENTS.md:114-123` -- the Playwright bullet; line 116 reads "Not in CI; run it locally." The rest of the bullet (focus order, the `*.test.ts` fixture-naming trap) stays.
- `src/lib/__tests__/pnpm-workspace-root.test.ts:80-140` -- `readRepoFile`/`readRepoDir` helpers and the `ROOT = path.resolve(__dirname, "../..", "..")` idiom to copy for a repo-file guard; also the workflow scraper the new job must not perturb.
- `vitest.config.ts:74` -- comment asserting "`ci.yml` runs `pnpm test` and nothing else"; the claim is about there being ONE vitest invocation, and a Playwright job is not a second vitest config — but the phrasing is now literally stale and should be narrowed to vitest.
- `package.json` -- `test:e2e` = `playwright test`; `@playwright/test` ^1.58.2 is a devDependency, so `pnpm exec playwright` resolves after the normal install.

## Tasks & Acceptance

**Execution:**
- `.github/workflows/ci.yml` -- add a third job `e2e` (name `Browser E2E`) with the shared checkout/pnpm/node/install steps, then `pnpm exec playwright install --with-deps chromium`, then `pnpm test:e2e`; `timeout-minutes` generous enough for a cold `next dev` compile (30). No `env:` block. -- gives the browser half of the DW-185 rule an automated home.
- `AGENTS.md` -- rewrite the "Not in CI; run it locally" sentence to say the lane runs in CI (naming the job) and can also be run locally; keep the rest of the bullet intact. -- the doc is the only place the lane's CI status is stated in prose.
- `src/lib/__tests__/e2e-lane-in-ci.test.ts` -- new node-suite guard reading `.github/workflows/ci.yml` and `AGENTS.md`: one job installs browsers and runs `pnpm test:e2e`; that job declares no Clerk publishable key; AGENTS.md's Playwright bullet no longer calls the lane absent from CI; each read throws a named sentence if the file is missing. -- pins every claim above so it cannot silently rot.
- `vitest.config.ts` -- narrow the "runs `pnpm test` and nothing else" comment to say `pnpm test` is the only VITEST invocation. -- keeps the rationale true now that CI runs a second test command.

**Acceptance Criteria:**
- Given the shipped `ci.yml`, when the new guard suite runs under `pnpm test`, then it finds exactly one job whose steps both install Playwright browsers and run `pnpm test:e2e`, and it passes.
- Given a hypothetical `ci.yml` in which the e2e job's `run:` no longer names `pnpm test:e2e`, when the guard runs, then it fails with a message naming `.github/workflows/ci.yml` and the missing command.
- Given the shipped `AGENTS.md`, when the guard inspects the Playwright bullet, then it finds no phrase describing `pnpm test:e2e` as not in CI or local-only.
- Given the working tree, when `pnpm exec tsc --noEmit`, `pnpm lint` and `pnpm test` run, then all three succeed.
- Given the working tree, when `pnpm test:e2e` runs, then all 26 specs pass — the lane being enrolled is green.

## Spec Change Log

## Review Triage Log

## Design Notes

The job is deliberately thin because `playwright.config.ts` already owns the server. Its `webServer` block boots `next dev` (not `next start`: Next inlines middleware env at build time, so `YOPEDIA_E2E` must be read at request time), arms the HMAC cookie identity, and wipes `e2e/.data` first. A CI job that started its own server would duplicate — and drift from — that contract.

```yaml
  e2e:
    name: Browser E2E
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      # …checkout / pnpm / node / install, identical to `application`…
      - name: Install Playwright browsers
        run: pnpm exec playwright install --with-deps chromium
      - name: Playwright e2e
        run: pnpm test:e2e
```

Runtime and flake budget, measured on this tree: 26 tests, 1.4m wall locally including the dev-server boot, `workers: 1`, `retries: 0`. Zero retries is the flake budget — a flaky spec fails the lane rather than being papered over, which is the only setting that makes the DW-185 browser half worth having.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean
- `pnpm lint` -- expected: clean
- `pnpm test` -- expected: all suites pass, including the new guard
- `pnpm test:e2e` -- expected: 26 passed
- `python3 -c "import yaml,sys;d=yaml.safe_load(open('.github/workflows/ci.yml'));print(sorted(d['jobs']))"` -- expected: parses, and lists the new job alongside `application` and `sandbox`
