---
title: 'Pin MaintainFixType to the auto-fixable list (DW-459)'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
baseline_revision: '1b12bf481831db660b6662debdad60f4fe9e9cc7'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `MaintainFixType` (`src/lib/tasks.ts:285-293`) is a bare eight-arm literal union with no reference to `AutoFixableCheckType` (`src/lib/lint-types.ts:78`), the ten-type list `fixLintIssue` actually dispatches. The DW-341/343 change pinned `MAINTAIN_FIX_TYPES` to the union in both directions but left the union itself un-derived, so dropping a member from `AUTO_FIXABLE_CHECK_TYPES` still compiles here and surfaces only at runtime: `parseTask` admits the queued `maintain:fix` task, and `POST /api/tasks/run`'s `fixLintIssue` call (`src/app/api/tasks/run/route.ts:255`) throws `FixValidationError` on a task that is already off the queue.

**Approach:** Add a compile-time subset pin next to the existing omission pin, using the file's own `AssertNever` idiom: `Exclude<MaintainFixType, AutoFixableCheckType>` must be `never`. Import `AutoFixableCheckType` type-only so no runtime dependency is added to the producer module. Add one runtime test that the maintenance vocabulary is dispatchable at the doors' own gate, so deleting the type pin does not silently restore the gap.

## Boundaries & Constraints

**Always:** `src/lib/lint-types.ts` stays the single home of the fixable list — the pin references it, never restates it. The new import into `src/lib/tasks.ts` must be `import type` only; `tasks.ts` is the queue producer and gains no runtime dependency. The existing `_NoMaintainFixTypeMissingFromList` and the `satisfies readonly MaintainFixType[]` on `MAINTAIN_FIX_TYPES` stay exactly as they are — this pin is a third, independent constraint, not a replacement.

**Block If:** The subset relation does not hold at HEAD — i.e. some current `MaintainFixType` arm is absent from `AUTO_FIXABLE_CHECK_TYPES`. That is a live defect, not a typing gap, and deciding which list is wrong is not an unattended call.

**Never:** Do not widen or narrow either list's membership; the eight maintain types and ten fixable types stay as they are. Do not rewrite `MaintainFixType` as `Extract<AutoFixableCheckType, …>` — that narrows silently when a member disappears instead of failing the build, which is the defect. Do not touch `MAINTAIN_FIX_TYPE_SET`, `parseTask`'s `typeof` guard, or `src/lib/lint-fix.ts`'s dispatch tables. Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`. Do not act on this bundle's stale prose intent about the email Worker's decoded byte budget — DW-360 is `done`/archived and the post-decode gate already exists at `workers/email-ingest/index.ts:902`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HEAD as-is | Both lists unchanged | `pnpm exec tsc --noEmit` clean | No error expected |
| Fixable member dropped | `"stale-page"` removed from `AUTO_FIXABLE_CHECK_TYPES` | `tsc` fails at the new pin naming `'"stale-page"' ... constraint 'never'` | Compile error, not a runtime `FixValidationError` |
| Maintain arm added that is not fixable | Ninth arm `"disputed-page"` added to `MaintainFixType` | `tsc` fails at the new pin | Compile error |
| Maintain arm added that IS fixable | Ninth arm `"contradiction"` added to `MaintainFixType` | New pin passes; `_NoMaintainFixTypeMissingFromList` fails until `MAINTAIN_FIX_TYPES` lists it | Compile error from the existing omission pin |
| Maintenance vocabulary at the door gate | Each `MAINTAIN_FIX_TYPES` member through `autoFixRefusal(type, "some-page")` | `null` for every member — none is refused | No error expected |

</intent-contract>

## Code Map

- `src/lib/tasks.ts:280-282` -- `AssertNever<T extends never>` plus `_NoTaskKindMissingFromList`. The idiom to mirror; reuse this alias, do not declare a second one.
- `src/lib/tasks.ts:284-293` -- `MaintainFixType`, the un-derived union. Edit site: its JSDoc gains the subset rationale.
- `src/lib/tasks.ts:315-328` -- `MAINTAIN_FIX_TYPES` tuple with `satisfies readonly MaintainFixType[]`, then `_NoMaintainFixTypeMissingFromList`. The new pin goes immediately after :328, so the three constraints read together.
- `src/lib/tasks.ts:16-19` -- import block. Add `import type { AutoFixableCheckType } from "./lint-types";` beside the existing `import type` lines.
- `src/lib/lint-types.ts:64-78` -- `AUTO_FIXABLE_CHECK_TYPES` (ten members) and `AutoFixableCheckType`. Read-only. Its header states every import is type-only and it emits no runtime dependency, which is why `tasks.ts` may reference it.
- `src/lib/tasks.ts:334` -- `MAINTAIN_FIX_TYPE_SET`, derived from the tuple. Read-only.
- `src/lib/tasks.ts:583-586` -- `parseTask`'s `maintain:fix` branch, the membership gate whose pass leads to the route call. Read-only.
- `src/app/api/tasks/run/route.ts:245-257` -- the `maintain:fix` branch calling `fixLintIssue(task.lintType, …)`; where the drift surfaces today as `FixValidationError`. Read-only.
- `src/lib/lint-fix.ts:915` -- `export function autoFixRefusal(type: unknown, slug: string): string | null` — the doors' gate; `null` means dispatchable. The runtime pin's subject.
- `src/lib/__tests__/lint-fix.test.ts:1-100` -- already mocks `../wiki`, `../lifecycle`, `../llm`, `../frontmatter` and imports `AUTO_FIXABLE_CHECK_TYPES`. Home for the new runtime pin. `autoFixRefusal` is not yet imported there; add it.
- Import-safety evidence: `src/lib/__tests__/prose-inventory-parity.test.ts:5` imports `MAINTAIN_FIX_TYPES` from `../tasks` with no `@opennextjs/cloudflare` mock. `tasks.ts:16` does carry a VALUE import of `getCloudflareContext` from `@opennextjs/cloudflare` (its other runtime imports, `./logger` and `./source-delete`, import nothing) — the import is safe anyway because `getCloudflareContext` is only ever called inside `getTaskQueue`'s try/catch, never at module scope, so importing `../tasks` runs no Workers-context code. So `lint-fix.test.ts` may import `../tasks` directly.

## Tasks & Acceptance

**Execution:**
- `src/lib/tasks.ts` -- add `import type { AutoFixableCheckType } from "./lint-types";`, then after `_NoMaintainFixTypeMissingFromList` add `type _MaintainFixTypesAreAutoFixable = AssertNever<Exclude<MaintainFixType, AutoFixableCheckType>>;` with a JSDoc naming the runtime harm it replaces (a poison `maintain:fix` task reaching `fixLintIssue` and throwing `FixValidationError` at `src/app/api/tasks/run/route.ts:255`) and stating why the union is not rewritten as `Extract<…>`. Amend the `MaintainFixType` JSDoc so a reader learns the union is the maintenance-eligible SUBSET of `AutoFixableCheckType`, not an independent list -- the union currently claims no relation at all.
- `src/lib/__tests__/lint-fix.test.ts` -- add `autoFixRefusal` to the `../lint-fix` import, import `MAINTAIN_FIX_TYPES` from `../tasks`, and add a `describe` asserting `autoFixRefusal(type, "some-page")` is `null` for every `MAINTAIN_FIX_TYPES` member, iterated from the tuple rather than any literal restated in the test. Comment why it exists alongside the compile-time pin: it guards the guard, so deleting the type alias fails a test rather than silently restoring the gap.

**Acceptance Criteria:**
- Given the repository at HEAD with the pin added, when `pnpm exec tsc --noEmit` runs, then it exits clean.
- Given `"stale-page"` is removed from `AUTO_FIXABLE_CHECK_TYPES`, when `tsc --noEmit` runs, then it reports an error at the new pin in `src/lib/tasks.ts` naming `"stale-page"` and the `never` constraint, and the file is restored afterwards.
- Given the pin is present, when the lint-fix suite runs, then every `MAINTAIN_FIX_TYPES` member is reported dispatchable (`autoFixRefusal` returns `null`) and the count of assertions equals `MAINTAIN_FIX_TYPES.length`.
- Given the pin is present, when `src/lib/tasks.ts` is inspected, then the only new import is `import type`, so the producer module's emitted runtime dependencies are unchanged.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 0
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` The new describe's JSDoc claimed deleting `_MaintainFixTypesAreAutoFixable` would fail a test; it would not — the alias is referenced by no runtime code, so `tsc` and all 82 tests stayed green when it was deleted. Made the claim true rather than weakening it: added a source read-back of `src/lib/tasks.ts` (following `prose-inventory-parity.test.ts`) asserting the declaration is still `AssertNever<Exclude<MaintainFixType, AutoFixableCheckType>>`. Proved by deletion: `tsc` clean, 1 failed / 82 passed naming that test.
  - `[low]` `[patch]` `it("has some — the list is not accidentally empty")` guarded nothing reachable (emptying the tuple already fails the compile-time omission pin). Replaced with a complement assertion: `AUTO_FIXABLE_CHECK_TYPES` minus `MAINTAIN_FIX_TYPES` is exactly `contradiction` and `missing-concept-page` — verified to be the only two handlers reaching `callLLM`/`hasLLMKey` — plus the arity reconciliation. One assertion now proves the arity, catches a silently dropped member, and pins the deterministic/no-LLM property the subset exists for.
  - `[low]` `[patch]` Test JSDoc called `autoFixRefusal` the gate `fixLintIssue` and the routes share; `fixLintIssue` reaches it only on its throw path (`src/lib/lint-fix.ts:946`) and the doors that gate on it are `POST /api/lint/fix` and `src/lib/mcp-http.ts`. Corrected.
  - `[low]` `[patch]` Test JSDoc oversold the per-type `toBeNull()` assertions as independent coverage. It now states the load-bearing fact (both paths resolve through `FIX_HANDLERS`, `Record<AutoFixableCheckType, FixHandler>` at `src/lib/lint-fix.ts:791`) and says plainly that those assertions cannot fail while `tsc` is green — the independent value is the read-back and the complement pin.
  - `[low]` `[patch]` `MAINTAIN_FIX_TYPES`'s JSDoc still opened "The two assertions here…" after a third constraint landed 35 lines below. Now opens "Three constraints hold this pair" with a pointer to what the third supplies; the two existing bullets are unchanged.
  - `[low]` `[patch]` The subset argument, the poison-task harm and the `Extract<…>` rejection were each stated in full in both `MaintainFixType`'s JSDoc and the pin's. The pin's JSDoc now owns the argument; the union's is cut to the one fact plus a pointer. Separately, the Code Map's import-safety bullet was factually wrong ("`tasks.ts`'s only runtime imports are `./logger` and `./source-delete`" — it also value-imports `getCloudflareContext`); corrected to the real reason, that `getCloudflareContext` is called only inside `getTaskQueue`'s try/catch.

## Design Notes

The pin, in the file's own idiom (`AssertNever` already exists at :280):

```ts
type _MaintainFixTypesAreAutoFixable = AssertNever<
  Exclude<MaintainFixType, AutoFixableCheckType>
>;
```

Three constraints now hold the pair, each catching a different drift: `satisfies` (no extras in the tuple), `_NoMaintainFixTypeMissingFromList` (no omissions from the tuple), and this one (no arm outside the fixable list). `Extract<AutoFixableCheckType, …>` was rejected as the union's definition because a member vanishing from the fixable list would narrow the union silently — the tuple's `satisfies` would then fail, but at the wrong site and with the wrong message.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm exec vitest run src/lib/__tests__/lint-fix.test.ts src/lib/__tests__/tasks.test.ts src/lib/__tests__/prose-inventory-parity.test.ts` -- expected: all pass, including the new dispatchability pin.
- `pnpm exec eslint src/lib/tasks.ts src/lib/__tests__/lint-fix.test.ts` -- expected: clean.

**Manual checks (if no CLI):**
- Perturbation proof for the compile-time rows: remove `"stale-page"` from `AUTO_FIXABLE_CHECK_TYPES`, run `tsc --noEmit`, confirm the error lands at `_MaintainFixTypesAreAutoFixable`; restore and reconfirm clean. Repeat by adding a `"disputed-page"` arm to `MaintainFixType`; restore and reconfirm clean.

## Auto Run Result

Status: done

**Implemented change.** `MaintainFixType` (`src/lib/tasks.ts`) is now pinned at compile time to `AutoFixableCheckType`, the list `fixLintIssue` actually dispatches (DW-459). A third `AssertNever` constraint, `_MaintainFixTypesAreAutoFixable`, joins the two that already held the union and `MAINTAIN_FIX_TYPES` to each other; the import is `import type`, so the queue producer gains no runtime dependency. A member leaving `AUTO_FIXABLE_CHECK_TYPES` is now a build failure instead of a poison `maintain:fix` task that `parseTask` admits and `src/app/api/tasks/run/route.ts:255` then kills with `FixValidationError`.

**Bundle note — the prose intent was stale and was not acted on.** `.bmad-loop/runs/20260820-220331-0f16/bundles/c3-email-worker-decoded-byte-budget/intent.md` carries two unrelated descriptions: a prose `## Intent` about the email Worker's decoded byte budget, and `dw_ids: DW-459` with the verbatim ledger entry for `MaintainFixType`. The ledger entry is authoritative and matches `deferred-work.md:3401` exactly. The prose work is already in the tree: the post-decode aggregate gate exists at `workers/email-ingest/index.ts:902`, DW-360 reads `status: done 2026-08-26 / archived: 2026-08-29`, and the README records it. Its cross-references are also wrong — DW-456 is `POST /api/lint/fix` author attribution, not the same exposure; the live cousin of the byte-budget copy problem is DW-697, which the bundle never names. No `workers/` file was touched.

**Files changed.**
- `src/lib/tasks.ts` — `import type { AutoFixableCheckType }`; the `_MaintainFixTypesAreAutoFixable` pin with its rationale; `MaintainFixType`'s and `MAINTAIN_FIX_TYPES`' JSDoc updated for the third constraint.
- `src/lib/__tests__/lint-fix.test.ts` — new `maintenance fix vocabulary` describe: a source read-back that fails if the pin is deleted, a complement pin (`contradiction`, `missing-concept-page` — the two LLM-backed fixable types), and per-type dispatchability through `autoFixRefusal`.
- `_bmad-output/implementation-artifacts/spec-dw-459-maintain-fix-type-derivation.md` — this spec.

**Review findings.** 6 patches applied (1 medium, 5 low), 0 items deferred, 8 rejected, 0 intent gaps, 0 spec defects. Follow-up review recommended: **true** — patched severities 0 high / 1 medium / 5 low, scoring `3x1 + 1x5 = 8`, at or above the threshold of 5.

**Verification.** All three spec commands re-run after the patches: `pnpm exec tsc --noEmit` clean; `pnpm exec vitest run src/lib/__tests__/{lint-fix,tasks,prose-inventory-parity}.test.ts` 133/133 passing (lint-fix 73 -> 83); `pnpm exec eslint src/lib/tasks.ts src/lib/__tests__/lint-fix.test.ts` clean.

Matrix Test Audit — all five rows proved, the four compile-time rows by direct perturbation with the file restored and `tsc` reconfirmed clean after each:
- HEAD as-is: `tsc` clean.
- `"stale-page"` removed from `AUTO_FIXABLE_CHECK_TYPES`: `src/lib/tasks.ts(363,3): error TS2344: Type '"stale-page"' does not satisfy the constraint 'never'.` Note for readers of the AC: that perturbation raises six errors across `LintIssueCard.tsx` and `lint-fix.ts` as well, and the pin's is the last of them — the pin is a guarantee, not the first line a developer sees.
- `"disputed-page"` added to `MaintainFixType`: errors at both `tasks.ts:339` (existing omission pin) and `tasks.ts:364` (new pin).
- `"contradiction"` added to `MaintainFixType`: only `tasks.ts:339` fires; the new pin passes, exactly as the row predicts.
- Door-gate row: 8 `autoFixRefusal` assertions ran and passed.

Separately, the read-back was proved by deleting `_MaintainFixTypesAreAutoFixable`: `tsc` stayed clean (exit 0) while `lint-fix.test.ts` went 1 failed / 82 passed on `still declares the compile-time subset pin in src/lib/tasks.ts`. Restored and reconfirmed green.

**Residual risks.**
- The per-type `toBeNull()` assertions cannot fail while `tsc` is green — `FIX_HANDLERS` is `Record<AutoFixableCheckType, FixHandler>`, so exhaustiveness is compiler-guaranteed. This is now stated in the test's JSDoc rather than left implied; the independent guards are the read-back and the complement pin.
- The read-back matches source text, so it is insensitive to reformatting inside the declaration (`\s*` between tokens) but fails on a rename or a changed `Exclude<...>` shape. That is the intended sensitivity.
- Concurrency: partway through this run another session began editing `src/lib/storage/*`, `src/lib/embeddings.ts`, `src/lib/backups.ts`, `src/lib/portable-archive.ts` and their tests in this same working copy. Those files were absent from the reviewed diff, were never touched here, and were left uncommitted. `tsc` and `eslint` therefore ran against a tree containing them; both were clean, and the three suites above exercise only this change's surface.
