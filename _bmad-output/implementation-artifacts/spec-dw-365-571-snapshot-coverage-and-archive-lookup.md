---
title: 'DW-571/DW-365: compare every readable Source in coverage lint, and read the archive map through ownLookup'
type: 'bugfix'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `extractPptx` indexes the unzipped archive map with a relationship-derived
      path, so a crafted PPTX turns document ingest into an uncaught `TypeError`
      (HTTP 500) and silently discards the deck's real slides.
    evidence: |-
      `src/lib/document-extract.ts:595` filters slides with
      `Boolean(files[slide.path])` and `:602` reads `const bytes = files[path]`,
      where `path` comes from `relationshipMap` -> `resolveArchiveTarget` over an
      uploaded archive's `Target` attribute. A `ppt/_rels/presentation.xml.rels`
      entry of `Target="../constructor"` resolves to the bare key `constructor`,
      which the plain index answers with the inherited `Object` constructor
      function: the `Boolean(...)` filter keeps the bogus slide, `ordered.length`
      is non-zero so it OVERRIDES the correct `fallbackSlides`, and
      `new TextDecoder().decode(fn)` throws
      `TypeError: The "list" argument must be an instance of SharedArrayBuffer,
      ArrayBuffer or ArrayBufferView`. Three independent reviewers built the
      fixture and reproduced it. Because it is not a `ClientInputError`,
      `src/app/api/ingest/document/route.ts` answers 500 rather than the 400 the
      extractor's contract promises, and the readable `ppt/slides/slide1.xml` in
      the same archive is never extracted. Reachable without the sidecar: an
      emailed attachment (`src/app/api/email/ingest/route.ts:547`) or a `.pptx`
      nested in an uploaded `.zip` (`document-extract.ts:972`). No test in the
      repo builds a presentation-relationship fixture with such a target.
      `extractXlsx` is NOT affected: it rejects `..` and force-prefixes `xl/`.
      Out of scope here -- this bundle's intent names `document-extract.ts:458`
      only, and that line is inert by contrast (`mediaTypeFor` rejects every
      extensionless name).
    location: >-
      src/lib/document-extract.ts:595
    severity: medium
baseline_revision: 'e5dc6724d36cd57af3f28ebc816b065fe980c30c'
---

<intent-contract>

## Intent

**Problem:** Two reader defects on the ingest side. (DW-571) `checkIncompleteCoverage` (`src/lib/lint-checks.ts:1054-1069`) reaches the hashed snapshots only inside the `catch` of `readRawSource(slug)`, and `break`s on the first snapshot that opens — so a page assembled from several Intake arrivals is judged against exactly one of them, chosen by directory-listing order, and a page that also has a flat `raw/sources/<slug>.md` blob never has its snapshots compared at all. DW-437 settled which pages are *candidates*; which bytes reach the LLM was left open. (DW-365) `assetFromArchive` (`src/lib/document-extract.ts:458`) indexes the unzipped file map with a raw `files[target]`, where `target` is resolved from a relationship `Target` inside an attacker-supplied archive; `resolveArchiveTarget` can yield a bare `constructor`, which answers an inherited `Object.prototype` function. It is inert only because `mediaTypeFor` rejects the extensionless name one line below — an accident of ordering, not a guard, and the line sits directly above the `ownLookup` call added to close exactly this pattern.

**Approach:** In the coverage loop, collect **every** readable Source for the slug — the flat blob when it opens, plus each readable hashed snapshot — instead of stopping at the first, and hand them all to the LLM in one call under per-part headers, splitting the existing `MAX_RAW_CHARS` budget evenly so no single Source can starve the others out of the payload. In `assetFromArchive`, replace `files[target]` with `ownLookup(files, target)` (already imported at `:3`), matching its neighbour.

## Boundaries & Constraints

**Always:** One LLM call per sampled page — `MAX_COVERAGE_CHECKS` remains a cap on calls, not just on pages. The total raw payload stays bounded by `MAX_RAW_CHARS`. A slug with no readable Source is still skipped silently. Unreadable individual snapshots are skipped, never fatal.

**Block If:** The coverage change cannot keep one LLM call per page without dropping Sources.

**Never:** Do not change `listRawSources`/`listRawSourceSnapshots` or their contracts (DW-568/DW-569 are separate, in-flight work). Do not change candidacy (which slugs are sampled). Do not raise `MAX_RAW_CHARS`, `MAX_COVERAGE_CHECKS`, or per-page LLM call count. Do not export `assetFromArchive` or otherwise widen `document-extract`'s surface to make DW-365 testable. Do not touch the other raw `files[...]` reads in `document-extract.ts` — DW-365 names `:458` only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Flat blob + snapshots | `raw/sources/<slug>.md` plus two `raw/sources/<slug>/<id>.md` | One LLM call whose user message carries all three, each under its own `--- Raw Source: <slug> [...] ---` header | No error expected |
| Several snapshots, no flat blob | Two hashed snapshots, `readRawSource` throws | One LLM call carrying both snapshots' content | `readRawSource` throw is swallowed |
| One snapshot unreadable | Two snapshot ids listed, one read throws | One LLM call carrying only the readable one | Failed read skipped, not fatal |
| No readable Source | Flat read throws, every snapshot read throws | Slug skipped, no LLM call | All reads swallowed |
| Single flat Source (status quo) | Only `raw/sources/<slug>.md` | One LLM call, up to the full `MAX_RAW_CHARS` of it | No error expected |
| Duplicate bytes | Flat blob and a snapshot with byte-identical content | Sent once, so the budget is not spent twice on the same text | No error expected |
| Archive target names a prototype member | DOCX relationship `Target="../constructor"` alongside a real `media/chart.png` | No asset for the prototype-named target; the real PNG still extracts with its own bytes | Returns `null`, no throw |

</intent-contract>

## Code Map

- `src/lib/lint-checks.ts:1054-1078` -- the coverage loop. `snapshotIdsBySlug` (built at `:1013-1026`) already holds every snapshot id per slug; the `catch`-only fallback at `:1058-1067` and its `break` at `:1061` are the defect. `MAX_RAW_CHARS`/`MAX_WIKI_CHARS` at `:1050-1051`; the user message at `:1074`.
- `src/lib/lint-checks.ts:969-979` -- the `checkIncompleteCoverage` JSDoc, which today says the check compares "the two" documents. It describes the shape this change replaces.
- `src/lib/lint-checks.ts:929-940` -- `INCOMPLETE_COVERAGE_SYSTEM_PROMPT`, which today promises the model exactly "two documents". Must acknowledge that the raw side may arrive as several parts.
- `src/lib/lint-checks.ts:1004-1012` and `:1020-1026` -- the two listing `catch` blocks. They `logger.warn` rather than swallow, with the rationale that a broken listing and an empty one must not look alike. The per-snapshot read failure added by this change follows that same convention.
- `src/lib/raw.ts:512-524` (`readRawSourceById`) and `:661-673` (`readRawSource`) -- both throw on absence; read-only here.
- `src/lib/document-extract.ts:446-449` -- `mediaTypeFor`, the neighbour already routed through `ownLookup`. Its rejection of extensionless names is the only reason `:458` is inert today.
- `src/lib/document-extract.ts:452-467` -- `assetFromArchive`; `:458` is the raw index to replace. Callers at `:520` (DOCX) and `:622` (PPTX) both treat `null` as "skip this image", so the return contract does not move.
- `src/lib/document-formats.ts:148-162` -- `ownLookup<T>(table: Record<string, T>, key: string): T | null`, with the prototype-chain rationale in its doc comment. `files` is `Record<string, Uint8Array>`, so the call type-checks and narrows to `Uint8Array | null`.
- `src/lib/document-extract.ts:542-556` -- `resolveArchiveTarget`; `../constructor` from `word/document.xml` resolves to the bare string `constructor`.
- `src/lib/__tests__/lint.test.ts:1235-1502` -- the `checkIncompleteCoverage` suite. `saveRawSource` / `saveRawSourceFor` are the fixture writers; the cap row at `:1490-1494` pins `MAX_COVERAGE_CHECKS` LLM calls and must stay green.
- `src/lib/__tests__/document-extract.test.ts:70-115` -- the DW-254 prototype-member row and the `office(...)` fixture helper to mirror. Note its `expect(asset.mediaType).toMatch(/^image\//)` assertion — the new row matches that strength, not a weaker `typeof` check.

## Tasks & Acceptance

**Execution:**
- `src/lib/lint-checks.ts` -- Replace the first-readable-wins fallback with an accumulator: try the flat `readRawSource(slug)` and push its content when it opens, then loop every id in `snapshotIdsBySlug.get(slug)` pushing each content that opens, skipping duplicates by exact content. Skip the slug when nothing was collected. `logger.warn("lint", ...)` when a listed snapshot fails to read — the two listing catches twelve lines above already log rather than swallow, and a page silently compared against a partial source set is the same lie in a smaller shape. The flat read throwing is the normal case for an Intake-only page and stays silent. -- Every stored Source for the page reaches the comparison, and a partial set is visible rather than silent.
- `src/lib/lint-checks.ts` -- Allocate the `MAX_RAW_CHARS` content budget across the collected Sources with the need-aware split in Design Notes (equal share as a floor, unused share redistributed), then render each part under its own `--- Raw Source: <slug> [flat] ---` / `[snapshot <id>] ---` header in the single existing `callLLM` call. -- A plain even split silently truncates a long Source to `8000/n` while short siblings leave most of the budget unspent, which loses bytes that reach the model today.
- `src/lib/lint-checks.ts` -- Amend `INCOMPLETE_COVERAGE_SYSTEM_PROMPT` so the raw side is described as one or more stored sources shown under their own headers, to be judged together, and update the `checkIncompleteCoverage` JSDoc, which still describes a comparison of "the two" documents. -- The prompt currently promises "two documents"; a multi-part payload without those amendments is a contract neither the model nor the next reader was told about.
- `src/lib/document-extract.ts` -- Change `const bytes = files[target]` to `const bytes = ownLookup(files, target)`, with a comment naming the inherited-member hazard. The comment must say accurately what keeps the line inert today — `mediaTypeFor` returns `null` for every extensionless name, and no `Object.prototype` member name carries an extension — and must not claim the hazard is held off by an orderable pair of checks, because `!bytes || !mediaType` is one combined guard. -- Removes the dependence on a second function's rejection rule and matches the line below it.
- `src/lib/__tests__/lint.test.ts` -- Add rows for the I/O Matrix coverage scenarios: flat-plus-snapshots, multiple snapshots with no flat blob, one unreadable snapshot among two, byte-identical duplicate, and the lone flat Source. Add two budget rows: several Sources all longer than their share (every Source represented, content total within `MAX_RAW_CHARS`), and one oversized flat blob beside short snapshots (the flat blob keeps far more than an equal share, and the short snapshots are whole). Pin the lone-Source row on both sides — the full budget survives AND content past it is dropped — so removing truncation cannot pass it. Assert the rewritten system prompt (`mock.calls[0][0]`) describes several raw sources in at least one row. -- The defect is invisible from the issue list; only the LLM payload shows it, and a lower-bound-only assertion would pass with no budget at all.
- `src/lib/__tests__/document-extract.test.ts` -- Add a row pinning that a DOCX relationship target resolving to a bare `Object.prototype` member yields no asset while a real sibling image still extracts with its own bytes and media type, asserting `mediaType` matches `/^image\//` as the neighbouring DW-254 row does. Its docstring must state plainly that the row is green with and without the `ownLookup` change and say what it actually protects (the outcome, should `mediaTypeFor` ever stop rejecting extensionless names) rather than claiming a reorder proof. -- Behaviour is unchanged today by design; an overclaiming docstring is worse than an honest one.
- Both test files -- Keep the existing single-blank-line spacing between `it(...)` blocks; do not leave a stray double blank line where the new rows are inserted. -- Matches the surrounding files.

**Acceptance Criteria:**
- Given a page with a flat Source and two hashed snapshots, when `checkIncompleteCoverage` samples it, then the single `callLLM` user message contains distinctive text from all three.
- Given a page whose Sources number `n` and whose combined content exceeds `MAX_RAW_CHARS`, when the check runs, then the raw content in the user message totals at most `MAX_RAW_CHARS` characters and every one of the `n` Sources is represented.
- Given a page with one Source far longer than `MAX_RAW_CHARS` and several Sources far shorter than an equal share, when the check runs, then the short Sources appear whole and the long one receives the remaining budget rather than a bare `MAX_RAW_CHARS / n`.
- Given `MAX_COVERAGE_CHECKS + 10` candidate pages, when the check runs, then `callLLM` is called exactly `MAX_COVERAGE_CHECKS` times — unchanged.
- Given a slug whose flat read and every snapshot read throw, when the check runs, then no `callLLM` call is made for it and no error escapes.
- Given a slug with a listed snapshot whose read throws, when the check runs, then a `lint` warning is logged for that snapshot and the readable Sources still reach the comparison.
- Given a DOCX whose relationship `Target` resolves to `constructor`, when the document is extracted, then no asset is produced for it, a real sibling image is unaffected, and no `TypeError` escapes.

## Spec Change Log

### 2026-08-31 — bad_spec repair (review pass 1)

**Triggering finding (medium):** the even split prescribed by the original Design Notes — `Math.max(1, Math.floor(MAX_RAW_CHARS / parts.length))` — never redistributes an unspent share. A page with one 30 000-character flat Source and three 10-character snapshots gives the flat Source 2 000 characters and leaves roughly 5 970 characters of budget unused, so bytes that reach the model today stop reaching it. That is a regression at the exact surface the intent is about, and it was the spec, not the implementation, that named the formula.

**Amended:** Design Notes now prescribe a need-aware split (equal share as a floor, unused share redistributed to the parts that can use it) with the invariant stated explicitly; Tasks gain the budget task, the JSDoc refresh, the snapshot-read warning, the honest DW-365 comment wording, the two budget test rows, the two-sided lone-Source pin, the system-prompt assertion, and the spacing note; Acceptance Criteria gain the redistribution row and the warning row; Code Map gains the JSDoc, the listing-catch convention, and the DW-254 assertion strength. `<intent-contract>` is untouched — every amendment still satisfies its I/O Matrix and its "up to the full `MAX_RAW_CHARS`" status-quo row.

**Known-bad state avoided:** shipping a change that widens which Sources reach the model while narrowing how much of the largest one does, and shipping a DW-365 comment and test docstring that claim a proof neither provides.

**KEEP (must survive re-derivation):**
- The accumulator shape: flat Source first when it opens, then every listed snapshot; dedupe by exact content; `continue` silently when nothing was collected.
- Per-part labelled headers `--- Raw Source: <slug> [flat] ---` and `--- Raw Source: <slug> [snapshot <id>] ---`, with the `--- Wiki Page: <slug> ---` section unchanged after them.
- Exactly one `callLLM` per sampled page; `MAX_COVERAGE_CHECKS` stays a cap on calls and the existing cap row stays green untouched.
- The rewritten `INCOMPLETE_COVERAGE_SYSTEM_PROMPT` multi-source wording.
- `ownLookup(files, target)` at `src/lib/document-extract.ts:458`, no other `files[...]` read touched, nothing newly exported.
- The five behavioural lint rows from pass 1 (flat+snapshots, snapshots-only, one-unreadable, none-readable, duplicate) and the DOCX prototype-target row.

**Carry forward (not this story's problem, to be recorded as deferred on the next pass):** `extractPptx` indexes the same `unzipSync` map with a relationship-derived path at `src/lib/document-extract.ts:592` and `:599`. Verified reachable: a PPTX whose `ppt/_rels/presentation.xml.rels` carries `Target="../constructor"` resolves to the bare key `constructor`, passes the `Boolean(files[slide.path])` filter via the inherited `Object` constructor, and reaches `new TextDecoder().decode(fn)` — an uncaught `TypeError`, which `src/app/api/ingest/document/route.ts` answers with 500 instead of the `ClientInputError` 400, discarding the real slide. Out of scope here: the intent names `document-extract.ts:458` only.

## Review Triage Log

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 1: (high 0, medium 1, low 0)
- patch: 7: (high 0, medium 0, low 7)
- defer: 1: (high 0, medium 1, low 0)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[medium]` `[bad_spec]` Even split never redistributes unused budget, so a long Source loses bytes that reach the model today — Design Notes replaced with a need-aware split, code reverted for re-derivation.
  - `[low]` `[bad_spec]` `checkIncompleteCoverage` JSDoc still describes comparing "the two" documents — folded into the spec amendment.
  - `[low]` `[bad_spec]` A snapshot read that fails is swallowed while the function's own listing catches log — folded into the spec amendment.
  - `[low]` `[bad_spec]` The DW-365 comment and test docstring claim a "reorder of two checks" mechanism the code does not have — folded into the spec amendment.
  - `[low]` `[bad_spec]` The lone-Source budget row pins only a lower bound and passes with truncation removed — folded into the spec amendment.
  - `[low]` `[bad_spec]` The rewritten system prompt has no assertion anywhere (`mock.calls[0][0]` never read) — folded into the spec amendment.
  - `[low]` `[bad_spec]` The oversized-flat-blob-plus-snapshots shape the code comment names as the regression was the one shape untested — folded into the spec amendment.
  - `[low]` `[bad_spec]` Stray double blank line before each new test block — folded into the spec amendment.

## Design Notes

**Budget allocation.** The raw side of the message carries every collected Source, and their combined content must stay within `MAX_RAW_CHARS`. Allocate need-aware rather than uniformly:

```ts
// Equal share is the FLOOR, not the cap: parts shorter than their share
// release the remainder to the parts that can still use it. A flat blob
// beside three tiny snapshots keeps ~7 970 chars, not 2 000; four equally
// oversized Sources still get 2 000 each.
let remaining = MAX_RAW_CHARS;
let left = rawParts.length;
const sized = rawParts.map((part) => {
  const share = Math.max(1, Math.floor(remaining / left));
  const take = Math.min(part.content.length, share);
  remaining -= take;
  left -= 1;
  return { ...part, content: part.content.slice(0, take) };
});
```

Process short parts first so their unspent share reaches the long ones — sort a copy by ascending content length for the allocation, then render in collection order (flat, then snapshots in listing order) so the message shape stays stable. The invariant to hold and to test: every collected Source is represented, and the sum of the rendered content is at most `MAX_RAW_CHARS`. Per-part headers sit outside that budget, exactly as the single `--- Raw Source: <slug> ---` header always did.

Concatenate-then-truncate is the alternative that must not ship: one `.slice(0, MAX_RAW_CHARS)` over the joined Sources pushes every snapshot out behind a long flat blob, which is DW-571 in a new shape.

Shape of the assembled message:

```
--- Raw Source: acme [flat] ---
<allocated chars>

--- Raw Source: acme [snapshot abc123] ---
<allocated chars>

--- Wiki Page: acme ---
<up to MAX_WIKI_CHARS chars>
```

**DW-365 is behaviour-neutral today.** The ledger entry says so and it holds: `mediaTypeFor` returns `null` for every extensionless name, and no `Object.prototype` member name carries an extension, so the old and new code both return `null`. The test row added for it is a characterization pin on the outcome, not a red-then-green proof, and its docstring must say that outright. The value of the change is that the lookup no longer depends on a second function's rejection rule.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/lint.test.ts src/lib/__tests__/document-extract.test.ts` -- expected: all rows pass, including the pre-existing `MAX_COVERAGE_CHECKS` cap row.
- `pnpm lint` -- expected: no new findings in the two changed source files.
- `npx tsc --noEmit` -- expected: no new type errors (`ownLookup(files, target)` narrows to `Uint8Array | null`).

### 2026-08-31 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 1: (high 0, medium 1, low 0)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[low]` `[patch]` The `Math.max(1, …)` share floor guaranteed every part one character, so with more parts than the budget has characters the rendered total exceeded `MAX_RAW_CHARS` — the spec's own invariant, broken at the boundary. Floor changed to `Math.max(0, …)`; the invariant now holds for any part count.
  - `[low]` `[patch]` A flat Source that `listRawSources` reported but `readRawSource` could not open was swallowed while the snapshot failure warned — the same asymmetry the warning was added to remove. Added `flatSlugsOnDisk`, so a listed-but-unreadable flat Source warns and a page with no flat blob stays silent, plus a test row.
  - `[low]` `[patch]` The no-readable-Source row was named "skips a slug silently" while the code does warn, and installed a `logger.warn` spy it never asserted. Renamed and the warning is now asserted.
  - `[low]` `[patch]` Every new row mocked `callLLM` to `"[]"`, leaving the gap → `LintIssue` mapping unverified on the multi-part path. The flagship multi-Source row now returns a real gap payload and asserts the emitted issue.
  - `[low]` `[patch]` The rendering comment claims a stable collection order but no test pinned it. The flat header's position is now asserted ahead of every snapshot header.
  - `[low]` `[patch]` The prototype-target row covered only `constructor`. The fixture now also carries targets resolving to bare `valueOf` and `__proto__` (an inherited accessor), with the same single-surviving-asset assertions.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `checkIncompleteCoverage` now collects EVERY readable Source for a sampled page — the flat `raw/sources/<slug>.md` blob when it opens, plus every hashed `raw/sources/<slug>/<id>.md` snapshot — instead of stopping at the first one that opens, and hands them all to the LLM in the single existing call under per-part `--- Raw Source: <slug> [flat|snapshot <id>] ---` headers. The `MAX_RAW_CHARS` budget is split need-aware (equal share as a floor while budget remains, allocated shortest-first so an unspent share flows to the parts that can use it), so a long Source is not truncated to `8000/n` while short siblings leave the budget unspent. Byte-identical parts are deduped; a listed Source that will not open warns rather than vanishing; a page with nothing readable is still skipped silently. `assetFromArchive` reads the unzipped archive map through `ownLookup(files, target)` instead of a raw index, removing its dependence on `mediaTypeFor` happening to reject extensionless names.

**Files changed.**
- `src/lib/lint-checks.ts` — multi-Source collection, need-aware budget split, per-part headers, `flatSlugsOnDisk` + two warnings, rewritten `INCOMPLETE_COVERAGE_SYSTEM_PROMPT` and refreshed `checkIncompleteCoverage` JSDoc.
- `src/lib/document-extract.ts` — `files[target]` → `ownLookup(files, target)` at `assetFromArchive`, with the hazard and its (honest) current inertness documented.
- `src/lib/__tests__/lint.test.ts` — nine new `checkIncompleteCoverage` rows covering every I/O Matrix scenario plus the two budget behaviours and both warnings.
- `src/lib/__tests__/document-extract.test.ts` — one new row pinning that DOCX relationship targets resolving to `constructor` / `valueOf` / `__proto__` yield no asset while a real sibling image survives intact.

**Review findings breakdown.** Two passes. Pass 1: 1 bad_spec (medium) + 7 low folded into it — the prescribed even split never redistributed an unspent share, so a long flat Source would have lost bytes that reach the model today; code was reverted, Design Notes replaced with the need-aware split, and the code re-derived. Pass 2: 6 patches applied (all low), 1 deferred (medium), 12 rejected.

**Follow-up review recommendation.** Patched this pass: 0 high, 0 medium, 6 low. Score = 3×0 + 6 = 6, which is ≥ 5, so `followup_review_recommended: true`.

**Verification.**
- `pnpm vitest run src/lib/__tests__/lint.test.ts src/lib/__tests__/document-extract.test.ts` — 106 passed, including the untouched `MAX_COVERAGE_CHECKS` cap row (still exactly 20 calls).
- `npx tsc --noEmit` — exit 0.
- `pnpm lint` — exit 0 (the three `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing repo noise from unrelated `.tsx` files).
- Mutation checks confirmed the budget rows are load-bearing: removing the shortest-first sort fails the redistribution row, and removing truncation fails all three budget rows.

**Residual risks.**
- DW-365 is behaviour-neutral today and its test row is a characterization pin, green with and without the change. No input can separate the two versions through the public entry point, because `mediaTypeFor` returns `null` for every extensionless name and no `Object.prototype` member name carries an extension. The row's docstring says so outright.
- The number of collected Sources per page is deliberately uncapped, because the intent is to compare every readable snapshot. A page with very many Intake arrivals therefore gets a proportionally smaller slice of each, and the per-part headers sit outside the `MAX_RAW_CHARS` content budget exactly as the single header always did. Each sampled page also now issues one read per snapshot rather than one read total.
- A concurrent `bmad-loop` session committed part of this work into its own sweep commit `8c75f2d5` while the run was in flight; `src/lib/document-extract.ts` and the pass-1 test rows landed there. The remainder is committed by this run. `src/cli.ts` was left modified by that other session and is untouched here.
