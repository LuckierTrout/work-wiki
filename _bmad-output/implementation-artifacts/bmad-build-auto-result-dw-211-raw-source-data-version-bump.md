---
status: done
date: 2026-09-01
bundle: c3-raw-source-data-version-bump
dw_ids: DW-211
---

# BMad Build Auto Result

Status: done
Blocking condition: none

## Outcome: already resolved — no code change required

The bundle intent describes a pre-existing state that the codebase has since
moved past. Every element of the intent is implemented and pinned on
`epic8-stories1-9` at HEAD `7f04fefe`. No files were modified by this run.

## Evidence

**1. The bump tail exists on both named writers.**

`saveRawSource` (`src/lib/raw.ts:367`, delegating at :373) and
`saveRawSourceFor` (:444, delegating at :454) both route through
`storeRawSource` (:200), which carries the bump:

- `src/lib/raw.ts:229` — `await bumpDataVersion();` after a real create-only
  write, trailing `publishSourceFirstWrite` and the silo mirror.
- `src/lib/raw.ts:225` — `if (repaired) await bumpDataVersion();` on the
  occupied path, so a fail-then-repair silo mirror still wakes the Files tree
  (the watcher is forward-only) while a no-op re-arrival wakes nobody.

The same shape is mirrored in the binary twin `storeRawSourceBytes` (:253,
bumps at :267 and :271), and `deleteRawSourceBytes` bumps at :718 after a
cascade delete. Five sites total.

**2. The bump is outside any lock and fail-soft.**

The calls sit in `storeRawSource`'s own body, not inside a storage lock
callback. Fail-soft is satisfied at the source rather than by a per-caller
`try`/`catch`: `bumpDataVersion` (`src/lib/data-version.ts:101-108`) catches
internally, emits `logger.warn("data-version", "bump failed; the signal did not
move", …)` and returns `0`. It cannot throw into an arrival path, so the bare
`await` is warn-and-continue by construction. `wikis.ts`'s extra
`bumpRefreshSignal` wrapper exists to give six call sites one shared `catch`,
not because the callee can throw.

**3. The tripwire allowlist already includes `lib/raw.ts`.**

`src/lib/__tests__/workbench-data-version.test.ts:1132-1139` — the "is called
from nowhere else in the app" writer set is now
`data-version.ts`, `graph-insight-dismissals.ts`, `lifecycle.ts`, `raw.ts`,
`review-queue.ts`, `todos.ts`, `wikis.ts`. The reason is recorded in the
comment at :1119-1129 ("since Story 2.1, `lib/raw.ts`, which owns another: a
Source stored under `raw/sources/` is not a page write…").

Because that list is file-granular, a dedicated case at :1288 —
"has exactly one site inside raw.ts, on the path that actually wrote bytes" —
pins the count at five and asserts the placement: the unconditional bump trails
the create-only publication, and the repair bump is conditional and precedes
the `return false;` skip.

**4. Tests are green.**

`npx vitest run src/lib/__tests__/workbench-data-version.test.ts`
→ 61 passed / 61, 1 file passed.

## Ledger note

DW-211's own entry already reads `status: done 2026-08-26`, `archived:
2026-08-29`, consistent with the above. The bundle's `intent.md` narrative
("Neither writer bumps") reflects the state at ledger-entry time, not HEAD.
The orchestrator records resolution; this run edited no ledger.

## Deferred work

None. Nothing in the surrounding code exposes a wrong answer, lost data, or a
broken door that this bundle did not name.
