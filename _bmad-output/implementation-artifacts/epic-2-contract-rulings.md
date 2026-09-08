---
epic: 2
date: 2026-08-22
status: decided
ref: _bmad-output/implementation-artifacts/epic-2-retro-2026-08-22.md
---

# Epic 2 contract rulings

Decided while remediating the 2026-08-22 retrospective. These pin the three
open acceptance questions plus Overview's treatment of Source summaries.

1. **Vector embedding is fail-soft.** A successful Page write does not require
   a successful embed. Activity exposes embed-job failures. This matches the
   existing lifecycle/backfill contract.

2. **`dataVersion` is fail-soft.** A successful Page write may miss a counter
   bump. The kernel already swallows counter errors; ingest does not fail the
   compile for them.

3. **Identical bytes at a second folder path are a distinct Source.** The
   second path is stored (Story 2.2). Two-step compile is skipped after an
   *authorized* re-see (Story 2.7). A cross-owner SHA hit is fenced: the
   caller stores and compiles their own Source and never sees the match.

4. **Overview includes Source summaries.** `overview.md` lists every
   non-bookkeeping page, including `type: summary`. Bookkeeping writes the
   current summary first, then regenerates Overview so the new summary appears.

## Remediation evidence (2026-08-22)

Release gates after the retrospective remediations:

- `pnpm exec tsc --noEmit` — pass
- `pnpm test` — 6,348 passed / 279 files
- `pnpm exec next build` — compiled
- `pnpm test:e2e` — 13 passed (including the three authenticated Workbench tests)
- `git diff --check` — pass
- ESLint on the owner fixture and the remediations — pass

Action item 8 (extract Intake/delete orchestration from the Workbench shell)
stays open until after this correctness pass.
