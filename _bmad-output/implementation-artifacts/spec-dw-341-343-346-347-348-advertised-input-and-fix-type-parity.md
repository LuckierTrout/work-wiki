---
title: 'Advertised-input and fix-type parity (DW-341, DW-343, DW-346, DW-347, DW-348)'
type: 'bugfix'
created: '2026-08-27'
status: 'done'
baseline_revision: '39bbbe82a40d38ac2eb3c1c0284e933f053da8d5'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `fix_lint_issue` on the HTTP MCP transport gates `type` but still forwards
      `slug`, `target` and `message` to the handler with no check, so the two
      lint-fix doors now enforce different contracts for the same tool.
    evidence: |-
      `src/lib/mcp-http.ts`'s `run` calls `autoFixRefusal` on `type`, then does
      `...(a as { type: string; slug: string; target?: string; message?: string })`.
      `dispatchMcp` does not validate `tools/call` arguments, so a non-string
      `slug` reaches `handleFixLintIssue` and surfaces as a 404 naming
      `[object Object]`. The REST door type-checks all four fields via
      `LINT_FIX_REQUEST`. Pre-existing (the cast predates this change) and
      outside DW-348, whose title scopes the defect to `type`.
    location: >-
      src/lib/mcp-http.ts:525
    severity: medium
  - summary: >-
      `POST /api/lint/fix` never passes the owner's handle as `author`, so every
      REST lint fix is attributed to the default `"lint-fix"` while both MCP
      doors pass the real principal.
    evidence: |-
      The route resolves `principal` for its owner gate, then calls
      `fixLintIssue(type, slug ?? "", targetSlug, message)` with no fifth
      argument; `fixLintIssue`'s `author` parameter defaults to `"lint-fix"`.
      `src/lib/mcp-http.ts` and `src/mcp.ts` both pass `p!.handle`. Pre-existing
      — the pre-change line omitted it too — but the line was rewritten by this
      change and the principal is in scope three statements above.
    location: >-
      src/app/api/lint/fix/route.ts:156
    severity: medium
  - summary: >-
      `missing-concept-page` is effectively unreachable over both MCP
      transports: `slug` is required in both schemas though the type reads
      `message` alone.
    evidence: |-
      The route JSDoc this change wrote states the type "Reads `message` ALONE
      — no `slug`, no `targetSlug`", and `LINT_FIX_REQUEST` makes `slug`
      optional for exactly that reason. But `src/mcp.ts` declares
      `slug: z.string()` (required) and `src/lib/mcp-http.ts` lists
      `["type", "slug"]` as required, so an agent must invent a dummy slug. No
      test on either transport exercises this type. Pre-existing; surfaced by
      the JSDoc making the asymmetry explicit.
    location: >-
      src/mcp.ts:2501
    severity: medium
  - summary: >-
      `autoFixRefusal(type, "")` renders `PATCH /api/wiki/` with an empty slug
      segment, contradicting the copy-pasteability rationale the change states
      for gating at the doors.
    evidence: |-
      Both doors deliberately pass `""` when no usable slug arrived. For
      `disputed-page` the `NOT_AUTO_FIXABLE` sentence then reads
      `Reconcile the conflicting claims in "", then clear the Disputed toggle
      in the page editor (PATCH /api/wiki/ with metadata { disputed: false })`
      — a path that 404s if pasted. `src/mcp.ts`'s own comment argues the
      sentence must name the sibling slug to be worth keeping. No test sends a
      slug-less non-fixable type to either door.
    location: >-
      src/lib/lint-fix.ts:830
    severity: low
  - summary: >-
      `MaintainFixType` has no compile-time constraint to `AutoFixableCheckType`,
      so it remains an un-derived restatement of a subset of the fixable list.
    evidence: |-
      This change pins `MAINTAIN_FIX_TYPES` to `MaintainFixType` in both
      directions, but the union itself (`src/lib/tasks.ts:285-292`) is a bare
      literal union with no reference to `AutoFixableCheckType`. A member
      dropped from `AUTO_FIXABLE_CHECK_TYPES` would still compile here and
      surface only as a runtime `FixValidationError` on the maintenance path
      (`src/app/api/tasks/run/route.ts:255`). The bundle intent named the
      restatements of the fixable list, not the subset relation between the two
      lists.
    location: >-
      src/lib/tasks.ts:285
    severity: low
---

<intent-contract>

## Intent

**Problem:** Five deferred entries share one shape — a list the code owns is restated by hand, or advertised at a door that never validates against it. `MAINTAIN_FIX_TYPES` is a `Set` that rejects extras but is silent about an omitted member (an omitted fix type makes `parseTask` return `null`, so the task DLQs with `tsc` happy); the same eight names are re-typed in `src/lib/maintenance.ts`'s header and `workers/task-consumer/README.md` with no pin; `POST /api/lint/fix`'s JSDoc names five of the ten auto-fixable types; that route destructures `type` off a raw `await req.json()` though `AUTO_FIXABLE_CHECK_TYPES` exists to validate against; and bulk import's `accept` advertises 21 MIME types its `validationError` never consults, so an extension-less `application/pdf` the picker admits is refused client-side though `/api/ingest/document` accepts it.

**Approach:** These fixes already shipped and were reverted wholesale by commit `f2458e18` ("sweep dw3-embedding-readiness-truthfulness"), which deleted 16,429 lines across 151 files. RECOVER them from the two commits that authored them rather than re-implementing: `04bf3f06` (DW-341/343/346) and `f214130f` (DW-347/348). A saved, conflict-resolved patch of exactly the in-scope files is at `/private/tmp/claude-501/-Users-christianlee-App-Development-work-wiki/0387ba64-2397-4bea-9d99-e6c8c6b57471/scratchpad/recovery-full.patch`.

## Boundaries & Constraints

**Always:** Recover verbatim from the named commits — the prose in those diffs is the deliverable, not incidental. Restore only the files listed in the Code Map. `pnpm exec tsc --noEmit` must stay clean.

**Block If:** A recovery hunk fails to apply and the conflicting HEAD content is a deliberate later change whose intent contradicts the recovered code.

**Never:** Do not restore `src/lib/__tests__/brand-copy.test.ts` or the `AGENTS.md` hunk from `04bf3f06` — both are DW-352, which is a separate open ledger entry and not in this bundle. Do not restore the `hasLLMKey` import from `f214130f`'s `mcp.test.ts` hunk — that belongs to DW-395, also reverted and also out of scope. Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`. Do not revert `f2458e18` wholesale.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fixable lint type at the HTTP door | `POST /api/lint/fix` `{type:"orphan-page",slug:"some-page"}` | Reaches `fixLintIssue`; absent page answers 404 | No error expected |
| Non-fixable but recognized type | `{type:"disputed-page",slug:"contested-page"}` | 400 carrying `PATCH /api/wiki/contested-page with metadata { disputed: false }`, dispatcher never called | 400 from `autoFixRefusal` at the door |
| Unrecognized / non-string / prototype-chain type | `{type:"made-up-type"}`, `{type:["orphan-page"]}`, `{type:"constructor"}` | 400 `Auto-fix not supported for this issue type`, dispatcher never called | 400 |
| Body that is not a JSON object | `null`, `"hi"`, `7`, `{not json` | 400 containing `Invalid request body` | 400, not 500 |
| Fixable type, bad sibling field | `{type:"orphan-page",slug:7}` | 400 naming the field `slug` | 400 |
| Slug-less `missing-concept-page` | `{type:"missing-concept-page",message:"…"}` | Reaches dispatcher with `slug:""` | Handler's own 400 |
| Extension-less file with a supported MIME type | `File{name:"report", type:"application/pdf"}` | Accepted by bulk import; badged `pdf` | No error expected |
| Omitted `MaintainFixType` member | A ninth union arm not added to `MAINTAIN_FIX_TYPES` | `tsc` fails at `_NoMaintainFixTypeMissingFromList` | Compile error, not a silent DLQ |

</intent-contract>

## Code Map

Recovery sources (read the diffs, they carry the intended prose verbatim):
- `git show 04bf3f06` — DW-341/343/346. In scope: `src/lib/tasks.ts`, `src/app/api/lint/fix/route.ts`, `src/lib/__tests__/prose-inventory-parity.test.ts`. OUT of scope in that commit: `AGENTS.md`, `src/lib/__tests__/brand-copy.test.ts` (DW-352).
- `git show f214130f` — DW-347/348. All source + test files in scope except the `hasLLMKey` import in `mcp.test.ts` (DW-395).
- `/private/tmp/claude-501/-Users-christianlee-App-Development-work-wiki/0387ba64-2397-4bea-9d99-e6c8c6b57471/scratchpad/recovery-full.patch` — the two diffs already merged onto HEAD with the one conflict resolved; verified `tsc`-clean and green.

Files to change (all currently at their pre-fix state; verified by diffing HEAD against `f214130f`):
- `src/lib/tasks.ts:284-304` — `MaintainFixType` union + `const MAINTAIN_FIX_TYPES = new Set<…>` at :295. Becomes an exported `as const satisfies readonly MaintainFixType[]` tuple plus `_NoMaintainFixTypeMissingFromList` (the omission pin, mirroring `TASK_KINDS`/`AssertNever` at :281) and a derived `MAINTAIN_FIX_TYPE_SET`. `parseTask` at :552 gains a `typeof t.lintType !== "string"` guard.
- `src/app/api/lint/fix/route.ts:14-31` — the five-type JSDoc becomes the full ten with per-type argument notes; :55-56 `const { type, slug, … } = await req.json()` becomes a `LINT_FIX_REQUEST` zod schema over `AUTO_FIXABLE_CHECK_TYPES` with a `fieldMessage` helper and an `autoFixRefusal` fallback.
- `src/lib/lint-fix.ts:860-890` — extract `autoFixRefusal(type, slug)` (+ `AUTO_FIX_UNSUPPORTED`) as the single owner of the refusal sentences; `fixLintIssue` calls it.
- `src/lib/mcp-http.ts:486-505` — `fix_lint_issue` gains an advertised `enum` on `type` and an enforcing `autoFixRefusal` call in `run` (this transport does not validate `tools/call` arguments).
- `src/mcp.ts:2467-2481` — `z.enum(ALL_CHECK_TYPES)` → `z.enum(AUTO_FIXABLE_CHECK_TYPES)`, plus the description change.
- `src/lib/bulk-document-import.ts:70-104` — `documentExtension` gains an optional `contentType` and falls back to `detectDocumentFormat`; `validationError` switches from `documentExtension(file.name) === "file"` to `isSupportedDocument(file.name, file.type)`, the server's own question.
- `src/components/BulkDocumentImport.tsx:506` — pass `item.file.type` to `documentExtension`.
- `src/lib/__tests__/prose-inventory-parity.test.ts` — two new `MaintainFixType` read-back pins (`src/lib/maintenance.ts` header, `workers/task-consumer/README.md`), one for the route's `Supported issue types:` block, plus a `backtickedLiterals` helper and its own guard test.
- Tests recovered alongside: `src/lib/__tests__/lint-fix-route.test.ts`, `lint-checks.test.ts`, `mcp-http.test.ts`, `mcp.test.ts`, `bulk-document-import.test.ts`, `src/components/__tests__/bulk-document-accept-parity.test.tsx`.

Read-only evidence (already correct at HEAD, do NOT edit — the new pins read them back):
- `src/lib/maintenance.ts:11-14` — the `fix` bullet, `… lint fix (`lintType`) — `orphan-page`, …: the whole `MaintainFixType` union`.
- `workers/task-consumer/README.md:48-50` — the same eight names, period-terminated.
- `src/lib/lint-types.ts:63-77` — `AUTO_FIXABLE_CHECK_TYPES` (ten members) and `AutoFixableCheckType`; already present at HEAD.
- `src/lib/document-formats.ts:142,164,178` — `extension`, `detectDocumentFormat`, `isSupportedDocument`; already present.

## Tasks & Acceptance

**Execution:**
- `/private/tmp/claude-501/-Users-christianlee-App-Development-work-wiki/0387ba64-2397-4bea-9d99-e6c8c6b57471/scratchpad/recovery-full.patch` -- apply with `git apply -3` -- it is the two recovery diffs already merged onto this HEAD with the `mcp.test.ts` import conflict resolved; if it does not apply cleanly, fall back to applying `git diff 04bf3f06^ 04bf3f06 -- <in-scope files>` then `git diff f214130f^ f214130f -- <in-scope files>` with `-3` and resolve.
- `src/lib/__tests__/mcp.test.ts` -- confirm only `AUTO_FIXABLE_CHECK_TYPES` was added to the import block -- the `hasLLMKey` import in the source hunk belongs to DW-395 and would not compile here.
- `git status` -- confirm no changes landed in `AGENTS.md`, `src/lib/__tests__/brand-copy.test.ts`, or `deferred-work.md` -- those are DW-352 and orchestrator-owned respectively.

**Acceptance Criteria:**
- Given the union `MaintainFixType` gains an arm absent from `MAINTAIN_FIX_TYPES`, when `pnpm exec tsc --noEmit` runs, then it fails at `_NoMaintainFixTypeMissingFromList` rather than compiling into a silent DLQ.
- Given `src/lib/maintenance.ts`'s header or `workers/task-consumer/README.md` drifts from `MAINTAIN_FIX_TYPES`, when `prose-inventory-parity.test.ts` runs, then it names the offending file.
- Given the route JSDoc's `Supported issue types:` block disagrees with `AUTO_FIXABLE_CHECK_TYPES`, when that suite runs, then it fails — the block currently names five of ten.
- Given a `type` outside `AUTO_FIXABLE_CHECK_TYPES` posted to `/api/lint/fix`, when the route runs, then it answers 400 and `fixLintIssue` is never called.
- Given a stdio MCP client calls `fix_lint_issue` with `disputed-page`, when the SDK validates, then the call is refused at the transport and `listTools` advertises the ten fixable types.
- Given a `File` with no extension and `type: "application/pdf"`, when bulk import validates it, then it is accepted — matching what `/api/ingest/document` would do.

## Design Notes

Why recover rather than re-implement: `f2458e18` was a sweep commit that reverted shipped work as collateral. The two authoring commits contain not just the code but the reasoning prose these entries were filed to produce (the `NOT_AUTO_FIXABLE` sentence-ownership argument, the accepted cost of refusing at the stdio schema, the `contentType`-optional rationale). Re-writing would lose it.

The one conflict, and its resolution: `f214130f`'s `mcp.test.ts` hunk adds two imports in one block — `AUTO_FIXABLE_CHECK_TYPES` (this bundle) and `hasLLMKey` (DW-395, also reverted by `f2458e18`, not in this bundle). HEAD has neither. Take only the first.

`src/lib/maintenance.ts` and `workers/task-consumer/README.md` are deliberately NOT edited: their prose is already correct and already matches the union. What DW-341/343 asked for is the pin that keeps it that way, which lives in the test.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: no output (this is also the enforcement half of the DW-343 omission pin).
- `pnpm exec vitest run src/lib/__tests__/prose-inventory-parity.test.ts src/lib/__tests__/lint-fix-route.test.ts src/lib/__tests__/bulk-document-import.test.ts src/components/__tests__/bulk-document-accept-parity.test.tsx src/lib/__tests__/lint-checks.test.ts` -- expected: all pass (154 tests at time of planning).
- `pnpm exec vitest run src/lib/__tests__/mcp.test.ts src/lib/__tests__/mcp-http.test.ts src/lib/__tests__/tasks.test.ts src/lib/__tests__/lint-fix.test.ts` -- expected: all pass (450 tests at time of planning).
- `pnpm exec eslint src/lib/tasks.ts src/lib/lint-fix.ts src/lib/mcp-http.ts src/mcp.ts src/lib/bulk-document-import.ts src/app/api/lint/fix/route.ts src/components/BulkDocumentImport.tsx` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** Recovered the five bundled deferred-work fixes from the two commits that authored them, rather than re-implementing. Commit `f2458e18` had reverted them as collateral (16,429 lines across 151 files). Provenance was verified: the recovered hunks are byte-identical to `04bf3f06` (DW-341/343/346) and `f214130f` (DW-347/348), with DW-352's carriers (`AGENTS.md`, `brand-copy.test.ts`) and DW-395's `hasLLMKey` import deliberately excluded as out-of-bundle. Review then corrected six factual/coverage defects in the recovered material.

**Files changed (15).**
- `src/lib/tasks.ts` — `MAINTAIN_FIX_TYPES` becomes an exported `as const satisfies` tuple with an `AssertNever` omission pin; `parseTask` gains a `typeof` guard (DW-343).
- `src/app/api/lint/fix/route.ts` — JSDoc goes from five to all ten fixable types; the raw `req.json()` destructure becomes a zod schema over `AUTO_FIXABLE_CHECK_TYPES` (DW-346, DW-348).
- `src/lib/lint-fix.ts` — `autoFixRefusal` extracted as the single owner of the refusal sentences.
- `src/lib/mcp-http.ts` — `fix_lint_issue` advertises and enforces the fixable set; `target` description corrected.
- `src/mcp.ts` — `z.enum(ALL_CHECK_TYPES)` → `z.enum(AUTO_FIXABLE_CHECK_TYPES)`; two comment corrections.
- `src/lib/bulk-document-import.ts`, `src/components/BulkDocumentImport.tsx` — the client gate asks the server's question, `isSupportedDocument(name, type)` (DW-347).
- `src/lib/document-formats.ts` — stale "six prose inventories" claim corrected to nine.
- Tests: `prose-inventory-parity.test.ts` (three new read-back pins, DW-341/346), `lint-fix-route.test.ts`, `lint-checks.test.ts` (new `checkDuplicateEntities` suggestion pin), `mcp-http.test.ts`, `mcp.test.ts`, `bulk-document-import.test.ts`, `bulk-document-accept-parity.test.tsx`.

**Review findings.** 6 patches applied (2 medium, 4 low), 5 items deferred (3 medium, 2 low), 8 rejected, 0 intent gaps, 0 spec defects. Follow-up review recommended: **true** — patched severities were 0 high / 2 medium / 4 low, scoring `3×2 + 1×4 = 10`, at or above the threshold of 5.

**Verification.** All four spec commands re-run after the patches: `pnpm exec tsc --noEmit` clean; suite one 155/155 passing; suite two 450/450 passing; `eslint` clean across the eight touched source files. The Matrix Test Audit was satisfied for all eight rows — the seven runtime rows by named tests in `lint-fix-route.test.ts` and `bulk-document-import.test.ts`, and the compile-time omission row by direct perturbation: adding a ninth `MaintainFixType` arm produced `src/lib/tasks.ts(328,3): error TS2344: Type '"ninth-fix-type"' does not satisfy the constraint 'never'` at `_NoMaintainFixTypeMissingFromList`, then the file was restored and `tsc` reconfirmed clean. The three new prose pins were each proved by perturbing one literal in `maintenance.ts`, `workers/task-consumer/README.md`, and the route JSDoc; each test failed naming its own file, and all perturbations were reverted.

**Residual risks.**
- This is a *scoped* recovery. `f2458e18` also reverted work belonging to entries outside this bundle — DW-379's `isPageUnreadableError` → 503 branch in the lint-fix route is the clearest example, and DW-352 and DW-395 were excluded by design. Those remain unrecovered and presumably still open in the ledger; a future bundle for them will need the same commit-recovery approach.
- The three prose pins couple the machine list to prose *shape* via hand-written regex anchors. A reworded sentence fails loudly rather than silently (each anchor carries a "parsed to no entries" guard), but the anchors are themselves a fourth hand-maintained artifact.
- DW-343's failure surface is runtime (a forgotten fix type DLQs on the task-consumer worker); the omission pin is compile-time only, so the guarantee rests on CI running `tsc --noEmit`.
