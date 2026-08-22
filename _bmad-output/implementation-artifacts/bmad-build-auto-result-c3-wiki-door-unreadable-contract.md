---
status: blocked
---

# BMad Build Auto Result

Status: blocked

Blocking condition: the bundle cannot be resolved — it carries two independent contradictions, and the second is a repo-level regression that a prior sweep introduced and that four later sweeps have built on top of.

## 1. The bundle's `dw_ids` and its `## Intent` describe disjoint work

`.bmad-loop/runs/20260820-220331-0f16/bundles/c3-wiki-door-unreadable-contract/intent.md` carries `dw_ids: DW-421, DW-423` and pastes both entries verbatim. Both are Settings/dialog focus items:

- **DW-421** — `useDialogA11y`'s `withdrawn()` guard reads only `[hidden]`, missing CSS-only hiding (`src/hooks/useDialogA11y.ts`).
- **DW-423** — a `popstate` that closes Settings unmounts `SettingsCanvas` under the keyboard (`src/components/workbench/Workbench.tsx`).

Its `bundle_name` and its whole `## Intent` section instead describe the wiki write doors: `DELETE /api/wiki/[slug]`'s unqualified existence read and its 400 catch-all, and `PUT /api/workbench/artifact` relaying a raw errno. Nothing in the Intent touches `useDialogA11y` or `Workbench`.

This is the defect **DW-433** already records for the immediately preceding bundle (`c3-pnpm-workspace-root`, keyed `DW-415` while its Intent restated `DW-411`) — the same orchestration bug, one bundle later. Implementing either reading and letting the orchestrator record `DW-421, DW-423` resolved would repeat exactly the harm DW-433 names: closing entries nothing in the change touched.

## 2. The Intent's anchors were deleted from the tree by commit `f2458e1`

Even taken on its own terms, the Intent is unexecutable at HEAD. It instructs adding an `isPageUnreadableError` branch and reusing `PAGE_UNREADABLE_COPY`, stating both are "already imported in that file at :18-20" and that PUT/PATCH "already do this at :337 and :439". At HEAD (`f5d0243`):

- `src/lib/page-read-failure.ts` **does not exist**; neither does `src/lib/__tests__/page-read-failure.test.ts`.
- `grep` for `PAGE_UNREADABLE_COPY` / `isPageUnreadableError` across `src` returns nothing.
- `src/app/api/wiki/[slug]/route.ts` is 399 lines, so the cited `:439` anchor does not exist; the imports at `:18-20` are `write-precondition`, not the unreadable-page module.

The Intent is not wrong — it was authored against the tree as it stood at `e6edb85`. Commit **`f2458e1`** ("sweep dw3-embedding-readiness-truthfulness: DW-402, DW-403") was authored from a stale checkout and reverted that tree:

- **25 files deleted**, including `src/lib/page-read-failure.ts` (144 lines), `src/lib/__tests__/page-read-failure.test.ts` (141 lines), `src/lib/__tests__/storage-write-bounds.test.ts`, `src/lib/__tests__/discuss-fixture.ts`, `src/components/__tests__/revision-revert-session-gate.test.tsx`, `src/components/__tests__/system-health-partial-backup.test.tsx`, and **19 completed spec files** (`spec-dw-378-380-wiki-read-failure-contract.md`, `spec-dw-379-merge-base-fresh-reads.md`, `spec-dw-382-…`, `spec-dw-390-…`, `spec-dw-395-…`, and 14 more).
- **Source reverted** across `src/lib/wiki.ts`, `src/app/api/wiki/[slug]/route.ts`, `src/app/api/wiki/[slug]/revisions/route.ts`, `src/app/api/lint/fix/route.ts`, `src/lib/lint-fix.ts`, `src/lib/merge.ts`, `src/lib/wikis.ts`, `src/app/api/email/ingest/route.ts`, `src/app/api/ingest/history/route.ts`, `src/app/api/query/stream/route.ts`, and others.
- **Ledger rolled back** (`69` insertions vs `502` deletions): 465 entries → 434. **DW-435 through DW-465 (31 entries) were dropped entirely**, and **32 entries flipped `done` → `open`** — DW-64, 108, 131, 158, 215, 253, 259, 293, 323, 325, 338, 341, 343, 346, 347, 348, 352, 357, 358, 361, 362, 364, 371, 378, 379, 380, 382, 389, 390, 392, 393, 395.

The loss persists at HEAD. `src/lib/wiki.ts`, `src/app/api/wiki/[slug]/route.ts`, `src/lib/lint-fix.ts`, `src/lib/merge.ts` and `src/lib/wikis.ts` are byte-identical between `f2458e1` and `f5d0243`, so none of the four sweeps after it (`6df3e0c`, `b7d5aea`, `b18c539`, `f5d0243`) restored any of it. Those four sweeps recorded DW-400, 402, 403, 407, 408, 412, 413, 414, 415 as `done` against the regressed tree.

## Why this run stops rather than picks a reading

- Implementing the **Intent** first requires restoring a deleted 144-line module plus its 141-line test suite, and reconciling a ledger that lost 31 entries and un-did 32 completions. That is a repo recovery decision spanning ~10 sweeps, not this bundle's scope, and reconstructing `page-read-failure.ts` here would fork from the `e6edb85` version and collide with any proper recovery.
- Implementing **DW-421 / DW-423** would produce a commit whose bundle name, Intent, and recorded resolutions all disagree — the DW-433 defect, deliberately repeated.
- Either way, continuing to sweep on this tree keeps compounding the regression: this bundle's own Intent is already a symptom of it, having been generated from the pre-revert state.

## Recommended recovery (for the orchestrator / a human)

1. Halt the `20260820-220331-0f16` sweep run before further bundles land on the regressed tree.
2. Recover the `f2458e1` revert by restoring the 25 deleted files and the reverted source hunks from `e6edb85`, while **keeping** `f2458e1`'s genuine DW-402/403 changes (`spec-dw-402-403-endpoint-refusal-and-readiness.md` and its source edits). A plain `git revert f2458e1` is wrong — it would discard that legitimate work.
3. Rebuild `deferred-work.md` from `e6edb85`'s 465-entry version, re-applying the DW-400/402/403/407/408/412/413/414/415 completions the four post-regression sweeps earned.
4. Re-derive this bundle after recovery, with `dw_ids` matching its Intent.

## Verification performed

- `git status --porcelain` clean; branch `cursor/story-1-1-sign-in-f3b2`; `git add --refresh -- .` left the tree clean.
- `ls src/lib/page-read-failure.ts` → No such file; `grep -rn "isPageUnreadableError\|PAGE_UNREADABLE_COPY" src` → no matches.
- `git show --diff-filter=D --name-only f2458e1` → 25 deleted files.
- `git show --numstat f2458e1 -- _bmad-output/implementation-artifacts/deferred-work.md` → `69 502`.
- Ledger diff between `f2458e1^` and HEAD computed entry-by-entry (counts and status flips above).
- `git diff --quiet f2458e1 HEAD -- <each reverted source file>` → identical.

No source files were modified by this run. The deferred-work ledger was not edited.
