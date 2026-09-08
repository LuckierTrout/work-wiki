---
title: 'Authz gate and copy tails (DW-389, DW-392)'
type: 'bugfix'
created: '2026-08-28'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
baseline_revision: '0e62e034c7f4773e0deecc996e75c2eabd7d8d3a'
deferred:
  - summary: >-
      `spec-dw-75-76-lint-check-parity-and-disputed-surface.md`'s golden example
      still quotes the pre-DW-389 `disputed-page` suggestion verbatim.
    evidence: |-
      Line 144 of that done spec reproduces the old one-line `suggestion`
      template, which no longer matches `checkDisputedPages` now that the clause
      comes from `disputedClearGuidance`. It reads as a record of what DW-76
      built rather than a live expectation, and DW-389's decision authorised
      renegotiating only `spec-dw-121-230-269-270-…`, so it was left as recorded
      rather than edited. A reader consulting that spec for the current copy gets
      the version the realm gate falsified.
    location: >-
      _bmad-output/implementation-artifacts/spec-dw-75-76-lint-check-parity-and-disputed-surface.md:140-146
    severity: low
  - summary: >-
      `SCHEMA.md` still carries the unqualified "clear it with the Disputed
      toggle" instruction DW-121 falsified.
    evidence: |-
      The `disputed-page` entry in the lint-check reference says clearing is
      "done via the Disputed toggle in the page editor (`PATCH /api/wiki/<slug>`
      with metadata `{ disputed: false }`)" with no admin/service qualification.
      DW-389 enumerated the two lint COPY sites (`lint-fix.ts`, `lint-checks.ts`)
      and both now render `disputedClearGuidance`; this is a third, reader-facing
      site of the same falsified sentence, in documentation rather than lint
      output, and it was already wrong before this change.
    location: >-
      SCHEMA.md:633-641
    severity: medium
  - summary: >-
      Under the armed E2E cookie identity there is no `ClerkProvider`, so every
      client identity gate — Revert now included — fails closed for the E2E owner.
    evidence: |-
      `src/app/layout.tsx:88` renders the shell WITHOUT `<ClerkProvider>` when
      `isE2eIdentityArmed()`, while `middleware.ts` admits the owner from the
      `yopedia_e2e` cookie. `useViewerHandle` reads Clerk, so `isSignedIn` and
      `handle` are unavailable on that path: Delete and Re-ingest were already
      hidden from the E2E owner for this reason, and DW-392's signed-in term
      extends the same blind spot to Revert. Nothing breaks today — neither
      `e2e/workbench-owner.spec.ts` nor `e2e/retired-routes.spec.ts` exercises an
      article affordance — but an E2E case that ever does will see a control the
      server would admit.
    location: >-
      src/app/layout.tsx:88, src/lib/viewer-handle.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two tails the DW-121/DW-269 authz pass deliberately left open. `canRevert` in `src/components/RevisionHistory.tsx:99` is `isSiteOwner || !realmDeniesRevert` with no signed-in term, so an anonymous viewer of a public artifact or an agent-scoped page is still shown Revert and its irreversible-sounding confirm in front of a write the middleware 401s (DW-392). Separately, the `disputed-page` guidance in `src/lib/lint-fix.ts:836` and the check's own `suggestion` in `src/lib/lint-checks.ts:727` both tell the reader to clear the Disputed toggle with a `PATCH /api/wiki/<slug>` that DW-121 now refuses for every non-admin, non-service principal on a public knowledge page (DW-389).

**Approach:** Add the signed-in term to `canRevert`, mirroring `ArticleActions`'s `isLoaded && isSignedIn`, and record in `spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md` that its frozen "no ownership term on Revert" clause was deliberately renegotiated for the signed-in half only. Rewrite both `disputed-page` copy sites from ONE exported clause in the client-safe `src/lib/lint-types.ts`, so the guidance names who can actually complete the PATCH and the two sites cannot drift again.

## Boundaries & Constraints

**Always:**
- The Revert gate stays NARROWER than the server, never wider: signed-out is refused, and the site owner (an admin server-side) keeps the door on realm pages.
- `isSignedIn` is read only through `@/lib/viewer-handle` and guarded by `isLoaded`, exactly as `ArticleActions` does — no second `useUser` in the island.
- `RevisionHistory.tsx` / `RevisionItem.tsx` stay free of `@/lib/commons`, `@/lib/authz`, `@/lib/wiki`; the realm keeps arriving as a required prop.
- Both `disputed-page` copy sites read the same exported clause — closing only one leaves half the instruction wrong.
- Prose that these changes falsify is rewritten in the same edit: the `realmDeniesRevert` prop docblock, the `checkDisputedPages` docblock, and the `NOT_AUTO_FIXABLE` comment above the `disputed-page` entry.

**Block If:**
- Adding the signed-in term would hide Revert from a viewer the server admits. (It does not: `src/middleware.ts` exempts `POST /api/wiki/<slug>/revisions` from the private-deployment gate ONLY when a `Bearer` credential is present (`isBearerMachineWrite`), so a session-less browser POST is answered 401 "Authentication required." before the route runs — re-confirm this in `middleware.ts` before assuming otherwise.)

**Never:**
- Do not add an OWNERSHIP term to Revert. The renegotiation covers the signed-in half only; `isOwner`/`ownsOrContributes` stay out.
- Do not change `REVERT_READ_ONLY_COPY`, `WRITE_DENIAL*` wording, the realm predicate, or `belongsInCommons`.
- Do not make `disputed-page` auto-fixable, and do not touch the other `NOT_AUTO_FIXABLE` entries.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Signed-out viewer, non-realm page | `realmDeniesRevert={false}`, no Clerk session | No Revert button on any row; View revision still rendered | n/a |
| Signed-out viewer, read-only deployment | same, `readOnly` | No Revert button and no read-only note (nothing references its id) | n/a |
| Signed-in page owner, non-realm page | `realmDeniesRevert={false}`, session = page owner | Revert offered, as before | n/a |
| Signed-in page owner, realm page | `realmDeniesRevert={true}`, session = page owner | No Revert button (DW-269, unchanged) | n/a |
| Site owner, realm page | `realmDeniesRevert={true}`, session = site owner | Revert offered (admin server-side, unchanged) | n/a |
| Session not yet loaded | `isLoaded === false` | No Revert button — fail closed until identity resolves | n/a |
| `disputed-page` lint issue | `checkDisputedPages()` over a `disputed: true` page | `suggestion` names the PATCH AND that it is admin/service-only on a public knowledge page | n/a |
| `disputed-page` fix attempt | `fixLintIssue("disputed-page", slug)` | Throws `FixValidationError` carrying the same clause, slug interpolated | Unchanged |

</intent-contract>

## Code Map

- `src/components/RevisionHistory.tsx` -- `canRevert` at :99 (`isSiteOwner || !realmDeniesRevert`); `useViewerHandle()` already destructured at :86 without `isSignedIn`; `realmDeniesRevert` prop docblock at :30-50 carries the "REVERT TAKES NO OWNERSHIP TERM" paragraph to amend; `canRevert` also gates the read-only note at :246-256 and is threaded to every `RevisionItem`.
- `src/components/ArticleActions.tsx:111,154` -- the pattern to mirror: `const { isLoaded, isSignedIn, handle: handleLc } = useViewerHandle();` and `isLoaded && !!isSignedIn`.
- `src/lib/viewer-handle.ts` -- already exports `isSignedIn: boolean`; no change needed.
- `src/lib/lint-types.ts` -- client-safe, dependency-free shared home for lint constants (`ALL_CHECK_TYPES`, `AUTO_FIXABLE_CHECK_TYPES`); the new clause helper belongs here so both server modules and `LintIssueCard` stay importable.
- `src/lib/lint-checks.ts:696-731` -- `checkDisputedPages`, its docblock naming "the surviving clear path", and the `suggestion` template at :727.
- `src/lib/lint-fix.ts:817-837` -- `NOT_AUTO_FIXABLE`, the comment at :831 and the `disputed-page` entry at :835-836; `autoFixRefusal`'s docblock at :903 describes the slug interpolation.
- `src/lib/authz.ts:196,254` -- `isRealmRestrictedWrite` / `canWritePage` docblocks state the admin/service-only rule the new copy must describe. Read-only.
- `src/middleware.ts:112,143-151,194-240` -- `WIKI_REVISIONS_RE`, `isBearerMachineWrite` and `handlePrivateRequest`: the evidence that a session-less revert POST is 401ed, not admitted. Read-only.
- `src/lib/__tests__/article-actions-gate.test.ts:168-171` -- pins the exact `canRevert` source line; must be updated with it.
- `src/components/__tests__/page-write-read-only.test.tsx:44-46` -- mocks Clerk as SIGNED OUT while asserting Revert renders; the mock must move to signed-in or the read-only cases stop exercising anything.
- `src/components/__tests__/article-actions-delete-gate.test.tsx:506-606` -- the mounted realm/identity gate suite (`clerk.current`, `renderArticle`), where the signed-out case belongs.
- `src/lib/__tests__/lint-checks.test.ts:936-953` and `src/lib/__tests__/lint-fix.test.ts:1031-1049` -- the existing copy assertions to extend.
- `_bmad-output/implementation-artifacts/spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md:122` -- the frozen Never clause to renegotiate; follow the recorded convention in `spec-dw-222-workers-ai-label-parity.md` (edit minimally, append a dated note).

## Tasks & Acceptance

**Execution:**
- `src/lib/lint-types.ts` -- export a `disputedClearGuidance(slug: string): string` helper returning the one clause both sites share (clear the Disputed toggle in the page editor, `PATCH /api/wiki/<slug>` with `metadata { disputed: false }`, and that on a public knowledge page that PATCH is admin- or service-only since DW-121, so a non-admin owner must ask an admin) -- one home, so the two sites cannot drift again.
- `src/lib/lint-checks.ts` -- build `checkDisputedPages`'s `suggestion` from the helper and correct the docblock's "surviving clear path" sentence -- the check's own guidance is what the MCP `fix_lint_issue` description points agents at.
- `src/lib/lint-fix.ts` -- build the `NOT_AUTO_FIXABLE["disputed-page"]` message from the helper and correct the comment above it -- half-corrected copy is the failure DW-389 names.
- `src/components/RevisionHistory.tsx` -- destructure `isSignedIn`, gate `canRevert` on `isLoaded && isSignedIn` in addition to the existing terms, and amend the `realmDeniesRevert` docblock to state that the signed-in term now exists while ownership still does not -- an offered control the middleware 401s is the harm.
- `src/lib/__tests__/article-actions-gate.test.ts` -- update the pinned `canRevert` source line and assert the island reads `isSignedIn` from `@/lib/viewer-handle` (still no `useUser`).
- `src/components/__tests__/page-write-read-only.test.tsx` -- move the Clerk mock to signed-in, saying in the comment why the read-only cases now require it.
- `src/components/__tests__/article-actions-delete-gate.test.tsx` -- add mounted cases for a signed-out viewer (no Revert on a non-realm page, View revision still present) and for the unresolved session.
- `src/lib/__tests__/lint-checks.test.ts`, `src/lib/__tests__/lint-fix.test.ts` -- assert each site names the admin/service-only constraint and that both are the helper's output for the slug (parity), plus the existing talk-free assertions.
- `_bmad-output/implementation-artifacts/spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md` -- narrow the frozen Never clause to ownership only and append a dated note recording DW-392's 2026-08-28 decision as a deliberate renegotiation -- a frozen clause edited without a record is indistinguishable from one edited to match changed code.

**Acceptance Criteria:**
- Given a signed-out viewer on a page the realm does not restrict, when the history panel is expanded, then no Revert button is rendered on any row and no `window.confirm` can be raised, while View revision remains.
- Given a signed-in page owner or the site owner, when the same page is rendered, then Revert is offered exactly as it was before this change.
- Given the Clerk session has not yet loaded, when the panel is expanded, then Revert is absent rather than briefly offered.
- Given a page flagged `disputed: true`, when `checkDisputedPages()` runs, then the issue's `suggestion` names the PATCH and states it is admin- or service-only on a public knowledge page, and mentions no talk thread.
- Given `fixLintIssue("disputed-page", slug)`, when it refuses, then the thrown message carries the same clause with the slug interpolated, so the two sites read identically.

## Spec Change Log

## Review Triage Log

### 2026-08-28 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 4, low 5)
- defer: 2: (high 0, medium 1, low 1)
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[medium]` `[patch]` The `realmDeniesRevert` prop docblock still opened "Only the realm term is threaded", which the signed-in term falsifies, and carried the identity rationale on the realm prop. Sentence scoped to the realm half; the identity half now points at `canRevert`.
  - `[medium]` `[patch]` `article-actions-delete-gate.test.tsx`'s signed-in non-owner row justified itself with "the route admits him", citing `canWritePage`. That is the per-page ACL, not the layer that answers — `handlePrivateRequest` 404s a non-owner first. Comment reframed to claim only what the ACL claims.
  - `[medium]` `[patch]` `src/mcp.ts`'s `fix_lint_issue` comment said `checkDisputedPages` "interpolates `entry.slug` into that sentence inline" — falsified by the move to `disputedClearGuidance`. Rewritten.
  - `[medium]` `[patch]` The load-bearing premise (the revisions path is exempt from the deployment gate ONLY under `isBearerMachineWrite`, i.e. with a `Bearer` credential) appeared in five prose sites and zero assertions. Added a `middleware-write-gate.test.ts` case pinning both the exemption's precondition and the resulting 401.
  - `[low]` `[patch]` AC-1 says no `window.confirm` can be raised; the new cases asserted button absence only. The signed-out read-only case now clicks what remains and asserts `confirmMock` was never called.
  - `[low]` `[patch]` The durable prose presented DW-392 as a live user-visible bug. `handlePrivateRequest` makes the deployment single-owner, so no anonymous viewer renders the article today. A "hardening, not a live bug" paragraph added to the component docblock, the mounted suite, the renegotiation note and this spec's Design Notes.
  - `[low]` `[patch]` The `isLoaded` comment claimed the fail-closed shape "matches how `ArticleActions` treats its own session-derived affordances"; only `canCurate` is `isLoaded`-guarded there. Claim narrowed, with the exceptions named.
  - `[low]` `[patch]` The mounted suite's docblock said "an ANONYMOUS reader", but `renderArticle` always passes the page owner as the server principal. Added the clause saying these rows isolate the client identity term.
  - `[low]` `[patch]` The renegotiation note in `spec-dw-121-…` had one line past the file's wrap column. Rewrapped.


## Design Notes

**Why signed-in is not an ownership term.** `POST /api/wiki/[slug]/revisions` is gated by the private-deployment middleware (session or bearer), the realm and the private-page ACL — not by page ownership. `isSignedIn` therefore narrows the client gate toward the server's answer; an `isOwner` term would narrow it PAST the server and hide Revert from viewers it admits. That is why DW-392's decision authorises the signed-in half alone and the frozen Never clause is narrowed rather than deleted.

**Hardening, not a live bug.** `handlePrivateRequest` makes this deployment single-owner — a session-less navigation is redirected to `/sign-in`, any other signed-in user gets a 404 — so no anonymous viewer renders the article today. The change closes the gap between what the component claims about who may act and what the server would answer; it does not fix an observable production defect, and the durable prose says so.

**Shape of the gate** (mirroring `ArticleActions`, whose `canCurate` is `isLoaded && !!isSignedIn && …`):

```ts
const { isLoaded, isSignedIn, handle } = useViewerHandle();
const isSiteOwner = isLoaded && isOwnerHandle(handle);
const isSignedInViewer = isLoaded && isSignedIn;
const canRevert = isSignedInViewer && (isSiteOwner || !realmDeniesRevert);
```

The site owner is necessarily signed in, so the added conjunct removes no door the previous expression opened for them.

**Read-only note follows for free.** The note at `:246` is already gated on `canRevert` because it is the target of the button's `aria-describedby`; a signed-out viewer now loses both together, leaving no orphaned paragraph.

**Who can actually clear `disputed`.** After DW-121 a metadata PATCH on a page `belongsInCommons` selects (public, non-agent-scoped, non-artifact) is refused for every non-service, non-admin principal. On private, agent-scoped or artifact pages the owner's toggle still works, so the copy must qualify the refusal by page class rather than claim the loop is closed for everyone.

## Verification

**Commands:**
- `pnpm vitest run src/components/__tests__/article-actions-delete-gate.test.tsx src/components/__tests__/page-write-read-only.test.tsx src/lib/__tests__/article-actions-gate.test.ts src/lib/__tests__/lint-checks.test.ts src/lib/__tests__/lint-fix.test.ts src/components/__tests__/lint-check-parity.test.tsx` -- expected: all pass.
- `pnpm test` -- expected: no new failures against the pre-change baseline.
- `pnpm lint` -- expected: clean.
- `npx tsc --noEmit` -- expected: no new type errors.

## Auto Run Result

Status: done

**Implemented change.** DW-392: `canRevert` in `RevisionHistory` gained the signed-in term — `isSignedInViewer && (isSiteOwner || !realmDeniesRevert)`, with `isSignedIn` taken from the shared `@/lib/viewer-handle` hook and guarded by `isLoaded`, so a signed-out or unresolved viewer is never offered Revert (nor the read-only note that only the Revert button references). No ownership term was added; the frozen Never clause in `spec-dw-121-230-269-270-…` was narrowed from "no ownership gate" to "no OWNERSHIP gate" with a dated renegotiation note beneath it. DW-389: both `disputed-page` copy sites now render one exported clause, `disputedClearGuidance(slug)` in the client-safe `lint-types.ts`, which names the PATCH *and* says it is admin- or service-only on a public knowledge page — so a non-admin owner is told to ask an admin instead of being sent at a request DW-121 refuses.

**Files changed.**
- `src/components/RevisionHistory.tsx` — the signed-in term, plus the three prose sites it falsified (prop docblock, `isLoaded` comment, read-only-note comment).
- `src/lib/lint-types.ts` — new `disputedClearGuidance(slug)` and its docblock; module docblock corrected.
- `src/lib/lint-checks.ts` — `checkDisputedPages`'s `suggestion` built from the helper; docblock corrected.
- `src/lib/lint-fix.ts` — `NOT_AUTO_FIXABLE["disputed-page"]` built from the same helper; comment corrected.
- `src/mcp.ts` — the `fix_lint_issue` comment that described the old inline interpolation.
- `src/components/__tests__/article-actions-delete-gate.test.tsx` — four mounted rows (signed-out, unresolved session, signed-in page owner, signed-in non-owner) on a public artifact.
- `src/components/__tests__/page-write-read-only.test.tsx` — Clerk mock made mutable and signed-in by default; new signed-out case asserting button, note and confirm are all absent.
- `src/lib/__tests__/article-actions-gate.test.ts` — the pinned `canRevert` source line, the hook destructure, and negative pins that ownership stays out.
- `src/lib/__tests__/middleware-write-gate.test.ts` — the `isBearerMachineWrite` premise the client gate rests on.
- `src/lib/__tests__/lint-checks.test.ts`, `src/lib/__tests__/lint-fix.test.ts` — each site names the constraint and equals the helper's output for its slug.
- `_bmad-output/implementation-artifacts/spec-dw-121-230-269-270-…md` — the narrowed Never clause, the dated renegotiation note, and the annotated I/O matrix row.

**Review findings breakdown.** 9 patches applied (medium 4, low 5); 2 deferred this pass (plus 1 recorded during implementation); 15 rejected. Rejected, with reasons: `autoFixRefusal(type, "")` rendering `PATCH /api/wiki/` is already ledger DW-458; computing the realm from `page.frontmatter` to make the clause per-page would help only the `lint-checks` caller and the conditional sentence is accurate as written; there is no completable path to point a non-admin at, which is the finding; a `!canRevert` guard in `handleRevert` is unreachable, since `RevisionItem` renders the only caller behind `canRevert`; the repeated rationale paragraphs match house comment density; `ArticleActions`'s redundant `!!isSignedIn` is pre-existing and untouched by this intent; the `canRevert` source-scan regex is a seam pin, with behaviour covered by the mounted suite; the semantic copy assertions beside the parity assertion are the failure message worth keeping; the `openHistory`/`renderHistory` split gives the signed-out case a marker Revert cannot supply; a parenthetical on the frozen matrix row is the lighter edit for a frozen artifact; the ledger's stale `lint-fix.ts:729-730` pointer is already corrected in this spec's Code Map; the helper's fragment shape and punctuation are what let two callers embed it mid-sentence; a slug reflected into an error string is not an injection surface; and both proposals to make `canRevert` mirror the single-owner deployment gate would add exactly the ownership term the frozen clause still forbids.

**Follow-up review recommendation.** Patched findings: high 0, medium 4, low 5. Score = 3×4 + 1×5 = 17, which is ≥ 5, so `followup_review_recommended: true`.

**Verification performed.**
- Targeted suites (`article-actions-delete-gate`, `page-write-read-only`, `article-actions-gate`, `lint-checks`, `lint-fix`, `lint-check-parity`, `middleware-write-gate`, `mcp`): 491 passed.
- `npx vitest run` (full): 13 files / 229 tests fail, byte-identical to the `0e62e034` baseline — confirmed by stashing the change and re-running exactly those files. Every failure is `window.localStorage` being undefined in `src/components/workbench/__tests__/*`, untouched here. Passing count rose 7519 → 7521 → 7525 with the new cases.
- `npx tsc --noEmit`: clean. `npx eslint`: clean (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices).
- Mutation check: restoring `canRevert = isSiteOwner || !realmDeniesRevert` fails the signed-out and unresolved-session rows in both mounted suites, and leaves the signed-in rows passing — the new cases are not vacuous.
- Matrix audit: all eight I/O rows have a covering test that ran and passed.

**Residual risks.**
- The full-suite run is flaky at the file level (one run reported 14 failing files, the JSON reporter 13); the extra file passes in isolation. The pre-existing `localStorage` breakage in the workbench suites is the underlying noise and is out of scope here.
- The signed-in term is hardening: this single-owner deployment never renders the article for an anonymous viewer, so the change has no observable effect in production today. Its value is that the component's claim about who may act now matches the server's.
- The client identity gates remain invisible to the armed E2E cookie identity (recorded as a deferred finding); Revert now joins Delete and Re-ingest in that blind spot.
