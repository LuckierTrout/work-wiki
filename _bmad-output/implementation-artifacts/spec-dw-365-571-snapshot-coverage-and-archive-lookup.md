---
title: 'DW-571/DW-365: compare every readable Source in coverage lint, and read the archive map through ownLookup'
type: 'bugfix'
created: '2026-08-31'
status: 'in-review'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
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
