---
title: 'Add a single-item sweep filter and reconcile DW-781'
type: 'feature'
created: '2026-09-07'
status: 'done'
baseline_commit: '17d1bf9046ea4e270a1de87ba036127403ee6c80'
review_loop_iteration: 0
tool_baseline: '1a3d358b5398498af968c7ead5fa0e8c70b6fe0e'
tool_commit: '4b64b5e1'
tool_root: '/private/tmp/bmad-loop-dw781-CCeOPk/source'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The installed sweep processes every open ledger entry. Its bundle cap applies after resolved-entry closures, so it cannot safely reconcile only DW-781.

**Approach:** Add `sweep --only DW-<number>` with deterministic scope enforcement, including resume. Test and install the same-revision tool patch, then run one non-repeating DW-781 sweep. The existing orchestrator remains the sole ledger writer.

## Boundaries & Constraints

**Always:**
- Restrict triage output, decisions, bundle execution, closure, recovery and pre-answer cleanup to the selected ID. Reject mixed bundles rather than trimming their intent.
- Preserve every other ledger block and unrelated pre-answer. Do not harvest new ledger rows during a scoped run; retain findings in run artifacts instead.
- Persist immutable scope in run state and options. Missing/corrupt/conflicting scope metadata must never widen a scoped resume. Old unrestricted runs remain compatible.
- Validate IDs before creating a run. An existing closed ID is a successful no-op; an unknown or malformed ID is an error.
- Preserve existing tool dependencies, project customizations, credentials and unfiltered behavior. Retain a recoverable original tool package before installation.

**Ask First:** An upstream upgrade, dependency change, broader ledger work, or scope preservation requiring replacement of unrelated project customization.

**Never:** Manually close DW-781, synthesize a successful triage result, edit other ledger entries, initiate migration/archive in scoped mode, bypass validation, overlap sweeps in this checkout, push, merge or deploy.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Dry run | --only DW-781 | Only selected entry listed; no sessions or writes | Reject unknown ID |
| Resolved selection | Selected ID fixed; others open | Close only selected ID with evidence | Reject foreign result IDs |
| Buildable selection | Selected ID still needs work | Only its bundle may execute | Reject mixed bundle |
| Resume | Scope persisted; options damaged or conflicting | Preserve scope or refuse before effects | Never fall back to unrestricted |
| Cached/recovery contamination | Foreign IDs in cache, tasks or pending ledger carries | No execution or ledger mutation | Fail closed |
| Other state | Unrelated closed pre-answers, new deferrals | Preserve unrelated state; findings remain artifacts | Reject unauthorized ledger edits |
| Compatibility | No --only | Existing unrestricted behavior | Existing handling |
| Invalid combination | --only with archive or legacy migration | No migration or archive | Explicit refusal |

</frozen-after-approval>

## Code Map

Paths relative to `tool_root`; installed source matches this revision. Read its AGENTS.md and testing instructions. Python paths below are under `src/bmad_loop/`.

- `cli.py:2078,2209,2368,4329`: launch, handler, dry-run, parser.
- `runsetup.py:1059,1235`: creation/resume; damaged sweep.json currently becomes empty options. `model.py:604,680,710`: RunState serialization.
- `sweep.py:586,643,738,1126,1233,1433`: cycle, recovery, pruning, cached triage, closures, bundles.
- `engine.py`: carries replay BEFORE sweep loop; harvesting and whole-ledger restores need guards. `decisions.py`: pruning and previous-run decisions.
- `data/skills/bmad-loop-sweep/`: canonical skill; Work-wiki's installed copy is customized.
- `tests/test_{cli,runsetup,model,sweep,sweep_skill_contract}.py`: existing fake-adapter and composition seams.

## Tasks & Acceptance

**Execution:**
- [x] CLI/model/runsetup: validate, persist and resume scope; expose it in dry-run.
- [x] Sweep/engine/decisions: guard execution and writes, caches, recovery, harvesting and restoration.
- [x] Canonical skill and Work-wiki `.agents/skills/bmad-loop-sweep/`: additive scope instructions only.
- [x] Named tests: exercise every matrix row through fake adapters/CLI; ablate guards to prove refusals are tested.
- [x] `docs/FEATURES.md`, `CHANGELOG.md`: document selector and limits.
- [x] Build original rollback package and patched package; install tested patch without changing dependencies.
- [x] Commit approved Work-wiki skill/spec changes for a clean tree; validate, dry-run, then launch `bmad-loop sweep --only DW-781 --no-prompt --no-repeat --max-bundles 0` (zero development bundles).
- [x] Verify terminal write-back and byte-identical unrelated ledger blocks/pre-answers.

**Acceptance Criteria:**
- Scoped completion/resume cannot execute or modify unrelated entries.
- The installed command reconciles only DW-781 with terminal orchestrator evidence.
- Unfiltered behavior and dependencies remain unchanged; rollback is available.

## Spec Change Log

## Verification

- Tool: `uv sync --locked --all-extras`; focused suites, full `uv run pytest -q`, `uv run pyright`, changed-file lint/format. Tests use fake adapters, zero live LLM calls.
- Before launch: clean Work-wiki, no live sweep, dry-run lists only DW-781. Actual triage uses configured live adapter.
- Terminal journal plus Git diff prove closure, zero development sessions and unrelated-state preservation; result.json alone is insufficient.

### Verification evidence — 2026-09-07

- Evidence/package directory: `/private/tmp/bmad-loop-dw781-CCeOPk/`.
- Focused suites: 1,295 passed, 2 skipped. All scoped matrix cases ran; 15 guard ablations failed as expected and were restored.
- Full suite with required process/socket permissions: 7,044 passed, 75 skipped, 7 failed. The same seven fail against untouched baseline source: five macOS invalid-byte filename cases and two installed OpenCode schema mismatches. These are retained limitations, not a clean full-suite claim.
- Linux-targeted Pyright, Ruff, pinned Black and diff checks passed. Default macOS Pyright has the same two `os.*xattr` diagnostics as the original source.
- Installed the patched wheel with `uv pip install --no-deps --reinstall`. Before/after package inventories are identical. Rollback wheel retained under `rollback/`; patched wheel under `patched/`.
- Patched wheel SHA256: `287a923a272a98482b9c87acc4d706522e496373b0eb48ca7177cccf744010e4`.
- Installed CLI dry-run lists DW-781 alone; project preflight passed with a clean tree after local preparation commit `880c37a3`.
- Live run `20260907-174715-9ac9` finished: one triage session, only DW-781 classified already resolved, zero development bundles. The terminal journal records `sweep-resolved-closed`, ledger commit `291eb18b020d19a6c4e98a978102a2dc515aa4d8`, and `run-complete`.
- Before/after byte comparisons confirmed every non-DW-781 ledger byte and the complete pre-answer file unchanged. State, options and scope pin all name DW-781.
- Existing startup retention pruned five older recovery refs. All five original snapshots were uniquely recovered against journal timestamps and their refs restored; the four preserved unfinished attempts stayed intact throughout. Review will address this incidental scoped-startup behavior.

### Review patch pass

Three independent review lenses completed. Accepted implementation/test fixes: suppress scoped recovery-ref retention; correct byte-faithful tracked and external-ledger rollback checks; preserve disputed concurrent writes without unattributed whole-file restoration; check isolated pre-answer stores; retain invalid-UTF8 rejection evidence; skip malformed historical state objects; test scoped decision discovery at its consumer; show the scope in the dry-run prompt. No intent changes or new deferred-work rows.

The first patched installation was temporarily rolled back while these fixes are verified. The original and first-run wheels are retained in the gitignored `.bmad-loop/cache/tool-patches/20260907-dw781/` directory. DW-781's terminal closure is unaffected; no second live sweep is planned.

### Final verification

All eight review fixes are complete. Final focused suites: **1,311 passed, 2 skipped**. Full suite: **7,060 passed, 75 skipped, the same seven baseline-reproduced failures**. Eleven additional targeted guard ablations failed as intended and were restored before final gates. Linux Pyright, Ruff, pinned Black and diff checks pass; macOS retains the same two baseline diagnostics. [Complete verification and matrix map](../../.bmad-loop/cache/tool-patches/20260907-dw781/evidence/review-verification.md).

The reviewed wheel is installed from the durable ignored cache, SHA256 `307a6990b652053774925dfbcb22861377bb1304dd16cb46daacb3b146ec7940`. Installed source matches local tool commit `4b64b5e1` byte-for-byte, excluding bytecode caches; package inventories remain identical. The installed DW-781 dry-run returns a successful already-closed no-op. No second live sweep was created.

The cache retains the original rollback wheel, first-run wheel, final reviewed wheel, [source patch](../../.bmad-loop/cache/tool-patches/20260907-dw781/single-item-sweep.patch), source archive and verification logs. Scoped startup and resume now skip global recovery-ref pruning. Disputed writes stop with raw before/after evidence rather than overwriting another writer's work. No push, merge or deployment was performed.

## Suggested Review Order

**Selection and resume**

- Start with selection validation and the closed-entry no-op.
  [cli.py:2214](../../../../../../private/tmp/bmad-loop-dw781-CCeOPk/source/src/bmad_loop/cli.py#L2214)
- Require matching persisted scope before resume effects.
  [sweepscope.py:62](../../../../../../private/tmp/bmad-loop-dw781-CCeOPk/source/src/bmad_loop/sweepscope.py#L62)

**State preservation**

- Keep scoped startup from deleting unrelated recovery refs.
  [sweep.py:576](../../../../../../private/tmp/bmad-loop-dw781-CCeOPk/source/src/bmad_loop/sweep.py#L576)
- Preserve disputed shared writes and record raw evidence.
  [sweep.py:623](../../../../../../private/tmp/bmad-loop-dw781-CCeOPk/source/src/bmad_loop/sweep.py#L623)
- Enforce unrelated-byte preservation inside the ledger write boundary.
  [deferredwork.py:907](../../../../../../private/tmp/bmad-loop-dw781-CCeOPk/source/src/bmad_loop/deferredwork.py#L907)

**Regression evidence**

- Prove startup and resume leave recovery refs intact.
  [test_sweep.py:242](../../../../../../private/tmp/bmad-loop-dw781-CCeOPk/source/tests/test_sweep.py#L242)
- Prove decision discovery cannot expose foreign scoped entries.
  [test_decisions.py:118](../../../../../../private/tmp/bmad-loop-dw781-CCeOPk/source/tests/test_decisions.py#L118)
