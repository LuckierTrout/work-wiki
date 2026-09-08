# Epic 5 retrospective closure evidence

Exact-head release-gate output for the remediations that answer
`epic-5-retro-2026-08-23.md`. These 2026-08-24 logs were captured from a clean
tree at the immutable commit below. They are gate evidence, not acceptance.
The retrospective remains `verdict: rejected` until a fresh review at this
same SHA records no unresolved acceptance findings.

## Exact head

- Remediation commit: `250688ee769d356c8be6c8567b00c2dd7b34a620`
- Parent of that commit (the rejected snapshot): `15a34824debd64d5cd0e731c5f68cf80918f589c`
- Working tree at gate time: clean (`git status --porcelain` empty)
- `followup_review_recommended` stays `true` in
  `spec-5-1-through-5-10-see-the-wikis-shape.md`.
- `epic-5-retro-delivery-review-gate` stays `in-progress` until that same-SHA
  reviewer step.

## Commands and results at `250688ee`

| Gate | Command | Result at `250688ee` | Retained output |
| --- | --- | --- | --- |
| TypeScript | `pnpm exec tsc --noEmit` | Passed (exit 0, empty compiler stdout) | `tsc-2026-08-24.log` |
| Lint | `pnpm lint` | Passed (exit 0). No ESLint warnings. jsx-ast-utils prints three “Please file an issue” lines; those are library stderr, not unused-code warnings. | `lint-2026-08-24.log` |
| Full Vitest | `pnpm test` | Passed: 302 files, 6,648/6,648 tests, including `workbench-data-version.test.ts` | `vitest-2026-08-24.log` |
| Production build | `pnpm build` | Compiled successfully | `build-2026-08-24.log` |
| Authenticated Playwright | `pnpm test:e2e` | Passed: 17/17, including the named signed-in Graph, Lint, Review, and Research journeys | `playwright-2026-08-24.log` |

## Named Playwright journeys

- `signed-in Graph, Lint, Review, and Research journeys open after a wiki exists`
- `non-empty Graph chrome, reduced-motion Fit, narrow layout, and Research handoff`
- `Lint auto-fix and Review Create Page / Skip in the signed-in browser`

## Superseded working-tree snapshot

The 2026-08-23 logs in this directory were captured before the remediations
were committed. They remain useful as execution history, but they are neither
exact-head evidence nor acceptance.

| Gate | Historical working-tree result | Retained output |
| --- | --- | --- |
| TypeScript | Passed | `tsc-2026-08-23.log` |
| Lint | Passed | `lint-2026-08-23.log` |
| Full Vitest | 299 files, 6,542/6,542 | `vitest-2026-08-23.log` |
| Production build | Compiled successfully | `build-2026-08-23.log` |
| Authenticated Playwright | 17/17 | `playwright-2026-08-23.log` |

## Still not acceptance

- The authoritative decisions for malformed stores, Review scope, stale-index
  lifecycle, Story `done`, and the other retrospective rulings are recorded in
  the implementable spec under **Recorded product rulings (Epic 5 retrospective)**.
- Semantic Lint with a live provider remains unaccepted (recorded in the spec).
- Worker/R2 multi-isolate evidence is the local CAS/restart path (recorded in the spec).
- `epic-2-retro-orchestration` stays `open` and is linked from Action 10.
- A reviewer must review this SHA before clearing `followup_review_recommended`.
