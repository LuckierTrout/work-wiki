---
title: 'DW-766: truthful private purpose-save failures'
type: 'bugfix'
created: '2026-09-09'
status: 'done'
baseline_commit: '3e786d97090347b012d30b0dee485c3b761c2c2d'
context: []
---

## Intent and authorization

The user approved continuing independent fixes starting with DW-766 after the
merge/decision recommendation. A purpose save can expose raw registry storage
errors to the owner, including absolute paths. Replace those failures with
safe typed outcomes, preserving diagnostic causes server-side and making
incomplete recovery distinct from an unconfirmed save.

This packet extends only the previously deferred purpose authority branches.
Historical specs, ledger rows, configuration, dependencies and identifiers remain
unchanged. No production data, deployment or write-safety architecture changes.
Publication/merge of this follow-on fix is separate from the specifically
approved merges of PRs #16 and #17.

## Contract

- Keep pre-write authentication, read-only, validation and conflict refusals.
- Catch registry resolution failure for purpose saves at both the real route and
  the writer's under-lock read; do not leak diagnostics or write the draft.
- Keep the existing marker-last ordering and compensation. A marker write can
  commit then throw: successful compensation does not prove effective authority
  is unchanged. Report an unconfirmed save and ask the owner to preserve the
  draft, reload, and check the stored version before another save.
- If restoring old bytes or removing a newly created artifact fails, return a
  distinct incomplete-recovery message, retaining both errors as server causes.
- Return constants selected by typed/name-matched guards, never caught messages.
  These storage failures remain HTTP 500 with private/no-store responses.
- Do not modify the shared registry/put helpers or change unrelated artifact
  callers. Do not promise atomicity, no side effects, or safe automatic retry.

## Code map and tasks

- [x] `src/lib/wikis.ts`: three safe outcomes and name guards; wrap the purpose
  registry read, marker failure and compensation failure at their call sites.
- [x] `src/app/api/workbench/artifact/route.ts`: catch purpose lookup failures;
  translate typed outcomes into safe constant responses with diagnostic logging.
- [x] `src/lib/__tests__/purpose-save-failure.test.ts`: real route → kernel →
  temporary filesystem composition; only authentication and fault injection
  are controlled. Never replace the writer/registry with mocks.
- [x] Verify focused and full suites, typecheck, lint, production build and browser
  composition; review the resulting code and record actual evidence.

## Acceptance matrix

| Case | Required result |
| --- | --- |
| Route registry read fails | Safe context error; draft not written |
| Writer registry read fails | Same safe outcome; no draft write |
| Marker rejects before write | Previous artifact restored, save remains unconfirmed |
| Marker commits then throws | No false unchanged claim; retained marker and compensated bytes inspected |
| Artifact restoration fails | Distinct recovery error; both causes retained |
| Previously absent artifact | Compensation removes new bytes; deletion failure is distinct |
| Successful legacy-purpose save | Draft and authority marker land; normal response and version increment |
| Existing refusal contracts | Existing schema/precondition suites continue to pass |

## Verification

Focused: purpose-save-failure, wiki-schema-edit, workspace-purpose-canonicalization.
Run `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm exec tsc --noEmit` after build,
`pnpm test:e2e`, and `git diff --check`. Use synthetic fixtures and the installed
local runtime; no provider credentials or external test effects.


## Local completion evidence

- Focused real-route/kernel and existing precondition suites: **81 tests passed**.
- Full suite: **406 files, 10,093 tests passed, one existing credential-dependent
  skip**; 117.05 seconds. No new skipped case or mock fallback.
- Full lint passed with the three existing JSX analysis diagnostics. Production
  build and the subsequent standalone TypeScript check passed.
- Browser suite: **26 passed**, using local synthetic identity/data. These cover
  the normal owner journey; the injected failure matrix is exercised by the
  real route → kernel → filesystem suite, not browser network mocks.
- Local diff review checked response privacy, both registry reads, marker-write
  ambiguity, restore/delete compensation, retained diagnostic causes and
  preservation of the existing precondition/read-only paths. No additional
  in-scope defect found. This is a local review, not an independent agent review.
- `git diff --check` passed. No ledger edits; its SHA-256 remains
  `383e6c1110e550015797c5e3520c8a2115afbd54944d4de5c85a321323f20740`.

Status `done` means this local implementation and verification packet is complete.
It is not published, merged or deployed. It does not make the purpose/registry
writes transactional; an unconfirmed outcome still requires checking stored state.
