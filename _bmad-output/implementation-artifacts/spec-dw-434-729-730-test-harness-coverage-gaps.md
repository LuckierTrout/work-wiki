---
title: 'Test harness coverage gaps: queue config parity, pnpm nested-package scraper, load-sensitive research rows'
type: 'chore'
created: '2026-09-05'
status: 'done'
baseline_revision: 'b91fc402ef1585782c2dce6f7df232bed61d3092'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      The PRODUCER half of the `yopedia-tasks` wiring is still unpinned: renaming
      or deleting `wrangler.jsonc`'s `queues.producers` entry leaves the whole
      suite green while tasks are never enqueued at all.
    evidence: |-
      Surfaced by two reviewers while auditing the new consumer-side config
      block. `wrangler.jsonc:82-89` declares `{"binding": "TASK_QUEUE", "queue":
      "yopedia-tasks"}`, read at runtime by `getTaskQueue()`/`enqueueTask()` in
      `src/lib/tasks.ts:383-412`, which returns null and logs `TASK_QUEUE
      unavailable (off-Workers)` at info level when the binding is missing;
      call sites such as `src/lib/integration-outbox.ts:227` and
      `src/app/api/tasks/run/route.ts:328` ignore the boolean return. The only
      tests that open the root `wrangler.jsonc` are `e2e-identity.test.ts:147`
      (asserts only that `YOPEDIA_E2E` is absent) and `brand-copy.test.ts`
      (brand-name counts); `tasks.test.ts:29-57` injects its own
      `{ env: { TASK_QUEUE: { send } } }` mock and never reads a config file.
      So a rename there sends messages to a queue nothing drains, or drops them
      before they are queued, with no test and no error-level signal — the same
      "queued work is replayable, not lost" promise the new consumer block was
      added to protect, defeated one file over. This bundle's intent scoped
      DW-730 to the consumer config, so it is out of scope here.
    location: >-
      wrangler.jsonc:82-89 (producer) vs
      src/lib/__tests__/task-consumer.test.ts (consumer block)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three things the suite cannot currently see. (1) `workers/task-consumer/wrangler.jsonc`'s queue-consumer config — `dead_letter_queue: "yopedia-tasks-dlq"` and `max_retries: 3` — is what turns "the consumer retried" into "the message survived", yet no test parses that file, so deleting the DLQ line or bumping the retry count leaves the whole suite green while inverting DEPLOY.md's "queued work is replayable, not lost". (2) `pnpmDirTargets` in `pnpm-workspace-root.test.ts` scrapes only `--dir`/`-C`, so a nested pnpm package reached by GitHub Actions' `working-directory:` key or by `cd x && pnpm install` is invisible to the nested-package guard. (3) Two `research-runtime.test.ts` rows run ~5.1s against vitest's 5s default and fail as duration failures under parallel `node`-project load.

**Approach:** Add a config-parity test that JSONC-parses the consumer wrangler file and ties its `max_retries` to the worker's `MAX_DELIVERY_ATTEMPTS` and to DEPLOY.md's published attempt count; extend `pnpmDirTargets` to the two additional workflow forms with direct scraper unit tests; give the two slow rows an explicit timeout.

## Boundaries & Constraints

**Always:** Derive, never restate — the queue test must compare `max_retries + 1` against the worker constant and against the number DEPLOY.md publishes, so any one of the three moving alone fails. Every new assertion carries a failure message naming what breaks in production, matching the surrounding files' voice. Scraper additions must be anti-vacuous: a regex that stops matching must fail a test rather than silently shrink the derived set. Keep `workers/task-consumer/wrangler.jsonc` byte-identical.

**Block If:** The consumer wrangler file's `queues.consumers` entry for `yopedia-tasks` does not actually declare both `dead_letter_queue` and `max_retries` (the pin would then be inventing a contract rather than recording one).

**Never:** Do not change the queue config, the worker's retry logic, DEPLOY.md's prose, or any runtime behaviour — this bundle only adds test visibility. Do not add a YAML or JSONC parsing dependency. Do not raise vitest's global `testTimeout` in `vitest.config.ts`; scope the timeout to the two named rows. Do not touch `brand-copy.test.ts`'s frozen spelling-list counts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DLQ line deleted | consumer entry without `dead_letter_queue` | queue-config test fails naming message loss on a read-only deployment | n/a — assertion failure |
| `max_retries` bumped to 5 | config says 5, `MAX_DELIVERY_ATTEMPTS` still 4 | test fails: `max_retries + 1` no longer equals the worker's final attempt | n/a |
| DEPLOY.md attempt count drifts | doc no longer says "four delivery attempts" | test fails naming the stale doc line | n/a |
| JSONC comments and `//` inside strings | `"YOPEDIA_URL": "https://workwiki.app"` next to `//` comments | comment stripper leaves the URL intact and `JSON.parse` succeeds | throw a sentence naming the file if parsing fails |
| Workflow step with `working-directory:` | step body runs `pnpm install`, no `--dir` | scraper returns that directory | n/a |
| Workflow step with `cd x && pnpm install` | inline `run:` chain | scraper returns `x` | n/a |
| `--ignore-workspace` present | either new form | scraper returns nothing for that command | n/a |
| Slow research rows | two concurrent `vitest run --project node` | both rows pass | n/a |

</intent-contract>

## Code Map

- `workers/task-consumer/wrangler.jsonc:26-37` -- the `queues.consumers` entry under test: `queue: "yopedia-tasks"`, `dead_letter_queue: "yopedia-tasks-dlq"`, `max_retries: 3`. READ-ONLY here. Note `"YOPEDIA_URL": "https://workwiki.app"` at :60 — a `//` inside a string, so comment stripping must be string-aware.
- `workers/task-consumer/index.ts:56` -- `const MAX_DELIVERY_ATTEMPTS = 4;` (module-local today; read at :89 and :130). Needs `export` so the test can tie to it rather than retype `4`. `export default { … }` at :212 is the worker entry and must stay.
- `src/lib/__tests__/task-consumer.test.ts` -- home for the new config-parity block. Already imports the worker (`import worker from "../../../workers/task-consumer/index"`) and holds the DW-647 read-only door pins (:117, :135) that this config test completes. Add a new `describe` at the end.
- `DEPLOY.md:605-612` -- "a **403 falls into its transient branch and is retried**, up to four delivery attempts, after which the message is parked in the dead-letter queue. Queued work is therefore replayable, not lost." The doc-side anchor.
- `src/lib/__tests__/e2e-identity.test.ts:147-157` -- existing (and only other) reader of this wrangler file; asserts only `not.toMatch(/YOPEDIA_E2E\b/)`. Leave alone.
- `src/lib/__tests__/email-ingest-workerd.test.ts:41-72` -- precedent for reading a wrangler.jsonc from a test and throwing a named sentence when the shape is unexpected.
- `src/lib/__tests__/pnpm-workspace-root.test.ts:253-274` -- `pnpmDirTargets(yaml)`: iterates `/\bpnpm\b[^\n]*/g`, skips `--ignore-workspace`, extracts `--dir`/`-C`. This is what gets extended. Consumers: :455-457 (the union built into `sourcesFor`) and the anti-vacuity assertion at :461-467 pinning `workers/sandbox-runner`. Helpers already present: `normalizeDir` (:130), `unquote` (:119).
- `.github/workflows/` -- 12 files; **no** `working-directory:` key and no `cd … && pnpm` exists today, so the new forms must be covered by direct unit tests of the scraper against inline YAML fixtures, not by scraping a real workflow. `ci.yml:86-92` carries the three real `pnpm --dir workers/sandbox-runner` steps.
- `src/lib/__tests__/research-runtime.test.ts:1632-1677` and `:1679-1701` -- "logs a read-only skip, not data damage, when a delete is refused" (runs `runResearchProject` for two full fixtures) and "still names a DAMAGED project when the fault is not a refusal".
- `vitest.config.ts:84-127` -- no `testTimeout`, so the default 5s applies. Per-test timeouts are the repo's established fix: `lifecycle.test.ts:389` `}, 15_000);`, `merge.test.ts:183`, `epic8-remediation.test.ts:889` `}, 20_000);`.

## Tasks & Acceptance

**Execution:**
- `workers/task-consumer/index.ts` -- add `export` to `MAX_DELIVERY_ATTEMPTS` (line 56) and keep the comment explaining it is the queue's `max_retries + 1` -- so the parity test ties to the constant instead of retyping `4`.
- `src/lib/__tests__/task-consumer.test.ts` -- add a `describe` block that reads `workers/task-consumer/wrangler.jsonc`, strips JSONC comments string-awarely, `JSON.parse`s it, locates the single `queues.consumers` entry whose `queue` is `"yopedia-tasks"`, and asserts: `dead_letter_queue === "yopedia-tasks-dlq"`; `max_retries + 1 === MAX_DELIVERY_ATTEMPTS`; and that `DEPLOY.md` still spells that same attempt count in its "up to … delivery attempts" sentence (number→word map, failing loudly if the constant leaves the map) and still names the dead-letter queue. Cover the I/O matrix's parse edge case by asserting the parsed `vars.YOPEDIA_URL` survived comment stripping intact.
- `src/lib/__tests__/pnpm-workspace-root.test.ts` -- extend `pnpmDirTargets` to also derive targets from a step's `working-directory:` key and from `cd <dir> && pnpm …` chains, keeping the `--ignore-workspace` skip for both; document what the scraper covers. Add a `describe` of direct unit tests over inline YAML fixtures for the two new forms plus the `--ignore-workspace` and quoted-value cases, since no workflow in the repo uses either form today.
- `src/lib/__tests__/research-runtime.test.ts` -- give the two named rows an explicit `15_000` timeout with a comment naming DW-729 and the parallel-load cause.

**Acceptance Criteria:**
- Given the consumer wrangler file with its DLQ line deleted, when `pnpm test` runs, then `task-consumer.test.ts` fails with a message naming discarded queued messages on a read-only deployment.
- Given `max_retries` bumped to `5` with `MAX_DELIVERY_ATTEMPTS` unchanged, when the suite runs, then the parity assertion fails naming both the config value and the worker constant.
- Given a workflow step that installs a nested package only via `working-directory:` or `cd x && pnpm install`, when the scraper unit tests run, then that directory appears in `pnpmDirTargets`' output.
- Given the unchanged repository, when two `npx vitest run --project node` runs execute concurrently, then both research-runtime rows pass in both halves.
- Given the whole change, when `pnpm test` and `pnpm exec tsc --noEmit` run, then both pass and no non-test source behaviour changed beyond adding one `export` keyword.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 17: (high 0, medium 6, low 11)
- defer: 1: (high 0, medium 0, low 1)
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[medium]` `[patch]` Scraper form 2 fired on ANY pnpm command, so `working-directory: docs` + `pnpm build` demanded `docs/pnpm-workspace.yaml` — forms 2 and 3 now require an install-shaped command; form 1 (`--dir`/`-C`) deliberately unchanged.
  - `[medium]` `[patch]` Form 1 overrode form 2 per STEP, dropping the step's own directory when another command in the same step carried `--dir` — the loop now resolves per command.
  - `[medium]` `[patch]` A relative `cd` inside a `working-directory:` step emitted both directories and then failed on a path that does not exist — the two now compose.
  - `[medium]` `[patch]` Non-literal targets (`${{ matrix.dir }}`, `$GITHUB_WORKSPACE/...`, `..`, `~`, `-`) were emitted as repo paths — added a literal-path filter.
  - `[medium]` `[patch]` `shellCommandsIn` read block-scalar continuations of non-`run:` keys as commands, so `cache-dependency-path: |` + `pnpm-lock.yaml` looked like a pnpm invocation — continuations are now attributed to their owning key.
  - `[medium]` `[patch]` The two receipt-boundary rows still staged the literal `message(4)`; a coordinated retry-count change would have left them testing an unreachable attempt — they now stage `message(MAX_DELIVERY_ATTEMPTS)`.
  - `[low]` `[patch]` CRLF line endings, and comment/blank lines indented shallower than their step, mis-split step blocks.
  - `[low]` `[patch]` Both documented `yamlStepBlocks` branches had no direct test — added `describe("the step-block splitter")`.
  - `[low]` `[patch]` The scraper's new `it` docstring was labelled DW-730; corrected to DW-434.
  - `[low]` `[patch]` `CONFIG_PATH` and the path actually read were two independent spellings — the read now derives from the constant.
  - `[low]` `[patch]` The stripper row froze the production hostname; it now asserts the URL shape.
  - `[low]` `[patch]` `stripJsonComments`' block-comment and line-count branches were unreachable from the only caller — added a direct fixture.
  - `[low]` `[patch]` A legal JSONC trailing comma would have failed every config row claiming the file was malformed — trailing commas are now stripped.
  - `[low]` `[patch]` A `null` or non-object entry in `queues.consumers` threw a raw TypeError instead of the explanatory assertion.
  - `[low]` `[patch]` `**four** delivery attempts` in DEPLOY.md would have failed the prose match — emphasis characters are now normalised away.
  - `[low]` `[patch]` Both DW-729 comments stated measurements that do not hold (~5.1s standalone; the control row "walks the same reconcile path") — rewritten to the measured truth (319ms / 12ms standalone; duration failures under concurrent load).

## Design Notes

JSONC stripping must respect string literals — `"https://workwiki.app"` is in the file. A ~20-line scanner (track in-string state and escapes, drop `//`-to-EOL and `/* … */`) is the whole requirement; no dependency.

The scraper extension keeps the existing shape — one pass over the text — but widens what a "target" is. Suggested structure: split the YAML into blocks at each `- ` sequence item so a step's `working-directory:` stays attached to its own `run:`, then, per block containing a pnpm invocation, take `--dir`/`-C` first (existing behaviour, unchanged), else the block's `working-directory:`, and separately scan the block for `cd <dir> && … pnpm`. A job-level `defaults: run: working-directory:` is not a step block and stays uncovered; say so in the comment rather than silently implying full coverage.

## Verification

**Commands:**
- `npx vitest run --project node src/lib/__tests__/task-consumer.test.ts src/lib/__tests__/pnpm-workspace-root.test.ts src/lib/__tests__/research-runtime.test.ts` -- expected: all green.
- Mutation checks (revert each after): delete the `dead_letter_queue` line, and separately set `max_retries` to `5`, then re-run `task-consumer.test.ts` -- expected: a named failure each time, not a pass.
- `npx vitest run --project node & npx vitest run --project node & wait` -- expected: both halves green, specifically the two research-runtime rows.
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm lint` and `pnpm test` -- expected: clean / all green.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

Closed the three test-visibility gaps in DW-434, DW-729 and DW-730. No runtime behaviour changed: the only non-test edit is an `export` keyword and a doc block on an existing constant.

### Files changed

- [workers/task-consumer/index.ts](../../workers/task-consumer/index.ts) -- `MAX_DELIVERY_ATTEMPTS` exported (value unchanged) with a doc block explaining it is the queue's `max_retries + 1`, so the config, the worker and DEPLOY.md tie to one number.
- [src/lib/__tests__/task-consumer.test.ts](../../src/lib/__tests__/task-consumer.test.ts) -- DW-730: a string-aware JSONC comment/trailing-comma stripper plus a `task consumer queue configuration` block pinning `dead_letter_queue: "yopedia-tasks-dlq"`, `max_retries + 1 === MAX_DELIVERY_ATTEMPTS`, and DEPLOY.md's published attempt count and dead-letter promise. The two receipt-boundary rows now stage the final attempt from the constant.
- [src/lib/__tests__/pnpm-workspace-root.test.ts](../../src/lib/__tests__/pnpm-workspace-root.test.ts) -- DW-434: `pnpmDirTargets` extended from `--dir`/`-C` alone to a step's `working-directory:` and to `cd <dir> && pnpm ...`, resolved per command, with a step-block splitter and a `run:`-aware command reader; new unit rows over inline YAML fixtures for both forms and for the splitter's own branches.
- [src/lib/__tests__/research-runtime.test.ts](../../src/lib/__tests__/research-runtime.test.ts) -- DW-729: `15_000` timeouts on the two named rows, scoped to the rows rather than `vitest.config.ts`.

### Review findings

- Patches applied: 17 (medium 6, low 11)
- Items deferred: 1 (low) -- the producer half of the queue wiring, recorded in frontmatter `deferred`
- Items rejected: 5 (low)
- Follow-up review recommended: **false** -- patched findings by severity: high 0, medium 6, low 11; the score counts only high-severity patches, of which there were none.

### Verification performed

- `npx vitest run --project node` over the three target files: 185 passed, 1 skipped.
- `pnpm test`: 389 files, 9820 passed, 1 skipped. `pnpm exec tsc --noEmit`: exit 0. `pnpm lint`: clean.
- Mutation checks, each reverted (`git diff` on `workers/task-consumer/wrangler.jsonc` and `DEPLOY.md` empty afterwards): deleting the `dead_letter_queue` line and setting `max_retries: 5` each produced the named failure, not a pass.
- Two concurrent `npx vitest run --project node` runs: both DW-729 rows passed in both halves.
- Scraper no-regression: the rewritten `pnpmDirTargets` over all 12 real workflows still yields exactly the five pre-existing `workers/sandbox-runner` hits.

### Residual risks

- The concurrent double-run is still not fully green, on files this change does not touch and which are byte-identical to the `b91fc402` baseline: `ingest-image.test.ts` > "mirrors each forked page's asset into its OWN tenant silo" (both halves) and `mcp.test.ts` > "attributes merge to the given author, not 'system'" (one half), both as 5000ms duration failures. `pnpm test` in a single run is green. This is the class DW-729 and DW-722 already name, in different files, so it is not filed again.
- `pnpmDirTargets` still does not cover a job-level `defaults: run: working-directory:` or a `cd` separated from its pnpm call by `;` or a newline; both are stated in the function's docstring, and the on-disk lockfile walk remains the durable half of the derived set.
- No workflow uses either new form today, so the two forms are proven at the scraper's own boundary rather than end to end through a real workflow file.
