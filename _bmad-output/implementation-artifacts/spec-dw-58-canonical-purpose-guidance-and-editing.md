---
title: 'DW-58 canonical Purpose guidance and editing'
type: 'feature'
created: '2026-08-31'
status: 'in-progress'
baseline_commit: 'ffc99a2f2b50f1d2d09be5fbecd854bfb1561f46'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `purpose.md` is visible but cannot be edited, while the writable structured Workspace Purpose profile—not the Markdown artifact named by FR-34—currently guides generated work. The two representations can disagree, and LLM-backed Lint does not receive Purpose guidance.

**Approach:** Make `purpose.md` the canonical owner-authored Purpose and `schema.md` the canonical page-conventions source. Migrate supported legacy profile edits without deleting their evidence, route Settings and Files to the same confirm-gated Markdown editor/history, and make subsequent LLM-backed Ingest, Chat, Lint, Todo/extraction, monitoring, query, and agent runs read the canonical artifacts.

## Boundaries & Constraints

**Always:**
- Mark artifact authority per Wiki. Until an unmarked Wiki migrates, its valid profile remains effective; after the marker commits, missing/corrupt artifacts never resurrect profile guidance. New and re-templated Wikis are artifact-authoritative immediately.
- Migrate idempotently under `wikis:<tenant>`: project supported profile Purpose/questions/scope/language into `purpose.md`; append a uniquely marked legacy `pageConventions` block to Schema only when it adds guidance; snapshot every changed artifact; preserve `workspace-profile.json` bytes as rollback evidence; commit the registry marker last and bump once.
- Serve the effective Purpose during migration, so Preview, prompts, backups, and exports never expose stale template bytes as canonical owner guidance.
- Use the existing Preview editor only. Settings launches the active Wiki’s artifact through the shell’s dirty-draft guard; it does not embed a second form/editor or auto-open the confirmation.
- Purpose saves are nonblank Markdown within `PREVIEW_MAX_CHARS`, current-Wiki scoped, owner/read-only gated, `If-Match` protected inside the Wiki lock, revisioned, correctly labelled, and followed by one log entry and one `dataVersion` bump. Schema alone requires a nonempty `## Page conventions` body.
- Purpose affects LLM-backed Lint checks; deterministic lint rules remain code-defined. Existing per-operation guidance caches stay stable in flight, and the next operation sees a landed edit or revert.

**Ask First:**
- Expanding this work to cross-process/isolate linearizability or a durable multi-object transaction; the existing Wiki lock is process-local and compensation must be described honestly.
- Any migration path that would delete legacy profile bytes or overwrite unreadable artifact bytes without first preserving a recoverable copy.

**Never:**
- Never modify `deferred-work.md`, edit `llm-wiki.md`, rename frozen identifiers, route artifacts through the Page/index/backlink pipeline, or claim that arbitrary Purpose text changes deterministic lint results.
- Never merge legacy profile text and canonical artifact text into competing prompt blocks, keep `/api/workspace-profile` as a live writer, or allow an unmarked/stale profile to win after artifact authority is recorded.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Legacy profile migration | Unmarked Wiki; profile differs from seeded artifacts | Effective Preview/export uses supported profile guidance; migration revisions changed artifacts, preserves profile bytes, marks authority last | Unreadable bytes are preserved; warn and leave retryable/unmarked |
| Purpose edit | Owner saves unique Markdown from Preview | Canonical bytes land; prior bytes are revisioned; the next supported LLM run contains the edit | Missing/stale precondition refuses with 428/412 and writes no tail |
| Settings launcher | General → Open Purpose/Schema with another dirty draft | Whole mode/tab/selection change waits behind the existing discard guard; same-target draft survives | No Wiki is explained; read-only still opens view but cannot edit/revert |
| Purpose revert | Owner restores an earlier Purpose revision | Purpose and subsequent guidance restore; current bytes become the newest undo revision | Invalid/missing revision is refused without changing guidance |
| Re-template | Artifact-authoritative Wiki chooses a template | Purpose and Schema are replaced and both prior versions are recoverable; legacy profile stays non-live | Existing compensation and one-bump contract remain |

</frozen-after-approval>

## Code Map

- `src/lib/wiki-scenarios.ts`, new `src/lib/workspace-purpose.ts` -- artifact allowlist plus bounded render/effective/migration rules; keep template prose single-sourced.
- `src/lib/wikis.ts`, `workspace-profile.ts`, `workspace-profile-backfill.ts`, `maintenance.ts` -- marker, locked migration/composite artifact writes, compensation, lifecycle/history, and preserved legacy evidence.
- `src/lib/workspace-guidance.ts`, `lint-checks.ts`, `research-prefill.ts` -- canonical Purpose runtime reader, three LLM-lint prompt paths, and removal of duplicate profile prefill.
- `src/app/api/workbench/{preview,artifact,artifact/revisions}/route.ts` -- effective reads, file-specific validation, current-Wiki CAS saves/reverts.
- `src/lib/workbench-preview.ts`, `src/components/workbench/{PreviewColumn,SettingsCanvas,Workbench}.tsx`, `src/lib/workbench-settings.ts` -- Purpose-specific copy/history and guarded Settings launch/focus.
- `src/components/WorkspacePurposeSettings.tsx`, `src/app/settings/page.tsx`, `src/components/KnowledgeStudio.tsx`, `src/app/api/workspace-profile/route.ts` -- replace the structured writer with a callout to the one Workbench editor; retain only migration-safe compatibility reads if required.
- `src/lib/backups.ts`, `src/lib/portable-archive.ts` -- export effective canonical artifact bytes without mutating storage.
- `src/lib/__tests__/*purpose*`, `*guidance*`, `*lint*`, `*artifact-revisions*`, `*wikis*`; `src/components/**/__tests__/*.test.tsx` -- node storage/prompt proofs plus mounted editor, dirty-guard, focus, history, and read-only proofs.

## Tasks & Acceptance

**Execution:**
- [ ] Canonicalization layer -- add artifact-authority state, effective reads, idempotent profile-to-artifact migration, revision/compensation/export handling, and new-Wiki/re-template lifecycle behavior.
- [ ] Runtime layer -- read canonical Purpose across every existing guidance consumer and LLM-backed Lint path; remove live profile/duplicate-prefill semantics.
- [ ] Editing layer -- widen the artifact pipeline to Purpose, generalize validation/copy/history/logging, and make Settings open the same guarded Preview editor while retiring the structured writer.
- [ ] Tests -- cover every matrix row, migration idempotence/failure injection, prompt capture, CAS/no-tail refusals, exact one-bump behavior, dirty-draft navigation, focus, and read-only visibility.

**Acceptance Criteria:**
- Given an existing Wiki whose supported Settings profile differs from its artifacts, when canonicalization runs, then no owner-authored supported field is lost, prior artifact bytes are recoverable, profile bytes remain preserved, and later profile mutation cannot change runtime guidance.
- Given Purpose text saved or reverted from either Settings’ launcher or Files, when the next Ingest, Chat/query, LLM Lint, Todo/extraction, monitoring, or agent operation starts, then its captured prompt contains that canonical text while an already-running cached operation remains unchanged.
- Given no Wiki, read-only mode, stale content, storage failure, or an unsaved draft on another selection, when the owner tries to open/save/revert Purpose, then the existing refusal/guard protects data and keeps the relevant text and controls reachable.
- Given the completed change, when full verification runs, then typecheck, lint, combined Vitest projects, and relevant Playwright Workbench flows pass without editing protected files or the deferred-work ledger.

## Spec Change Log

## Design Notes

Migration precedence follows supported history: the structured profile was the only editable Purpose before this change, so it temporarily wins for unmarked Wikis. The marker is the irreversible semantic boundary—not deletion. Once marked, raw Markdown is product truth and the untouched profile is evidence only.

## Verification

**Commands:**
- `pnpm typecheck` -- expected: no TypeScript errors.
- `pnpm lint` -- expected: no lint failures.
- `pnpm test` -- expected: node and dom projects pass and collect their guarded suites.
- `pnpm test:e2e` -- expected: relevant authenticated Workbench Settings → Preview edit/history flows pass; report environment limits if authentication is unavailable.
