---
title: 'Read-only deployment consistency (DW-37, DW-65, DW-149)'
type: 'bugfix'
created: '2026-08-17'
status: 'done'
baseline_revision: '6bebc4e6491b2638b3557a5878387beb5fdee424'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A read-only deployment still accepts page CREATION, revision revert, and bulk
      ingest deletion — three page-write doors that never consulted isReadOnly().
    evidence: |-
      DW-37 gated PUT/PATCH/DELETE /api/wiki/[slug]. `POST /api/wiki`
      (src/app/api/wiki/route.ts:51), `POST /api/wiki/[slug]/revisions` with
      {action:"revert"} (src/app/api/wiki/[slug]/revisions/route.ts:98) and
      `DELETE /api/ingest/history` (src/app/api/ingest/history/route.ts:107) all
      write or delete pages through the same kernel lifecycle with no isReadOnly()
      check — verified by grep: the string does not appear in any of the three
      files. So "read-only" currently means a page cannot be edited or deleted
      one at a time, but can still be created, reverted to an older body, or
      deleted in bulk. Pre-existing; none of the three is named by DW-37, DW-65
      or DW-149, and the spec's Never clause records them as out of scope.
    location: >-
      src/app/api/wiki/route.ts:51, src/app/api/wiki/[slug]/revisions/route.ts:98,
      src/app/api/ingest/history/route.ts:107
    severity: medium
  - summary: >-
      The stdio MCP server writes pages through the library directly, so no HTTP
      route gate can reach the agent callers DW-37's reason claims it covers.
    evidence: |-
      DW-37's reason says the fix belongs at the write route "where it also
      covers the MCP and agent callers". src/mcp.ts calls
      writeWikiPageWithSideEffects / patchMetadata / deleteWikiPage directly and
      only MIRRORS the REST ACL in comments (src/mcp.ts:283, :381) — it never
      issues an HTTP request. A read-only deployment therefore still accepts
      every MCP write. Pre-existing and structural: the gate would have to move
      into the library, or be restated in src/mcp.ts.
    location: src/mcp.ts
    severity: low
  - summary: >-
      WikiWorkbench's Change template control opens a confirm dialog onto a route
      that already answers 403 on a read-only deployment.
    evidence: |-
      `PUT /api/wikis/[id]/template` has consulted isReadOnly() since before this
      work (src/app/api/wikis/[id]/template/route.ts:24), but the canvas card's
      Change template button (src/components/WikiWorkbench.tsx:193) opens its
      confirm dialog unconditionally — the same confirm-then-403 shape DW-149
      names, one card away from the switcher this bundle fixed. Pre-existing; the
      bundle names WikiSwitcher only, and the canvas card is not under the shell
      seam this change threaded readOnly through.
    location: src/components/WikiWorkbench.tsx:193
    severity: low
  - summary: >-
      `POST /api/ingest/reingest` rewrites an entire page body with no
      isReadOnly() gate, and its control sits on the same article action bar as
      the Delete button this bundle just gated.
    evidence: |-
      src/app/api/ingest/reingest/route.ts has its own comment saying
      "re-ingest rewrites the page" and runs the realm-aware write ACL, but
      never consults isReadOnly() (verified by grep: the string appears nowhere
      under src/app/api/ingest/). On a read-only deployment the owner is
      refused a one-line edit through the editor while Reingest replaces the
      whole body. `ArticleActions.tsx` renders Reingest and Graphify beside the
      now-aria-disabled Delete, and article-actions-gate.test.ts deliberately
      pins that they are NOT dimmed — correctly, since the routes behind them
      answer no refusal to mirror. Distinct from DW-187, which names page
      create, revisions revert and ingest-history delete but not reingest.
      Pre-existing; not named by DW-37, DW-65 or DW-149.
    location: >-
      src/app/api/ingest/reingest/route.ts:9, src/components/ArticleActions.tsx:127
    severity: medium
  - summary: >-
      WorkspacePurposeSettings wraps its whole form in a `disabled` fieldset on
      a read-only deployment, so the stored purpose text becomes unreachable by
      keyboard — the DW-65 defect at full form scale.
    evidence: |-
      src/components/WorkspacePurposeSettings.tsx:223 is
      `<fieldset disabled={loading || saving || readOnly || !wiki}>` around
      every field and the Save button (:331 disables Save again). `disabled` on
      a fieldset removes every descendant from the tab order, so a keyboard or
      screen-reader user cannot read the stored Workspace Purpose at all — the
      exact harm DW-65 names for the Settings selects, on a surface the bundle
      did not name. The file already renders the read-only sentence at :344, so
      only the refusal mechanism is wrong. Pre-existing; the spec's Code Map
      cites this file only as the copy pattern to follow.
    location: src/components/WorkspacePurposeSettings.tsx:223
    severity: medium
---

<intent-contract>

## Intent

**Problem:** On a read-only deployment (`YOPEDIA_READONLY=1`) the page write route accepts writes that every sibling route refuses, and the shell offers write controls that will be refused: `PUT`/`PATCH`/`DELETE /api/wiki/[slug]` never consult `isReadOnly()`, `WikiSwitcher` renders New/switch/Rename/Delete with no read-only signal so the 403 arrives only after an irreversible confirm, and `SettingsCanvas` uses `disabled` on its selects and the vector checkbox, taking them out of the tab order so a keyboard user cannot even read the stored provider.

**Approach:** Add the three missing `isReadOnly()` gates at the page write route (and stop the Preview offering `Edit` for a page it can no longer save), pass a server-read `readOnly` flag through `WorkbenchData` into `WikiSwitcher`, and adopt one convention for a control that a read-only deployment refuses: `aria-disabled` plus a suppressed handler that restores the control, never `disabled`.

## Boundaries & Constraints

**Always:**
- A refusal the server answers is mirrored by the surface that offers it: an affordance is never rendered interactive where the write it triggers returns 403.
- Read-only means read-only, never hidden. Every control stays rendered, focusable and readable; only its write is refused.
- `aria-disabled` + a suppressed handler for read-only refusals; `disabled` stays only for transient busy states (`switching`, `saving`, `busy`) and for the Save button that already ships `SETTINGS_READ_ONLY_COPY` beside it.
- A suppressed handler on a controlled `<select>`/checkbox must put the control back — no state change means no re-render, so React never rewrites the DOM value on its own.
- Left-column sentences are sourced from `@/lib/workbench-tree`, never typed at the render site.
- Runtime identifiers stay `yopedia` (`YOPEDIA_READONLY`); copy says work-wiki.

**Block If:**
- The read-only gate cannot be added to a route without changing an existing status code for a non-read-only caller.

**Never:**
- Do not gate `POST /api/wiki` (page create), the revisions/revert routes, or the stdio MCP server in `src/mcp.ts` — all ungated today, none named by DW-37/DW-65/DW-149. Record, do not widen.
- Do not change the artifact half of the Preview route's `editable`, the `WikiWorkbench` canvas card, or the Settings Save button's `disabled`.
- Do not touch the deferred-work ledger.
- No new dependency, no i18n, no restyle beyond the disabled-face rules the new attribute needs.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Page body write, read-only | `YOPEDIA_READONLY=1`, `PUT /api/wiki/alpha` as the owner | 403, page bytes unchanged, no `dataVersion` bump | JSON `{ error }` naming read-only |
| Page metadata write, read-only | `YOPEDIA_READONLY=1`, `PATCH /api/wiki/alpha` | 403, frontmatter unchanged | JSON `{ error }` naming read-only |
| Page delete, read-only | `YOPEDIA_READONLY=1`, `DELETE /api/wiki/alpha` | 403, page still present | JSON `{ error }` naming read-only |
| Writable deployment | `YOPEDIA_READONLY` unset, same three requests | Unchanged behaviour — existing ACL, 404-cloak and 200 paths all as before | Unchanged |
| Unknown slug, read-only | `YOPEDIA_READONLY=1`, `PUT /api/wiki/nope` | 403 (deployment-wide, identical for every slug — no existence oracle) | JSON `{ error }` |
| Preview of a page, read-only | `YOPEDIA_READONLY=1`, `GET /api/workbench/preview?kind=page&slug=alpha` | `editable: false`, body still served in full | No error |
| Settings provider picker, read-only | `stored.readOnly`, keyboard user tabs to the select | Control is focusable, announces disabled, reports the stored provider | Change is refused, value restored |
| Settings vector checkbox, refused | `stored.readOnly`, or the provider cannot support vector search | Focusable, `aria-disabled`, hint announced as its description | Toggle refused, `checked` restored |
| Wiki controls, read-only | `readOnly` true in `WorkbenchData` | New/Rename/Delete and the switcher stay focusable and `aria-disabled`; the read-only sentence renders | No request is made, no dialog opens |

</intent-contract>

## Code Map

- `src/app/api/wiki/[slug]/route.ts` -- the three ungated handlers: `DELETE` (:16), `PUT` (:80), `PATCH` (:207). Each decodes the slug, then resolves `getPrincipal() ?? getServicePrincipal(req)`. The gate goes right after `decodeSlug`, before any read — the answer is identical for every slug, so it leaks nothing.
- `src/app/api/wikis/[id]/route.ts:24` -- the shape to copy verbatim: `if (isReadOnly()) return NextResponse.json({ error: "… while this deployment is read-only." }, { status: 403 })`.
- `src/lib/config.ts:125` -- `isReadOnly()`; reads `process.env.YOPEDIA_READONLY` at call time, so tests can flip it per case.
- `src/app/api/workbench/preview/route.ts:208-233` -- `editable`. The page half is `slug !== undefined` today, with a long comment justifying it *because* `PUT /api/wiki/[slug]` has no read-only check. That justification dies with this change: add `!isReadOnly()` to the page half and rewrite the comment. The artifact half is already correct — do not touch it.
- `src/components/workbench/SettingsCanvas.tsx` -- `providerRow` select (:280), embedding-provider select (:393), vector checkbox (:441). `set()` (:203) is the single draft funnel; `stored.readOnly` comes from the payload. Text inputs already use `readOnly` (:250, :326) — the model to match. The secret-row Remove control at :339 is already hidden under `!stored.readOnly`; leave it.
- `src/components/workbench/WikiSwitcher.tsx` -- `WikiSwitcherProps` (:31), the active-wiki `<select>` (:268-288, `POST /api/wikis/current` is gated), New Wiki (:292-302, `POST /api/wikis`), Rename/Delete (:320-347, `PATCH`/`DELETE /api/wikis/[id]`). `value` (:235) is the controlled value to restore to.
- `src/components/workbench/WorkbenchData.tsx` -- the server→client seam; add `readOnly` to `WorkbenchData` and to `EMPTY_DATA`.
- `src/app/page.tsx:109-127` -- the provider value; server component, so it can call `isReadOnly()` directly.
- `src/components/workbench/Workbench.tsx:143-158, 929-933` -- destructures `useWorkbenchData()` and renders `<WikiSwitcher>`; add the prop pass-through.
- `src/lib/workbench-tree.ts:103` -- `WIKI_SCOPE_COPY`; the module that owns every left-column sentence. The new read-only sentence goes here.
- `src/app/globals.css:2864-2912` (`.wb-wiki-switch-*`) and `:3500-3525` (`.wb-set-*`) -- the disabled faces. `.wb-wiki-switch-action:hover:not([disabled])` (:2902) must also exclude `aria-disabled`.
- `src/components/WorkspacePurposeSettings.tsx:344-348` -- the read-only sentence pattern to follow ("… cannot be changed while this deployment is read-only.").
- Tests: `src/lib/__tests__/wiki-routes.test.ts` (route suite, env-per-test), `src/lib/__tests__/workbench-preview.test.ts:1196+` (`GET /api/workbench/preview`, `writePage` helper), `src/lib/__tests__/workbench-settings.test.ts:1382+` (SettingsCanvas source scans, incl. "gives every class it applies a rule in the stylesheet"), `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` (mounted, `dom` project), `src/lib/__tests__/wiki-schema-edit.test.ts:544-570` (the read-only route/affordance pair to mirror).

## Tasks & Acceptance

**Execution:**
- `src/app/api/wiki/[slug]/route.ts` -- import `isReadOnly` and add a 403 gate at the top of `DELETE`, `PUT` and `PATCH`, immediately after `decodeSlug` -- the page write route is the only mutating route that never consulted it, so a read-only deployment silently accepted page writes.
- `src/app/api/workbench/preview/route.ts` -- add `!isReadOnly()` to the page half of `editable` and rewrite the comment that justified its absence -- the read and the write must agree, or the owner retypes a page and is refused at Save.
- `src/lib/workbench-tree.ts` -- add the read-only sentence constant beside `WIKI_SCOPE_COPY` -- one owner per wording, so the claim cannot drift between the render site and its test.
- `src/components/workbench/WorkbenchData.tsx` -- add `readOnly: boolean` to `WorkbenchData` and `EMPTY_DATA` -- the deployment fact is a server read, and this is the one seam that carries server reads into the shell.
- `src/app/page.tsx` -- set `readOnly: isReadOnly()` on the provider value -- the flag is an env fact the server already knows; no route and no client fetch is added for it.
- `src/components/workbench/Workbench.tsx` -- read `readOnly` from `useWorkbenchData()` and pass it to `<WikiSwitcher>` -- the shell is the only component between the provider and the switcher.
- `src/components/workbench/WikiSwitcher.tsx` -- add the `readOnly` prop; give the switcher select, New Wiki, Rename Wiki and Delete Wiki `aria-disabled` and handlers that return early (the select restoring `event.currentTarget.value` to the controlled `value`); render the sourced read-only sentence -- the four routes behind these controls all answer 403, and Delete's arrives only after the confirm.
- `src/components/workbench/SettingsCanvas.tsx` -- replace `disabled` with `aria-disabled` plus a restoring, suppressed `onChange` on both provider selects and the vector checkbox (the checkbox covering its full refusal predicate, read-only and provider-unsupported alike) -- `disabled` removes them from the tab order, so a keyboard user cannot read the stored value or hear the hint that explains the refusal.
- `src/app/globals.css` -- add `[aria-disabled="true"]` faces for `.wb-set-select`, the `.wb-set-check` input and `.wb-wiki-switch-select`/`-new`/`-action`, and exclude `aria-disabled` from the switcher's hover rule -- a control that refuses every click must not light up on hover or show a pointer cursor.
- `src/lib/__tests__/wiki-routes.test.ts` -- add a read-only describe covering the three handlers' 403 and unchanged bytes, plus the writable-deployment control case -- the I/O matrix's server half.
- `src/lib/__tests__/workbench-preview.test.ts` -- add a page-half read-only case asserting `editable: false` with the body still served -- mirrors the artifact-half case in `wiki-schema-edit.test.ts`.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- add mounted read-only cases: every control still reachable and `aria-disabled`, no request made on click or change, and the sentence rendered.
- `src/lib/__tests__/workbench-settings.test.ts` -- add a source scan pinning that no read-only-refused select or checkbox carries `disabled` and that each carries `aria-disabled` with a restoring handler.

**Acceptance Criteria:**
- Given `YOPEDIA_READONLY=1` and an existing page the caller may write, when `PUT`, `PATCH` or `DELETE /api/wiki/[slug]` is called, then each answers 403 with a JSON error naming read-only and the stored bytes and frontmatter are unchanged.
- Given `YOPEDIA_READONLY` is unset, when the same three requests are made, then every existing status code, ACL outcome and response body is unchanged.
- Given `YOPEDIA_READONLY=1`, when the Preview route is asked for a readable page, then `editable` is `false` and the full body is still served.
- Given a read-only deployment, when a keyboard user tabs through the Settings model and embeddings categories, then the provider selects and the vector checkbox receive focus, report their stored value and are announced disabled.
- Given a read-only deployment, when the owner activates a Settings provider select or the vector checkbox, then the draft does not change and the control still displays the stored value.
- Given a read-only deployment, when the Workbench left column renders, then the read-only sentence is shown and the switcher, New Wiki, Rename Wiki and Delete Wiki are focusable and `aria-disabled`.
- Given a read-only deployment, when the owner clicks New Wiki, Rename Wiki or Delete Wiki, or changes the switcher, then no request is made, no dialog opens, and the switcher still names the active wiki.

## Spec Change Log

## Review Triage Log

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 2, low 6)
- defer: 3: (high 0, medium 1, low 2)
- reject: 14: (high 0, medium 0, low 14)
- addressed_findings:
  - `[medium]` `[patch]` The new server gates created confirm-then-403 at two live surfaces outside the Workbench — `DeletePageButton` (whose first act is a "cannot be undone" confirm) and the `/u/[handle]/[slug]/edit` page, both of which previously succeeded on a read-only deployment. Threaded `isReadOnly()` from both server pages down as a `readOnly` prop, applied the same aria-disabled + suppressed-handler convention (the guard runs before `window.confirm`, and inside `handleSave` rather than only on the button, since Enter submits the form), rendered the refusal sentence above the edit fields, and added a mounted suite plus source scans. Reingest, Graphify, Save to vault and Restore were deliberately left alone.
  - `[medium]` `[patch]` Nothing pinned the `page.tsx` → `Workbench` → `WikiSwitcher` seam: deleting the prop pass-through left every suite green while the shell silently presented a writable-looking UI. Added `workbench-read-only-seam.test.tsx`, which mounts the real shell inside `WorkbenchDataProvider` with `readOnly: true` and never hands the prop to the switcher itself, plus a scan pinning `readOnly: isReadOnly()` in `page.tsx`.
  - `[low]` `[patch]` The four `event.currentTarget…` restore statements were dead weight and their justification was false — React re-applies a controlled value after a change event whose handler commits no state. Verified by deleting all four and re-running both mounted suites (35 tests still green, including the value-restored assertions). Deleted them, corrected the claim at its single new owner, and replaced the source scan that pinned them. Every behavioural assertion kept.
  - `[low]` `[patch]` The switcher `<select>` was the one refused control with no reason in its accessible description — `aria-disabled` plus the scope sentence, never the read-only one. Joined both ids into the space-separated list and extended the mounted test to resolve each.
  - `[low]` `[patch]` The Settings refused controls had the same gap: `SETTINGS_READ_ONLY_COPY` sat unassociated in the save bar. Gave it an id and appended it to all three controls' `aria-describedby`, keeping each field's own hint; replaced the weak "description is non-empty" assertion with one that resolves every id and asserts the sentence is announced.
  - `[low]` `[patch]` `WikiSwitcherProps.readOnly`'s docstring named `POST /api/wikis/current`; the route exports `PUT`.
  - `[low]` `[patch]` The I/O matrix's "no `dataVersion` bump" clause was unverified. The three refusal cases now capture the counter before and after, and the writable control case asserts it does move — so the unchanged assertions are evidence of the gate rather than of a counter that never moves.
  - `[low]` `[patch]` Tests had become dependent on the ambient environment: the new preview case asserted `editable: true` outside its `try/finally`, and the newly gated handlers made ~20 pre-existing `wiki-routes.test.ts` assertions sensitive to an exported `YOPEDIA_READONLY`. Both suites now clear the variable per test and restore the shell's value in teardown.

### 2026-08-17 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 2: (high 0, medium 2, low 0)
- reject: 21: (high 0, medium 0, low 21)
- addressed_findings:
  - `[low]` `[patch]` `WikiEditor`'s Save kept `disabled={busy || !dirty}`, so on a read-only deployment's untouched form — the state an owner who reads the sentence and types nothing stays in — the button was natively disabled, out of the tab order, and its `aria-disabled` / `aria-describedby={readOnlyNoteId}` were unreachable. That is the DW-65 defect on the very control whose refusal the sentence explains, and the comment above it claimed the opposite. The existing mounted test never saw it because it fires a `change` before asserting focus. Changed to `disabled={!readOnly && (busy || !dirty)}`, rewrote the comment, and added two cases: Save focusable and described before a keystroke on a read-only page, and still `disabled` on an untouched writable page.
  - `[low]` `[patch]` `isReadOnly()`'s docstring still said it governs "settings writes" and justified itself entirely in provider-preference terms, while this change made it the gate for page bodies, page metadata, page deletion and the Preview's `editable`. It is the single definition every new gate calls, so a reader deciding whether a new route needs it was actively misled. Rewrote it to state the real scope and to name the page writes that still do NOT consult it (`POST /api/wiki`, revisions revert, `DELETE /api/ingest/history`, reingest, `src/mcp.ts`).
  - `[low]` `[patch]` The article-page seam assertion `expect(view).toContain("readOnly={readOnly}")` was unanchored, unlike its sibling which pins the whole `<DeletePageButton …>` element and its count. The hop it guards could be deleted with the suite green as soon as any other element in `ArticleView.tsx` grew the same attribute. Anchored it to the `<ArticleActions` element.
  - `[low]` `[patch]` The spec's Design Notes still prescribed the four hand-written `event.currentTarget.value = …` restores that the previous pass deleted after verifying React restores a controlled value on its own — and `workbench-settings.test.ts:1490` now pins their absence. A reader following the note would have reintroduced code a test forbids. Replaced the block with the corrected mechanism and a pointer to the pin.

## Design Notes

**Why the gate goes before the existence read.** Deployment read-only is the same answer for every slug, so answering it first is not an oracle — and it keeps the refusal cheap. The realm-aware 404-cloak below it is untouched.

**Restoring a suppressed control — the early return IS the restore.** The premise this note originally carried ("no state change means no re-render, so React never rewrites the DOM value on its own") is false for a controlled input: React restores the DOM value after a change event whose handler commits no state. Verified by deleting the four hand-written `event.currentTarget.value = …` restores and re-running both mounted suites — the value-restored assertions stayed green. So the handler is a bare guard, and `workbench-settings.test.ts:1490` pins the absence of the manual restore so it cannot creep back:

```tsx
onChange={(event) => {
  if (stored.readOnly) return;
  set(key, event.target.value);
}}
```

**Why the vector checkbox gets the convention for its whole predicate.** Its hint is wired as `aria-describedby` precisely so the reason travels with the control — but a `disabled` control is not focusable, so that description is never announced. Applying `aria-disabled` to both halves of the refusal (read-only, and provider-unsupported) is what makes the existing comment true rather than aspirational.

**Out of scope, recorded:** `POST /api/wiki`, the revisions/revert routes and the stdio MCP server in `src/mcp.ts` also write without an `isReadOnly()` gate. None is named by DW-37, DW-65 or DW-149.

## Verification

**Commands:**
- `pnpm test` -- expected: all suites pass, including the `dom` project.
- `pnpm lint` -- expected: no new errors.
- `pnpm exec tsc --noEmit` -- expected: clean (the new `readOnly` field is required on `WorkbenchData`, so every construction site must be updated).

## Auto Run Result

Status: done

**Summary.** Follow-up review pass over the committed DW-37/DW-65/DW-149 bundle (baseline `6bebc4e6491b2638b3557a5878387beb5fdee424`). Four review layers ran in parallel over the full diff. No intent gap and no spec defect surfaced — the diff implements the contract's Approach and every I/O matrix row has an executed assertion. Four low-severity patches were applied and two pre-existing medium issues were recorded.

**Files changed in this pass:**
- `src/components/WikiEditor.tsx` -- Save no longer carries native `disabled` on a read-only deployment, so it stays focusable and its refusal sentence is announced before the owner types.
- `src/components/__tests__/page-write-read-only.test.tsx` -- two cases pinning Save focusable/described before a keystroke on read-only, and still `disabled` on an untouched writable page.
- `src/lib/config.ts` -- `isReadOnly()` docstring rewritten to its real (page-write-wide) scope, naming the writes that still bypass it.
- `src/lib/__tests__/article-actions-gate.test.ts` -- the `ArticleView` -> `ArticleActions` seam assertion anchored to the element rather than to a bare attribute substring.
- `_bmad-output/implementation-artifacts/spec-dw-37-read-only-deployment-consistency.md` -- Design Notes corrected, triage log and two deferred items appended.

**Review findings breakdown:** 4 patches applied (all low), 2 items deferred (both medium), 21 items rejected (all low).

**Deferred this pass:**
- `POST /api/ingest/reingest` rewrites an entire page body with no `isReadOnly()` gate, with its control on the same action bar as the now-gated Delete. Distinct from DW-187.
- `WorkspacePurposeSettings` wraps its whole form in a `disabled` fieldset when read-only, making the stored purpose text keyboard-unreachable -- the DW-65 defect at form scale on an unnamed surface.

**Follow-up review recommendation:** `false`. Patched this pass: high 0, medium 0, low 4. Score = 3x0 + 1x4 = 4, below the threshold of 5, and no patched finding was high severity.

**Verification performed:**
- `npx vitest run` -- 223 files, 4643 tests, all passing (up from 4641; the two additions are this pass's).
- `npx tsc --noEmit` -- clean, exit 0.
- `npm run lint` -- no errors (only three pre-existing informational `jsx-ast-utils` notices about `TSNonNullExpression` prop values).
- Note: `pnpm test` / `pnpm exec` as written in the Verification section fail in this working copy with `ERROR packages field missing or empty`; the equivalents were run through `npx` / `npm run`.

**Residual risks:**
- "Read-only" is still not deployment-wide for pages: page create, revisions revert, bulk ingest-history delete, reingest and every stdio MCP write all land on a read-only deployment (DW-187, DW-188, and the reingest item above). The gated routes' copy tells the owner pages "cannot be edited", which overstates what the deployment actually refuses.
- Both server->client `readOnly` seams are threaded through optional props defaulting to `false`, so a deleted pass-through is a silent regression rather than a compile error. Each hop is pinned by a test (mounted for the Workbench, props-recording for the edit page, anchored source scan for the article page), but the type system does not enforce them.
- The Workbench Preview's `Edit` control disappears entirely when `editable` is false rather than staying rendered and `aria-disabled`. This is what the contract's I/O matrix specifies, but it is the one surface in the bundle that hides rather than explains.
