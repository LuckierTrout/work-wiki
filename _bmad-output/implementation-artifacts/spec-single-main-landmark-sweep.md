---
title: 'Single `<main>` landmark sweep: demote the 30 inner landmarks SiteChrome already provides (DW-11)'
type: 'refactor'
created: '2026-08-17'
status: 'done'
baseline_revision: '0614c2b26bb0e25182d33a14a753a8094abfcefc'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Demoting KnowledgeStudio's and VaultExplorer's content columns to plain
      `<div>` leaves each grid with labelled `<aside>` landmarks on both sides and
      no landmark on the content between them.
    evidence: |-
      `src/components/KnowledgeStudio.tsx:213` (`.studio-main`) sits between
      `<aside className="studio-nav" aria-label="Knowledge Studio sections">` and
      `<aside className="studio-evidence" aria-label="Evidence and actions">`.
      `src/components/VaultExplorer.tsx:369` is the same shape: after the sweep the
      grid's only landmark children are `<aside aria-label="Vault explorer">` and
      `<aside aria-label="Document preview">`. A screen-reader user can jump to both
      rails but not to the substance between them. Three independent reviewers raised
      it. Not patched here for two reasons: DW-11's intent authorises `<div>` OR
      `<section>` without selecting between them per site and promises nothing about
      region navigability, and this spec's frozen intent-contract says "Do not add
      ARIA roles, headings or landmarks to compensate". Restoring the region means a
      named `<section>` (or `role="region"` + `aria-label`) on those two wrappers —
      a deliberate a11y decision, not a mechanical follow-on to the sweep. Note that
      `single-main-landmark-mounted.test.tsx` pins `PrivateWorkspaceNotice`'s wrapper
      as a `DIV`; that surface has no aside siblings and is not part of this item.
    location: >-
      src/components/KnowledgeStudio.tsx:213, src/components/VaultExplorer.tsx:369
    severity: low
  - summary: >-
      The DW-152 entry in the deferred-work ledger is truncated mid-sentence,
      losing the clause that scopes it away from PrivateWorkspaceNotice.
    evidence: |-
      `deferred-work.md`'s DW-152 `reason:` ends with "... not a mechanical
      follow-on to the sweep. Note that" and then jumps straight to `status:
      open`. The missing tail survives only here, in this spec's `deferred[0]`
      block scalar: "`single-main-landmark-mounted.test.tsx` pins
      `PrivateWorkspaceNotice`'s wrapper as a `DIV`; that surface has no aside
      siblings and is not part of this item." The clause was lost flattening a
      multi-line block scalar onto one ledger line. It matters because the
      ledger is what the sweep tooling reads, so a later run picking up DW-152
      cannot see which surface the item excludes. Recorded here rather than
      fixed: this run was invoked under an explicit instruction not to modify,
      re-open or rewrite deferred-work ledger entries — the orchestrator owns
      their text, status and resolution.
    location: >-
      _bmad-output/implementation-artifacts/deferred-work.md (DW-152)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `SiteChrome` wraps every route's children in `<main id="main-content">`, and 30 further `<main>` elements across 27 page/component files render *inside* it — `PrivateWorkspaceNotice` (the signed-out branch of nine owner-only pages), plus every desk, page shell and not-found surface. That is a duplicate-landmark violation (WCAG 2.2 AA, one `main` per document), and nothing in the suite can catch a new one being added.

**Approach:** Demote every inner `<main>` to a plain `<div>`, preserving each element's `className`, inline `style` and children exactly, and add a source-level scan test that fails when any file under `src/app` or `src/components` other than `SiteChrome.tsx` emits a `<main>`.

## Boundaries & Constraints

**Always:** Keep each converted element's attributes byte-identical — only the tag name changes (`<main` → `<div`, `</main>` → `</div>`). `SiteChrome.tsx` keeps both of its `<main id="main-content" className="flex-1">` landmarks (bare and chrome branches) untouched. The new scan test must skip `__tests__` directories and must not flag `<main>` written inside comments (three such comments exist and are correct as prose). The scan test must also positively assert `SiteChrome.tsx` still holds `<main id="main-content"`, so it cannot pass vacuously after a bad edit.

**Block If:** A conversion site turns out to need `<section>` semantics with an accessible name to preserve behaviour (i.e. a plain `<div>` would drop a labelled region a test or stylesheet depends on) — no such site exists in the evidence gathered, so treat one appearing as a spec gap.

**Never:** Do not touch `SiteChrome`'s landmarks, the skip-link targets (`#main-content`, `#wb-canvas`), any `className`/`style` value, or the `<main>` strings in `src/lib/html.ts` and `src/lib/__tests__/*` — those concern *ingested* third-party HTML and are unrelated to the app's own chrome. Do not add ARIA roles, headings or landmarks to compensate. Do not restyle, and do not edit `src/app/globals.css` (it has no bare `main` element selector).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Signed-out owner route | `PrivateWorkspaceNotice` renders under `SiteChrome` | Exactly one `main` landmark in the document (SiteChrome's); notice root is `div.shell.fade` with its padding/centering style intact | No error expected |
| Desk/page surface | e.g. `ReviewDesk`, `VaultExplorer`, `KnowledgeStudio` render under `SiteChrome` | One `main`; content column stays a block-level element carrying the same classes, so `.shell`/`.paper-route`/`.studio-main`/`.vault-explorer-grid` CSS still applies | No error expected |
| Regression: new inner `<main>` | A file under `src/app`/`src/components` (not `SiteChrome.tsx`, not under `__tests__`) gains a `<main>` in JSX | Scan test fails and names the offending relative path | Test failure lists offenders |
| Comment mentioning `<main>` | `ModeCanvas.tsx`, `Workbench.tsx`, `SiteChrome.tsx` prose comments | Scan test passes — comments are stripped before matching | No false positive |

</intent-contract>

## Code Map

- `src/components/SiteChrome.tsx:50,63` -- the ONE real landmark, in both branches (`bare` for `/` and `/sign-in`, and the nav+footer branch). Read-only. Its comments at :36 and :44 mention `<main>` in prose.
- `src/app/layout.tsx:~95` -- the only root layout; `SiteChrome` wraps `{children}` for every route. `src/app/settings/layout.tsx` is the only nested layout and adds no landmark. No `global-error.tsx` exists, so nothing escapes the root layout.
- Conversion sites (30 `<main>` / 30 `</main>`, all open+close in the same file, verified 1:1 by grep):
  - `src/app/agent-api/page.tsx:15,24`; `src/app/ingest/page.tsx:82,417`; `src/app/lint/LintClient.tsx:29,108`; `src/app/loading.tsx:3,8`; `src/app/query/page.tsx:230,494`; `src/app/save/page.tsx:32,34`; `src/app/settings/page.tsx:55,68` and `73,219`; `src/app/u/[handle]/[slug]/edit/page.tsx:23,28` / `49,63` / `90,112`; `src/app/u/[handle]/[slug]/not-found.tsx:5,14`; `src/app/u/[handle]/[slug]/page.tsx:82,87`; `src/app/u/[handle]/raw/[slug]/not-found.tsx:5,14`; `src/app/wiki/graph/page.tsx:129,173`; `src/app/wiki/log/page.tsx:50,73`; `src/app/wiki/new/page.tsx:69,155`
  - `src/components/ActionInbox.tsx:213,404`; `ChatWorkspace.tsx:246,377`; `ErrorBoundary.tsx:26,59`; `IngestSuccess.tsx:15,61`; `IntegrationDesk.tsx:85,156`; `KnowledgeAtlas.tsx:208,384`; `KnowledgeStudio.tsx:213,272`; `PrivateWorkspaceNotice.tsx:23,43`; `RawSourceBrowser.tsx:141,267`; `ReviewDesk.tsx:250,477`; `SourceMonitorDesk.tsx:128,230`; `SystemHealthDesk.tsx:182,303`; `VaultExplorer.tsx:369,665`
- `src/lib/__tests__/single-ia.test.ts` -- reuse target: its `walk()` + `appAndComponentSources()` source-scan pattern (skips `__tests__`, matches `\.tsx?$`, reports `path.relative(SRC, file)`) is exactly the shape the new test needs.
- Read-only evidence that the tag swap is behaviour-neutral:
  - `src/app/globals.css` -- every relevant rule is class-based (`.shell`, `.paper-route`, `.fade`, `.studio-main`, `.vault-explorer-shell`). Grep for `main` in the file returns only `.studio-main*` class rules and one prose comment at :2488; there is no bare `main`/`> main` element selector anywhere.
  - No runtime code selects the element: repo-wide grep for `querySelector('main')`, `getElementsByTagName("main")`, `closest("main")`, `role="main"` and `getByRole("main")` all return nothing.
  - No existing test asserts `paper-route` / `shell fade` / `studio-main` / `vault-explorer-shell`, and no test queries the `main` role, so no test needs updating.
  - `src/components/workbench/ModeCanvas.tsx:34` and `src/components/workbench/Workbench.tsx:240` mention `<main>` only in comments — the scan must not flag them.

## Tasks & Acceptance

**Execution:**
- All 27 files listed in the Code Map -- rename the tag only: `<main` → `<div` at each listed open line and `</main>` → `</div>` at each listed close line, leaving `className`, `style`, attribute order and children untouched -- SiteChrome already supplies the document's single `main` landmark, so these are redundant landmarks, not layout.
- `src/lib/__tests__/single-main-landmark-scan.test.ts` -- new scan test, modelled on `single-ia.test.ts`: walk `src/app` + `src/components` (skip `__tests__`; `.ts`/`.tsx`/`.js`/`.jsx`/`.mdx`), strip comments with a string-aware left-to-right tokenizer, then flag any remaining `<main`, `role="main"`, `createElement("main")`, `as="main"` or `styled.main` in a file outside the `LANDMARK_OWNERS` set (`components/SiteChrome.tsx`). A regex stripper cannot be used here: `accept="image/*"` in `src/app/ingest/page.tsx` would be read as a block-comment opener and blank the JSX up to the next `*/`, hiding a reintroduced `<main>`. Further cases assert SiteChrome still holds exactly TWO `<main id="main-content"` (one per branch, so the guard cannot pass vacuously nor lose half the routes' landmark), that the demoted columns keep their exact `className`, that no `.css` under `src` targets `main` at selector position, and -- as negative controls on the tokenizer itself -- that comments in all four forms are ignored while real tags are not.
- `src/components/__tests__/single-main-landmark-mounted.test.tsx` -- the mounted half: composes `PrivateWorkspaceNotice` (the signed-out branch of all nine owner-only pages) inside `SiteChrome` and counts `main` on `document` (not the render container, so a portalled landmark is caught) across all three chrome branches -- a nav route, `/`, and `/sign-in` -- plus the demoted wrapper's tag/class/padding and both skip-link targets.

**Acceptance Criteria:**
- Given the app rendered on any route, when the DOM is inspected, then exactly one `main` landmark exists and it is `SiteChrome`'s `<main id="main-content" className="flex-1">`.
- Given a converted surface, when its markup is compared against the baseline, then the only difference is the tag name — every `className` and inline `style` is unchanged, so `.shell`, `.fade`, `.paper-route`, `.studio-main` and `.vault-explorer-*` styling and fade-in behaviour are preserved.
- Given the skip link, when it is activated on `/` or on a nav route, then it still targets `#wb-canvas` / `#main-content` respectively, unchanged.
- Given `./node_modules/.bin/vitest run` and `./node_modules/.bin/eslint`, when they run on the swept tree, then both pass with no new failures (see the environment note below on why the `pnpm` wrappers are not used).

## Spec Change Log

## Review Triage Log

### 2026-08-17 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 1, medium 1, low 8)
- defer: 1: (high 0, medium 0, low 1)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[high]` `[patch]` The guard's comment stripper was blind over ~32 lines of `src/app/ingest/page.tsx`: `accept="image/*"` (line 286) was read as a block-comment opener and the next `*/` closed it, so a reintroduced `<main>` in that window passed the scan. Replaced the two-regex stripper with a string-aware left-to-right tokenizer and added seven negative-control cases over the stripper itself. Verified by injecting `<main>` at line 300 of that file: now flagged, previously not.
  - `[medium]` `[patch]` The scan matched only a literal `<main`, so `role="main"`, `createElement("main")`, `as="main"` and `styled.main` reintroduced the same landmark with CI green. All five patterns now flagged, each naming which one hit.
  - `[low]` `[patch]` The stylesheet check read one hardcoded path and its character class omitted `(`, so `:is(main, …)` / `:where(main)` / `:not(main)` slipped past — idioms `globals.css` already uses. Now walks every `.css` under `src`, tests selector preludes only (declaration blocks and quoted strings removed, so `grid-area: main` cannot false-positive), and ships 14 must-catch / must-not-catch controls.
  - `[low]` `[patch]` The demoted-column case pinned whole JSX lines including inline-style literals, making a landmark suite fail on a Prettier rewrap. Now asserts the `className` attribute on the wrapper element only, and covers 8 files instead of 3.
  - `[low]` `[patch]` `expect(offenders).toEqual([])` reported paths with no guidance. Every scan expectation now carries an explanatory message in the house style of `vitest.config.ts`, including what to do and when `LANDMARK_OWNERS` is the correct fix instead.
  - `[low]` `[patch]` The owner allowlist was one hardcoded string with no escape hatch. Now a `LANDMARK_OWNERS` set documenting that `src/app/global-error.tsx` renders outside the root layout and would legitimately need its own landmark. Extension filter widened to `.js`/`.jsx`/`.mdx`.
  - `[low]` `[patch]` The anti-vacuity check asserted "contains a landmark", which could not notice one of SiteChrome's two branch landmarks being deleted — that would strip the landmark from half the routes. Now asserts exactly two, over comment-stripped source.
  - `[low]` `[patch]` The mounted suite counted landmarks on the render container, so a portalled `<main>` would have read as a pass; it also skipped `/sign-in` (the other `bare` route) and never checked the `#wb-canvas` bypass on `/`. All three closed.
  - `[low]` `[patch]` The two suites shared a basename, differing only by extension, so their report lines were indistinguishable across the `node` and `dom` projects. Renamed to `single-main-landmark-scan.test.ts` and `single-main-landmark-mounted.test.tsx`, following the repo's `create-wiki-ui` / `create-wiki-flow` convention.
  - `[low]` `[patch]` Verification and the last acceptance criterion named `pnpm` wrappers that fail in this checkout, and the Execution bullets still described the superseded stripper. Restated against `./node_modules/.bin/*` and the final test design.

### 2026-08-17 — Review pass (follow-up)

- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 1: (high 0, medium 0, low 1)
- reject: 16: (high 0, medium 0, low 16)
- addressed_findings:
  - `[medium]` `[patch]` The scan walked only `src/app` and `src/components`, but `src/hooks/useToast.ts` and `src/hooks/useKeyboardShortcuts.ts` build their trees with `createElement` and mount on every route via `ClientProviders`. A landmark added there — the worst case, since it lands on every page at once — was unscanned. Demonstrated: `createElement("main", …)` injected into `useToast.ts` left the whole suite green. `src/hooks` added to a named `SCANNED_DIRS` list (`src/lib` still deliberately excluded, since `html.ts` handles ingested third-party HTML). Re-probed: now flagged.
  - `[medium]` `[patch]` Nothing asserted that `app/layout.tsx` still composes `<SiteChrome>` — the only place it is composed, and after this sweep the only source of any landmark at all. Both existing guards stay true if the layout stops rendering it: the offender sweep sees no new `<main>`, and the anti-vacuity check reads `SiteChrome.tsx`'s own source. Demonstrated: replacing `<SiteChrome …>` with `<>` in `layout.tsx` left 4440 tests green while every route shipped zero landmarks, no skip link, no nav and no footer — worse than the duplicate-landmark bug this story fixed. Added a case pinning the composition. Re-probed: now fails.
  - `[low]` `[patch]` `withoutComments()` treated any `//` as a line comment, so a bare URL in JSX *text* (`<p>see https://x.dev</p>`) or a regex literal ending in an escaped slash (`/https:\/\//`) blanked the rest of that line — the same silent blind-window shape as the `accept="image/*"` bug patched in the previous pass, and previously logged only as an accepted residual risk. `//` preceded by `:` or `\` is no longer a comment opener; two control cases added.
  - `[low]` `[patch]` `LANDMARK_PATTERNS` matched only the quoted attribute spellings, so the JSX expression-container forms `role={"main"}` and `as={'main'}` — a one-character change — reintroduced the landmark with CI green. Patterns widened to accept an optional brace and backticks, with a new case asserting seven must-flag and four must-not-flag spellings so an empty offender list can no longer mean a sleeping guard.
  - `[low]` `[patch]` `selectorPreludes()` stripped CSS comments and CSS strings in two separate regex passes, so whichever ran first was blind to the other: `content: "/*"` opened a phantom comment that could hide a real `main { … }` element rule. Rewritten as one left-to-right pass that tracks both states, plus two must-catch controls for the string-holds-comment-opener and comment-holds-apostrophe cases.
  - `[low]` `[patch]` The class-preservation case read raw source, so a commented-out copy of the old markup would satisfy it while the live wrapper had drifted. Now reads comment-stripped source.
  - `[low]` `[patch]` The mounted suite counted `document.querySelectorAll("main")`, which reports a `<div role="main">` duplicate as zero — the accessibility tree makes no such distinction. Now counts `main, [role="main"]`.

## Verification

**Commands:**
- `grep -rn "<main" src/app src/components` -- expected: the two real landmarks in `src/components/SiteChrome.tsx`; prose comments in `SiteChrome.tsx`, `src/components/workbench/ModeCanvas.tsx`, `src/components/workbench/Workbench.tsx` and `src/app/globals.css`; and the docstrings/case names of `src/components/__tests__/single-main-landmark-mounted.test.tsx` (a `__tests__` path, which the scan skips by design). No JSX `<main` outside SiteChrome.
- `grep -rn "</main>" src/app src/components` -- expected: exactly two matches, both in `src/components/SiteChrome.tsx`.
- `./node_modules/.bin/vitest run src/lib/__tests__/single-main-landmark-scan.test.ts src/components/__tests__/single-main-landmark-mounted.test.tsx` -- expected: all cases pass (18 scan + 6 mounted). The two halves are named apart because they run in different vitest projects — the scan in `node`, the mounted count in `dom`.
- `./node_modules/.bin/vitest run` -- expected: no new failures versus the baseline revision `0614c2b26bb0e25182d33a14a753a8094abfcefc`, which was 213 files / 4421 tests.
- `./node_modules/.bin/eslint` -- expected: clean.
- `./node_modules/.bin/next build` -- expected: succeeds (catches any unbalanced JSX tag from the sweep).

**Environment note:** the `pnpm` wrappers fail in this checkout with `ERROR packages field missing or empty` — a stray `~/pnpm-workspace.yaml` (dated 2026-08-07, outside the repo) that pnpm finds by walking up. Pre-existing and unrelated to this change; run `./node_modules/.bin/{vitest,eslint,next}` directly instead.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Thirty `<main>` elements across 27 page and component files were demoted to `<div>`, leaving `SiteChrome` as the sole owner of the document's `main` landmark (WCAG 2.2 AA). Two guards hold the invariant — a source scan that fails when any file emits a landmark it does not own, and a mounted suite that counts landmarks in a real rendered tree. `SiteChrome.tsx` is byte-identical to the baseline; `globals.css` is untouched.

This follow-up review pass changed no application code. It found and closed two demonstrated ways the *guard* could be bypassed while the suite stayed green, and hardened five smaller blind spots in the guard's own machinery.

**Files changed**
- 27 swept files — tag rename only; the diff is 60 changed lines, and normalising `main`↔`div` in the tag position makes every removed/added pair byte-identical, so no `className`, inline `style`, attribute order or child moved. The list is in the Code Map above; `src/app/settings/page.tsx` held two sites and `src/app/u/[handle]/[slug]/edit/page.tsx` three, which is why 30 elements live in 27 files.
- `src/lib/__tests__/single-main-landmark-scan.test.ts` (new) — the scan, now 18 cases: the landmark sweep across `src/app`, `src/components` and `src/hooks`; SiteChrome's two branch landmarks; the root-layout composition; class preservation on 8 demoted columns; selector-position `main` in every `.css` under `src`; and negative controls over the comment stripper, the pattern list and the CSS prelude scanner.
- `src/components/__tests__/single-main-landmark-mounted.test.tsx` (new) — the mounted half: 6 cases composing `PrivateWorkspaceNotice` inside `SiteChrome` across all three chrome branches (a nav route, `/`, `/sign-in`), plus the wrapper's tag/class/padding and both skip-link targets.
- This spec.

**Review findings breakdown (this pass).** 7 patches applied (0 high, 2 medium, 5 low — itemised in the Review Triage Log); 1 item deferred (low — the DW-152 ledger entry is truncated mid-sentence; recorded in frontmatter `deferred` rather than fixed, because this run was invoked under an explicit instruction not to modify deferred-work ledger entries); 16 rejected. The rejections were: brittleness speculation about the class-preservation regex and the anti-vacuity match (both shapes deliberately chosen in the previous pass, on a file this story does not touch); `withoutComments` being exported from a test file (nothing imports it); the `walk()` duplication with `single-ia.test.ts` (already tracked as DW-117); `integrations/browser-clipper/popup.css` having a bare `main` rule (a separate extension document, not the app's); partial class/style pinning and the unmounted `KnowledgeStudio`/`VaultExplorer` grids (deliberate, and the latter is DW-152); `landmarks()[0]` throwing on an empty list (the length assertion fails first); spec bookkeeping nits (`review_loop_iteration` was reset by the follow-up-review route, and the Spec Change Log is empty because no `bad_spec` loopback occurred); the `.mdx` extension and `styled.main` pattern covering shapes this stack cannot yet produce (harmless, forward-looking); prose count drift in a historical log entry; the scan reaching `src/app/api` route handlers that render no JSX; the string-literal carve-out for ingested HTML (`src/lib` is not scanned, so there is no collision); and a reviewer's report that `vitest` exits 1, which was its own uncleaned probe file — the tree has no untracked files.

**Follow-up review recommended: true.** Patched findings by severity: high 0, medium 2, low 5. No patched finding was high severity; the score `3 × 2 + 1 × 5 = 11` clears the threshold of 5 on its own.

**Verification performed** (all commands run directly from `./node_modules/.bin/`, per the environment note):
- `vitest run` — 215 files / 4445 tests passed. The previous pass was 215 / 4440; the delta is exactly the 5 new guard cases. Baseline `0614c2b` was 213 / 4421.
- `eslint` — exit 0. `tsc --noEmit` — exit 0. `next build` — succeeded, all routes emitted.
- `grep -rn "<main" src/app src/components src/hooks` — the two real landmarks in `SiteChrome.tsx` plus the four prose comments; no JSX `<main` elsewhere. `grep -rn "</main>"` — exactly two matches, both `SiteChrome.tsx`.
- Both medium findings were verified adversarially rather than taken on report, and re-probed after patching. Injecting `createElement("main", null)` into `src/hooks/useToast.ts`: previously green, now fails the offender sweep naming `hooks/useToast.ts`. Replacing `<SiteChrome …>` with `<>` in `src/app/layout.tsx`: previously green across all 4440 tests, now fails the root-layout case. Both files were restored from copies (never `git checkout`, which would have reverted uncommitted work), and `git status` confirms only the intended files are modified.

**Residual risks**
- The scan reads source, so it cannot see a landmark produced at runtime from data — e.g. `<main>` inside ingested HTML written through `dangerouslySetInnerHTML` from a database row. Markup in a source string literal *is* flagged; markup that only exists at runtime is not. `HtmlPreview` renders ingested HTML in a sandboxed iframe (a separate document), so no current path leaks one into the app's document.
- `withoutComments()` now refuses to open a line comment after `:` or `\`. The trade runs the safe way — a genuine comment in those rare positions (`cond ? a : // note`) would be scanned as code and could raise a false positive, which is visible and annoying rather than silent — but it is a trade, not a total fix.
- `LANDMARK_OWNERS` is a whole-file allowlist, so a second landmark added inside `SiteChrome.tsx` itself would pass the scan. The mounted suite counts landmarks per render across all three of its branches, which is what actually covers that file.
- Class preservation is pinned for 8 of the 27 swept files and inline `style` for one (`PrivateWorkspaceNotice`, mounted). Wider pinning was deliberately declined in the previous pass to keep a landmark suite from becoming a formatting change detector; the byte-identical property was instead proven mechanically over the diff at implementation time.
- 26 of the 27 swept surfaces are never mounted, so their single-landmark property rests on the source scan rather than a rendered DOM. `KnowledgeStudio` and `VaultExplorer` are the two where that gap has a known consequence, tracked as DW-152.

