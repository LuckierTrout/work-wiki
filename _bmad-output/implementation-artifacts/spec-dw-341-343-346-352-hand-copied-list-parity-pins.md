---
title: 'DW-341/343/346/352: pin four hand-copied inventories to the types they restate'
type: 'refactor'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `SCHEMA.md` restates the same ten auto-fixable check types, their
      descriptions and two hardcoded counts, and nothing pins it.
    evidence: |-
      `SCHEMA.md:667-686` says "Lint auto-fix handles ten of fifteen checks"
      and names all ten, then describes six of them and enumerates "the five
      exceptions without auto-fix". That is a third restatement of
      `AUTO_FIXABLE_CHECK_TYPES` and a second of `NOT_AUTO_FIXABLE`, with the
      cardinalities written out by hand. It is root markdown, already inside
      `prose-inventory-parity.test.ts`'s reach via `readProse`/`extract`, and
      `SCHEMA.md` is executable — AGENTS.md records that its page-conventions
      section is loaded into LLM prompts on every ingest. This pass pinned the
      route JSDoc and the two `MaintainFixType` sentences and left this one,
      so the parity header's census ("nine, across eight files") is already
      one short.
    location: >-
      SCHEMA.md:667
    severity: medium
  - summary: >-
      Nothing pins `MaintainFixType` against `AUTO_FIXABLE_CHECK_TYPES`, so a
      new deterministic auto-fix would be unenqueueable and DLQ exactly as
      DW-343 described.
    evidence: |-
      `MaintainFixType` (`src/lib/tasks.ts:202-210`) is exactly
      `AUTO_FIXABLE_CHECK_TYPES` (`src/lib/lint-types.ts:64-75`) minus
      `contradiction` and `missing-concept-page` — the two LLM handlers — but
      the relationship is coincidence, not contract. Add a deterministic fix to
      `lint-types.ts` and `lint-fix.ts` and `tsc` stays silent while
      `maintenance.ts` cannot enqueue it and `parseTask` returns null: the
      DW-343 poison-message failure one list over. This pass imported both
      consts into the same test file for the first time, which is what made
      the gap visible; closing it is either
      `Exclude<AutoFixableCheckType, "contradiction" | "missing-concept-page">`
      or a parity assertion, and both are decisions beyond this bundle.
    location: >-
      src/lib/tasks.ts:202
    severity: medium
  - summary: >-
      `POST /api/lint/fix`'s JSDoc documents no response contract — neither the
      statuses it returns nor the success shape.
    evidence: |-
      The route answers 403 twice (owner gate, read-only refusal), 400 on
      `FixValidationError`, 404 on `FixNotFoundError`, `PAGE_UNREADABLE_STATUS`
      on an unreadable page, and 500 otherwise, and returns a `FixResult`
      (`{ success, slug, message }`) on the happy path. The header comment —
      rewritten at length in this pass to complete the issue-type inventory —
      names none of them, so an integrator reading the one door DW-346 was
      about still cannot tell a refusal from a failure. Pre-existing: the
      five-entry version documented no statuses either.
    location: >-
      src/app/api/lint/fix/route.ts:19
    severity: low
baseline_revision: 'f342e2f110ebc959755bbec31b9ca9898aa66c97'
---

<intent-contract>

## Intent

**Problem:** Four inventories restate a machine list by hand with nothing pinning them. `MAINTAIN_FIX_TYPES` (`src/lib/tasks.ts:213`) is a `new Set<MaintainFixType>([...])` that rejects an extra member but not an omitted one — a ninth fix type wired into `src/lib/maintenance.ts` and forgotten here makes `parseTask` return `null` (:440), so the task is poison and goes to the DLQ with `tsc` silent (DW-343). Two prose copies of that same union — `src/lib/maintenance.ts:11-14` and `workers/task-consumer/README.md:48-50` — are unread by anything (DW-341, DW-343). `POST /api/lint/fix`'s JSDoc (`src/app/api/lint/fix/route.ts:22-27`) names five of the ten `AUTO_FIXABLE_CHECK_TYPES` — omitting `broken-link`, `missing-concept-page`, `stale-page`, `unmigrated-page` and `supersedes-dangling`, the very type DW-229 was about (DW-346). And `IDENTIFIER_ALLOWLIST`'s `/yopedia-[a-z-]+/g` (`src/lib/__tests__/brand-copy.test.ts:68`) is a shape, not a name: it waives `the yopedia-first workflow` as if it were a Cloudflare resource (DW-352).

**Approach:** Promote `MAINTAIN_FIX_TYPES` to an exported `as const satisfies readonly MaintainFixType[]` tuple with an `AssertNever` omission alias — the contract `TASK_KINDS` already has one screen above — and derive the membership Set from it. Pin the two prose restatements and the route JSDoc in `prose-inventory-parity.test.ts` with the read-back convention that file already uses. Complete the route JSDoc to all ten types first, so the pin has something true to pin. Replace the `yopedia-[a-z-]+` shape with an anchored alternation enumerating the real resource, Worker, host and User-Agent names, and add the slip cases the workwiki family already carries at :517.

## Boundaries & Constraints

**Always:** Every machine side is DERIVED (`MAINTAIN_FIX_TYPES`, `AUTO_FIXABLE_CHECK_TYPES`), never a literal restated in the test — a restated literal would have to be edited alongside the change it is meant to catch. Prose extraction is anchor-based and must throw naming the file when the anchor stops matching, matches twice, or captures nothing; comparisons run in both directions through the existing `expectSameSet`. `parseTask`'s runtime acceptance of `maintain`/`fix` tasks is byte-identical to today. The narrowed yopedia alternation must keep every real spelling waived: `yopedia-tasks`, `yopedia-tasks-dlq`, `yopedia-task-consumer`, `yopedia-email-ingest`, `yopedia-sandbox-runner`, `yopedia-sandbox.internal`, `yopedia-embeddings-bge-m3`, `yopedia-raw`, `yopedia-pages`, `yopedia-vec`, `yopedia-r2`, `yopedia-monitor`.

**Block If:** Narrowing `/yopedia-[a-z-]+/g` turns out to strand a spelling that is a genuine runtime identifier but has no home in either the enumeration or `YOPEDIA_PROSE_EXEMPT` — that is a freeze decision, not a test edit. Or completing the route JSDoc would require inventing behaviour: if any of the five missing types has no discoverable argument shape in `src/lib/lint-fix.ts`, stop rather than guess.

**Never:** Do not change which lint fixes exist, which types are auto-fixable, or any handler. Do not rename or retire `MaintainFixType`. Do not widen `TASK_KINDS`, `ALL_CHECK_TYPES` or `AUTO_FIXABLE_CHECK_TYPES`. Do not touch `src/lib/lint-fix.ts`, `src/lib/lint-types.ts` or `src/components/LintIssueCard.tsx`. Do not "fix" the grandfathered Yopedia prose in the exempt files — AGENTS.md forbids it. Do not add a second convention for prose pinning; extend the one file that owns it. Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ninth fix type added to `MaintainFixType` only | A member added to the union, not to the tuple | `pnpm exec tsc --noEmit` fails at `_NoMaintainFixTypeMissingFromList` | Compile error, before any test runs |
| Fix type added to the tuple but not the union | Extra member in `MAINTAIN_FIX_TYPES` | `satisfies readonly MaintainFixType[]` fails to compile | Compile error |
| Prose drifts behind the union | A type added to the tuple, `maintenance.ts` header or task-consumer README left alone | The matching parity case fails naming the file and the missing entry | `expectSameSet` reports both directions in one run |
| Route JSDoc drifts behind `AUTO_FIXABLE_CHECK_TYPES` | A type added to the const, JSDoc bullet list left alone | Parity case fails naming `src/app/api/lint/fix/route.ts` | Same |
| An anchor is reworded away | `Supported issue types:` heading renamed | Hard failure naming the file — never an empty set that compares equal to nothing | `extract`/`extractBlock` throw |
| `maintain`/`fix` task parsed | `{ kind: "maintain", op: "fix", lintType: "broken-link", slug, targetSlug }` | Accepted exactly as today; unknown `lintType` still returns `null` | Unchanged |
| Yopedia display prose | `"the yopedia-first workflow"` | `hasStrayYopedia` is `true` | Scan fails naming the file |
| Yopedia frozen identifier | `"yopedia-tasks-dlq"`, `"https://yopedia-sandbox.internal/execute"`, `"yopedia-monitor/1.0"` | `hasStrayYopedia` is `false` | No error expected |

</intent-contract>

## Code Map

- `src/lib/tasks.ts` -- the subject of DW-343. `TASK_KINDS` (:181-192) is the exact contract to copy: `as const satisfies readonly Task["kind"][]` plus `type _NoTaskKindMissingFromList = AssertNever<Exclude<Task["kind"], TaskKind>>` (:198-199). `AssertNever` is declared at :197, ABOVE `MaintainFixType` (:201-210), so the new alias can use it without moving anything. `MAINTAIN_FIX_TYPES` (:213-222) is today a `Set`; its only consumer is `MAINTAIN_FIX_TYPES.has(t.lintType as MaintainFixType)` at :440 inside `case "maintain"`. Export the tuple under the same name (the parity test imports it) and derive a module-private Set for the :440 lookup so the hot parse path keeps O(1) membership.
- `src/lib/maintenance.ts:11-14` -- prose restatement #1, inside the module header JSDoc: ``- **fix** (deterministic, no LLM): a lint fix (`lintType`) — `orphan-page`, `stale-index`, `unmigrated-page`, `supersedes-dangling`, `broken-link`, `empty-page`, `stale-page`, `missing-crossref`: the whole `MaintainFixType` union (`tasks.ts`).`` The list is bounded on the right by `: the whole` — NOT by a period, so a `[^.]+` anchor would swallow `` `MaintainFixType` `` and `` `tasks.ts` `` as two phantom entries. Read-only apart from the list itself.
- `workers/task-consumer/README.md:48-50` -- prose restatement #2: ``- **`fix`** — a deterministic, no-LLM lint fix (`lintType`): `orphan-page`, ... `missing-crossref`.`` Ends with a period. `no-LLM lint fix` occurs exactly once in the file (verified). This README already carries the task-kind pin at `prose-inventory-parity.test.ts:302`, so it becomes a two-inventory file.
- `src/app/api/lint/fix/route.ts:19-35` -- the subject of DW-346. The JSDoc has a `Supported issue types:` heading (:22) followed by five ``- `type`: description.`` bullets (:23-27), a blank line, then a `Request body:` fenced json block (:29-35) that shows five per-type example bodies. Complete the bullet list to all ten; the block-bounded pin must stop at the blank line so the json examples are not parsed as inventory entries.
- `src/lib/lint-fix.ts:707-722` -- READ-ONLY evidence for the five missing descriptions and their argument shapes. `FIX_HANDLERS` is `Record<AutoFixableCheckType, FixHandler>`: `broken-link` → `fixBrokenLink(slug, targetSlug)`; `missing-concept-page` → `fixMissingConceptPage(message)` (no slug); `stale-page` → `fixStalePage(slug)`; `unmigrated-page` → `fixUnmigratedPage(slug)`; `supersedes-dangling` → `fixSupersededDangling(slug)` ("clear the dead reference, re-verified missing first"). `contradiction` and `missing-concept-page` are the two that run an LLM rewrite.
- `src/lib/lint-types.ts:64-75` -- `AUTO_FIXABLE_CHECK_TYPES`, the ten-entry derived side for the route pin. Read-only.
- `src/lib/__tests__/prose-inventory-parity.test.ts` -- where all three prose pins land. Reuse, do not reinvent: `repoFile` (:54), `readSourceLines` (:62, strips JSDoc gutters but not `**`), `readProse` (:73, flattens to one line), `extract` (:86, exactly-one-match anchor with a capture group), `extractBlock` (:127, line-bounded), `tokenize` (:166), `repeats` (:172), `expectSameSet` (:182, bidirectional + duplicate rejection). The task-kind case (:302-329) is the closest model: extract a span, then pull backticked tokens with `/`([^`]+)`/g` filtered to the `^[a-z]+(?:-[a-z]+)*$` literal shape, guard `length > 0`, then `expectSameSet`. The header comment (:8-52) says "Six hand-written prose inventories" and enumerates them — it must be updated to the new count and list, or it becomes a seventh unpinned inventory in this very file.
- `src/lib/__tests__/brand-copy.test.ts` -- the subject of DW-352. `IDENTIFIER_ALLOWLIST` (:58-79); the entry to replace is `/yopedia-[a-z-]+/g` at :68 (`// Cloudflare resource names, sandbox host, monitor UA`). `WORKWIKI_IDENTIFIER_ALLOWLIST`'s anchored `.?workwiki-(?:source-sync|backups|…)` (:205) is the pattern to mirror, and its slip case `"the workwiki-first approach"` (:517) is the case to mirror in the yopedia table (:558-568, `for (const slip of [...])`). `strayYopedia` (:267) strips every allowlist pattern then counts `/yopedia/gi`. `YOPEDIA_PROSE_EXEMPT` (:373-381) pins per-file occurrence counts and is asserted in BOTH directions at :579-601 — narrowing the pattern changes those counts for any exempt file that carries a hyphenated name, so every count must be re-verified against a real run, not reasoned about.
- Evidence for the enumeration (all hyphenated `yopedia-` spellings in the scanned corpus, `__tests__` excluded): `yopedia-tasks`, `yopedia-tasks-dlq` (queue + DLQ, `wrangler.jsonc:80-86`, `workers/task-consumer/wrangler.jsonc:24-30`); `yopedia-task-consumer`, `yopedia-email-ingest`, `yopedia-sandbox-runner` (Worker script names, the three `workers/*/wrangler.jsonc`); `yopedia-sandbox.internal` (`src/lib/sandbox-service.ts:29`); `yopedia-monitor` (User-Agent, `src/lib/source-monitors.ts:347`); `yopedia-raw`, `yopedia-embeddings-bge-m3`, `yopedia-pages`, `yopedia-vec`, `yopedia-r2` (R2 bucket, Vectorize index and the setup script's temp log basenames, `scripts/setup-cloudflare.sh:119-239`, `wrangler.jsonc:46-60`). `yopedia--yoyo` (`public/agent-api.md:26`) is already covered by the earlier `/yopedia--[a-z0-9-]+/g` entry. The ONE remaining spelling is `yopedia-project-tracking` (`docs/production-owner-session-acceptance-2026-08-03.md:52,59`) — a wiki page slug cited in a production acceptance record, i.e. this deployment's own history, which is what `YOPEDIA_PROSE_EXEMPT` is for.

## Tasks & Acceptance

**Execution:**
- `src/lib/tasks.ts` -- promote `MAINTAIN_FIX_TYPES` to an exported `as const satisfies readonly MaintainFixType[]` tuple, add `type _NoMaintainFixTypeMissingFromList = AssertNever<Exclude<MaintainFixType, (typeof MAINTAIN_FIX_TYPES)[number]>>`, derive a module-private Set for the `:440` membership test, and give the const a docblock explaining the two-directional pin the way `TASK_KINDS`' does -- closes the omission half `tsc` cannot see today (DW-343).
- `src/app/api/lint/fix/route.ts` -- complete the `Supported issue types:` bullet list to all ten `AUTO_FIXABLE_CHECK_TYPES`, each with a one-line description drawn from its handler, and rework the `Request body:` examples so they show the three argument SHAPES (slug only; slug + `targetSlug`; `message`-driven) rather than a second per-type inventory -- an integrator reading this door now sees every type it accepts, and the fix does not mint a new hand-copied list (DW-346).
- `src/lib/__tests__/prose-inventory-parity.test.ts` -- add three read-back parity cases (`src/lib/maintenance.ts` and `workers/task-consumer/README.md` against `MAINTAIN_FIX_TYPES`; `src/app/api/lint/fix/route.ts` against `AUTO_FIXABLE_CHECK_TYPES`), each with a duplicate check on the machine side and a "parsed to no entries" guard, and update the file header's inventory census -- the prose is unread by anything else, and this file is the repo's convention for pinning prose it cannot generate (DW-341, DW-343, DW-346).
- `src/lib/__tests__/brand-copy.test.ts` -- replace `/yopedia-[a-z-]+/g` with an anchored alternation over the twelve enumerated names, add `docs/production-owner-session-acceptance-2026-08-03.md` to `YOPEDIA_PROSE_EXEMPT` at its verified count, extend the yopedia frozen-case table with the enumerated spellings and the slip table with `"the yopedia-first workflow"` plus one near-miss per anchor, and re-verify every exempt count against a real run -- a shape-shaped waiver cannot tell a resource name from display prose (DW-352).

**Acceptance Criteria:**
- Given a new `MaintainFixType` union member that is not added to `MAINTAIN_FIX_TYPES`, when `pnpm exec tsc --noEmit` runs, then it fails at `_NoMaintainFixTypeMissingFromList` rather than compiling clean and failing at runtime in the DLQ.
- Given the prose in `src/lib/maintenance.ts`, `workers/task-consumer/README.md` or the `POST /api/lint/fix` JSDoc no longer agrees with the const it restates, when `pnpm test` runs, then a parity case fails naming that file, the direction of the drift, and the entries involved.
- Given every anchor still matches, when the suite runs against the tree as it stands, then all three new parity cases pass — i.e. the route JSDoc really does name all ten auto-fixable types.
- Given the repo as it stands, when the brand suite runs, then no file is reported as carrying a stray `yopedia` and every `YOPEDIA_PROSE_EXEMPT` count matches exactly, proving the narrowed alternation stranded nothing.

## Design Notes

The read-back convention is deliberate and already argued in `prose-inventory-parity.test.ts`'s header: a comment and a Markdown README cannot import a generated sentence, so the pin READS the prose out of the file, tokenizes it, and compares against a set DERIVED from code. That buys agreement, not fewer edits — adding a ninth fix type still means editing the union, the tuple, and both sentences; what changes is that you can no longer forget one.

The `maintenance.ts` anchor must be bounded on `: the whole`, not on `.`:

```js
// prose: "… a lint fix (`lintType`) — `orphan-page`, …, `missing-crossref`: the whole `MaintainFixType` union (`tasks.ts`)."
/lint fix \(`lintType`\) — ([^:]+): the whole `MaintainFixType` union/
```

A `([^.]+)\.` anchor would capture through the trailing clause and add `MaintainFixType` and `tasks.ts` as phantom entries — a failure that looks like drift but is the anchor's fault.

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 4, low 5)
- defer: 3: (high 0, medium 2, low 1)
- reject: 11: (high 0, medium 3, low 8)
- addressed_findings:
  - `[medium]` `[patch]` The reworked `Request body:` block re-created the very defect DW-346 filed: its third example was labelled `<message-driven type>` but showed `contradiction`'s slug+targetSlug+message shape, and a prose sentence assigned types to shapes by hand, deliberately outside the pin. Moved the arguments each type reads into the pinned bullets, deleted the assignment sentence, and made the `message` example one `fixMissingConceptPage` actually accepts.
  - `[medium]` `[patch]` The new trailing lookahead `(?![a-z0-9-])` did not do what its comment claimed — `yopedia-tasksQueue`, `yopedia-tasks_dlq` and `yopedia-monitorUA` were half-stripped and passed the scan. Widened both boundaries to `(?![A-Za-z0-9_-])` / `(?<![A-Za-z0-9_-])`, kept a trailing `.` permitted (a live hostname and three log basenames need it) and named that residual in the comment instead of overclaiming; six slip cases pin the newly blocked classes.
  - `[medium]` `[patch]` Nothing kept the enumeration minimal — a retired resource would leave its name behind as a permanent licence to write that word as display prose. Hoisted the names into `YOPEDIA_HYPHEN_IDENTIFIERS`, built the pattern from that list, and added a minimality test that fails when a waived name stops occurring in the scanned corpus.
  - `[medium]` `[patch]` Three "frozen identifier" cases added to the brand case table were fabricated command lines rather than repo spellings (invented `wrangler` invocations for `yopedia-pages`/`yopedia-vec`/`yopedia-r2`). Replaced with verbatim lines from `scripts/setup-cloudflare.sh:120,145` plus a deliberate `:159` fragment, with the reason for the fragment stated.
  - `[low]` `[patch]` The route comment claimed "the type DW-229 added (`supersedes-dangling`)"; DW-229 was about a missing Fix button, not the type. Reworded.
  - `[low]` `[patch]` `MAINTAIN_FIX_TYPE_SET.has(t.lintType as MaintainFixType)` asserted the proposition the line existed to test, on unparsed input. Replaced with a real `typeof` guard; `parseTask` behaviour unchanged.
  - `[low]` `[patch]` The `YOPEDIA_PROSE_EXEMPT` docblock enumerated the classes it covers and the new entry (a wiki page slug in a dated acceptance record) was none of them. Docblock extended to name that class and why a per-file count is the right instrument.
  - `[low]` `[patch]` `backtickedLiterals` — the new helper deciding which backticked spans count as inventory entries — had no self-test in the `extraction guards` describe that covers every other helper. Guard case added.
  - `[low]` `[patch]` AGENTS.md's yopedia bullet still described the hyphen family as a shape ("every resource name in both wrangler.jsonc files") while the enforcing allowlist had become a closed enumeration covering more than that. Bullet rewritten to enumerate all twelve names with their artifacts and state the add/retire rule; it stays below the closing `bmad:context` marker.


## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean; proves the `satisfies` and `AssertNever` halves both compile.
- `pnpm vitest run src/lib/__tests__/prose-inventory-parity.test.ts src/lib/__tests__/brand-copy.test.ts` -- expected: all pass, including the three new parity cases and the yopedia case table.
- `pnpm vitest run src/lib/__tests__/tasks.test.ts src/lib/__tests__/lint-fix.test.ts src/components/__tests__/lint-check-parity.test.tsx` -- expected: unchanged pass; `parseTask`'s `maintain`/`fix` acceptance is untouched.
- `pnpm exec eslint src/lib/tasks.ts src/app/api/lint/fix/route.ts src/lib/__tests__/prose-inventory-parity.test.ts src/lib/__tests__/brand-copy.test.ts` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** Four hand-copied inventories are now pinned to the types they restate. `MAINTAIN_FIX_TYPES` is an exported `as const satisfies readonly MaintainFixType[]` tuple with an `AssertNever` omission alias — the two-directional contract `TASK_KINDS` already carries — and `parseTask`'s membership Set is derived from it, so a ninth fix type can no longer be wired into `maintenance.ts`, forgotten in `tasks.ts`, and discovered only as a poison message in the DLQ (DW-343). The two prose restatements of that union (`src/lib/maintenance.ts`'s module header, `workers/task-consumer/README.md`) and `POST /api/lint/fix`'s JSDoc are read back in `prose-inventory-parity.test.ts` against derived consts (DW-341, DW-346); the route JSDoc, which named five of ten auto-fixable types, now names all ten with the arguments each handler reads. `IDENTIFIER_ALLOWLIST`'s `/yopedia-[a-z-]+/g` shape is replaced by a boundary-anchored enumeration of the twelve real resource, host and User-Agent names, so display prose like "the yopedia-first workflow" no longer passes the brand scan (DW-352).

**Files changed.**
- `src/lib/tasks.ts` — `MAINTAIN_FIX_TYPES` promoted to an exported tuple with `_NoMaintainFixTypeMissingFromList`; derived `MAINTAIN_FIX_TYPE_SET` plus a real `typeof` guard back `parseTask`'s membership test.
- `src/app/api/lint/fix/route.ts` — `Supported issue types:` completed to all ten types, each bullet naming the fields its handler reads; `Request body:` reduced to field vocabulary with no per-type inventory.
- `src/lib/__tests__/prose-inventory-parity.test.ts` — three read-back parity cases, a `backtickedLiterals` self-test, and an updated inventory census in the file header.
- `src/lib/__tests__/brand-copy.test.ts` — `YOPEDIA_HYPHEN_IDENTIFIERS` + a pattern built from it with both word boundaries; a minimality test; a new `YOPEDIA_PROSE_EXEMPT` entry for the acceptance record citing `yopedia-project-tracking`; twelve frozen and eighteen slip cases.
- `AGENTS.md` — the yopedia freeze bullet rewritten from a shape to the closed enumeration, with the add/retire rule; stays below the closing `bmad:context` marker.

**Review findings.** 9 patches applied (4 medium, 5 low), 3 deferred (2 medium, 1 low), 11 rejected. No intent gap and no spec defect: DW-352's ledger `reason` said to pin today's behaviour rather than change it, while the bundle Intent said to anchor the pattern by enumeration — the bundle Intent governs, and the evidence its `reason` said was missing was gathered by hand-enumerating the scanned corpus. Follow-up review recommended: **true** (0 high patched; 3 × 4 medium + 1 × 5 low = 17, at or above the threshold of 5).

**Verification.**
- `./node_modules/.bin/tsc --noEmit` — clean.
- `./node_modules/.bin/vitest run` — 274 files / 6205 tests, all pass (6203 before the patch round; +2 from the minimality and `backtickedLiterals` cases).
- `./node_modules/.bin/eslint` on the four code files — clean.
- Plant-and-revert, run independently of the implementation agent and reverted afterward: a ninth union arm missing from the tuple → `TS2344 … does not satisfy the constraint 'never'`; an extra tuple member → `TS2322`; `stale-page` dropped from `maintenance.ts`'s header → "does not mention: stale-page"; a bogus entry added to the README → "mentions entries that do not exist: bogus-type"; the `supersedes-dangling` bullet deleted from the route → "does not mention: supersedes-dangling". Every new pin fails loudly on planted drift.
- The narrowed brand pattern is defended from both sides by the suite itself: restoring the wildcard fails the `the yopedia-first workflow` slip case and empties the new exemption; dropping a name from the enumeration fails both the case table and the live repo scan.

**Residual risks.**
- The enumeration is now a maintenance surface: a new `yopedia-*` Cloudflare resource fails the brand suite until it is added to `YOPEDIA_HYPHEN_IDENTIFIERS`. That is the intended trade — a shape cannot tell a resource name from display prose — but it is a new failure mode an operator will meet.
- A trailing `.` is still permitted after an enumerated name, so a future `yopedia-<enumerated name>.<host>` stays waived. Blocking it would flag the task-consumer README's live health-check hostname and move the pinned exempt counts, so the residual is documented in the pattern's docblock rather than closed.
- The minimality test matches each waived name as a plain substring, so `tasks` reads as "still used" via `yopedia-tasks-dlq`. Retiring the queue while keeping its DLQ is not a reachable state, but the guard is weaker for a name that prefixes another than for the other ten.
- The three new prose pins couple `src/lib/maintenance.ts` and `workers/task-consumer/README.md` to anchor regexes those documents do not mention. Rewording either sentence throws from `extract()` naming the file — a loud failure, and the trade this test file's header already documents.
