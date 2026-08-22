---
status: blocked
---

# BMad Build Auto Result

Status: blocked
Blocking condition: dirty working tree; branch `cursor/story-1-1-sign-in-f3b2` does not fit story 2.1

Invocation: `/bmad-build-auto story 2.1`

Resolved intent: Story 2.1 — Upload, drag-drop, and URL Intake (Epic 2: Sources compile).

Version-control check failed before routing:

- `git add --refresh -- .` succeeded (repository metadata is writable).
- Working tree is not clean. Untracked:
  - `_bmad-output/implementation-artifacts/bmad-build-auto-result-c3-wiki-door-unreadable-contract.md`
  - `_bmad-output/implementation-artifacts/bmad-build-auto-result-epic-2.md`
  - `_bmad-output/implementation-artifacts/bmad-build-auto-result-unclear-intent.md`
  - `_bmad-output/implementation-artifacts/epic-2-context.md` (compiled this run; valid cache starts with `# Epic 2 Context:`)
- Current branch `cursor/story-1-1-sign-in-f3b2` is an obvious mismatch for story 2.1.

Re-invoke on a clean tree and a branch that fits story 2.1 (Epic 2 / upload-drag-drop-and-url-intake).
