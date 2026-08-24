# Epic 5 retrospective closure evidence

Retained historical working-tree gate output for the remediations that answer
`epic-5-retro-2026-08-23.md`. These logs predate the four feature-area review
follow-ups recorded in the implementable spec and are therefore superseded as
proof of the current diff. They remain useful as execution history, but they
are neither exact-head evidence nor acceptance. The retrospective remains
`verdict: rejected` until a fresh review at an immutable commit SHA that
contains this work.

## Working tree

- Parent commit (the rejected snapshot): `15a34824debd64d5cd0e731c5f68cf80918f589c`
- These remediations were still uncommitted when the gates below ran.
- No tree digest was recorded, so the logs identify neither an immutable
  revision nor the later reviewed working tree.
- `followup_review_recommended` stays `true` in
  `spec-5-1-through-5-10-see-the-wikis-shape.md`.

## Commands and results

| Gate | Command | Historical result at the captured working-tree snapshot | Retained output |
| --- | --- | --- | --- |
| TypeScript | `pnpm exec tsc --noEmit` | Passed (exit 0, empty stdout) | `tsc-2026-08-23.log` |
| Lint | `pnpm lint` | Passed (exit 0). No ESLint warnings. jsx-ast-utils prints three “Please file an issue” lines; those are library stderr, not unused-code warnings. | `lint-2026-08-23.log` |
| Full Vitest | `pnpm test` | Passed: 299 files, 6,542/6,542 tests | `vitest-2026-08-23.log` |
| Production build | `pnpm build` | Compiled successfully | `build-2026-08-23.log` |
| Authenticated Playwright | `pnpm test:e2e` | Passed: 17/17, including signed-in Graph, Lint, Review, and Research journeys | `playwright-2026-08-23.log` |

The later Chunk 4 review added coverage and recorded 6,590 passing tests plus
17/17 passing Playwright tests in the implementable spec. The 48-test increase
from the 6,542-test log above is expected from the follow-up patches; neither
count is immutable-revision proof until the final diff is committed and rerun.

## Named Playwright journeys

- `signed-in Graph, Lint, Review, and Research journeys open after a wiki exists`
- `non-empty Graph chrome, reduced-motion Fit, narrow layout, and Research handoff`
- `Lint auto-fix and Review Create Page / Skip in the signed-in browser`

## Still not acceptance

- The authoritative decisions for malformed stores, Review scope, stale-index
  lifecycle, Story `done`, and the other retrospective rulings are recorded in
  the implementable spec under **Recorded product rulings (Epic 5 retrospective)**.
- Semantic Lint with a live provider remains unaccepted (recorded in the spec).
- Worker/R2 multi-isolate evidence is the local CAS/restart path (recorded in the spec).
- `epic-2-retro-orchestration` stays `open` and is linked from Action 10.
- A reviewer must re-run these commands at the commit that lands this work
  before clearing `followup_review_recommended`.
