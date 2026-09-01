---
title: 'Fresh+strict create-conflict and merge-base reads on the CLI write doors'
type: 'bugfix'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['ledger-id-mismatch', 'oversized']
deferred:
  - summary: >-
      A concurrently in-review spec lists `src/cli.ts:366` — this bundle's
      create-conflict guard — in its Never clause as a "pure display read",
      so a later sweep acting on that clause could revert the guard.
    evidence: |-
      `_bmad-output/implementation-artifacts/spec-dw-495-496-497-merge-base-strict-reads.md`
      (`status: in-review`, another session's in-flight bundle) groups
      `src/cli.ts:366` with `src/cli.ts:279` and `:327` under "Do not convert
      reads that do not authorize a write and do not serve an existence answer
      -- the pure display reads ... stay exactly as they are." `:366` is
      neither: it is `runCreate`'s conflict guard, whose `null` is the sole
      authorization for the create below, and DW-496's own `reason`
      (`deferred-work.md:3717`) names the create-conflict guards as the mirror
      case in scope. That same spec also plans to convert `src/cli.ts:431` --
      the SAME site this bundle converted -- and prescribes the opposite
      handling there ("A rethrow reaches `main().catch` ... correct already, no
      repair needed"), where this bundle's intent explicitly requires a
      distinct "could not read" exit message. If the stale Never clause is
      later acted on, the create guard reverts to a cached-negative read and a
      create can land over a stored Page -- the exact harm this bundle closed.
      Not caused by this change; surfaced by reviewing against it.
    location: >-
      _bmad-output/implementation-artifacts/spec-dw-495-496-497-merge-base-strict-reads.md:37
    severity: low
baseline_revision: '8c75f2d5ac1f797ce4fb1831fd6edf5e6184a40e'
---

<intent-contract>

## Intent

**Problem:** `runCreate` (`src/cli.ts:366`) and `runUpdate` (`src/cli.ts:431`) read the page with no options. `pageCache` is module-global and ref-counted around bulk scans, so a scan holding a stale NEGATIVE entry open makes `runCreate`'s guard rule a stored slug free; and without `strict` a non-ENOENT storage failure flattens to `null`, so a blip is reported as `already exists`-free (create proceeds) or `not found` (update refuses a page that is only unreadable). `runUpdate`'s bytes are also the merge base — `expectedContent: existing.content` at `:468`.

**Approach:** Pass the established `{ fresh: true, strict: true }` literal at both reads, with the FRESH/STRICT comment shape the already-converted twins carry, and wrap each read in a local `try`/`catch` that prints a distinct `could not read page` line and exits 1 — so a blip never falls into the `already exists` / `not found` sentences below. Two of the intent's four sites (`src/app/api/wiki/route.ts:114`, `src/mcp.ts:258`) are already converted; verify and leave them.

## Boundaries & Constraints

**Always:**
- Spell the literal exactly as the twins do — `{ fresh: true, strict: true }` as the second argument. Let Prettier decide wrapping.
- The new refusal must name the slug AND the storage message, and must contain neither `already exists` nor `not found`. Exit code stays 1, via `process.exit(1)` followed by `return;` — the existing shape in both functions.
- Keep the existing `already exists` / `not found` branches and their exact wording untouched: an absent page and an invalid slug still answer `null` under `strict`.
- Extract the message inline (`err instanceof Error ? err.message : String(err)`), the pattern `src/cli.ts`'s own top-level `main().catch` already uses. Do not add a static import to `src/cli.ts`.
- Every new test must fail against the unconverted read. `fresh` and `strict` are independently droppable, so each site needs BOTH a blip row and a stale-cache row.
- Real-filesystem rows go in `src/lib/__tests__/cli-lifecycle.test.ts`; they must spy `process.exit` to throw, or an exit path takes the vitest worker down.

**Block If:**
- `readWikiPage` / `readWikiPageWithFrontmatter` do not accept `{ fresh, strict }` as written, or `strict` does not rethrow a non-ENOENT `readFile` failure.

**Never:**
- Do not add a 503 branch to `POST /api/wiki`. The intent's premise is false: `grep -rn "503" src/app/api/wiki/` returns nothing, so the `[slug]` siblings carry no 503 to reach parity with. Their catches (`src/app/api/wiki/[slug]/route.ts:338`, `:433`) are read-only→403, then a code/prefix ladder, then a bare 500 — which is exactly what `src/app/api/wiki/route.ts:174-182` already does. Parity holds today; inventing a 503 would break it.
- Do not touch `src/app/api/wiki/route.ts:114` or `src/mcp.ts:258`. Both already pass `{ fresh: true, strict: true }` with the full comment (DW-378/DW-195 work); this bundle only verifies them.
- Do not convert any other unqualified read in `src/cli.ts` (`:274`, `:279`, `:327`). `runRead` and `runReingest` serve output, not a write precondition — other DW entries, other bundles.
- Do not change `ReadWikiPageOptions`, `readWikiPage`'s `null` contract, the CLI's exit codes, or `deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| create happy path | slug never written, body on stdin | `Created: <slug>` printed, page stored | No error expected |
| create, guard read blips | page stored; one-shot non-ENOENT failure on that slug's `readFile` | stderr contains `could not read page "<slug>"` and the storage message; NOT `already exists`; exit 1; stored bytes unchanged byte for byte | Storage error rethrown by `strict`, caught locally |
| create, stale negative cached | `beginPageCache()` open holding a cached miss; bytes written straight to the flat path afterwards | Refuses with the existing `Error: page "<slug>" already exists.`; the stored bytes survive byte for byte | Existing exit-1 branch |
| update happy path | stored page, body on stdin | `Updated: <slug>` printed | No error expected |
| update, merge-base read blips | page stored; one-shot non-ENOENT failure on that slug's `readFile` | stderr contains `could not read page "<slug>"` and the storage message; NOT `not found`; exit 1; stored bytes unchanged | Storage error rethrown by `strict`, caught locally |
| update, stale cache open | `beginPageCache()` held with bytes a direct flat-path write has superseded | The write merges over the STORED bytes — the newer stored-only frontmatter key survives the update | No error expected |
| absent page (both) | slug never written | Unchanged: `already exists` never fires for create; `Error: page "<slug>" not found.` for update | Existing null branches |

</intent-contract>

## Code Map

- `src/cli.ts:356-378` -- `runCreate`. The read is `:366` (`readWikiPage(slug)`, destructured from the dynamic `./lib/wiki` import at `:357`); the `already exists` refusal is `:367-371`; stdin is read only afterwards. THE FIRST EDIT.
- `src/cli.ts:421-435` -- `runUpdate` (the intent calls it `runEdit`; there is no such symbol). The read is `:431` (`readWikiPageWithFrontmatter(slug)`, imported at `:422`); the `not found` refusal is `:432-435`; `existing.content` becomes `expectedContent` at `:468` and `existing.title` the title fallback at `:448`. THE SECOND EDIT.
- `src/cli.ts:816-833` -- the top-level `main().catch`. Shows the inline `err instanceof Error ? err.message : String(err)` extraction to copy, and why an uncaught throw is NOT enough: it prints a bare `Error: <message>` with no slug and no `could not read`.
- `src/mcp.ts:246-261` -- `handleCreatePage`'s conflict guard. ALREADY `{ fresh: true, strict: true }`. COPY THE COMMENT SHAPE from here (a FRESH (DW-195) paragraph and a STRICT (DW-378) paragraph). READ-ONLY.
- `src/app/api/wiki/route.ts:101-120` -- the 409 guard. ALREADY `{ fresh: true, strict: true }`; its catch (`:170-183`) is read-only→403, `invalid slug`→400, else 500. READ-ONLY — evidence for the Never clause.
- `src/app/api/wiki/[slug]/route.ts:338-362` and `:433-447` -- the sibling catches the intent claims carry a 503. They do not. READ-ONLY.
- `src/lib/wiki.ts:336-415` -- `ReadWikiPageOptions` docs. `readWikiPage:416-540`: cache consult `:429-431` (skipped when `fresh`), silo rethrow `:461`, `getPageIndex({ strict })` `:471`, flat rethrow `:484`, negative-cache seed `:501-503` (skipped when `fresh`), positive seed `:535`. `readWikiPageWithFrontmatter:558` forwards `options` verbatim. READ-ONLY.
- `src/lib/__tests__/mcp.test.ts:564-664` -- the two model rows for exactly this pair of edits: a ONE-SHOT `storage.readFile` spy (one-shot because a permanent spy also breaks the write's own `createOnly` re-check, giving a green row that pins nothing), and a `beginPageCache()` + direct `fs.writeFile` to the flat path. MIRROR BOTH.
- `src/lib/__tests__/cli-lifecycle.test.ts:1-47` -- real-fs CLI suite: tmpdir `WIKI_DIR`/`RAW_DIR`/`DATA_DIR`, `_resetLocks()`, `_resetStorage()`, stdin swap via `Object.defineProperty`. Imports `fs/promises`, `os`, `path`, `Readable`, `serializeFrontmatter`, `writeWikiPageWithSideEffects`, `readWikiPageWithFrontmatter`. NEW REAL-FS ROWS GO HERE (append inside the existing `describe`). It does NOT yet spy `process.exit` or `console.error` — add those in the rows that need them.
- `src/lib/__tests__/cli.test.ts:320-325` -- `vi.mock("../wiki")` stubs `readWikiPage` / `readWikiPageWithFrontmatter`, so this suite can pin the OPTIONS ARGUMENT directly and can reject the mock to pin the refusal copy. `:437-443` -- `exitSpy` throws `process.exit`. `:1231-1241` (`already exists`) and `:1490-1503` (`not found`) -- the rows the new copy must not disturb; add the new rows beside them.

### Ledger ID mismatch (flagged, not acted on)

`intent.md` declares `dw_ids: DW-425` and pastes that entry verbatim, but it is `status: done 2026-08-28`, `archived: 2026-08-29`, and is about a second `g s` over an open Settings panel — unrelated. The narrative Intent matches the still-open `DW-496` (`deferred-work.md:3714`), whose `reason` names `src/app/api/wiki/route.ts:104` and `src/mcp.ts:222` as "the mirror case" for create-conflict guards. Same mismatch as the immediately preceding bundle (`spec-dw-424-426-mcp-and-delete-fresh-merge-bases.md`). This spec implements the narrative Intent, which is self-contained. Ledger write-back is the orchestrator's.

## Tasks & Acceptance

**Execution:**
- `src/cli.ts` -- in `runCreate`, pass `{ fresh: true, strict: true }` to the `readWikiPage` call at `:366` under a FRESH/STRICT comment naming the guard's `null` as what authorizes the create, and wrap it in a `try`/`catch` that prints `Error: could not read page "<slug>": <message>` plus a line saying nothing was created, then `process.exit(1); return;`.
- `src/cli.ts` -- in `runUpdate`, do the same at `:431`, with the comment additionally naming `expectedContent` at `:468` as the merge base, and a catch line saying nothing was written.
- `src/lib/__tests__/cli-lifecycle.test.ts` -- add the four real-fs rows from the I/O matrix (create blip, create stale-negative-cache, update blip, update stale-cache), spying `process.exit` and `console.error` where the path exits.
- `src/lib/__tests__/cli.test.ts` -- add one row per function asserting the mocked read was called with `(slug, { fresh: true, strict: true })`, so the literal itself is pinned at the call site independent of the behavioural rows.

**Acceptance Criteria:**
- Given `src/cli.ts` after the change, when `grep -n "fresh: true" src/cli.ts` runs, then it reports exactly two call sites — the `runCreate` and `runUpdate` reads — and no other read in the file gained options.
- Given `src/app/api/wiki/route.ts` and `src/mcp.ts`, when the change is complete, then `git diff` shows neither file was modified.
- Given a stored page and a one-shot non-ENOENT `storage.readFile` failure on its `.md`, when `runCreate` runs, then stderr carries `could not read page` and the storage message but not `already exists`, exit is 1, and the stored bytes are unchanged byte for byte.
- Given the same blip, when `runUpdate` runs, then stderr carries `could not read page` and the storage message but not `not found`, and exit is 1.
- Given an open `beginPageCache()` holding a cached miss for a slug whose bytes were then written directly to the flat path, when `runCreate` runs, then it refuses with the existing `already exists` sentence and the stored bytes survive.
- Given an open `beginPageCache()` holding bytes a direct flat-path write has superseded, when `runUpdate` runs, then the resulting file is a merge over the STORED bytes — the stored-only marker survives.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 1, low 2)
- defer: 1: (high 0, medium 0, low 1)
- reject: 14: (high 0, medium 3, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The refusal's trailing sentence ("Nothing was created." / "Nothing was written.") was emitted but unasserted — a reviewer mutated the create door to print the update door's sentence and all 103 rows stayed green. Both blip rows in `cli-lifecycle.test.ts` now assert the WHOLE refusal line, in the exact-sentence style the stale-cache row already used. Mutation re-run confirms the row now fails.
  - `[low]` `[patch]` `let existing;` dropped the read's declared return type at both sites. Annotated as `Awaited<ReturnType<typeof readWikiPage>>` / `...WithFrontmatter>>`. Hardening, not a demonstrated hole: a control probe showed TS's evolving-`let` inference was already narrowing the declaration.
  - `[low]` `[patch]` No real-filesystem control row proved that `strict` still flattens ENOENT to `null` on the update door. Added `runUpdate() still answers 'not found' for a slug that was never written`; a mutation making `strict` rethrow ENOENT fails it.

## Design Notes

Both edits are the same shape. `runCreate`:

```ts
// FRESH (DW-195) + STRICT (DW-378). This read's `null` is what lets the
// create below proceed: a stale negative entry in the ref-counted global
// `pageCache`, or a non-ENOENT blip flattened to `null`, would land a create
// over a stored Page. Strict rethrows; the catch keeps that out of the
// `already exists` sentence below.
let existing;
try {
  existing = await readWikiPage(slug, { fresh: true, strict: true });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: could not read page "${slug}": ${message}\nNothing was created.`);
  process.exit(1);
  return; // unreachable but satisfies linting
}
```

`runUpdate` is identical with `readWikiPageWithFrontmatter` and `Nothing was written.`.

Stale-cache mechanics differ per row. `runCreate`'s slug is NEVER written through the lifecycle, so it has no page-index entry and `readWikiPage` takes the flat fallback — a direct `fs.writeFile` to `$WIKI_DIR/<slug>.md` is enough (exactly the `mcp.test.ts:626` setup). `runUpdate`'s page DOES exist, written through `writeWikiPageWithSideEffects`, so it is indexed and `readWikiPage` is silo-primary: supersede the AUTHORITATIVE copy (`tenants/<tenant>/wiki/<slug>.md`) directly, or the cached-vs-stored distinction the row depends on never materialises. Verify which path the read actually took before asserting.

The stale-negative-cache row for `runCreate` is what `strict` cannot pin: drop `fresh` and every blip row still passes. Off a cached miss the guard falls through and `writeWikiPageWithSideEffects`'s own `createOnly` re-check refuses instead — with ITS sentence, not the CLI's — so asserting the CLI's exact `Error: page "<slug>" already exists.` on stderr is the discriminating assertion.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/cli-lifecycle.test.ts src/lib/__tests__/cli.test.ts` -- expected: all rows pass, including the new ones.
- `pnpm test` -- expected: passes with no new failures.
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit` -- expected: no type errors (the `let existing;` declarations must infer correctly).
- `grep -n "fresh: true" src/cli.ts` -- expected: exactly two lines.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** The two CLI write doors now read fresh and strict. `runCreate`'s conflict guard (`src/cli.ts:378`) and `runUpdate`'s merge-base read (`src/cli.ts:465`) pass `{ fresh: true, strict: true }`, each under a FRESH (DW-195) / STRICT (DW-378) comment pair matching the already-converted twins. Each read is wrapped in a local `try`/`catch` that prints `Error: could not read page "<slug>": <message>` plus a door-specific `Nothing was created.` / `Nothing was written.` line and exits 1, so a storage blip never falls into the `already exists` / `not found` sentences below. The existing refusal wording and exit codes are unchanged.

Two of the intent's four sites were already converted at baseline and were verified, not edited: `src/app/api/wiki/route.ts:114` and `src/mcp.ts:258` both already carried the literal. The intent's 503 clause was declined on a verified-false premise — `grep -rn "503" src/app/api/wiki/` returns nothing, so the `[slug]` siblings carry no 503 branch to reach parity with; `POST /api/wiki`'s catch already matches theirs (read-only→403, invalid-slug→400, else 500).

**Files changed:**
- `src/cli.ts` -- fresh+strict at both write-door reads, each with a rationale comment and a local read-failure refusal.
- `src/lib/__tests__/cli-lifecycle.test.ts` -- two stdin helpers plus five real-fs rows: create/update blip (one-shot non-ENOENT `storage.readFile` failure), create stale-negative-cache, update stale-cache, and an update genuine-absence control.
- `src/lib/__tests__/cli.test.ts` -- two rows pinning the options literal at each call site.

**Review findings breakdown:** 3 patches applied (1 medium, 2 low), 1 item deferred (low), 14 rejected. 0 intent gaps, 0 bad-spec loopbacks.

**Follow-up review recommendation:** true. Patched counts: high 0, medium 1, low 2. Score = 3x1 + 1x2 = 5, which is >= 5.

**Verification performed:**
- `pnpm exec vitest run src/lib/__tests__/cli-lifecycle.test.ts src/lib/__tests__/cli.test.ts` -- 104 passed.
- `pnpm test` -- 8554-8556 passed across three runs. Every failure observed was a 5000 ms `Test timed out` in an unrelated suite (`contributors`, `agents`, `review-queue`, `search`, `lint`, `wiki`, `query`, `extract-jobs`); all pass in isolation, none is in a changed file, and the count rose from 1 to 13 across runs as machine load rose. Load-induced flakes from concurrent orchestrator processes, not this change.
- `pnpm lint` rc 0; `pnpm exec tsc --noEmit` rc 0.
- `grep -n "fresh: true" src/cli.ts` -- exactly two lines (378, 465); the display reads at `:274`, `:279`, `:327` are untouched.
- `src/mcp.ts`, `src/app/api/wiki/route.ts` and `src/lib/wiki.ts` are sha1-identical to baseline `8c75f2d5`.
- Independent droppability proved by mutation: removing `fresh` fails the two stale-cache rows plus both literal rows; removing `strict` fails the two blip rows plus both literal rows; making `strict` rethrow ENOENT fails the new absence row; swapping the create door's trailing sentence fails the create blip row.
- Matrix audit: all seven I/O rows are covered by rows that ran and passed in the targeted run.

**Residual risks:**
1. **Concurrent-run collision.** A parallel `bmad-loop` process rewrote this branch mid-session: `baseline_revision` `8c75f2d5` is no longer an ancestor of HEAD, and this bundle's `src/cli.ts` and `cli.test.ts` edits were swept into the unrelated commit `7cfc9d0b` ("sweep dw-snapshot-coverage-and-archive-lookup: DW-571, DW-365"). Content is intact and verified; commit attribution needs orchestrator reconciliation.
2. **Overlapping in-flight bundle.** `spec-dw-495-496-497-merge-base-strict-reads.md` is `status: in-review` in another session and targets `src/cli.ts:431` with the opposite error handling. Recorded as the deferred item above.
3. **Ledger ID mismatch.** `intent.md` declares `dw_ids: DW-425`, which is done/archived and about Settings focus. The narrative Intent matches the still-open DW-496. This spec implements the narrative Intent; ledger write-back is the orchestrator's.
