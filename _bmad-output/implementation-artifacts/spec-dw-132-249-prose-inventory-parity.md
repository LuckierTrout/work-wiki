---
title: 'Pin the six hand-written prose inventories against their machine sources'
type: 'chore'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A fifth supported-format sentence lives in the bulk importer and is already
      stale, and the private allowlist behind it is narrower than the app's.
    evidence: |-
      `src/lib/bulk-document-import.ts:48` returns "Use Markdown, TXT, HTML, PDF,
      DOCX, PPTX, XLSX, CSV, or ZIP." from `validationError`, and its private
      `SUPPORTED_EXTENSIONS` (:6-18) omits odt/ods/odp/epub/mobi/org/rtf. So bulk
      upload rejects files `POST /api/ingest/document` accepts. The bundle intent
      enumerated exactly four format sites, so this one was out of scope for this
      pass; it is the same drift class and the only one already out of sync.
      Adopting it means deriving the sentence from the set it actually describes,
      not from `DOCUMENT_FORMAT_LABELS`.
    location: >-
      src/lib/bulk-document-import.ts:48
    severity: medium
  - summary: >-
      `MAINTAIN_FIX_TYPES` has no omission pin and the task-consumer README
      restates the same `lintType` list in unpinned prose.
    evidence: |-
      `src/lib/tasks.ts:213` builds `new Set<MaintainFixType>([...])`, which
      rejects extra members but not omitted ones — the exact half `AssertNever`
      was added to cover for `TASK_KINDS` one screen above. A ninth fix type
      wired into `src/lib/maintenance.ts` but forgotten here makes `parseTask`
      return null at :440, so the enqueued task is treated as poison and goes to
      the DLQ, with `tsc` silent. `workers/task-consumer/README.md:48-50`
      restates the eight fix types in prose and nothing reads it — a seventh
      inventory of the same shape as the six this pass pinned.
    location: >-
      src/lib/tasks.ts:213
    severity: medium
  - summary: >-
      The bulk-import file picker advertises formats the very next step refuses.
    evidence: |-
      `src/components/BulkDocumentImport.tsx:25-26` puts `.org,.rtf,.odt,.ods,
      .odp,.epub,.mobi` in the `accept` attribute of both file inputs, but
      `documentExtension` (`src/lib/bulk-document-import.ts:33-36`) maps all of
      them to "file", so `selectBulkDocuments` rejects them. Nothing compares the
      `accept` list to the allowlist. Pre-existing; surfaced while enumerating
      format sites.
    location: >-
      src/components/BulkDocumentImport.tsx:25
    severity: low
  - summary: >-
      The bulk importer's only copy test restates the sentence as a literal, so
      it can never fail on drift.
    evidence: |-
      `src/lib/__tests__/bulk-document-import.test.ts:45` asserts
      `/Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX, CSV, or ZIP/i` — a literal
      that would have to be edited alongside the very change it is meant to
      catch. This is the pattern `prose-inventory-parity.test.ts`'s header
      explicitly rules out; it would be replaced by adopting the site.
    location: >-
      src/lib/__tests__/bulk-document-import.test.ts:45
    severity: low
baseline_revision: '2c72132f0884b8510d37f38d759b5ba8ded06ef0'
---

<intent-contract>

## Intent

**Problem:** Six hand-written prose inventories restate machine lists with nothing pinning them: `src/mcp.ts`'s header comment names every MCP tool, `workers/task-consumer/README.md` names every `Task` kind, and four sites — `workers/email-ingest/index.ts`, `workers/email-ingest/README.md`, `src/components/EmailIngestSettings.tsx`, `src/app/api/ingest/document/route.ts` — restate the supported document formats. Adding or retiring a tool, task kind, or format leaves each of these silently stale (DW-132, DW-249).

**Approach:** Establish ONE convention — read the prose out of the file, tokenize it, and compare the token set to a machine-derived set — and apply it to all six sites from a single new test file. Where no runtime source of truth exists yet (the `Task` union is types-only; the format labels are undeclared), export one from the module that owns it so the comparison has something real to compare against.

## Boundaries & Constraints

**Always:** Every machine side of a comparison must be *derived*, never a literal restated in the test — a restated literal would have to be edited alongside the change it is supposed to catch. Comparisons are bidirectional (a prose entry with no machine counterpart fails too). Every failure carries a message naming the file and the drifted entries. Existing prose wording stays as it is: this bundle pins what is written, it does not rewrite it.

**Block If:** A prose site turns out to disagree with its machine source today in a way that cannot be settled from the code alone (i.e. it is unclear whether the prose or the machine list is wrong).

**Never:** Do not change the four format sentences, the `src/mcp.ts` header, or either README's wording. Do not make `workers/*` import from `src/lib` (the Worker bundles cannot). Do not edit the deferred-work ledger. Do not add a second convention — all six sites go through the same helper.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| All six in sync | Repo as-is today | Every parity test passes | No error expected |
| Format added | `docx2` added to `DOCUMENT_FORMATS` | `tsc` fails on the exhaustive label map until a label is added; then all four format-site tests fail naming `DOCX2` as unmentioned | Assertion message lists the missing label and the file |
| Tool retired | A `server.registerTool` call deleted from `src/mcp.ts` while the header keeps its line | Header parity test fails naming the extra prose entry | Assertion message lists prose-only names |
| Task kind added | New arm added to the `Task` union | `tsc` fails until `TASK_KINDS` gains the kind; then the README test fails naming it | Assertion message lists the missing kind |
| Prose reworded past the anchor | An anchor phrase (e.g. `Supported attachments:`) is edited away | Extraction fails loudly with "no format sentence found in <file>" | Explicit failure, never a silently empty token set |

</intent-contract>

## Code Map

- `src/lib/document-extract.ts` -- `DOCUMENT_FORMATS` (:7-22, `as const`), `EXTENSION_ALIASES` (:72), `SUPPORTED_DOCUMENT_EXTENSIONS` (:84, derived). The four format sentences enumerate `DOCUMENT_FORMATS` (16 entries), not the 18-entry extension list — aliases `markdown`/`htm` fold into "Markdown"/"HTML". No display-label table exists yet; add one here.
- `src/lib/tasks.ts` -- `Task` discriminated union (:25-155, 11 top-level `kind` arms). Types-only: no runtime kind list exists. Note the nested `staged.kind` (:51) is a *different* axis (pdf/image/text/document) and must not leak into the task-kind list. `parseTask`'s switch (:268-546) has one `case` per kind — the runtime mirror.
- `src/mcp.ts` -- header comment `Tools:` block (:4-45), one ` *   name — description` line per tool; ends at the blank comment line before ` * Usage:`. `createMcpServer()` is the machine side.
- `src/lib/__tests__/mcp-annotations.test.ts` -- **the precedent to follow** (:39-63): reads a repo file, strips JSDoc gutters, collapses whitespace, regex-extracts, compares to `Object.keys((server as any)._registeredTools)`. Reuse the gutter-strip + collapse idiom and the private-field access idiom verbatim.
- `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` -- sibling convention for machine-vs-machine parity; the new file is its prose-vs-machine counterpart. Note its header comment style (why the duplication is forced, what drifted for real).
- `workers/email-ingest/index.ts` -- prose at :240, anchored `Supported attachments: <LIST>.`
- `workers/email-ingest/README.md` -- prose at :7-9, anchored `<LIST> attachments are forwarded`.
- `src/components/EmailIngestSettings.tsx` -- prose at :209-210, JSX `<li>` wrapped across lines, anchored `<LIST> attachments are included.`
- `src/app/api/ingest/document/route.ts` -- prose at :54, anchored `Unsupported document type. Use <LIST>.` (note: `or RTF`, not `and RTF`).
- `workers/task-consumer/README.md` -- prose at :10-15, backticked kinds between ``` `src/lib/tasks.ts`: ``` and `This worker imports`.
- `.github/workflows/ci.yml:47` -- CI runs `pnpm exec tsc --noEmit`, so compile-time exhaustiveness assertions are enforced.
- `vitest.config.ts` -- `.test.ts` under `src/**/__tests__/` runs in the node project; `.test.tsx` is the dom project. The new file is `.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/lib/document-extract.ts` -- export `DOCUMENT_FORMAT_LABELS: Record<DocumentFormat, string>` mapping each format to the token the prose uses (`md` → `Markdown`, `org` → `Org`, everything else upper-case: `TXT`, `HTML`, `PDF`, `DOCX`, `PPTX`, `XLSX`, `CSV`, `ZIP`, `ODT`, `ODS`, `ODP`, `EPUB`, `RTF`, `MOBI`) -- `Record<DocumentFormat, …>` is exhaustive at compile time, so a new format cannot land without a label, and the prose tests then name it. Comment why it lives here and who reads it.
- `src/lib/tasks.ts` -- export `TASK_KINDS` (`as const`) listing the 11 top-level kinds, with type-level assertions in BOTH directions against `Task["kind"]` (no missing kind, no extra) -- the union has no runtime form, so the README has nothing to be compared against without it; CI's `tsc --noEmit` is what makes the assertions bite.
- `src/lib/__tests__/prose-inventory-parity.test.ts` -- new file holding the whole convention: one `readProse(relativePath)` helper (read repo-relative file, strip comment gutters, collapse whitespace), one `extract(text, anchor, file)` helper that throws a named error when the anchor does not match, one `tokenize(list)` helper (split on `,` and `/`, strip a leading `and `/`or `, drop empties), and one `expectSameSet(actual, expected, file)` assertion. Drive all six sites through them: four format sentences vs `Object.values(DOCUMENT_FORMAT_LABELS)`, the `src/mcp.ts` `Tools:` block vs `createMcpServer()`'s registered tool names, and `workers/task-consumer/README.md`'s backticked kinds vs `TASK_KINDS`. Add one extra case pinning `TASK_KINDS` against `parseTask`'s `case "<kind>":` labels so `pnpm test` alone catches a kind that never reaches the executor.
- `src/lib/__tests__/prose-inventory-parity.test.ts` -- cover the I/O matrix's edge cases directly: assert the extractor throws on a missing anchor, and assert the tokenizer keeps `ODT/ODS/ODP` as three tokens and strips the `and `/`or ` conjunction -- these are the two ways a "passing" test could actually be asserting nothing.

**Acceptance Criteria:**
- Given the repo as it stands, when `pnpm test` runs, then every case in `prose-inventory-parity.test.ts` passes without any prose file having been edited.
- Given a format label is removed from one of the four sentences, when the suite runs, then exactly that site's case fails with a message naming the file and the missing label — and the other three still pass, proving the four are checked independently.
- Given a tool is registered in `src/mcp.ts` without a header line, when the suite runs, then the header case fails naming the unlisted tool.
- Given `TASK_KINDS` and the `Task` union disagree, when `pnpm exec tsc --noEmit` runs, then it reports an error at the assertion in `src/lib/tasks.ts`.

## Spec Change Log

## Design Notes

Generating the sentences from the set was considered and rejected for these six sites: two are Markdown READMEs, two are comments, and one is a Cloudflare Worker that cannot import `src/lib`. Only the JSX site could consume a generated string, so generating would leave five sites unpinned and add a *second* convention. Reading-and-comparing is the one convention that reaches all six.

The extractors are anchor-based on purpose. An anchor that stops matching is a hard failure with a named file, not an empty token set that compares equal to nothing — see the matrix row.

Shape of the shared assertion:

```ts
const expectSameSet = (actual: string[], expected: string[], where: string) => {
  const missing = expected.filter((e) => !actual.includes(e));
  const extra = actual.filter((a) => !expected.includes(a));
  expect(missing, `${where} does not mention: ${missing.join(", ")}`).toEqual([]);
  expect(extra, `${where} mentions entries that do not exist: ${extra.join(", ")}`).toEqual([]);
};
```

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/prose-inventory-parity.test.ts` -- expected: all cases pass
- `pnpm exec tsc --noEmit` -- expected: no errors (proves the exhaustive label map and the `TASK_KINDS` assertions compile)
- `pnpm exec vitest run src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/mcp-annotations.test.ts src/lib/__tests__/mcp-http.test.ts src/lib/__tests__/tasks.test.ts src/lib/__tests__/document-extract.test.ts` -- expected: unchanged, all pass (the touched modules gained exports only)
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done

**Summary.** Six hand-written prose inventories that restated a machine list with nothing pinning them are now pinned by one convention: read the prose back out of the file, tokenize it, and compare the token set — in both directions — to a set derived from the code. Two of the six had no runtime source of truth to compare against, so one was added for each. No prose file was edited: all six already agreed with their machine sources, so this pass is purely the pin.

**Files changed**

- [`src/lib/document-extract.ts`](../../src/lib/document-extract.ts) -- added exported `DOCUMENT_FORMAT_LABELS: Record<DocumentFormat, string>`; the `Record` key type makes it exhaustive at compile time, so a format cannot land without a prose label.
- [`src/lib/tasks.ts`](../../src/lib/tasks.ts) -- added exported `TASK_KINDS`/`TaskKind`, pinned to the types-only `Task` union in both directions (`satisfies readonly Task["kind"][]` rejects extras; `AssertNever<Exclude<Task["kind"], TaskKind>>` rejects omissions), enforced by CI's `tsc --noEmit`.
- [`src/lib/__tests__/prose-inventory-parity.test.ts`](../../src/lib/__tests__/prose-inventory-parity.test.ts) -- new, 16 cases. Shared helpers (`readSourceLines`/`readProse`, `extract`, `extractBlock`, `tokenize`, `expectSameSet`) drive all six sites: the four format sentences vs the label map, `src/mcp.ts`'s `Tools:` block vs `createMcpServer()`'s registrations, and `workers/task-consumer/README.md` vs `TASK_KINDS` — plus a runtime pin of `TASK_KINDS` against `parseTask`'s dispatch switch and guard cases for the helpers themselves.

**Review findings breakdown:** 12 patches applied (3 medium, 9 low), 4 items deferred (2 medium, 2 low), 6 rejected. 0 intent gaps, 0 spec repairs.

**Follow-up review recommended:** true. Patched by severity — high 0, medium 3, low 9; score `3 × 3 + 1 × 9 = 18`, which is at or above the threshold of 5.

**Verification.** `tsc --noEmit` clean; `eslint` exit 0 (three pre-existing `jsx-ast-utils` notices from untouched JSX); full `vitest run` 5553 passed across 257 files. `pnpm exec` is broken in this working copy (`ERROR packages field missing or empty`, unrelated to this change), so the binaries were run directly from `node_modules/.bin` — CI invokes the same ones.

Every case was mutation-verified rather than merely observed green, each mutation reverted:

| Injected drift | Result |
|---|---|
| `EPUB` dropped from `workers/email-ingest/README.md` only | that one case fails naming the file and `EPUB`; the other three sites pass, proving they are checked independently |
| `MOBI` label removed from the map | the runtime exhaustiveness case fails, and all four sites fail "mentions entries that do not exist: MOBI" |
| `wiki_graph` header line replaced by an unregistered `ghost_tool` | header case fails naming the unlisted tool |
| `phantom-kind` added to `workers/task-consumer/README.md` | task-kind case fails "mentions entries that do not exist" |
| `case "create-backup":` deleted from `parseTask` | switch case fails naming the undispatched kind |
| `Supported attachments:` anchor reworded | hard failure "no format sentence found in …", never a silently empty set |
| a second `Supported attachments:` sentence added | "ambiguous format sentence … matches 2 times" |
| an em dash inserted inside a tool description | no phantom tool — the pre-patch parser would have invented one |
| a second string switch appended to `tasks.ts` | its `case` labels are not counted — the pre-patch anchor would have counted them |
| kind removed from / bogus kind added to `TASK_KINDS` | `tsc` fails at `src/lib/tasks.ts` (TS2344 / TS2322) |
| `docx2` added to `DOCUMENT_FORMATS` | `tsc` fails at the label map (TS2741) |

Every row of the I/O & Edge-Case Matrix is covered by a case that ran and passed. The "format added" row's compile-time half was additionally given a runtime case (`names every supported format exactly once`), so `pnpm test` alone catches it rather than waiting on CI's typecheck.

**Residual risks**

- The task-kind extractor filters backticked spans to `^[a-z]+(-[a-z]+)*$` so the `op: "staleness"` parenthetical is excluded. A future kind in another casing would drop off the prose side — but it then fails as "does not mention", which is the safe direction.
- Both new exports (`DOCUMENT_FORMAT_LABELS`, `TASK_KINDS`) are consumed only by the test today. That is inherent to read-back pinning: the two sites that could consume a generated sentence are two of six, and generating for them would split the convention the intent asked to be single.
- The pin is on working-tree source text, so the failure mode shifts from silent drift to a broken anchor when a sentence is reworded. That is deliberate and loud — `extract` throws naming the file — but it is a maintenance surface that did not exist before.
