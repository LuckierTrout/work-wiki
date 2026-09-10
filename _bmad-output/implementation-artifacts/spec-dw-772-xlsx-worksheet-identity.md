---
title: 'DW-772: preserve worksheet data when XLSX relationships are invalid'
type: 'bugfix'
created: '2026-09-09'
status: 'in-review'
baseline_commit: '3ea23aaaa05991f9713714e5ed0b024be10f22c3'
---

## Intent and authorization

The owner authorized DW-772 after approving the next-step list. An XLSX sheet
relationship targeting sharedStrings.xml can suppress actual worksheets and
produce an empty table. Refuse unrelated members as worksheet selections, using
the inline extractor's existing admitted numbered worksheet-part contract.
The prior DW-724/744 spec remains historical and unchanged.

<intent-contract>
- Relationship-selected worksheets must be admitted xl/worksheets/sheetN.xml
  parts with stored bytes. Explicit non-worksheet relationship types and
  external relationships do not select local worksheets. Preserve typeless
  relationships accepted by the current parser.
- Preserve valid sheet names/order, absolute and relative targets, shared/inline
  strings, genuine empty worksheets and the numbered fallback when no valid
  relationship-selected worksheet remains.
- Carry fallback bytes directly so a case-variant admitted archive key does not
  turn into a nonexistent reconstructed lowercase key.
- Test the real XLSX extraction entry and inline XLSX-within-ZIP composition.
  No worksheet members means ClientInputError, not an invented empty worksheet.
- No sidecar, format expansion, dependency, runtime configuration or ledger edits.
</intent-contract>

## Implementation and acceptance

`src/lib/document-extract.ts` filters relationships and member identity, and
carries selected bytes into worksheet parsing. The new worksheet-identity suite
covers shared-string misdirection, valid/invalid mixtures, relationship type
and external mode, case-sensitive fallback, absent/empty sheets, and nested ZIP
extraction. Existing document-extract tests cover cell representations.

The inline reader continues to support numbered sheet XML parts only, matching
archiveEntryKind. This does not change the sidecar spreadsheet reader.

## Verification

Run focused document extraction suites, full tests, lint, typecheck and build.
Record results and local review before publication. CI must pass at the published
head. Follow-on merge/deployment is separate from the specifically requested
completion of DW-766.


## Implementation and local verification result

Implemented member/relationship selection checks and direct fallback-byte use.
Local review checked parity with archiveEntryKind, valid relationship ordering,
case-sensitive archive lookup, no-sheet errors and preservation of genuine empty
worksheets. No further in-scope defect found; this was a local review, not an
independent agent review.

- Focused: **28 tests passed in two suites**, including eight new extraction cases.
- Final combined baseline includes merged DW-766 at `1b8b67af`.
- Full suite: **407 files, 10,101 passed, one existing credential skip**;
  125.33 seconds. An earlier concurrent full run hit the existing five-second
  owner-session-actors timeout. Sequential verification passed without changing
  timeouts, assertions or product behavior to accommodate that failure.
- Full lint passed with the three existing JSX diagnostics. Production build
  using synthetic public identity configuration and subsequent standalone
  TypeScript check passed.
- Negative control: restoring the old extractor emitted an empty worksheet and
  failed the direct and nested-ZIP data-preservation tests. The fix was restored.
- Tests use actual zipped XML bytes and the public inline extraction entry paths.
  No sidecar/provider invocation or external effects are needed for this packet.
- Whitespace checks passed; ledger SHA-256 remains
  `383e6c1110e550015797c5e3520c8a2115afbd54944d4de5c85a321323f20740`.

Published-head CI and merge disposition are recorded on the PR. Local success
is not deployment or production write-safety acceptance.
