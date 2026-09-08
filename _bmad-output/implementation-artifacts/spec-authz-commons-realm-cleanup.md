---
title: 'Re-document the commons realm write gate and fix the edit-page denial copy'
type: 'chore'
created: '2026-08-16'
status: 'done'
baseline_revision: '7d7f43e668b4b138a65ccf12074e2ab05f2ba6e5'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The client delete gate still shows "Delete page" to a non-admin owner of a
      public knowledge page, whose DELETE the same realm gate then refuses with a
      generic message.
    evidence: |-
      `src/components/ArticleActions.tsx:82` computes `canDelete = isOwner ||
      isSiteOwner` and renders `DeletePageButton` at :137. For a page where
      `belongsInCommons` is true, `canWritePage(meta, principal, "delete")`
      returns false for any non-service, non-admin principal — so a non-admin
      page owner sees the button and gets "You don't have permission to delete
      this page." from `src/app/api/wiki/[slug]/route.ts:39-49`, the same vague
      copy this pass replaced on the edit surface. The comment above the gate
      calls `isOwner || isSiteOwner` "the effective server outcome", which holds
      only for the site owner (who is an admin). Its pin,
      `src/lib/__tests__/article-actions-gate.test.ts:22-26`, reads
      ArticleActions.tsx as TEXT and asserts the literal source string, so it
      cannot observe the divergence from `canWritePage`. This is DW-77's second
      clause; the bundle intent scoped this pass to documentation and copy, so
      no behaviour was changed here.
    location: >-
      src/components/ArticleActions.tsx:82
    severity: medium
  - summary: >-
      The edit page gates the whole editor — including the seven metadata fields
      — on writeKind "body", withholding metadata patches that canWritePage
      still permits.
    evidence: |-
      `src/app/u/[handle]/[slug]/edit/page.tsx:34` denies on `"body"` and
      returns before building `initialMetadata` (:69-79), yet
      `canWritePage(..., "metadata")` returns true for the same principal and
      `src/lib/patch-metadata.ts:91-106` admits the PATCH. The rewritten authz
      docblock now states that "metadata patches are still collectively
      editable", while the only UI reaching them is the screen that just
      refused. The bundle intent explicitly scoped a metadata-only editing
      surface out of this pass.
    location: >-
      src/app/u/[handle]/[slug]/edit/page.tsx:34
    severity: medium
  - summary: >-
      Seven other call sites of the same realm deny still emit a generic
      permission message with no realm explanation.
    evidence: |-
      `src/mcp.ts:295` and `:395`, `src/app/api/wiki/[slug]/route.ts:39` and
      `:123`, `src/app/api/wiki/[slug]/revisions/route.ts:144`,
      `src/app/api/ingest/reingest/route.ts:39`,
      `src/app/api/ingest/history/route.ts:195`, and `src/lib/mcp-http.ts:407`
      all return "You don't have permission to edit/delete this page." for the
      same deny the edit page now explains. `WikiEditor` renders the API's raw
      `error` string, so a human who read the new explanation on load would get
      the old generic one on save. The bundle intent named only
      `edit/page.tsx:50`, so the other surfaces were left alone.
    location: >-
      src/app/api/wiki/[slug]/route.ts:126
    severity: low
  - summary: >-
      The edit page's write denial returns before the canonical-tenant redirect,
      so a non-canonical edit URL renders the refusal instead of its 308.
    evidence: |-
      `src/app/u/[handle]/[slug]/edit/page.tsx` runs the `canWriteFrontmatter`
      denial branch (:33) before the `permanentRedirect(editPath(pageTenant,
      slug))` at :65-67. A non-admin opening `/u/bob/transformers/edit` for
      alice's public knowledge page therefore gets a 200 "Cannot edit" screen
      whose "← Back to page" link points at `/u/alice/transformers`, while the
      writable path for the same URL 308s to the canonical handle first. The
      asymmetry predates this pass — the branch and the redirect were already
      in this order at `{baseline_revision}`; this pass only rewrote the
      sentence inside the branch, so the ordering was left alone.
    location: >-
      src/app/u/[handle]/[slug]/edit/page.tsx:33
    severity: low
---

<intent-contract>

## Intent

**Problem:** `canWritePage` still denies `body`/`delete` writes on public non-agent pages to non-service, non-admin principals, but its in-comment rationale justifies that deny with mechanisms that no longer exist — "humans steer via metadata patches and talk threads" — since talk and the commons product surface were retired (AD-21). The one surface a human hits, the edit page, then says only "You don't have write access to this page," which explains nothing and offers nowhere to go.

**Approach:** Keep the rule and its test pin exactly as they are; rewrite the two stale rationale comments in `src/lib/authz.ts` to state the surviving justification (a public page's prose is agent-maintained, so a non-admin human may not overwrite or delete a curated public page), and replace the edit page's bare denial sentence with an accurate explanation of why the editor is closed and who can change the page.

## Boundaries & Constraints

**Always:** Preserve `canWritePage`'s behaviour byte-for-byte — the same principals are admitted and denied for every `WriteKind`. Keep `src/lib/__tests__/authz.test.ts` unchanged, including the pins at lines 223-231. Any new comment must describe only mechanisms that exist today in this repo.

**Block If:** The intended change would require altering the deny branch's condition, its ordering relative to the service/admin short-circuits, or any assertion in `authz.test.ts`.

**Never:** Do not remove, relax, or extend the commons realm deny branch. Do not touch `belongsInCommons` in `src/lib/commons.ts` or any other `canWriteFrontmatter` call site. Do not add a metadata-only editing surface to the edit page. Do not edit the deferred-work ledger (`_bmad-output/implementation-artifacts/deferred-work.md`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Non-admin human, public non-agent page, body write | `canWritePage({owner:"alice",visibility:"public"}, aliceP, "body")` | `false` — unchanged by this spec | No error expected |
| Non-admin human, public non-agent page, delete | `canWritePage({owner:"alice",visibility:"public"}, aliceP, "delete")` | `false` — unchanged | No error expected |
| Service / admin principal, same page | `canWritePage(commonsPage, service \| admin, "body" \| "delete")` | `true` — unchanged | No error expected |
| Non-admin human opens the edit page for a public non-agent page | Readable page, `canWriteFrontmatter(fm, principal, "body")` is `false` | "Cannot edit" screen whose body text names the reason (public pages are agent-maintained) and who can change it (an agent or a site admin), plus the existing "← Back to page" link | No error expected |

</intent-contract>

## Code Map

- `src/lib/authz.ts:155-178` -- `canWritePage`'s doc block. The third bullet ("**Commons body/delete** writes are agent-only… humans steer via metadata patches and talk threads") is the first stale rationale to rewrite.
- `src/lib/authz.ts:189-198` -- the deny branch itself plus its inline `── Realm gate ──` comment, which repeats the same stale justification. Rewrite the comment; the `if ((writeKind === "body" || writeKind === "delete") && belongsInCommons(meta)) return false;` body stays byte-identical.
- `src/lib/authz.ts:184-187` -- the service-principal and `isAdmin` short-circuits that run *before* the deny; they are why the deny only ever bites a non-service, non-admin principal. Do not reorder.
- `src/lib/commons.ts:47-56` -- `belongsInCommons`: public AND not agent-scoped AND not an artifact. Read-only here; it is what makes the deny reachable only for plain public knowledge pages.
- `src/lib/commons.ts:1-13,167-190` -- the AD-21 retirement notes and the no-op `syncCommonsForPage`. Evidence that the commons *surface* is gone while `belongsInCommons` survives as a predicate — the new comment must say this rather than imply a live commons.
- `src/app/api/wiki/[slug]/discuss/route.ts:3` (and its `[threadIndex]` siblings) -- talk routes now delegate to `src/lib/retired.ts`. Evidence that "talk threads" is a dead referent in the current comment.
- `src/app/u/[handle]/[slug]/edit/page.tsx:32-54` -- the readable-but-unwritable branch. Line 50 holds the copy to replace; the `backHref`/`← Back to page` link and the `"body"` write-kind argument above it stay as-is.
- `src/lib/patch-metadata.ts:91-106` -- metadata patches stay open to any signed-in caller (`canWriteFrontmatter` defaults to `"metadata"`), but the only UI that reaches them is the blocked editor. Read-only constraint: the new copy must not promise a metadata-editing screen that does not exist.
- `src/lib/__tests__/authz.test.ts:209-256` -- the `realm-aware write gate (WriteKind)` describe block, including the DW-77 pin at 223-231. Read-only: it is the regression proof that this pass changed no behaviour.
- `_bmad-output/planning-artifacts/architecture/architecture-work-wiki-2026-08-12/ARCHITECTURE-SPINE.md:158-162` -- AD-21, the decision that retired the commons surface and talk. Cite-worthy anchor for the rewritten comment.

## Tasks & Acceptance

**Execution:**
- `src/lib/authz.ts` -- rewrite the commons/realm bullet in `canWritePage`'s doc block (~L163-166) and the inline `── Realm gate ──` comment (~L189-192) so the stated rationale is the one that survives today: a public non-agent page's prose is agent- and admin-maintained, so a non-service, non-admin principal may not replace its body or delete it; note that the commons surface and talk threads are retired (AD-21) and that metadata patches remain collectively editable. Leave every executable line, including the deny branch, untouched -- the stale referents are the defect, not the rule.
- `src/app/u/[handle]/[slug]/edit/page.tsx` -- replace the bare denial sentence at L50 with copy that states why the editor is closed (this page is public, and public pages are agent-maintained) and who can change it (an agent or a site admin), keeping the existing heading, `← Back to page` link, and markup shape. Use HTML entities for apostrophes as the surrounding file already does -- otherwise `react/no-unescaped-entities` fails lint.
- `src/app/u/[handle]/[slug]/edit/__tests__/edit-denial-copy.test.tsx` -- NEW. Cover the I/O matrix's edit-page row, which nothing pinned before: render the real server component through the real `authz` predicate (mock only `getPrincipal`, the page read, and `WikiEditor`) and assert the denial screen names the realm reason and the site admin, retains the back link, and no longer carries the superseded sentence -- plus contrast cases (admin, owner-writable private page) proving the screen does not appear when the gate admits the caller. Must be `.test.tsx` under a `__tests__` directory: `vitest.config.ts` routes only that shape to the jsdom project with `esbuild.jsx` enabled, so a `.test.ts` importing the page's JSX would not transform.

**Acceptance Criteria:**
- Given the reworked `src/lib/authz.ts`, when the file is searched for "talk" and "metadata patches and talk threads", then no comment references talk threads or any other retired mechanism as the reason humans are denied, and every mechanism the comments name (service principal, admin, `belongsInCommons`, metadata patches) exists in the current codebase.
- Given `git diff src/lib/authz.ts`, when the diff is inspected, then every changed line is a comment line -- no executable statement, signature, import, or export is altered.
- Given the full test suite, when `pnpm test` runs, then it passes with `src/lib/__tests__/authz.test.ts` unmodified, proving the realm gate's behaviour is unchanged.
- Given `pnpm lint`, when it runs over the two edited files, then it reports no new errors or warnings.

## Spec Change Log

## Review Triage Log

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 3: (high 0, medium 2, low 1)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[medium]` `[patch]` The new denial copy said "public pages are agent-maintained", a universal claim that is false for public artifact (`html`/`slides`) and agent-scoped pages, which fail `belongsInCommons` and stay human-editable in the same editor. Rescoped the copy to "public knowledge pages", the class the gate actually covers.
  - `[medium]` `[patch]` The suite's two contrast cases asserted only `not.toContain("Cannot edit")`, which a not-found render, an empty render, or a swallowed throw would satisfy equally; `WikiEditor` was mocked to `() => null`, erasing the only positive signal. Mocked it to a `data-testid="wiki-editor"` sentinel and added a positive assertion to both cases.
  - `[low]` `[patch]` The rewritten doc bullet and inline comment were headed "is agent-only" while their bodies described service principals (agents AND cron) plus admins. Retitled both to "service- and admin-only" / "service/admin-only".
  - `[low]` `[patch]` The new copy used `&mdash;` while the not-found branch three lines above uses a literal em dash. Switched to the literal `—`; apostrophes stay `&rsquo;` for `react/no-unescaped-entities`.
  - `[low]` `[patch]` The suite's docblock reasoned that agent-scoped and artifact pages fall through to the writable branch — reasoning the reworded copy now depends on — but nothing pinned it. Added an `it.each` over `agent-knowledge`, `agent-identity`, `html`, `slides` asserting no denial screen and a rendered editor.
  - `[low]` `[patch]` `vitest.setup.dom.ts` documents that every DOM-project suite calls `cleanup()` first in its own `afterEach`; this suite renders via `renderToStaticMarkup` and never mounts. Recorded that as a deliberate exception in the `afterEach` so it does not read as an oversight. Also corrected the docblock's mock inventory, which omitted `WikiEditor`.

Rejected findings were dominated by pre-existing product facts the intent already accounts for: `src/middleware.ts:187-191` admits only `YOPEDIA_OWNER_USER_ID`, who is the site owner and therefore an admin, so no principal in the current deployment can reach the denial screen at all — the bundle intent already frames the deny as protecting a **future** non-admin principal, so today's unreachability is not a defect of this change. Also rejected: the absent in-app link to `editPath` (ArticleActions records that no "Edit page" affordance is intended), the anonymous-principal case (middleware redirects to sign-in before the route renders), and assorted style notes on duplication that predate this diff.

### 2026-08-16 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 0, low 5)
- defer: 1: (high 0, medium 0, low 1)
- reject: 14: (high 0, medium 0, low 14)
- addressed_findings:
  - `[low]` `[patch]` The suite's key assertion `/public knowledge pages are agent-maintained/i` passed only because that phrase sits on one 92-character JSX source line. A pure re-wrap of the JSX — byte-identical rendered output, since JSX joins source lines with single spaces — would have turned the suite red with a misleading failure. Extracted it as a whitespace-tolerant `REALM_REASON` constant (`\s+` between words) and used it at all three assertion sites.
  - `[low]` `[patch]` The two denial cases asserted the refusal's presence but never the editor's absence, the mirror of the care taken on the writable side; a render emitting both screens would have passed. Added `not.toContain('data-testid="wiki-editor"')` to both.
  - `[low]` `[patch]` `src/lib/authz.ts` still headed the public branch "Public / collective commons" three lines below the new comment declaring the commons surface retired — the same class of stale referent this pass exists to remove. Reworded to name the survival of `belongsInCommons` as a predicate only. Still comment-only.
  - `[low]` `[patch]` The new suite's docblock claimed agent-scoped and artifact pages "fall through to the public `return true`", which is true only of *public* ones — a private agent page takes the private-owner branch. Corrected, since an overstated rationale comment is exactly the defect this pass was opened to fix.
  - `[low]` `[patch]` The new copy's absolute "This page is public knowledge" is true only because the read cloak runs first and a readable private page is writable by its readers — an invariant neither recorded at the branch nor pinned anywhere, so a reorder would have shipped a false statement that also leaks a private page's realm. Recorded it in the branch comment and pinned it with a ninth test rendering an unreadable private page, asserting "Page not found" rather than the denial copy.

Rejected findings clustered into three groups. **Already deferred:** the delete-button divergence, the metadata-UI gap, and the seven generic-message call sites are recorded in `deferred` and were re-reported by reviewers who could not see that list. **Foreclosed by the contract:** the terminology residue in `src/lib/mcp-http.ts` and the "commons page" naming in `authz.test.ts` (Never/Always clauses forbid touching other call sites and that test file), and the JSDoc/inline duplication (the Tasks section mandates rewriting both comments). **Not defects:** the anonymous-principal case (middleware redirects to sign-in before the route renders — rejected in the prior pass too), unpinned non-owner and service-principal renders (neither varies the copy), the unpinned `NEXT_PUBLIC_OWNER_HANDLE` admin door (Next inlines `NEXT_PUBLIC_*` at build time, so a runtime-deletion test would pin a vitest-only construction — already logged as a residual risk), the pre-existing duplicate tenant derivation and `text-foreground/60` styling, and the `importOriginal` mock breadth (deliberate: it keeps the real `tenantForOwner`).

## Design Notes

The deny is reachable only through a narrow gap, and the new copy must match that gap rather than describe write access in general. `canReadFrontmatter` runs first on the edit page, so an unreadable private page already rendered "Page not found"; a *readable* private page is writable by exactly the same principals that could read it. Agent-scoped and artifact pages fail `belongsInCommons`, so they fall through to the public `return true`. That leaves one reachable case: a signed-in non-admin human on a plain public knowledge page. The copy should therefore name that case specifically — "this page is public / public pages are agent-maintained" — not the generic "you lack write access."

Illustrative shape for the rewritten inline comment (wording may vary, the referents may not):

```ts
// ── Realm gate: body/delete on a public knowledge page is agent-only ──
// The commons product surface and talk threads are retired (AD-21), but this
// deny still earns its place: it stops a signed-in non-admin from overwriting
// or deleting a curated public page. Service principals (agents, cron) and
// admins pass above; metadata patches stay collectively editable below.
```

## Verification

**Commands:**
- `./node_modules/.bin/vitest run src/lib/__tests__/authz.test.ts` -- expected: all realm-gate tests pass with the test file unmodified.
- `./node_modules/.bin/vitest run` -- expected: the full suite passes, including the new edit-page denial suite.
- `./node_modules/.bin/eslint src/lib/authz.ts 'src/app/u/[handle]/[slug]/edit/page.tsx' 'src/app/u/[handle]/[slug]/edit/__tests__/edit-denial-copy.test.tsx'` -- expected: exit 0, no output.
- `./node_modules/.bin/tsc --noEmit` -- expected: exit 0.
- `git status --porcelain` -- expected: exactly three source paths -- `src/lib/authz.ts` and `src/app/u/[handle]/[slug]/edit/page.tsx` modified, `src/app/u/[handle]/[slug]/edit/__tests__/edit-denial-copy.test.tsx` added.

Tooling note: `pnpm test` / `pnpm exec` fail from this directory with `ERROR packages field missing or empty`, caused by an unrelated stray `~/pnpm-workspace.yaml` two levels above the repo. The binaries under `./node_modules/.bin` run the same tools directly, hence the command forms above.


**Manual checks (if no CLI):**
- Read the final `src/app/u/[handle]/[slug]/edit/page.tsx` denial branch and confirm the rendered sentence would be true for the only principal that can reach it (a signed-in non-admin human on a public non-agent page), and that it promises no surface the app does not have.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** DW-7 and DW-77, resolved as documentation and copy work over a rule that stays. `canWritePage`'s realm deny is byte-identical and `src/lib/__tests__/authz.test.ts` is untouched; what changed is the stale rationale attached to the deny and the one human-facing sentence it produces. The old justification — "humans steer via metadata patches and talk threads" — named a mechanism retired with AD-21, leaving a deny with no stated reason and an edit screen that said only "You don't have write access to this page." This second review pass hardened the result rather than changing its shape: it removed the last retired referent from the same function, corrected an overstated sentence in the new suite's own rationale, and closed the gap between what the new copy asserts absolutely and what the code actually guarantees.

**Files changed.**
- `src/lib/authz.ts` — comment-only, mechanically verified (filtering the diff since `{baseline_revision}` to non-comment lines yields nothing). `canWritePage`'s doc bullet and the inline `── Realm gate ──` comment state the surviving justification, cite AD-21, and record that `belongsInCommons` survives only as the predicate naming that class; this pass also reworded the public branch's header, which still read "collective commons".
- `src/app/u/[handle]/[slug]/edit/page.tsx` — the denial copy names why the editor is closed and who can revise the page, scoped to public *knowledge* pages so it stays true of public artifacts and agent-scoped pages, which the gate does not cover. This pass added the branch comment recording why the copy may speak in absolutes, and what breaks if the read cloak is reordered ahead of it.
- `src/app/u/[handle]/[slug]/edit/__tests__/edit-denial-copy.test.tsx` — NEW, 9 tests. Renders the real server component through the real `authz` predicate and pins the explanation, the back link, the read cloak, the admin and owner-writable-private contrast cases, and the four page types outside the realm gate.

**Review findings (this pass).** 5 patches applied (0 high, 0 medium, 5 low), 1 item deferred (low), 14 rejected. No intent gaps, no spec repairs, no review loopbacks; `review_loop_iteration` stayed 0. Details in the Review Triage Log above. Cumulatively across both passes: 11 patches, 4 deferrals, 26 rejections.

**Follow-up review recommendation: true.** Patched findings this pass by severity: high 0, medium 0, low 5 → score `3 × 0 + 1 × 5 = 5`, exactly at the threshold of 5. Note the character of the remaining findings has shifted: this pass produced no medium or high patch and no spec-level defect, so the recommendation rests on volume of small comment/test refinements rather than on anything structural.

**Verification performed.**
- `./node_modules/.bin/vitest run` — 211 files, 4352 tests, all passed (prior pass: 211 files, 4351 tests; the ninth test in the new suite is the delta).
- `./node_modules/.bin/vitest run src/lib/__tests__/authz.test.ts` — 39/39 passed with the file unmodified, confirming the realm gate's behaviour is unchanged.
- `./node_modules/.bin/eslint` over the three files — exit 0, no output.
- `./node_modules/.bin/tsc --noEmit` — exit 0.
- Comment-only check on `src/lib/authz.ts` re-run after this pass's edit — no non-comment line changed since `{baseline_revision}`.
- Every I/O matrix row is covered by a test that ran and passed: the three predicate rows by `authz.test.ts:223-249`, the edit-page row by the new suite.

**Residual risks.**
- No principal in the current deployment can reach the improved screen: `src/middleware.ts:187-191` admits only `YOPEDIA_OWNER_USER_ID`, who is the site owner and therefore an admin, so `canWritePage` short-circuits before the deny. The copy is correct for the future non-admin principal the bundle intent says the deny exists to stop, and dead until one exists.
- The same deny still speaks in generic terms at eight other surfaces, the client delete button still shows for a principal the server refuses, and the collectively-editable metadata patches the new comment names have no reachable UI. All three are recorded in frontmatter `deferred` rather than fixed, since the intent scoped this pass to the authz comments and `edit/page.tsx:50`.
- The non-canonical edit URL renders the denial instead of a 308, newly recorded in `deferred`. Pre-existing ordering, untouched here.
- The suite deletes `NEXT_PUBLIC_OWNER_HANDLE` at runtime to control admin-ness. Next inlines `NEXT_PUBLIC_*` at build time, so this lever exists in vitest and not in the deployed app; the assertions about the predicate still hold, but the admin/non-admin split is a test-environment construction.

