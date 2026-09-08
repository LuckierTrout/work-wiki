---
title: 'Derive the lint fixable-type set and the bulk-import document allowlist'
type: 'bugfix'
created: '2026-08-20'
baseline_revision: 'bf8be0333c6fdc9338cded452bd61eea5b97e62d'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `POST /api/lint/fix`'s JSDoc is a sixth un-derived restatement of the fixable
      list and names only five of the ten types.
    evidence: |-
      `src/app/api/lint/fix/route.ts:17-30` lists `missing-crossref`, `orphan-page`,
      `stale-index`, `empty-page` and `contradiction` under "Supported issue types",
      omitting `broken-link`, `missing-concept-page`, `stale-page`, `unmigrated-page`
      and `supersedes-dangling` — the very type DW-229 was about. This story derived
      every executable copy of the list and left the one an integrator reads. It is a
      doc comment, so nothing observes it; the repo's own convention for pinning a
      prose inventory it cannot generate is `prose-inventory-parity.test.ts`.
    location: >-
      src/app/api/lint/fix/route.ts:17
    severity: medium
  - summary: >-
      Bulk import's `accept` advertises 21 MIME types its validator never consults, so
      a file the picker admits by content type alone is still refused client-side.
    evidence: |-
      `validationError` (`src/lib/bulk-document-import.ts`) branches only on
      `documentExtension(file.name)` and ignores `file.type` entirely, while
      `ACCEPTED_DOCUMENT_ATTRIBUTE` now derives from extensions AND
      `SUPPORTED_DOCUMENT_MIME_TYPES`. An extension-less file carrying
      `application/pdf` therefore passes the picker and is rejected by the manifest,
      though `detectDocumentFormat` at `/api/ingest/document` accepts it on the MIME
      arm. This is the residual half of DW-246's class (client narrower than server);
      the intent named the list, not the MIME arm, so it is out of this story's scope.
    location: >-
      src/lib/bulk-document-import.ts:80
    severity: medium
  - summary: >-
      The two untrusted lint-fix doors accept an unvalidated `type` even though
      `AUTO_FIXABLE_CHECK_TYPES` now exists as a tuple to validate against.
    evidence: |-
      `src/app/api/lint/fix/route.ts:54-56` destructures `type` off a raw
      `await req.json()` with no schema at all, and `src/lib/mcp-http.ts:490` declares
      it as free-form `str(...)`. `src/mcp.ts:2465` does validate, but against
      `z.enum(ALL_CHECK_TYPES)` rather than the fixable subset. The `ownEntry` guard
      added by this story is currently the only defense; `z.enum(AUTO_FIXABLE_CHECK_TYPES)`
      at the door would make it a second line rather than the sole one.
    location: >-
      src/app/api/lint/fix/route.ts:54
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Two hand-copied allowlists have drifted from the sources they mirror. `LintIssueCard`'s nine-entry `fixableTypes` omits `supersedes-dangling`, which `fixLintIssue` really does auto-fix, so that check renders with no Fix button (DW-229). `src/lib/bulk-document-import.ts` keeps its own 11-entry `SUPPORTED_EXTENSIONS` missing `odt/ods/odp/epub/org/rtf/mobi`, restates the narrow list in its rejection copy, and `BulkDocumentImport.tsx` carries a fourth hand-written `accept` string — so dragging `plan.odt` into bulk import is refused client-side even though POSTing it to `/api/ingest/document` succeeds (DW-246).

**Approach:** Give each list one declaration and derive every consumer from it. For lint, add `AUTO_FIXABLE_CHECK_TYPES` to the browser-safe `src/lib/lint-types.ts` and make `fixLintIssue`'s dispatch a `Record` keyed by it, so an entry without a handler (or a handler without an entry) fails to compile; `LintIssueCard` imports the const. For documents, lift the format tables out of `document-extract.ts` (which transitively reaches `storage`/`llm` and cannot enter a client bundle) into a dependency-free `src/lib/document-formats.ts`, re-export them from `document-extract.ts` so existing importers are untouched, and derive the bulk allowlist, the rejection copy, and the `accept` string from it.

## Boundaries & Constraints

**Always:** Every consumer list is derived at build or runtime from its single declaration — no new literal restating another list, including in tests. `document-formats.ts` stays import-free (no `./constants`, no `fflate`) so it is safe in a client bundle. `document-extract.ts` keeps exporting every symbol it exports today, at the same names.

**Block If:** Deriving the bulk allowlist from `SUPPORTED_DOCUMENT_EXTENSIONS` would require changing what `/api/ingest/document` accepts.

**Never:** Do not change `ALL_CHECK_TYPES`, `DOCUMENT_FORMATS`, `MIME_FORMATS`, `EXTENSION_ALIASES`, or `DOCUMENT_FORMAT_LABELS` membership. Do not touch `workers/email-ingest/index.ts` (its duplication is forced — the Worker bundle cannot reach `src/lib`). Do not edit `SCHEMA.md` (already accurate at ten fixable checks). Do not give `disputed-page`, `low-confidence`, `duplicate-entity`, `uncited-claims`, or `incomplete-coverage` an auto-fix.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Dangling supersedes issue | `LintIssueCard` given `{ type: "supersedes-dangling", slug }` | Renders a Fix button; clicking calls `onFix` with the issue | No error expected |
| Human-only check | `LintIssueCard` given `{ type: "disputed-page" }` (or any type outside `AUTO_FIXABLE_CHECK_TYPES`) | Renders no button at all | No error expected |
| Fixable but under-specified | `{ type: "broken-link" }` or `"missing-crossref"`/`"contradiction"` with `target` absent | No Fix button — the endpoint would 400 | No error expected |
| OpenDocument drag | `selectBulkDocuments([File "plan.odt"])` | Accepted; `documentExtension("plan.odt") === "odt"` | No error expected |
| Alias extension | `documentExtension("notes.MARKDOWN")` | `"markdown"` (lower-cased, kept as its own display token) | No error expected |
| Unsupported drag | `selectBulkDocuments([File "malware.exe"])` | Rejected; reason names every `DOCUMENT_FORMAT_LABELS` value and nothing else | Reason string, no throw |
| File input `accept` | `BulkDocumentImport` file input / drop zone | `accept` lists every supported extension (dot-prefixed) and every supported MIME type | No error expected |

</intent-contract>

## Code Map

- `src/lib/lint-types.ts` -- browser-safe, type-only-import home of `ALL_CHECK_TYPES` (DW-75's fix). Add `AUTO_FIXABLE_CHECK_TYPES` + `AutoFixableCheckType` here, same `as const satisfies readonly LintIssue["type"][]` shape.
- `src/lib/lint-fix.ts:670-730` -- `fixLintIssue`'s `switch`. Ten fixable cases delegate to the exported `fix*` functions above (`fixOrphanPage`:48, `fixStaleIndex`:85, `fixEmptyPage`:132, `fixMissingCrossRef`:153, `fixContradiction`:263, `fixMissingConceptPage`:330, `fixBrokenLink`:407, `fixStalePage`:471, `fixUnmigratedPage`:529, `fixSupersededDangling`:615); five throw bespoke `FixValidationError` copy; `default` throws "Auto-fix not supported for this issue type". Imports `./wiki`, `./lifecycle`, `./llm` — server-only, never importable by the card.
- `src/components/LintIssueCard.tsx:25-46` -- the hand-copied `fixableTypes` (nine) and `fixLabel` map (nine). `isFixable` at :68-75 adds per-type `target`/message preconditions — keep those verbatim.
- `src/lib/document-extract.ts:7-131` -- `DOCUMENT_FORMATS`, `MIME_FORMATS`, `EXTENSION_ALIASES`, `SUPPORTED_DOCUMENT_EXTENSIONS`, `SUPPORTED_DOCUMENT_MIME_TYPES`, `DOCUMENT_FORMAT_LABELS`; `extension()`:164, `ownLookup()`:183, `detectDocumentFormat()`:187, `isSupportedDocument()`:201. Module head imports `fflate`, `./vision` (→`./storage`, `./llm`) — this is why a client module cannot import it.
- `src/lib/bulk-document-import.ts:6-17,34-36,44-52` -- the 11-entry `SUPPORTED_EXTENSIONS`, `documentExtension` (returns `"file"` sentinel), and `validationError`'s narrow rejection sentence.
- `src/components/BulkDocumentImport.tsx:25,331,342,507` -- `ACCEPTED_DOCUMENTS` (fourth copy) feeding two `accept=` attributes; `documentExtension` renders the manifest badge.
- `src/lib/__tests__/bulk-document-import.test.ts:46` -- pins the stale rejection wording; must be re-pointed at derived labels.
- `src/components/__tests__/lint-check-parity.test.tsx:139-176` -- the DW-75/DW-76 parity suite; its closing describe documents the `fixableTypes` hazard in prose without asserting it.
- `src/lib/__tests__/lint-fix.test.ts:871-878` -- pins `default` → "Auto-fix not supported"; keep passing.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts`, `src/lib/__tests__/prose-inventory-parity.test.ts` -- import the format symbols from `document-extract`; the re-export must keep them green untouched.

## Tasks & Acceptance

**Execution:**
- `src/lib/lint-types.ts` -- add `AUTO_FIXABLE_CHECK_TYPES` (the ten types `fixLintIssue` really dispatches) and the `AutoFixableCheckType` alias -- one browser-safe home both the dispatcher and the card can import.
- `src/lib/lint-fix.ts` -- replace the fixable arm of `fixLintIssue`'s `switch` with a `Record<AutoFixableCheckType, handler>` and the human-only arm with a `Record<Exclude<LintIssue["type"], AutoFixableCheckType>, string>` message map, keeping every existing message verbatim (`disputed-page` still interpolates the slug) and keeping `default` for unknown strings -- makes drift a compile error in both directions.
- `src/components/LintIssueCard.tsx` -- import `AUTO_FIXABLE_CHECK_TYPES`; delete the local set; type `fixLabel` as `Record<AutoFixableCheckType, string>` and add the `supersedes-dangling` label ("Clear reference") -- a fixable type can no longer land without a label.
- `src/lib/document-formats.ts` -- NEW, zero imports except `import type`: move `DOCUMENT_FORMATS`, `DocumentFormat`, `MIME_FORMATS`, `EXTENSION_ALIASES`, `SUPPORTED_DOCUMENT_EXTENSIONS`, `SUPPORTED_DOCUMENT_MIME_TYPES`, `DOCUMENT_FORMAT_LABELS`, `extension`, `ownLookup`, `detectDocumentFormat`, `isSupportedDocument` here, comments intact -- the client-safe half of the extractor.
- `src/lib/document-extract.ts` -- import what it still uses from `./document-formats` and re-export the public symbols under the same names -- existing importers and the two parity tests keep compiling unchanged.
- `src/lib/bulk-document-import.ts` -- drop the local `SUPPORTED_EXTENSIONS`; derive membership from `SUPPORTED_DOCUMENT_EXTENSIONS`, the rejection sentence from `DOCUMENT_FORMAT_LABELS`, and export a derived `ACCEPTED_DOCUMENT_ATTRIBUTE` (dot-extensions + MIME types) -- one source, three consumers.
- `src/components/BulkDocumentImport.tsx` -- import `ACCEPTED_DOCUMENT_ATTRIBUTE` and delete the literal `ACCEPTED_DOCUMENTS` -- removes the fourth copy.
- `src/lib/__tests__/bulk-document-import.test.ts` -- re-point the `:46` wording assertion at derived labels and add allowlist-parity cases (`plan.odt` accepted, every `SUPPORTED_DOCUMENT_EXTENSIONS` entry accepted, `accept` covers both derived lists) -- the I/O matrix's document rows.
- `src/components/__tests__/lint-check-parity.test.tsx` -- replace the prose-only hazard note with mounted assertions: a Fix button for every `AUTO_FIXABLE_CHECK_TYPES` entry, none for the rest, and the target/message preconditions -- the I/O matrix's lint rows.
- `src/lib/__tests__/lint-fix.test.ts` -- add a case asserting every non-fixable `ALL_CHECK_TYPES` entry rejects with `FixValidationError` and never with the generic "not supported" text -- pins the message map against the card's silence.

**Acceptance Criteria:**
- Given a lint run that reports `supersedes-dangling`, when the issue list renders, then that card offers a Fix button whose click reaches `POST /api/lint/fix` and succeeds.
- Given a new entry added to `AUTO_FIXABLE_CHECK_TYPES` with no handler in `lint-fix.ts` or no label in `LintIssueCard`, when `tsc` runs, then the build fails.
- Given `pnpm test`, when the suite runs, then `email-ingest-allowlist-parity.test.ts` and `prose-inventory-parity.test.ts` pass with no edits to either file.
- Given a file whose extension `/api/ingest/document` would accept, when it is dropped into bulk import, then it is queued rather than rejected, and the reverse holds for one it would reject.

## Spec Change Log

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 5, low 2)
- defer: 3: (high 0, medium 3, low 0)
- reject: 16: (high 0, medium 0, low 16)
- addressed_findings:
  - `[medium]` `[patch]` `ownEntry` ran its key through `ToPropertyKey`, so a non-string `type` off the route's unvalidated `req.json()` (e.g. `["orphan-page"]`) coerced and DISPATCHED a real page mutation — behaviour the replaced `switch`'s strict equality was immune to. Added a `typeof key !== "string"` guard plus dispatcher tests for an array against both tables and a `toString`-bearing object.
  - `[medium]` `[patch]` `broken-link` was the only `AUTO_FIXABLE_CHECK_TYPES` entry no test routed through `fixLintIssue`; re-pointing its table key at `fixMissingCrossRef` (identical signature, `tsc`-clean) would append a link where the fix removes one, with a green suite. Added a dispatcher case asserting the dead link is gone from what `writeWikiPageWithSideEffects` received, a live sibling link survives, and no `## Related` section appears.
  - `[medium]` `[patch]` Nothing asserted that the two `<input type="file">` elements carry `ACCEPTED_DOCUMENT_ATTRIBUTE` — the exact "underived and untested" surface DW-246 named. Added `src/components/__tests__/bulk-document-accept-parity.test.tsx`, which mounts the component and compares each rendered `accept` against the derived constant.
  - `[medium]` `[patch]` The format TABLE was shared but the DETECTION was not: `documentExtension` kept `split(".").pop()` against the server's trimming regex, so a dot-less file named `org` passed the client then 400'd, and `"notes.md "` was refused client-side though the endpoint accepts it. Switched to the shared `extension()`; badging (`notes.MARKDOWN` → `markdown`) is unchanged and now pinned.
  - `[medium]` `[patch]` `document-formats.ts`'s zero-import invariant — the spec's own **Always** and the module's whole reason for existing — was asserted in prose only. Added `src/lib/__tests__/document-formats-client-safety.test.ts`, which reads the source back and flags any static import, static re-export, dynamic `import(` or `require(`, naming the offending `file:line`.
  - `[low]` `[patch]` `expect(button.textContent).toBeTruthy()` passed for the generic `"Fix"` fallback its comment claimed to exclude. Dropped it; the distinctness case now carries that claim explicitly.
  - `[low]` `[patch]` `DOCUMENT_FORMAT_LABELS`'s docblock still said "Four hand-written sentences" after this change added a fifth, generated consumer. Updated to name `SUPPORTED_FORMATS_SENTENCE` while keeping the can-import/cannot-import distinction.

## Design Notes

`AUTO_FIXABLE_CHECK_TYPES` is not a fourth copy because nothing else names that set: the `Record<AutoFixableCheckType, handler>` in `lint-fix.ts` is exhaustive-and-closed at compile time, so the const *is* the dispatcher's shape. Pair it with the `Exclude<...>` message map and a new `ALL_CHECK_TYPES` entry cannot land without an explicit fixable-or-not decision.

```ts
// src/lib/lint-fix.ts — sketch
type FixHandler = (c: { slug: string; targetSlug?: string; message?: string; author: string }) => Promise<FixResult>;
const FIX_HANDLERS: Record<AutoFixableCheckType, FixHandler> = {
  "orphan-page": (c) => fixOrphanPage(c.slug, c.author),
  "supersedes-dangling": (c) => fixSupersededDangling(c.slug, c.author),
  // …
};
const NOT_FIXABLE: Record<Exclude<LintIssue["type"], AutoFixableCheckType>, (slug: string) => string> = { /* verbatim copy */ };
```

`document-formats.ts` mirrors what `lint-types.ts` did for DW-75: the list's old home pulls in server-only modules, so the list moves to a leaf module and the old home re-exports. `MAX_DOCUMENT_SIZE` stays in `./constants` — `bulk-document-import.ts` already imports it directly, so `document-formats.ts` needs no imports at all.

`documentExtension` keeps its `"file"` sentinel and keeps returning the raw extension (so `notes.markdown` still badges "markdown", not "md") — only its membership test changes.

## Verification

**Commands:**
- `pnpm test` -- expected: full suite green, including `bulk-document-import`, `lint-fix`, `lint-check-parity`, `email-ingest-allowlist-parity`, `prose-inventory-parity`, `document-extract`, `document-extract-parity`.
- `pnpm exec tsc --noEmit` -- expected: no errors (this is what enforces the two exhaustive `Record`s).
- `pnpm lint` -- expected: no new errors.

## Auto Run Result

Status: done

### Summary

Both hand-copied allowlists now have exactly one declaration, with every consumer derived from it and `tsc` closing the loop in both directions.

**DW-229 (lint).** `AUTO_FIXABLE_CHECK_TYPES` lands in the browser-safe `src/lib/lint-types.ts`, and `fixLintIssue`'s 15-arm `switch` becomes `Record<AutoFixableCheckType, FixHandler>` plus `Record<Exclude<LintIssue["type"], AutoFixableCheckType>, …>` — so an entry without a handler, a handler without an entry, or a new `ALL_CHECK_TYPES` member with no fixable-or-not decision all fail to compile. `LintIssueCard` reads the same const, and `supersedes-dangling` now renders its Fix button ("Clear reference").

**DW-246 (documents).** `document-extract.ts` transitively reaches `./vision` → `./storage`/`./llm`, so the intent's premise that the client "CAN import `SUPPORTED_DOCUMENT_EXTENSIONS`" directly does not hold as written. The tables moved to a new zero-import leaf module `src/lib/document-formats.ts` (the same move `lint-types.ts` made for DW-75), with `document-extract.ts` re-exporting an identical public surface so no existing importer or parity test changed. The bulk allowlist, the rejection sentence, and the `accept` string all derive from it — `plan.odt` is now accepted client-side, and the fourth copy is gone.

### Files changed

- `src/lib/lint-types.ts` -- added `AUTO_FIXABLE_CHECK_TYPES` and the `AutoFixableCheckType` alias.
- `src/lib/lint-fix.ts` -- `switch` → two exhaustive `Record`s dispatched through a prototype- and coercion-safe `ownEntry`; every rejection message verbatim.
- `src/components/LintIssueCard.tsx` -- local `fixableTypes` deleted; `fixLabel` is total over `AutoFixableCheckType`; per-type `target`/message preconditions unchanged.
- `src/lib/document-formats.ts` -- NEW, zero imports: the format tables, `extension`, `ownLookup`, `detectDocumentFormat`, `isSupportedDocument`.
- `src/lib/document-extract.ts` -- re-exports the moved symbols under the same names.
- `src/lib/bulk-document-import.ts` -- allowlist, `SUPPORTED_FORMATS_SENTENCE` and `ACCEPTED_DOCUMENT_ATTRIBUTE` all derived; `documentExtension` now uses the shared `extension()`.
- `src/components/BulkDocumentImport.tsx` -- both `accept=` attributes read the derived constant.
- `src/lib/__tests__/bulk-document-import.test.ts` -- stale wording pin replaced by derived-label parity, plus `plan.odt`, every supported extension, dot-less and padded filenames, and `accept` set-equality.
- `src/components/__tests__/lint-check-parity.test.tsx` -- prose-only hazard note replaced by mounted assertions: a Fix button per fixable type, zero for the complement, distinct labels, preconditions.
- `src/lib/__tests__/lint-fix.test.ts` -- self-referential `uiFixableTypes` copy removed; derived human-only rejection suite, the missing `broken-link` dispatcher case, and non-string `type` coverage.
- `src/components/__tests__/bulk-document-accept-parity.test.tsx` -- NEW: mounts the component and pins each rendered `accept`.
- `src/lib/__tests__/document-formats-client-safety.test.ts` -- NEW: reads the leaf module's source back and fails on any value import.

### Review findings breakdown

- Patches applied: 7 (0 high, 5 medium, 2 low) — see the Review Triage Log.
- Items deferred: 3 (all medium) — recorded in frontmatter `deferred`.
- Items rejected: 16 (all low by consequence) — chiefly cosmetic or pre-existing: unreachable defensive branches, a newly-widened but unused export, the derived sentence's word order versus the route's hand-written one, and suggestions to re-pin button label text that the removed self-referential test never actually pinned.
- Follow-up review recommended: **true**. Patched counts: high 0, medium 5, low 2. Score = 3 x 5 + 1 x 2 = 17, which is >= 5.

### Verification

- `npx vitest run` -- 259 files / 5596 tests passed (baseline 257/5582). `email-ingest-allowlist-parity.test.ts` and `prose-inventory-parity.test.ts` pass with zero edits, confirming the re-export shim preserved the public surface.
- `npx tsc --noEmit` -- exit 0. Probed by temporarily adding `disputed-page` to `AUTO_FIXABLE_CHECK_TYPES`: it failed in three places at once (missing label, missing handler, extra `NOT_AUTO_FIXABLE` key), then reverted.
- `npx eslint` -- exit 0 (only pre-existing `jsx-ast-utils` `TSNonNullExpression` notices).
- Matrix audit: all seven I/O rows are covered by tests that ran and passed in the run above.
- Each behavioural patch was mutation-probed rather than trusted green: removing the `typeof` guard, re-pointing `"broken-link"` at `fixMissingCrossRef`, re-pasting a literal into one `accept=`, reverting `documentExtension`, and adding an import to `document-formats.ts` each failed exactly its intended test and nothing else.

### Residual risks

- The rejection sentence now names all sixteen formats in `DOCUMENT_FORMAT_LABELS` declaration order, so it is longer than the old nine-format one and orders formats differently from the route's hand-written sibling sentence. Correct per the I/O matrix and required by "derive the copy"; if it reads long in the UI that is a copy decision, not a code one.
- `document-formats.ts` is a new public address for `detectDocumentFormat`/`isSupportedDocument`. `document-extract.ts` re-exports them, so both paths work; a future reader could import either.
- The three deferred items are all in the same class this story addressed but sit outside the two lists the intent named.
