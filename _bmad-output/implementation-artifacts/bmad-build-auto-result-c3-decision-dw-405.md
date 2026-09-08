---
status: done
---

# BMad Build Auto Result

Status: done
Blocking condition: none — the bundle's intent is already true at HEAD; no source, test, or spec file needed to change.

## Bundle

- Bundle: `c3-decision-dw-405` (run `20260820-220331-0f16`)
- Intent: `.bmad-loop/runs/20260820-220331-0f16/bundles/c3-decision-dw-405/intent.md`
- Ledger entry: DW-405 (human decision: option 1 — "Require a positive labelled match")
- Baseline revision: `793e0a9c287d90c426accd41a2203bb49f67f797`
- Files touched by this session: none (this result file only). The deferred-work ledger was not edited.

## Why no change was made

The bundle asks to gate the drift re-arm on `kept.some((m) => m.metadata.model === currentModel)` so that only
positive proof of a rebuilt vector re-arms, while `modelMatches` stays permissive for RESULTS. That is exactly what
is in the tree.

**The ledger entry is closed.** `_bmad-output/implementation-artifacts/deferred-work.md:2971` carries DW-405 as
`status: done 2026-08-29`, `resolution: resolved by sweep bundle dw-decision-dw-405`, `archived: 2026-08-29` — the
same text the bundle intent quotes verbatim.

**The gate is in the tree,** landed by commit `0349df96eea85b82adc933ac2c0845bb92d9c4ad`
("sweep dw-decision-dw-405: DW-405 via bmad-loop"), on top of `945de9bfb9b40aa863b9a9a4a93a60223648b1db`
(DW-404's whole-window conjunct):

- `src/lib/embeddings.ts:1073` (`searchByVector`) —
  `if (kept.length === matches.length && kept.some((m) => m.metadata.model === currentModel))`
- `src/lib/embeddings.ts:1172` (`relatedByVector`) — the same predicate over `others`/`kept`.

Both conjuncts are load-bearing and the code says so at `:1075-1085` and `:1174-1176`: `kept.length === matches.length`
is vacuously true on an empty window, so the non-empty requirement is carried by DW-405's `some` conjunct rather than
a separate `matches.length > 0`. The `kept.length > 0` trigger DW-405 names no longer appears in the file.

**`modelMatches` was left permissive.** `src/lib/embeddings.ts:892` still returns true for metadata with no `model`
key, so unlabelled legacy vectors keep surviving the filter and are still RETURNED — the narrowing is on the re-arm
gate alone, exactly as the decision framed it.

**The narrowing is recorded in the doc comments** the decision touches: `src/lib/embeddings.ts:66-92` (the
`warnedMisconfigurations` census, which spells out why one kept match was not enough) and `:1029` (the
`searchByVector` JSDoc naming DW-332 → DW-404 → DW-405 in order).

## Verification

```
npx vitest run src/lib/__tests__/embeddings.test.ts

 ✓ src/lib/__tests__/embeddings.test.ts (190 tests)
 Test Files  1 passed (1)
      Tests  190 passed (190)
```

DW-405's decision point is pinned in both directions — the coverage gap DW-601 filed against it is itself closed
(`deferred-work.md:4634`, `status: done 2026-08-29`):

- `src/lib/__tests__/embeddings.test.ts:1291` — "does NOT re-arm on a window carried ENTIRELY by UNLABELLED vectors":
  reproduces the original two-lines-where-one-is-guaranteed bug across five alternating reads, asserts exactly one
  warning, and separately pins that those reads still returned `legacy`, so the permissiveness of `modelMatches` is
  held by the same test that narrows the gate.
- `src/lib/__tests__/embeddings.test.ts:1338` — "DOES re-arm on a window holding an ACTIVE-model vector beside an
  unlabelled one": the other side of the line, and the pin that discriminates the shipped conjunction from
  `matches.every(...)`, which the 2026-08-22 decision rejected.
- `src/lib/__tests__/embeddings.test.ts:1378` — "does NOT re-arm on an EMPTY window": the pin that fails if the `some`
  conjunct is dropped.
- `src/lib/__tests__/embeddings.test.ts:745` — the same proof conjunct held at the `relatedByVector` door.

## Working tree

Unchanged apart from this result file. The only other untracked files are prior build-auto result artifacts from
sibling bundles in this run (`bmad-build-auto-result-c3-decision-dw-398.md`, `-401.md`, `-404.md`), which are
orchestrator-owned harvest.

## Deferred work

None filed. The one hazard observed nearby — `spec-dw-404-405-406-embedding-drift-rearm-gate.md` still sitting at
`status: in-review` while prescribing `matches.every((m) => m.metadata.model === model)`, which contradicts the
2026-08-22 decision this bundle carries — is **already** on the ledger as DW-600 (`deferred-work.md:4624`,
`status: open`, with a recorded 2026-08-29 decision to withdraw the spec). It is not this bundle's scope and needs no
new entry.

## Note for the orchestrator

DW-405 was already `done` and `archived` before this dispatch. Nothing about the re-dispatch changed the tree;
recording it resolved is accurate.
