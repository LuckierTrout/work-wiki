---
title: 'Advertised-input validation parity: bulk-import MIME arm and lint-fix type gates'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
baseline_revision: '04bf3f06081556b5dbffa8bc6d8f62e3da50ccc8'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      mcp-http's `fix_lint_issue` gates `type` but still spreads its arguments
      through a bare cast, so a non-string `slug` or `target` reaches the fix
      handlers unvalidated.
    evidence: |-
      `run` in `src/lib/mcp-http.ts` now calls `autoFixRefusal(a.type, ...)`,
      then hands the rest through `...(a as { type: string; slug: string; ... })`.
      `dispatchMcp` validates `tools/call` arguments nowhere, so
      `{"type":"orphan-page","slug":7}` still reaches `fixOrphanPage(7)` — the
      same failure `POST /api/lint/fix` now refuses at the door. Out of scope
      here: DW-348's intent names `type` only.
    location: >-
      src/lib/mcp-http.ts:521
    severity: medium
  - summary: >-
      POST /api/lint/fix resolves a principal for its owner gate but never
      passes it as `author`, so every REST-initiated fix is attributed to the
      default "lint-fix" while both MCP doors stamp the caller's handle.
    evidence: |-
      `route.ts` calls `getPrincipal()` for `isOwnerHandle`, then invokes
      `fixLintIssue(type, slug ?? "", targetSlug, message)` with no fifth
      argument, defaulting `author` to `"lint-fix"` (`src/lib/lint-fix.ts`).
      `handleFixLintIssue` receives `author: p!.handle` on both MCP doors, so
      the same fix is attributed differently depending on which door ran it.
      Pre-existing; unchanged by this story.
    location: >-
      src/app/api/lint/fix/route.ts:157
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Two doors validate less than they advertise. Bulk import's `accept` attribute offers 21 MIME types, but `validationError` branches on the filename extension alone, so an extension-less `application/pdf` the picker admits is refused client-side even though `/api/ingest/document` accepts it (DW-347). And all three lint-fix doors take `type` on trust — `POST /api/lint/fix` parses the body with no schema at all, `mcp-http.ts`'s `fix_lint_issue` declares a free-form string, and `src/mcp.ts` validates against `ALL_CHECK_TYPES` rather than the fixable subset — leaving `ownEntry` inside `fixLintIssue` as the sole defense (DW-348).

**Approach:** Make the bulk-import client gate consult `detectDocumentFormat(name, type)` — via `isSupportedDocument` — exactly as the server does, and badge the resolved format when only the MIME arm matched. Then give each lint-fix door a `type` gate keyed on `AUTO_FIXABLE_CHECK_TYPES` that refuses before `fixLintIssue` runs, reusing one exported refusal-sentence helper so the recognized-but-not-fixable explanations are not hand-copied into the doors.

## Boundaries & Constraints

**Always:**
- Client acceptance and server acceptance agree in BOTH directions: `selectBulkDocuments` accepts a file iff `isSupportedDocument(file.name, file.type)` is true. Derive from `@/lib/document-formats`; never restate a format list.
- `POST /api/lint/fix` keeps answering 400 with the `NOT_AUTO_FIXABLE` explanation for a recognized-but-not-fixable type (`disputed-page`'s owner clear path must stay on the wire) and 400 with `Auto-fix not supported for this issue type` for anything else.
- The refusal sentences stay owned by `src/lib/lint-fix.ts`; doors call the exported helper rather than re-deriving text.
- `handleFixLintIssue` keeps its `type: string` parameter — the gate belongs at the doors, not the handler.
- Read-only and owner gates in `src/app/api/lint/fix/route.ts` stay ordered ahead of body validation.

**Block If:**
- Pinning the new client gate would require changing `detectDocumentFormat`'s own precedence (extension arm before MIME arm).

**Never:**
- Do not touch `workers/email-ingest/` or its duplicated allowlist.
- Do not add or remove entries in `ALL_CHECK_TYPES` / `AUTO_FIXABLE_CHECK_TYPES`, or in the route docstring's ten-bullet inventory (`prose-inventory-parity.test.ts` pins it).
- Do not add runtime imports to `src/lib/document-formats.ts` or `src/lib/lint-types.ts` — both are leaf modules that client bundles import.
- Do not introduce a generic MCP argument validator; gate `fix_lint_issue` only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| MIME-only bulk file | `File` named `report` (no dot), `type: "application/pdf"` | `selectBulkDocuments` accepts it; manifest badge reads `pdf` | No error expected |
| MIME-only, unsupported type | `File` named `blob`, `type: "application/x-msdownload"` | Rejected with the derived formats sentence | Rejection reason names every supported format |
| Extension wins over MIME | `File` named `notes.MARKDOWN`, `type: "text/plain"` | Accepted; badge stays `markdown` (raw extension, not `md`) | No error expected |
| Empty file with good MIME | `File` named `report`, `type: "application/pdf"`, size 0 | Rejected as empty — size check stays first | Reason is `The file is empty.` |
| Route: non-fixable type | `POST /api/lint/fix {"type":"disputed-page","slug":"contested-page"}` | 400, body carries the `disputedClearInstruction` clear path | `fixLintIssue` is never called |
| Route: unknown type | `POST /api/lint/fix {"type":"made-up-type","slug":"p"}` | 400 `Auto-fix not supported for this issue type` | `fixLintIssue` is never called |
| Route: non-string type | `POST /api/lint/fix {"type":["orphan-page"],"slug":"p"}` | 400 `Auto-fix not supported for this issue type` | No dispatch, no coercion |
| Route: non-object body | `POST /api/lint/fix` with body `null` or `"hi"` | 400 with a field-shaped message | 500/TypeError must not occur |
| Route: non-string slug | `POST /api/lint/fix {"type":"orphan-page","slug":7}` | 400 naming the invalid field | Handler never runs |
| MCP HTTP door | `tools/call fix_lint_issue {"type":"low-confidence","slug":"p"}` | Tool result `isError: true` carrying the low-confidence explanation | `handleFixLintIssue` never called |
| MCP stdio door | `fix_lint_issue` with `type: "disputed-page"` | SDK schema rejection — `type` is `z.enum(AUTO_FIXABLE_CHECK_TYPES)` | Refused before the handler |

</intent-contract>

## Code Map

- `src/lib/bulk-document-import.ts` -- `validationError` (:97-103) branches on `documentExtension(file.name)` only; `documentExtension` (:86-89) returns the raw extension or `"file"`. `ACCEPTED_DOCUMENT_ATTRIBUTE` (:34-37) already joins extensions AND `SUPPORTED_DOCUMENT_MIME_TYPES`. Both fixes land here.
- `src/lib/document-formats.ts` -- READ-ONLY reuse: `detectDocumentFormat(filename, contentType?)` (extension arm, then alias, then MIME arm) and `isSupportedDocument`. Zero-import leaf module — safe to import from client code. Do not edit.
- `src/components/BulkDocumentImport.tsx:506` -- manifest badge `{documentExtension(item.file.name)}`; pass `item.file.type` so a MIME-only accept badges its format.
- `src/lib/__tests__/bulk-document-import.test.ts` -- the parity suite. The `it.each` table at :106-140 asserts `isSupportedDocument(name)` === client accept; extend with MIME rows (helper `file()` at :18 builds `new File` with no `type` — needs a `type` argument).
- `src/components/__tests__/bulk-document-accept-parity.test.tsx:87` -- calls `documentExtension("sample.ext")` with one argument; the new `contentType` parameter must stay optional.
- `src/lib/lint-fix.ts` -- `FIX_HANDLERS` (:707), `NOT_AUTO_FIXABLE` (:733), `ownEntry` (:785, own-property + `typeof` guard), `fixLintIssue` (:796-814). Export the refusal helper from here.
- `src/lib/lint-types.ts` -- `ALL_CHECK_TYPES`, `AUTO_FIXABLE_CHECK_TYPES` (const tuples, `satisfies readonly LintIssue["type"][]`). Read-only.
- `src/app/api/lint/fix/route.ts:54-56` -- `const body = await req.json(); const { type, slug, targetSlug, message } = body;` then `fixLintIssue(...)` at :82. Owner gate :59-63, read-only gate :74-79 — keep both ahead of parsing. Zod is NOT yet imported here.
- `src/lib/mcp-http.ts` -- `str()` (:138) and `schema()` (:139-146) build advertised JSON Schema; `tools/call` (:1001-1029) calls `tool.run` with NO schema validation, so the gate must live in the tool's own `run`. `fix_lint_issue` def at :485-503.
- `src/mcp.ts:2474-2495` -- `server.registerTool("fix_lint_issue", …)`; `type: z.enum(ALL_CHECK_TYPES)` at :2465-ish is the line to narrow. `handleFixLintIssue` at :1219-1227 must keep `type: string` (`src/lib/__tests__/mcp.test.ts:2995` passes `"made-up-type"`).
- `src/lib/__tests__/lint-fix-route.test.ts` -- pins the `disputed-page` 400 + clear path, the generic-fallthrough negative, the owner gate and the read-only gate. All must stay green unchanged.

## Tasks & Acceptance

**Execution:**
- `src/lib/bulk-document-import.ts` -- give `documentExtension` an optional `contentType` parameter that falls back to `detectDocumentFormat(filename, contentType)` when the raw extension is not itself supported, and switch `validationError` to `isSupportedDocument(file.name, file.type)`; update the two doc comments that currently claim extension-only behaviour -- closes the client-narrower-than-server gap DW-246 left behind.
- `src/components/BulkDocumentImport.tsx` -- pass `item.file.type` to the manifest badge call -- a MIME-only accept must not badge `file`.
- `src/lib/lint-fix.ts` -- export `autoFixRefusal(type: unknown, slug: string): string | null` returning `null` for a fixable type, the `NOT_AUTO_FIXABLE` sentence for a recognized one, and the generic sentence otherwise; make `fixLintIssue` use it so the doors and the dispatcher share one source of refusal text -- prevents the doors hand-copying refusal prose.
- `src/app/api/lint/fix/route.ts` -- parse the body with a zod object whose `type` is `z.enum(AUTO_FIXABLE_CHECK_TYPES)` and whose `slug`/`targetSlug`/`message` are optional strings; on failure answer 400 with `autoFixRefusal`'s sentence when the raw `type` explains itself, else a field-named schema message -- refuses before `fixLintIssue` and before a malformed body can reach a handler.
- `src/lib/mcp-http.ts` -- advertise `enum: [...AUTO_FIXABLE_CHECK_TYPES]` on `fix_lint_issue`'s `type` property and refuse in its `run` via `autoFixRefusal` before calling `handleFixLintIssue` -- this transport validates nothing generically, so the gate has to be per-tool.
- `src/mcp.ts` -- narrow `fix_lint_issue`'s `type` to `z.enum(AUTO_FIXABLE_CHECK_TYPES)` and describe the valid list the way `lint_wiki` describes its own -- the SDK then refuses before `handleFixLintIssue`.
- `src/lib/__tests__/bulk-document-import.test.ts` -- add MIME-arm rows to the parity table (extension-less `application/pdf`, unsupported MIME, extension-beats-MIME, empty-file-with-good-MIME) and a badge assertion -- pins both directions of the client/server agreement.
- `src/lib/__tests__/lint-fix-route.test.ts` -- add rows for unknown type, non-string type, non-object body and non-string slug, each asserting 400 and that the response never reaches a handler -- pins the new door gate without disturbing the existing `disputed-page` rows.
- `src/lib/__tests__/mcp.test.ts` -- add a `fix_lint_issue` MCP-HTTP `tools/call` row proving a non-fixable type is refused with its explanation and `handleFixLintIssue` is not reached -- the HTTP transport's gate has no other observer.

**Acceptance Criteria:**
- Given a `File` whose name carries no extension but whose `type` is a supported MIME type, when it is passed to `selectBulkDocuments`, then it is accepted and `/api/ingest/document` would accept it too.
- Given any file, when the client gate and `isSupportedDocument(file.name, file.type)` are compared, then they agree in both directions.
- Given a `POST /api/lint/fix` body whose `type` is not in `AUTO_FIXABLE_CHECK_TYPES`, when the route runs, then it answers 400 and `fixLintIssue` is never invoked.
- Given a `POST /api/lint/fix` body with `type: "disputed-page"`, when the route runs, then the 400 body still contains `PATCH /api/wiki/contested-page with metadata { disputed: false }`.
- Given a `tools/call` for `fix_lint_issue` with a non-fixable `type`, when `dispatchMcp` runs, then the result is an error carrying that type's explanation and `handleFixLintIssue` is not called.
- Given the stdio MCP server, when `fix_lint_issue`'s input schema is inspected, then `type` enumerates exactly `AUTO_FIXABLE_CHECK_TYPES`.

## Design Notes

`documentExtension` keeps its raw-extension-first shape so the manifest badge still shows what the user actually dropped (`notes.markdown` badges `markdown`, not `md`); only the previously-`"file"` branch gains the MIME fallback:

```ts
export function documentExtension(filename: string, contentType?: string): string {
  const ext = extension(filename);
  if (SUPPORTED_EXTENSIONS.has(ext)) return ext;
  return detectDocumentFormat(filename, contentType) ?? "file";
}
```

The route's refusal keeps its message even though the schema is the gate — parse first, then let the raw `type` explain itself:

```ts
const raw: unknown = await req.json().catch(() => null);
const parsed = LINT_FIX_REQUEST.safeParse(raw);
if (!parsed.success) {
  const type = (raw as { type?: unknown } | null)?.type;
  const slug = (raw as { slug?: unknown } | null)?.slug;
  const refusal = autoFixRefusal(type, typeof slug === "string" ? slug : "");
  return NextResponse.json({ error: refusal ?? fieldMessage(parsed.error) }, { status: 400 });
}
```

`refusal` is `null` only when the type IS fixable, i.e. when some other field failed — which is exactly when the schema message is the useful one.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/bulk-document-import.test.ts src/components/__tests__/bulk-document-accept-parity.test.tsx` -- expected: all pass, including the new MIME-arm rows
- `npx vitest run src/lib/__tests__/lint-fix-route.test.ts src/lib/__tests__/lint-fix.test.ts src/lib/__tests__/mcp.test.ts src/components/__tests__/lint-check-parity.test.tsx src/lib/__tests__/prose-inventory-parity.test.ts` -- expected: all pass, existing `disputed-page` rows unchanged
- `npx tsc --noEmit` -- expected: no errors
- `npm run lint` -- expected: no new errors

## Auto Run Result

Status: done

### Summary

Two advertised-but-unvalidated doors now validate what they offer.

**DW-347.** Bulk import's `accept` attribute advertises 21 MIME types alongside the
extensions, but the client gate branched on the filename alone, so an
extension-less `application/pdf` the picker admitted was refused client-side
though `/api/ingest/document` accepts it. `validationError` now asks the
server's own question, `isSupportedDocument(file.name, file.type)`, and
`documentExtension` takes an optional `contentType` so a MIME-only match badges
its resolved format instead of `file`. The raw extension still wins where it is
itself supported, so `notes.markdown` keeps badging `markdown`.

**DW-348.** All three lint-fix doors now refuse a bad `type` before
`fixLintIssue` runs. `POST /api/lint/fix` parses its body with a zod schema
whose `type` is `z.enum(AUTO_FIXABLE_CHECK_TYPES)`; `mcp-http.ts`'s
`fix_lint_issue` advertises the same enum and enforces it in its own `run`
(that transport validates `tools/call` arguments nowhere); `src/mcp.ts` narrows
its registration from `ALL_CHECK_TYPES` to the fixable subset. A new exported
`autoFixRefusal` owns the refusal sentences so the two HTTP doors keep the
recognized-but-not-fixable explanations — including `disputed-page`'s
copy-pasteable clear path — on the wire rather than hand-copying them.

### Files changed

- `src/lib/bulk-document-import.ts` -- `validationError` consults
  `isSupportedDocument(name, type)`; `documentExtension` gains an optional
  `contentType` with a `detectDocumentFormat` fallback on the `"file"` branch.
- `src/components/BulkDocumentImport.tsx` -- manifest badge passes
  `item.file.type`.
- `src/lib/lint-fix.ts` -- exports `autoFixRefusal`; `fixLintIssue` throws
  through it; `ownEntry`'s doc premise corrected.
- `src/app/api/lint/fix/route.ts` -- `LINT_FIX_REQUEST` zod schema, non-JSON
  bodies answer 400 rather than 500, refusals keep their explanatory sentence.
- `src/lib/mcp-http.ts` -- `fix_lint_issue` advertises and enforces the fixable
  enum; description points at `lint_wiki`'s `suggestion` for the rest.
- `src/mcp.ts` -- stdio registration narrowed to `AUTO_FIXABLE_CHECK_TYPES`,
  with the accepted cost of the SDK refusal recorded at the enum.
- `src/lib/__tests__/bulk-document-import.test.ts` -- MIME parity table, derived
  sweep over all 21 advertised MIME types, precedence and ordering rows.
- `src/components/__tests__/bulk-document-accept-parity.test.tsx` -- mounted
  badge assertion; the queueability check now drives the gate.
- `src/lib/__tests__/lint-fix-route.test.ts` -- door-gate rows against a
  `fixLintIssue` spy, malformed-body rows, `slug ?? ""` pins.
- `src/lib/__tests__/mcp-http.test.ts` -- the HTTP door's type-gate rows.
- `src/lib/__tests__/mcp.test.ts` -- stdio schema and InMemoryTransport rows.
- `src/lib/__tests__/lint-checks.test.ts` -- two stale comments scoped to
  `lint_wiki`.

### Review findings

- Patches applied: 11 (medium 6, low 5)
- Items deferred: 2 (both medium) -- mcp-http's unvalidated `slug`/`target`,
  and the route not attributing fixes to the resolved principal
- Items rejected: 13
- intent_gap: 0, bad_spec: 0

Follow-up review recommended: **true** (patched: high 0, medium 6, low 5;
score = 3x6 + 1x5 = 23, threshold 5).

### Verification

- `npx vitest run src/lib/__tests__/bulk-document-import.test.ts src/components/__tests__/bulk-document-accept-parity.test.tsx` -- 34/34 passed
- `npx vitest run src/lib/__tests__/lint-fix-route.test.ts src/lib/__tests__/lint-fix.test.ts src/lib/__tests__/mcp.test.ts src/components/__tests__/lint-check-parity.test.tsx src/lib/__tests__/prose-inventory-parity.test.ts` -- 378/378 passed
- `npx tsc --noEmit` -- clean
- `npm run lint` -- clean (only the pre-existing `jsx-ast-utils` TSNonNullExpression warnings)
- Full suite -- 274 files / 6247 tests passed
- Matrix audit -- every I/O matrix row maps to a named test that ran and passed
- Mutation check -- reverting the badge call site, the client gate, the stdio
  enum, both tool descriptions, the mcp-http gate and `slug ?? ""` produced 18
  targeted failures; restored and re-verified green

### Residual risks

- The stdio MCP door now answers an SDK validation error, not the
  `NOT_AUTO_FIXABLE` prose, for the five non-fixable types. This is deliberate
  and recorded at the enum: a schema error is raised over `type` alone and so
  cannot interpolate the sibling `slug` the sentence must name, while
  `checkDisputedPages` already emits `disputedClearInstruction(entry.slug)` in
  the issue's own `suggestion` with the real slug.
- `POST /api/lint/fix` refuses `disputed-page` at the door rather than in the
  dispatcher. The message is byte-identical (same `autoFixRefusal` owner), but
  an observer expecting the dispatcher to be invoked would see a difference.
- Body parsing is non-strict: unknown keys are stripped, not rejected. The REST
  door reads `targetSlug` while both MCP doors read `target`, a pre-existing
  spelling difference this change does not close.
- Bulk-import acceptance now depends on `File.type`, which the picker populates
  but some drag-and-drop sources leave empty. An extension-less file dropped
  without a content type is still refused, with the generic formats sentence.
